import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ROLLOVER_ENDURANCE_PROFILE,
  createEnduranceSummary,
  createRunnerEnvironment,
  createCampaignAccounting,
  createUsageRecord,
  createVisionPolicy,
  explorationTrackForKnowledgeContext,
  findCodexExecutable,
  loadKnowledgeContext,
  main,
  parseCommandLine,
  runVisionSegment,
  visionArmDelay,
  writeUsageRecord,
} from "./run-codex-player.mjs";

assert.deepEqual(parseCommandLine([]), { help: false, confirmed: false });
assert.deepEqual(parseCommandLine(["--confirm-openai-upload"]), { help: false, confirmed: true });
assert.deepEqual(parseCommandLine(["--help"]), { help: true, confirmed: false });
assert.deepEqual(
  parseCommandLine(["--confirm-openai-upload", "--long-run"]),
  { help: false, confirmed: true, longRun: true },
);
assert.deepEqual(
  parseCommandLine(["--long-run", "--confirm-openai-upload"]),
  { help: false, confirmed: true, longRun: true },
);
assert.deepEqual(parseCommandLine(["--long-run"]), { help: false, confirmed: false, longRun: true });
assert.throws(() => parseCommandLine(["--confirm-openai-upload", "--confirm-openai-upload"]), { code: "COMMAND_LINE_INVALID" });
assert.throws(() => parseCommandLine(["--long-run", "--long-run"]), { code: "COMMAND_LINE_INVALID" });
assert.throws(() => parseCommandLine(["--other"]), { code: "COMMAND_LINE_INVALID" });
const enduranceResult = {
  executionProfile: ROLLOVER_ENDURANCE_PROFILE,
  primaryScoreEligible: false,
  rolloverEndurance: {
    thresholdInputTokens: 55_000,
    target: 2,
    completed: 2,
    validated: 2,
    requirementMet: true,
    status: "PASS",
  },
};
assert.deepEqual(createEnduranceSummary({ confirmed: true }, enduranceResult), {});
assert.deepEqual(createEnduranceSummary({ confirmed: true, longRun: true }, enduranceResult), enduranceResult);
assert.equal(visionArmDelay({}), 5000);
assert.equal(visionArmDelay({ ATLAS_VISION_ARM_DELAY_MS: "0" }), 0);
assert.throws(() => visionArmDelay({ ATLAS_VISION_ARM_DELAY_MS: "30001" }), { code: "ARM_DELAY_INVALID" });
assert.deepEqual(createVisionPolicy({}), {});
assert.deepEqual(createVisionPolicy({
  ATLAS_VISION_MAX_TURNS: "5",
  ATLAS_VISION_MAX_KEYS: "3",
  ATLAS_VISION_MAX_OBSERVATIONS: "8",
  ATLAS_VISION_MAX_ELAPSED_MS: "300000",
  ATLAS_VISION_MODEL_RESTARTS: "0",
  ATLAS_VISION_MODEL_SESSION_INPUT_TOKENS: "50000",
}), {
  turns: 5,
  keys: 3,
  observations: 8,
  elapsedMs: 300000,
  modelRestarts: 0,
  modelSessionInputTokens: 50000,
});
assert.deepEqual(createVisionPolicy({ ATLAS_VISION_MODEL_RESTARTS: "1" }), { modelRestarts: 1 });
assert.deepEqual(createVisionPolicy({}, ROLLOVER_ENDURANCE_PROFILE), {});
assert.deepEqual(createVisionPolicy({
  ATLAS_VISION_MODEL_RESTARTS: "0",
  ATLAS_VISION_MODEL_SESSION_INPUT_TOKENS: "55000",
}, ROLLOVER_ENDURANCE_PROFILE), {
  modelRestarts: 0,
  modelSessionInputTokens: 55000,
});
for (const candidate of ["0", "1", "50000", "55001", "not-a-number"]) {
  assert.throws(
    () => createVisionPolicy({ ATLAS_VISION_MODEL_SESSION_INPUT_TOKENS: candidate }, ROLLOVER_ENDURANCE_PROFILE),
    { code: "VISION_POLICY_INVALID" },
  );
}
for (const environmentName of [
  "ATLAS_VISION_MAX_TURNS",
  "ATLAS_VISION_MAX_KEYS",
  "ATLAS_VISION_MAX_OBSERVATIONS",
  "ATLAS_VISION_MAX_ELAPSED_MS",
]) {
  assert.throws(
    () => createVisionPolicy({ [environmentName]: "1" }, ROLLOVER_ENDURANCE_PROFILE),
    { code: "LONG_RUN_POLICY_CONFLICT" },
  );
}
assert.throws(() => createVisionPolicy({}, "UNTRUSTED_PROFILE"), /policyProfile is not supported/);
for (const candidate of ["-1", "1.5", "2", "9007199254740992"]) {
  assert.throws(() => createVisionPolicy({ ATLAS_VISION_MODEL_RESTARTS: candidate }), { code: "VISION_POLICY_INVALID" });
}
for (const candidate of ["0", "-1", "1.5", "41", "9007199254740992"]) {
  assert.throws(() => createVisionPolicy({ ATLAS_VISION_MAX_TURNS: candidate }), { code: "VISION_POLICY_INVALID" });
}
assert.deepEqual(
  createVisionPolicy({ ATLAS_VISION_MODEL_SESSION_INPUT_TOKENS: "0" }),
  { modelSessionInputTokens: 0 },
);
assert.deepEqual(
  createVisionPolicy({ ATLAS_VISION_MODEL_SESSION_INPUT_TOKENS: "55000" }),
  { modelSessionInputTokens: 55000 },
);
for (const candidate of ["-1", "1.5", "55001", "9007199254740992"]) {
  assert.throws(
    () => createVisionPolicy({ ATLAS_VISION_MODEL_SESSION_INPUT_TOKENS: candidate }),
    { code: "VISION_POLICY_INVALID" },
  );
}

