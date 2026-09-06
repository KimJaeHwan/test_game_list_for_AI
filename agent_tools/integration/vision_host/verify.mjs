import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { PassThrough } from "node:stream";

import {
  AgentLoopSupervisor,
  CodexHeadlessModelPort,
  PlayerRunnerStdioClient,
} from "../../05_vision_agent_host/src/index.mjs";
import { allowedKeysFromCompactModelActionSchema } from "../../05_vision_agent_host/src/model/model-action.mjs";

const temporaryRoot = mkdtempSync(join(tmpdir(), "atlas-vision-integration-"));
const bootstrapPath = resolve("integration/vision_host/synthetic-bootstrap.mjs");
const runnerEntry = resolve("01_player_runner/src/stdio-server.mjs");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ROLLOVER_THREAD_A = "11111111-1111-4111-8111-111111111111";
const ROLLOVER_THREAD_B = "22222222-2222-4222-8222-222222222222";
const ROLLOVER_THREAD_C = "33333333-3333-4333-8333-333333333333";

function rolloverFrame(frameId, marker) {
  const image = Buffer.concat([PNG_SIGNATURE, Buffer.from(marker)]);
  return {
    frameId,
    image,
    sha256: createHash("sha256").update(image).digest("hex"),
    changeClass: "PERSISTENT_CHANGE",
  };
}

function createRolloverRunner() {
  const calls = [];
  const observations = [rolloverFrame("F000001", "rollover-start")];
  const waited = [
    rolloverFrame("F000002", "rollover-after-enter"),
    rolloverFrame("F000003", "rollover-after-arrow-down"),
    rolloverFrame("F000004", "rollover-after-second-enter"),
  ];
  const take = (items, name) => {
    assert.ok(items.length > 0, `fake rollover runner ${name} queue exhausted`);
    return items.shift();
  };
  const invoke = async (name, argument, result) => {
    calls.push({ name, argument });
    return typeof result === "function" ? result(argument) : result;
  };
  return {
    calls,
    attachRun: (argument) => invoke("attachRun", argument, {
      runId: "rollover-run",
      observeCap: "ROLLOVER-OBSERVE-CAP",
      keyboardCap: "ROLLOVER-KEYBOARD-CAP",
      objectCap: "ROLLOVER-OBJECT-CAP",
      bookmarkCap: "ROLLOVER-BOOKMARK-CAP",
      handoffCap: "ROLLOVER-HANDOFF-CAP",
      actionProfile: {
        allowedKeys: ["ArrowDown", "Enter"],
        objectActions: false,
      },
      budgets: {
        observe: 10,
        keyboard: 10,
        object: 0,
        bookmark: 2,
        handoff: 2,
      },
    }),
    observe: (argument) => invoke("observe", argument, () => take(observations, "observe")),
    tapKey: (argument) => invoke("tapKey", argument, { deliveryStatus: "DELIVERED" }),
    waitFrame: (argument) => invoke("waitFrame", argument, () => take(waited, "waitFrame")),
    bookmarkObservation: (argument) => invoke("bookmarkObservation", argument, { ok: true }),
    requestEnd: (argument) => invoke("requestEnd", argument, { ok: true }),
    sealHandoff: (argument) => invoke("sealHandoff", argument, { ok: true }),
    close: (argument) => invoke("close", argument, undefined),
  };
}

function rolloverJsonl(events) {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function rolloverSuccessfulEvents(threadId, usage) {
  return [
    { type: "thread.started", thread_id: threadId },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "reasoning", type: "reasoning", text: "done" } },
    { type: "item.completed", item: { id: "answer", type: "agent_message", text: "one action" } },
    { type: "turn.completed", usage },
  ];
}

function rolloverWireAction(action, fields = {}) {
  return JSON.stringify({ action: { action, ...fields } });
}

function createRolloverFakeSpawn(scenarios) {
  const records = [];
  let nextScenario = 0;
  return {
    records,
    spawnImpl(executable, args, options) {
      const scenario = scenarios[nextScenario++];
      assert.ok(scenario, "unexpected real or duplicate Codex spawn");
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      let closed = false;
      let stdin = "";
      const record = {
        executable,
        args: [...args],
        options,
        stdin,
        killCount: 0,
      };
      records.push(record);
      child.stdin.on("data", (chunk) => {
        stdin += chunk.toString("utf8");
        record.stdin = stdin;
      });
      const close = (code, signal = null) => {
        if (closed) return;
        closed = true;
        setImmediate(() => child.emit("close", code, signal));
      };
      child.kill = () => {
        record.killCount += 1;
        close(null, "SIGTERM");
        return true;
      };
      child.stdin.once("finish", () => {
        setImmediate(() => {
          try {
            const outputFlag = args.indexOf("--output-last-message");
            assert.notEqual(outputFlag, -1);
            writeFileSync(args[outputFlag + 1], scenario.output, "utf8");
            child.stdout.end(rolloverJsonl(scenario.events));
            child.stderr.end();
            close(0);
          } catch (error) {
            child.emit("error", error);
          }
        });
      });
      return child;
    },
  };
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1, `missing ${flag}`);
  return args[index + 1];
}

function childEnvironment(root, launchTicket) {
  const allowed = ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP"];
  const env = Object.fromEntries(allowed.flatMap((name) => typeof process.env[name] === "string" ? [[name, process.env[name]]] : []));
  return {
    ...env,
    ATLAS_RUNNER_BOOTSTRAP: bootstrapPath,
    ATLAS_LAUNCH_TICKET: launchTicket,
    ATLAS_INTEGRATION_ROOT: root,
  };
}

class FakeModel {
  constructor() {
    this.actions = [
      { action: "press_key", code: "Enter" },
      { action: "finish", reason: "COMPLETE" },
    ];
    this.usages = [
      { inputTokens: 100, cachedInputTokens: 20, outputTokens: 5 },
      { inputTokens: 120, cachedInputTokens: 100, outputTokens: 7 },
    ];
    this.calls = [];
  }

  async decide(input) {
    const actualSupervisorSchema = JSON.parse(readFileSync(input.schemaPath, "utf8"));
    assert.deepEqual(
      allowedKeysFromCompactModelActionSchema(actualSupervisorSchema),
      ["Enter"],
      "the real Supervisor schema must be accepted by the Model Port bridge",
    );
    this.calls.push(input);
    return { action: this.actions.shift(), usage: this.usages.shift() };
  }
}

class FailingModel {
  constructor() {
    this.calls = [];
  }

  async decide(input) {
    this.calls.push(input);
    throw Object.assign(new Error("integration-private-model-diagnostic"), {
      code: "MODEL_TURN_FAILED",
      stderr: "integration-private-model-stderr",
    });
  }

  isQuiescent() {
    return true;
  }
}

class RestartingModel {
  constructor(decisions) {
    this.decisions = [...decisions];
    this.calls = [];
    this.resetCalls = [];
    this.sessionGeneration = 0;
  }

  async decide(input) {
    this.calls.push(input);
    assert.ok(this.decisions.length > 0, "restart integration model queue exhausted");
    const decision = this.decisions.shift();
    if (decision instanceof Error) throw decision;
    return decision;
  }

  isQuiescent() {
    return true;
  }

  async resetSession() {
    this.resetCalls.push({});
    this.sessionGeneration += 1;
    return Object.freeze({
      status: "RESET",
      nextInvocation: "EXEC",
      sessionGeneration: this.sessionGeneration,
    });
  }
}

function modelError(code) {
  return Object.assign(new Error("integration-private-model-diagnostic"), {
    code,
    stderr: "integration-private-model-stderr",
  });
}