const usageRecord = createUsageRecord({
  semantics: "TURN_DELTA",
  completeness: "PARTIAL",
  reportedTurns: 2,
  missingTurns: 1,
  knownTotals: {
    inputTokens: 125,
    cachedInputTokens: 25,
    outputTokens: 7,
    totalTokens: 132,
  },
});
assert.deepEqual(usageRecord, {
  schemaVersion: "atlas/vision-model-usage/1",
  tokens: {
    semantics: "TURN_DELTA",
    completeness: "PARTIAL",
    reportedTurns: 2,
    missingTurns: 1,
    knownTotals: {
      inputTokens: 125,
      cachedInputTokens: 25,
      outputTokens: 7,
      totalTokens: 132,
    },
  },
  monetaryCost: {
    status: "UNAVAILABLE",
    actualChargedAmount: null,
    estimatedAmount: null,
    currency: null,
    reason: "MONETARY_COST_NOT_REPORTED_BY_CODEX_CLI",
  },
});
assert.throws(() => createUsageRecord({
  ...usageRecord.tokens,
  completeness: "COMPLETE",
}), /completeness is inconsistent/);
assert.throws(() => createUsageRecord({
  ...usageRecord.tokens,
  knownTotals: { ...usageRecord.tokens.knownTotals, totalTokens: 157 },
}), /relationships are invalid/);
assert.throws(() => createUsageRecord({
  ...usageRecord.tokens,
  knownTotals: { ...usageRecord.tokens.knownTotals, billedCost: 1 },
}), /bounded token schema/);
assert.deepEqual(createUsageRecord({
  semantics: "TURN_DELTA",
  completeness: "UNKNOWN",
  reportedTurns: 0,
  missingTurns: 1,
  knownTotals: null,
}).tokens.knownTotals, null);

const runnerEnvironment = createRunnerEnvironment({
  SYSTEMROOT: "C:\\Windows",
  PATH: "safe-path",
  ATLAS_TARGET_HWND: "1234",
  OPENAI_API_KEY: "API_CANARY",
  CODEX_API_KEY: "CODEX_CANARY",
  UNRELATED_SECRET: "OTHER_CANARY",
  ATLAS_EXPLORATION_TRACK: "ASSISTED_EXPLORATION",
  ATLAS_RUNNER_PROFILE: "UNTRUSTED_PROFILE",
}, {
  ATLAS_RUNNER_BOOTSTRAP: "trusted-bootstrap",
  ATLAS_LAUNCH_TICKET: "trusted-ticket",
  ATLAS_RUNNER_STATE_DIR: "trusted-state",
  ATLAS_EXPLORATION_TRACK: "EXPLORATION",
  ATLAS_RUNNER_PROFILE: ROLLOVER_ENDURANCE_PROFILE,
});
assert.equal(runnerEnvironment.ATLAS_TARGET_HWND, "1234");
assert.equal(runnerEnvironment.ATLAS_LAUNCH_TICKET, "trusted-ticket");
assert.equal(runnerEnvironment.ATLAS_EXPLORATION_TRACK, "EXPLORATION");
assert.equal(runnerEnvironment.ATLAS_RUNNER_PROFILE, ROLLOVER_ENDURANCE_PROFILE);
assert.equal(Object.values(runnerEnvironment).some((value) => String(value).includes("CANARY")), false);
const defaultRunnerEnvironment = createRunnerEnvironment({
  PATH: "safe-path",
  ATLAS_RUNNER_PROFILE: ROLLOVER_ENDURANCE_PROFILE,
}, {
  ATLAS_RUNNER_BOOTSTRAP: "trusted-bootstrap",
  ATLAS_LAUNCH_TICKET: "trusted-ticket",
  ATLAS_RUNNER_STATE_DIR: "trusted-state",
  ATLAS_EXPLORATION_TRACK: "EXPLORATION",
});
assert.equal(Object.hasOwn(defaultRunnerEnvironment, "ATLAS_RUNNER_PROFILE"), false);
assert.equal(explorationTrackForKnowledgeContext(undefined), "EXPLORATION");
assert.equal(explorationTrackForKnowledgeContext({ track: "ASSISTED" }), "ASSISTED_EXPLORATION");