try {
  const launchTicket = randomUUID();
  const runnerRoot = join(temporaryRoot, "runner-complete");
  const runner = await PlayerRunnerStdioClient.start({
    executable: process.execPath,
    args: [runnerEntry],
    env: childEnvironment(runnerRoot, launchTicket),
    requestTimeoutMs: 5_000,
    closeGraceMs: 2_000,
  });
  const model = new FakeModel();
  const hostRoot = join(temporaryRoot, "host");
  const supervisor = new AgentLoopSupervisor({
    runner,
    model,
    workdir: hostRoot,
    idFactory: randomUUID,
  });
  const result = await supervisor.run({ launchTicket });
  const journal = readFileSync(join(hostRoot, "driver.jsonl"), "utf8");
  assert.deepEqual(
    result,
    {
      status: "SEALED",
      reason: "COMPLETE",
      failures: 0,
      usage: {
        semantics: "TURN_DELTA",
        completeness: "COMPLETE",
        reportedTurns: 2,
        missingTurns: 0,
        knownTotals: {
          inputTokens: 220,
          cachedInputTokens: 120,
          outputTokens: 12,
          totalTokens: 232,
        },
      },
    },
    `unexpected supervisor result; sanitized journal follows:\n${journal}`,
  );
  assert.equal(model.calls.length, 2);
  assert.equal(model.calls.every((call) => call.prompt.includes("Allowed keys: [\"Enter\"]")), true);
  assert.equal(model.calls[1].prompt.includes("PERSISTENT_CHANGE"), true);

  const frameFiles = readdirSync(join(hostRoot, "frames")).sort();
  assert.deepEqual(frameFiles, ["F000001.png", "F000002.png"]);
  assert.equal(journal.includes("integration-private"), false);
  assert.equal(journal.includes(launchTicket), false);
  assert.equal(journal.includes("WAITING_FRAME"), true);
  assert.equal(journal.includes('"semantics":"TURN_DELTA"'), true);

  const publicDirectories = readdirSync(join(runnerRoot, "runs-public"));
  assert.equal(publicDirectories.length, 1);
  const handoff = JSON.parse(readFileSync(join(runnerRoot, "runs-public", publicDirectories[0], "handoff.json"), "utf8"));
  assert.equal(handoff.payload.manifest.status, "COMPLETE");
  assert.equal(handoff.payload.manifest.counts.actions, 1);
  assert.equal(handoff.payload.actions[0].input.code, "Enter");

  const failureTicket = randomUUID();
  const failureRunnerRoot = join(temporaryRoot, "runner-model-failure");
  const failureRunner = await PlayerRunnerStdioClient.start({
    executable: process.execPath,
    args: [runnerEntry],
    env: childEnvironment(failureRunnerRoot, failureTicket),
    requestTimeoutMs: 5_000,
    closeGraceMs: 2_000,
  });
  const failingModel = new FailingModel();
  const failureHostRoot = join(temporaryRoot, "host-model-failure");
  const failureSupervisor = new AgentLoopSupervisor({
    runner: failureRunner,
    model: failingModel,
    workdir: failureHostRoot,
    idFactory: randomUUID,
    policy: { modelRestarts: 0 },
  });
  const failureResult = await failureSupervisor.run({ launchTicket: failureTicket });
  assert.deepEqual(failureResult, {
    status: "SEALED",
    reason: "PARTIAL",
    failures: 0,
    stopCode: "MODEL_TURN_FAILED",
    usage: {
      semantics: "TURN_DELTA",
      completeness: "UNKNOWN",
      reportedTurns: 0,
      missingTurns: 1,
      knownTotals: null,
    },
  });
  assert.equal(failingModel.calls.length, 1, "failed model turn must not be retried");
  const failureJournal = readFileSync(join(failureHostRoot, "driver.jsonl"), "utf8");
  assert.equal(failureJournal.includes("integration-private-model-diagnostic"), false);
  assert.equal(failureJournal.includes("integration-private-model-stderr"), false);
  const recoverableRecord = failureJournal
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line))
    .find((entry) => entry.type === "termination");
  assert.deepEqual(
    Object.fromEntries(Object.entries(recoverableRecord).filter(([key]) => !["seq", "at", "type"].includes(key))),
    {
      reason: "PARTIAL",
      terminationKind: "MODEL_DECISION_FAILED_NO_ACTION",
      stopCode: "MODEL_TURN_FAILED",
      turn: 1,
    },
  );
  const failurePublicDirectories = readdirSync(join(failureRunnerRoot, "runs-public"));
  assert.equal(failurePublicDirectories.length, 1);
  const failureHandoff = JSON.parse(readFileSync(
    join(failureRunnerRoot, "runs-public", failurePublicDirectories[0], "handoff.json"),
    "utf8",
  ));
  assert.equal(failureHandoff.payload.manifest.status, "PARTIAL");
  assert.equal(failureHandoff.payload.manifest.counts.frames, 1);
  assert.equal(failureHandoff.payload.manifest.counts.actions, 0);

  const retryTicket = randomUUID();
  const retryRunnerRoot = join(temporaryRoot, "runner-retry-success");
  const retryRunner = await PlayerRunnerStdioClient.start({
    executable: process.execPath,
    args: [runnerEntry],
    env: childEnvironment(retryRunnerRoot, retryTicket),
    requestTimeoutMs: 5_000,
    closeGraceMs: 2_000,
  });
  const retryModel = new RestartingModel([
    modelError("MODEL_TURN_FAILED"),
    {
      action: { action: "press_key", code: "Enter" },
      usage: { inputTokens: 10, cachedInputTokens: 3, outputTokens: 2 },
    },
    {
      action: { action: "finish", reason: "COMPLETE" },
      usage: { inputTokens: 20, cachedInputTokens: 5, outputTokens: 5 },
    },
  ]);
  const retryHostRoot = join(temporaryRoot, "host-retry-success");
  const retrySupervisor = new AgentLoopSupervisor({
    runner: retryRunner,
    model: retryModel,
    workdir: retryHostRoot,
    idFactory: randomUUID,
  });
  const retryResult = await retrySupervisor.run({ launchTicket: retryTicket });
  assert.deepEqual(retryResult, {
    status: "SEALED",
    reason: "COMPLETE",
    failures: 0,
    usage: {
      semantics: "TURN_DELTA",
      completeness: "PARTIAL",
      reportedTurns: 2,
      missingTurns: 1,
      knownTotals: {
        inputTokens: 30,
        cachedInputTokens: 8,
        outputTokens: 7,
        totalTokens: 37,
      },
    },
  });
  assert.equal(retryModel.calls.length, 3);
  assert.equal(retryModel.resetCalls.length, 1);
  assert.equal(retryModel.calls[0].imagePath, retryModel.calls[1].imagePath);
  assert.notEqual(retryModel.calls[0].outputPath, retryModel.calls[1].outputPath);
  const retryJournal = readFileSync(join(retryHostRoot, "driver.jsonl"), "utf8");
  const retryRecords = retryJournal.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  const initialServed = retryRecords.find((entry) => entry.type === "frame_served");
  assert.equal(retryRecords.filter((entry) => entry.type === "model_restart_authorized").length, 1);
  assert.equal(retryRecords.filter((entry) => entry.type === "model_session_reset").length, 1);
  assert.equal(retryRecords.filter((entry) => entry.type === "tap_receipt").length, 1, "failed turn must not duplicate input");
  assert.deepEqual(
    retryRecords.filter((entry) => entry.type === "frame_served").slice(0, 2).map((entry) => [entry.frameId, entry.sha256]),
    [
      [initialServed.frameId, initialServed.sha256],
      [initialServed.frameId, initialServed.sha256],
    ],
  );
  assert.equal(retryResult.usage.reportedTurns + retryResult.usage.missingTurns, retryModel.calls.length);
  const retryPublicDirectory = readdirSync(join(retryRunnerRoot, "runs-public"))[0];
  const retryHandoff = JSON.parse(readFileSync(join(retryRunnerRoot, "runs-public", retryPublicDirectory, "handoff.json"), "utf8"));
  assert.equal(retryHandoff.payload.manifest.counts.actions, 1, "retry must produce exactly one delivered game input");

  const exhaustedTicket = randomUUID();
  const exhaustedRunnerRoot = join(temporaryRoot, "runner-retry-exhausted");
  const exhaustedRunner = await PlayerRunnerStdioClient.start({
    executable: process.execPath,
    args: [runnerEntry],
    env: childEnvironment(exhaustedRunnerRoot, exhaustedTicket),
    requestTimeoutMs: 5_000,
    closeGraceMs: 2_000,
  });
  const exhaustedModel = new RestartingModel([
    modelError("MODEL_TURN_FAILED"),
    modelError("MODEL_TURN_FAILED"),
  ]);
  const exhaustedHostRoot = join(temporaryRoot, "host-retry-exhausted");
  const exhaustedResult = await new AgentLoopSupervisor({
    runner: exhaustedRunner,
    model: exhaustedModel,
    workdir: exhaustedHostRoot,
    idFactory: randomUUID,
  }).run({ launchTicket: exhaustedTicket });
  assert.deepEqual(exhaustedResult, {
    status: "SEALED",
    reason: "PARTIAL",
    failures: 0,
    stopCode: "MODEL_TURN_FAILED",
    usage: {
      semantics: "TURN_DELTA",
      completeness: "UNKNOWN",
      reportedTurns: 0,
      missingTurns: 2,
      knownTotals: null,
    },
  });
  assert.equal(exhaustedModel.calls.length, 2);
  assert.equal(exhaustedModel.resetCalls.length, 1);
  const exhaustedJournal = readFileSync(join(exhaustedHostRoot, "driver.jsonl"), "utf8");
  assert.equal((exhaustedJournal.match(/"type":"tap_receipt"/gu) ?? []).length, 0);

  const schemaTicket = randomUUID();
  const schemaRunnerRoot = join(temporaryRoot, "runner-schema-invalid");
  const schemaRunner = await PlayerRunnerStdioClient.start({
    executable: process.execPath,
    args: [runnerEntry],
    env: childEnvironment(schemaRunnerRoot, schemaTicket),
    requestTimeoutMs: 5_000,
    closeGraceMs: 2_000,
  });
  const schemaModel = new RestartingModel([modelError("MODEL_ACTION_SCHEMA_INVALID")]);
  const schemaHostRoot = join(temporaryRoot, "host-schema-invalid");
  const schemaResult = await new AgentLoopSupervisor({
    runner: schemaRunner,
    model: schemaModel,
    workdir: schemaHostRoot,
    idFactory: randomUUID,
  }).run({ launchTicket: schemaTicket });
  assert.equal(schemaResult.status, "QUARANTINED");
  assert.equal(schemaResult.reason, "PARTIAL");
  assert.equal(schemaResult.stopCode, "MODEL_ACTION_SCHEMA_INVALID");
  assert.equal(schemaModel.calls.length, 1);
  assert.equal(schemaModel.resetCalls.length, 0);
  const schemaJournal = readFileSync(join(schemaHostRoot, "driver.jsonl"), "utf8");
  assert.equal((schemaJournal.match(/"type":"tap_receipt"/gu) ?? []).length, 0);

  const rolloverRunner = createRolloverRunner();
  const rolloverSpawn = createRolloverFakeSpawn([
    {
      events: rolloverSuccessfulEvents(ROLLOVER_THREAD_A, {
        input_tokens: 55_000,
        cached_input_tokens: 50_000,
        output_tokens: 20,
      }),
      output: rolloverWireAction("press_key", { code: "Enter" }),
    },
    {
      events: rolloverSuccessfulEvents(ROLLOVER_THREAD_B, {
        input_tokens: 55_000,
        cached_input_tokens: 50_000,
        output_tokens: 20,
      }),
      output: rolloverWireAction("press_key", { code: "ArrowDown" }),
    },
    {
      events: rolloverSuccessfulEvents(ROLLOVER_THREAD_C, {
        input_tokens: 200,
        cached_input_tokens: 50,
        output_tokens: 6,
      }),
      output: rolloverWireAction("press_key", { code: "Enter" }),
    },
    {
      events: rolloverSuccessfulEvents(ROLLOVER_THREAD_C, {
        input_tokens: 300,
        cached_input_tokens: 100,
        output_tokens: 8,
      }),
      output: rolloverWireAction("finish", { reason: "COMPLETE" }),
    },
  ]);
  const rolloverModel = new CodexHeadlessModelPort({
    executablePath: "C:\\trusted\\codex.exe",
    spawnImpl: rolloverSpawn.spawnImpl,
    env: {},
  });
  const rotationReceipts = [];
  const actualRotateSession = rolloverModel.rotateSession.bind(rolloverModel);
  rolloverModel.rotateSession = (...args) => {
    const receipt = actualRotateSession(...args);
    rotationReceipts.push(receipt);
    return receipt;
  };
  const rolloverHostRoot = join(temporaryRoot, "host-real-model-port-rollover");
  let rolloverRequest = 0;
  const rolloverResult = await new AgentLoopSupervisor({
    runner: rolloverRunner,
    model: rolloverModel,
    workdir: rolloverHostRoot,
    idFactory: () => `rollover-request-${++rolloverRequest}`,
    policyProfile: "ROLLOVER_ENDURANCE_2X",
  }).run({ launchTicket: "rollover-launch-ticket" });
  assert.deepEqual(rolloverResult, {
    status: "SEALED",
    reason: "COMPLETE",
    failures: 0,
    usage: {
      semantics: "TURN_DELTA",
      completeness: "COMPLETE",
        reportedTurns: 4,
      missingTurns: 0,
      knownTotals: {
          inputTokens: 110_500,
          cachedInputTokens: 100_150,
          outputTokens: 54,
          totalTokens: 110_554,
        },
      },
      executionProfile: "ROLLOVER_ENDURANCE_2X",
      primaryScoreEligible: false,
      rolloverEndurance: {
        thresholdInputTokens: 55_000,
        target: 2,
        completed: 2,
        validated: 2,
        requirementMet: true,
        status: "PASS",
      },
    });
  assert.deepEqual(rotationReceipts, [1, 2].map((sessionGeneration) => ({
    status: "ROTATED",
    nextInvocation: "EXEC",
    sessionGeneration,
  })));
  for (const receipt of rotationReceipts) {
    assert.deepEqual(Object.keys(receipt), [
      "status",
      "nextInvocation",
      "sessionGeneration",
    ]);
    assert.equal(Object.isFrozen(receipt), true);
  }
  assert.equal(rolloverModel.sessionGeneration, 2);
  assert.equal(rolloverModel.threadId, ROLLOVER_THREAD_C);
  assert.equal(rolloverModel.isQuiescent(), true);

  assert.equal(rolloverSpawn.records.length, 4, "rollover must not duplicate a model invocation");
  assert.deepEqual(
    rolloverSpawn.records.map((record) => record.args.slice(0, 3)),
    [
      ["exec", "--sandbox", "read-only"],
      ["exec", "--sandbox", "read-only"],
      ["exec", "--sandbox", "read-only"],
      ["exec", "resume", "-c"],
    ],
  );
  assert.equal(rolloverSpawn.records[0].args.includes("resume"), false);
  assert.equal(rolloverSpawn.records[1].args.includes("resume"), false);
  assert.equal(rolloverSpawn.records[1].args.includes(ROLLOVER_THREAD_A), false);
  assert.equal(rolloverSpawn.records[2].args.includes("resume"), false);
  assert.equal(rolloverSpawn.records[2].args.includes(ROLLOVER_THREAD_B), false);
  assert.equal(rolloverSpawn.records[3].args.includes(ROLLOVER_THREAD_C), true);
  assert.equal(rolloverSpawn.records.every((record) =>
    record.executable === "C:\\trusted\\codex.exe" &&
    record.options.shell === false &&
    record.options.windowsHide === true), true);
  const modelImagePaths = rolloverSpawn.records.map((record) => flagValue(record.args, "--image"));
  const modelOutputPaths = rolloverSpawn.records.map((record) => flagValue(record.args, "--output-last-message"));
  assert.deepEqual(modelImagePaths, [
    join(rolloverHostRoot, "frames", "F000001.png"),
    join(rolloverHostRoot, "frames", "F000002.png"),
    join(rolloverHostRoot, "frames", "F000003.png"),
    join(rolloverHostRoot, "frames", "F000004.png"),
  ]);
  assert.equal(new Set(modelImagePaths).size, 4);
  assert.equal(new Set(modelOutputPaths).size, 4);
  assert.equal(new Set(rolloverSpawn.records.map((record) => record.stdin)).size, 4);
  assert.equal(rolloverSpawn.records[0].stdin.includes("F000001"), true);
  assert.equal(rolloverSpawn.records[1].stdin.includes("F000002"), true);
  assert.equal(rolloverSpawn.records[2].stdin.includes("F000003"), true);
  assert.equal(rolloverSpawn.records[3].stdin.includes("F000004"), true);

  const rolloverRunnerCalls = (name) =>
    rolloverRunner.calls.filter((call) => call.name === name);
  assert.equal(rolloverRunnerCalls("observe").length, 1);
  assert.equal(rolloverRunnerCalls("waitFrame").length, 3);
  assert.equal(rolloverRunnerCalls("tapKey").length, 3);
  assert.deepEqual(
    rolloverRunnerCalls("tapKey").map((call) => call.argument.code),
    ["Enter", "ArrowDown", "Enter"],
  );
  assert.deepEqual(
    rolloverRunnerCalls("tapKey").map((call) => call.argument.expectedFrameId),
    ["F000001", "F000002", "F000003"],
  );
  assert.equal(new Set(rolloverRunnerCalls("tapKey").map((call) =>
    call.argument.requestId)).size, 3);
  assert.equal(rolloverRunnerCalls("requestEnd").length, 1);
  assert.equal(rolloverRunnerCalls("sealHandoff").length, 1);

  const rolloverRecords = readFileSync(join(rolloverHostRoot, "driver.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line));
  const rolloverAuthorizationIndexes = rolloverRecords
    .map((entry, index) => entry.type === "model_rollover_authorized" ? index : -1)
    .filter((index) => index !== -1);
  assert.equal(rolloverAuthorizationIndexes.length, 2);
  for (const [index, authorizationIndex] of rolloverAuthorizationIndexes.entries()) {
    const ordinal = index + 1;
    const receiptIndex = authorizationIndex + 1;
    const servedIndex = authorizationIndex + 2;
    const usageIndex = authorizationIndex + 3;
    const decisionIndex = authorizationIndex + 4;
    const validatedIndex = authorizationIndex + 5;
    const authorization = rolloverRecords[authorizationIndex];
    const receipt = rolloverRecords[receiptIndex];
    const served = rolloverRecords[servedIndex];
    const usage = rolloverRecords[usageIndex];
    const decision = rolloverRecords[decisionIndex];
    const validated = rolloverRecords[validatedIndex];
    const frameId = `F${String(ordinal + 1).padStart(6, "0")}`;
    assert.deepEqual(
      Object.fromEntries(Object.entries(authorization).filter(([key]) =>
        !["seq", "at", "type"].includes(key))),
      {
        completedTurn: ordinal,
        nextTurn: ordinal + 1,
        rolloverOrdinal: ordinal,
        inputTokens: 55_000,
        threshold: 55_000,
        frameId,
        frameSha256: authorization.frameSha256,
        keyAttemptsAtStart: ordinal,
      },
    );
    assert.deepEqual(
      Object.fromEntries(Object.entries(receipt).filter(([key]) =>
        !["seq", "at", "type"].includes(key))),
      { rolloverOrdinal: ordinal, sessionGeneration: ordinal, nextInvocation: "EXEC" },
    );
    assert.equal(served.type, "frame_served");
    assert.equal(served.frameId, frameId);
    assert.equal(served.sha256, authorization.frameSha256);
    assert.equal(usage.type, "model_turn_usage");
    assert.equal(usage.turn, ordinal + 1);
    assert.equal(decision.type, "decision");
    assert.equal(decision.frameId, frameId);
    assert.deepEqual(
      Object.fromEntries(Object.entries(validated).filter(([key]) =>
        !["seq", "at", "type"].includes(key))),
      {
        rolloverOrdinal: ordinal,
        sessionGeneration: ordinal,
        turn: ordinal + 1,
        frameId,
        frameSha256: authorization.frameSha256,
      },
    );
    assert.equal(modelImagePaths[ordinal], join(rolloverHostRoot, "frames", `${frameId}.png`));
    assert.equal(
      createHash("sha256").update(readFileSync(modelImagePaths[ordinal])).digest("hex"),
      authorization.frameSha256,
    );
  }
  assert.deepEqual(
    rolloverRecords.filter((entry) => entry.type === "frame_served")
      .map((entry) => entry.frameId),
    ["F000001", "F000002", "F000003", "F000004"],
  );
  assert.equal(rolloverRecords.filter((entry) =>
    entry.type === "model_rollover_authorized").length, 2);
  assert.equal(rolloverRecords.filter((entry) =>
    entry.type === "model_session_rotated").length, 2);
  assert.equal(rolloverRecords.filter((entry) =>
    entry.type === "model_rollover_validated").length, 2);
  assert.equal(rolloverRecords.filter((entry) => entry.type === "tap_receipt").length, 3);

  console.log("vision_host_integration: normal, recovery, schema quarantine, and real-port 2x 55K rollover endurance lifecycles passed");
} finally {
  const canonical = realpathSync(temporaryRoot);
  const canonicalTemp = realpathSync(tmpdir());
  assert.equal(canonical.startsWith(canonicalTemp + sep), true);
  assert.equal(canonical.includes("atlas-vision-integration-"), true);
  rmSync(canonical, { recursive: true, force: true });
}