const temporaryRoot = mkdtempSync(join(tmpdir(), "atlas-vision-cli-"));
try {
  const executable = join(temporaryRoot, "codex.exe");
  writeFileSync(executable, "fixture", { flag: "wx" });
  assert.equal(findCodexExecutable({ ATLAS_CODEX_EXE: executable }), executable);
  assert.throws(() => findCodexExecutable({ ATLAS_CODEX_EXE: join(temporaryRoot, "missing.exe") }), { code: "CODEX_NOT_FOUND" });
  const usageFile = join(temporaryRoot, "usage.json");
  assert.deepEqual(writeUsageRecord(usageFile, usageRecord.tokens), usageRecord);
  assert.deepEqual(JSON.parse(readFileSync(usageFile, "utf8")), usageRecord);
  assert.throws(() => writeUsageRecord(usageFile, usageRecord.tokens), { code: "EEXIST" });
  const contextFile = join(temporaryRoot, "player-context.json");
  const context = {
    schemaVersion: "atlas/player-knowledge-context/1",
    track: "ASSISTED",
    revision: 3,
    guidance: [{ kind: "FACT", title: "Gate", body: "The gate was closed." }],
  };
  writeFileSync(contextFile, JSON.stringify(context), { flag: "wx" });
  const loadedContext = loadKnowledgeContext({ ATLAS_WIKI_CONTEXT_FILE: contextFile });
  assert.deepEqual(loadedContext, context);
  assert.ok(Object.isFrozen(loadedContext));
  assert.equal(loadKnowledgeContext({}), undefined);
  assert.throws(
    () => loadKnowledgeContext({ ATLAS_WIKI_CONTEXT_FILE: join(temporaryRoot, "missing.json") }),
    { code: "KNOWLEDGE_CONTEXT_INVALID" },
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

const segmentRoot = mkdtempSync(join(tmpdir(), "atlas-vision-segment-"));
try {
  const source = {
    ATLAS_TARGET_HWND: "1234",
    ATLAS_VISION_STATE_DIR: segmentRoot,
    PATH: "safe-path",
  };
  const knowledgeContext = {
    schemaVersion: "atlas/player-knowledge-context/1",
    track: "ASSISTED",
    revision: 4,
    guidance: [{ kind: "FACT", title: "Gate", body: "The gate was closed." }],
  };
  const checkpointPolicy = {
    modelInputTokens: 1000,
    keyAttempts: 3,
    frames: 4,
    onMissingUsage: true,
  };
  const usage = {
    semantics: "TURN_DELTA",
    completeness: "COMPLETE",
    reportedTurns: 2,
    missingTurns: 0,
    knownTotals: {
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 10,
      totalTokens: 110,
    },
  };
  const checkpointResult = {
    status: "SEALED",
    reason: "PARTIAL",
    failures: 0,
    usage,
    continuation: {
      schemaVersion: "atlas/vision-checkpoint-continuation/1",
      status: "CHECKPOINT_REQUIRED",
      causes: ["KEY_ATTEMPTS"],
      boundary: {
        completedTurns: 2,
        keyAttempts: 3,
        observations: 4,
        modelSessionGeneration: 0,
        frameId: "F000004",
        frameSha256: "a".repeat(64),
        knowledgeRevision: 4,
        knowledgeContextSha256: "b".repeat(64),
      },
      sealDigests: ["c".repeat(64)],
    },
  };
  const terminalResult = {
    status: "SEALED",
    reason: "COMPLETE",
    failures: 0,
    usage: {
      ...usage,
      reportedTurns: 3,
      knownTotals: { inputTokens: 150, cachedInputTokens: 30, outputTokens: 15, totalTokens: 165 },
    },
  };
  const ids = ["host-one", "launch-one", "host-two", "launch-two"];
  const times = [100, 125, 200, 213];
  const models = [];
  const runners = [];
  const supervisorOptions = [];
  const results = [checkpointResult, terminalResult];
  const measurements = [
    { turns: 2, keys: 3, observations: 4 },
    { turns: 3, keys: 1, observations: 5 },
  ];
  const delays = [];
  const dependencies = {
    randomUUID: () => ids.shift(),
    clock: () => times.shift(),
    wait: async (milliseconds) => { delays.push(milliseconds); },
    findCodexExecutable: () => "codex-fixture",
    requireCodexLogin: () => {},
    createModel: (options) => {
      assert.deepEqual(Object.keys(options).sort(), ["env", "executablePath"]);
      const model = { env: {}, cancelled: 0, cancel() { this.cancelled += 1; } };
      models.push(model);
      return model;
    },
    startRunner: async () => {
      const runner = { closed: 0, async close() { this.closed += 1; } };
      runners.push(runner);
      return runner;
    },
    createSupervisor: (options) => {
      supervisorOptions.push(options);
      const index = supervisorOptions.length - 1;
      mkdirSync(options.workdir, { recursive: true });
      return {
        usage: measurements[index],
        async run({ launchTicket }) {
          assert.equal(launchTicket, index === 0 ? "launch-one" : "launch-two");
          return results[index];
        },
      };
    },
  };

  let unexpectedOutput = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { unexpectedOutput += String(chunk); return true; };
  let checkpointSegment;
  let terminalSegment;
  try {
    checkpointSegment = await runVisionSegment({
      source,
      openAIImageUploadConfirmed: true,
      knowledgeContext,
      policy: { turns: 5, keys: 4, observations: 6, elapsedMs: 1000 },
      checkpointPolicy,
      armDelayMs: 7,
    }, dependencies);
    terminalSegment = await runVisionSegment({
      source,
      openAIImageUploadConfirmed: true,
      policy: { turns: 5 },
      armDelayMs: 0,
    }, dependencies);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(unexpectedOutput, "");
  assert.equal(checkpointSegment.supervisorResult, checkpointResult);
  assert.equal(terminalSegment.supervisorResult, terminalResult);
  assert.deepEqual(checkpointSegment.accounting, { turns: 2, keyAttempts: 3, frames: 4, elapsedMs: 25 });
  assert.deepEqual(terminalSegment.accounting, { turns: 3, keyAttempts: 1, frames: 5, elapsedMs: 13 });
  assert.deepEqual(delays, [7]);
  assert.equal(models.length, 2);
  assert.equal(runners.length, 2);
  assert.ok(models.every(({ cancelled }) => cancelled === 1));
  assert.ok(runners.every(({ closed }) => closed === 1));
  assert.notEqual(supervisorOptions[0].runner, supervisorOptions[1].runner);
  assert.notEqual(supervisorOptions[0].model, supervisorOptions[1].model);
  assert.deepEqual(supervisorOptions[0].checkpointPolicy, checkpointPolicy);
  assert.ok(Object.isFrozen(supervisorOptions[0].knowledgeContext));
  assert.equal(checkpointSegment.runDirectory, join(segmentRoot, "host-one"));
  assert.equal(checkpointSegment.hostRunId, "host-one");
  assert.equal(checkpointSegment.explorationTrack, "ASSISTED_EXPLORATION");
  assert.equal(terminalSegment.explorationTrack, "EXPLORATION");
  assert.deepEqual(JSON.parse(readFileSync(join(checkpointSegment.runDirectory, "operator-consent.json"), "utf8")), {
    schemaVersion: "atlas/vision-agent-operator-consent/1",
    hostRunId: "host-one",
    openAIImageUploadConfirmed: true,
    confirmedAt: JSON.parse(readFileSync(join(checkpointSegment.runDirectory, "operator-consent.json"), "utf8")).confirmedAt,
  });
  assert.throws(
    () => createCampaignAccounting(checkpointResult, { turns: 1, keys: 3, observations: 4 }, 10),
    { code: "SEGMENT_ACCOUNTING_INVALID" },
  );
  await assert.rejects(
    () => runVisionSegment({
      source,
      openAIImageUploadConfirmed: false,
      policy: {},
      armDelayMs: 0,
    }, dependencies),
    { code: "REMOTE_UPLOAD_NOT_CONFIRMED" },
  );
  await assert.rejects(
    () => runVisionSegment({
      source,
      openAIImageUploadConfirmed: true,
      policy: {},
      checkpointPolicy: { ...checkpointPolicy, onMissingUsage: "yes" },
      armDelayMs: 0,
    }, dependencies),
    /must be a boolean/u,
  );
  await assert.rejects(
    () => runVisionSegment({
      source,
      openAIImageUploadConfirmed: true,
      policy: {},
      armDelayMs: 0,
      modelPath: "model-chosen",
    }, dependencies),
    /unknown field/u,
  );
} finally {
  rmSync(segmentRoot, { recursive: true, force: true });
}

const mainRoot = mkdtempSync(join(tmpdir(), "atlas-vision-main-"));
try {
  const source = {
    ATLAS_TARGET_HWND: "4321",
    ATLAS_VISION_STATE_DIR: mainRoot,
    ATLAS_VISION_ARM_DELAY_MS: "0",
    PATH: "safe-path",
  };
  const result = {
    status: "SEALED",
    reason: "COMPLETE",
    failures: 0,
    usage: {
      semantics: "TURN_DELTA",
      completeness: "COMPLETE",
      reportedTurns: 1,
      missingTurns: 0,
      knownTotals: { inputTokens: 20, cachedInputTokens: 5, outputTokens: 3, totalTokens: 23 },
    },
  };
  const model = { env: {}, cancelled: 0, cancel() { this.cancelled += 1; } };
  const runner = { closed: 0, async close() { this.closed += 1; } };
  const ids = ["host-main", "launch-main"];
  const times = [10, 20];
  const dependencies = {
    randomUUID: () => ids.shift(),
    clock: () => times.shift(),
    wait: async () => {},
    findCodexExecutable: () => "codex-fixture",
    requireCodexLogin: () => {},
    createModel: () => model,
    startRunner: async () => runner,
    createSupervisor: (options) => {
      mkdirSync(options.workdir, { recursive: true });
      return {
        usage: { turns: 1, keys: 0, observations: 1 },
        async run() { return result; },
      };
    },
  };
  let printed = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { printed += String(chunk); return true; };
  let summary;
  try {
    summary = await main(["--confirm-openai-upload"], source, dependencies);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.deepEqual(Object.keys(summary).sort(), [
    "explorationTrack",
    "failures",
    "hostRunId",
    "knowledgeContext",
    "monetaryCost",
    "outputDirectory",
    "reason",
    "remoteImageUpload",
    "status",
    "usage",
    "usageFile",
    "usageRecord",
  ].sort());
  assert.equal(summary.hostRunId, "host-main");
  assert.equal(summary.outputDirectory, join(mainRoot, "host-main"));
  assert.deepEqual(summary.knowledgeContext, { status: "NONE" });
  assert.equal(printed, `${JSON.stringify(summary, null, 2)}\n`);
  assert.equal(model.cancelled, 1);
  assert.equal(runner.closed, 1);
} finally {
  rmSync(mainRoot, { recursive: true, force: true });
}

console.log("verify-vision-cli: offline consent and environment checks passed");
