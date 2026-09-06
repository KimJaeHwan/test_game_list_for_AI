import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentLoopSupervisor, PlayerRunnerStdioClient, validateKnowledgeContext } from "../../05_vision_agent_host/src/index.mjs";
import {
  ASSISTED_WIKI_SCHEMA_VERSION,
  buildAssistedWikiSnapshot,
} from "../../06_assisted_wiki_loop/src/core/index.mjs";
import { buildWikiRevision, parseWikiBuilderCommandLine } from "./build-wiki.mjs";
import { loadVisionRunForWiki } from "./vision-run-ingress.mjs";

const temporaryRoot = mkdtempSync(path.join(tmpdir(), "atlas-assisted-wiki-integration-"));
const campaignRoot = path.join(temporaryRoot, "campaign");
const bootstrapPath = path.resolve("integration/assisted_wiki_loop/synthetic-bootstrap.mjs");
const runnerEntry = path.resolve("01_player_runner/src/stdio-server.mjs");

function childEnvironment(runnerRoot, launchTicket, explorationTrack, extendedRun = false) {
  const allowed = ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP"];
  const env = Object.fromEntries(allowed.flatMap((name) => typeof process.env[name] === "string" ? [[name, process.env[name]]] : []));
  return {
    ...env,
    ATLAS_RUNNER_BOOTSTRAP: bootstrapPath,
    ATLAS_LAUNCH_TICKET: launchTicket,
    ATLAS_WIKI_INTEGRATION_RUNNER_ROOT: runnerRoot,
    ATLAS_EXPLORATION_TRACK: explorationTrack,
    ...(extendedRun ? { ATLAS_WIKI_INTEGRATION_EXTENDED_RUN: "1" } : {}),
  };
}

async function createSealedRun({
  assisted = false,
  explorationTrack,
  modelFailure = false,
  modelQuiescent = false,
  restartSuccess = false,
  retryFailure = false,
  modelRollover = false,
  rolloverFailureCount = 0,
  terminalFailureAfterSuccessTurns = null,
  rolloverAfterRestart = false,
  extendedTurnCount = null,
} = {}) {
  const hostRunId = randomUUID();
  const runRoot = path.join(temporaryRoot, hostRunId);
  const runnerRoot = path.join(runRoot, "runner");
  const hostRoot = path.join(runRoot, "host");
  const launchTicket = randomUUID();
  mkdirSync(runRoot, { recursive: false });
  writeFileSync(path.join(runRoot, "operator-consent.json"), `${JSON.stringify({
    schemaVersion: "atlas/vision-agent-operator-consent/1",
    hostRunId,
    openAIImageUploadConfirmed: true,
    confirmedAt: new Date().toISOString(),
  }, null, 2)}\n`, { flag: "wx" });
  const runner = await PlayerRunnerStdioClient.start({
    executable: process.execPath,
    args: [runnerEntry],
    env: childEnvironment(
      runnerRoot,
      launchTicket,
      explorationTrack ?? (assisted ? "ASSISTED_EXPLORATION" : "EXPLORATION"),
      extendedTurnCount !== null,
    ),
    requestTimeoutMs: 5_000,
    closeGraceMs: 2_000,
  });
  const knowledgeContext = assisted ? {
    schemaVersion: "atlas/player-knowledge-context/1",
    track: "ASSISTED",
    revision: 1,
    guidance: [{ kind: "FACT", title: "Prior route", body: "A route marker was previously observed." }],
  } : undefined;
  const supervisor = new AgentLoopSupervisor({
    runner,
    model: new PlayerModel({
      modelFailure,
      modelQuiescent,
      restartSuccess,
      retryFailure,
      modelRollover,
      rolloverFailureCount,
      terminalFailureAfterSuccessTurns,
      rolloverAfterRestart,
      extendedTurnCount,
    }),
    workdir: hostRoot,
    idFactory: randomUUID,
    knowledgeContext,
    policyProfile: extendedTurnCount === null ? "DEFAULT" : "ROLLOVER_ENDURANCE_2X",
    policy: modelRollover || rolloverAfterRestart
      ? { modelSessionInputTokens: 55_000 }
      : modelFailure && modelQuiescent && !restartSuccess
        ? { modelRestarts: 0 }
        : undefined,
  });
  const result = await supervisor.run({ launchTicket });
  assert.equal(
    result.status,
    modelFailure && !modelQuiescent ? "QUARANTINED" : "SEALED",
    JSON.stringify(result),
  );
  assert.equal(result.reason, "PARTIAL");
  const terminalModelFailure =
    (modelFailure && (!restartSuccess || retryFailure)) ||
    rolloverFailureCount === 2 ||
    terminalFailureAfterSuccessTurns !== null;
  if (terminalModelFailure) {
    assert.equal(result.stopCode, "MODEL_TURN_FAILED");
  } else {
    assert.equal(Object.prototype.hasOwnProperty.call(result, "stopCode"), false);
  }
  return { runRoot, runnerRoot, result };
}

class PlayerModel {
  constructor({
    modelFailure = false,
    modelQuiescent = false,
    restartSuccess = false,
    retryFailure = false,
    modelRollover = false,
    rolloverFailureCount = 0,
    terminalFailureAfterSuccessTurns = null,
    rolloverAfterRestart = false,
    extendedTurnCount = null,
  } = {}) {
    this.turn = 0;
    this.modelFailure = modelFailure;
    this.modelQuiescent = modelQuiescent;
    this.restartSuccess = restartSuccess;
    this.retryFailure = retryFailure;
    this.modelRollover = modelRollover;
    this.rolloverFailureCount = rolloverFailureCount;
    this.terminalFailureAfterSuccessTurns = terminalFailureAfterSuccessTurns;
    this.rolloverAfterRestart = rolloverAfterRestart;
    this.extendedTurnCount = extendedTurnCount;
    this.sessionGeneration = 0;
  }

  isQuiescent() {
    return (this.modelFailure && this.modelQuiescent) ||
      this.modelRollover ||
      this.rolloverAfterRestart;
  }

  async decide() {
    this.turn += 1;
    if (this.extendedTurnCount !== null) {
      if (this.turn === this.extendedTurnCount) {
        return { action: "finish", reason: "PARTIAL" };
      }
      return this.turn % 4 === 0
        ? {
            action: "bookmark",
            frameIds: [`F${String(this.turn).padStart(6, "0")}`],
          }
        : { action: "press_key", code: "Enter" };
    }
    if (this.modelRollover) {
      if (this.turn === 1) {
        return {
          action: { action: "press_key", code: "Enter" },
          usage: { inputTokens: 55_000, cachedInputTokens: 50_000, outputTokens: 10 },
        };
      }
      if (this.turn <= this.rolloverFailureCount + 1) {
        const error = new Error("synthetic post-rollover model failure");
        error.code = "MODEL_TURN_FAILED";
        throw error;
      }
      if (
        this.rolloverFailureCount === 1 &&
        this.terminalFailureAfterSuccessTurns !== null
      ) {
        const terminalTurn = 4 + this.terminalFailureAfterSuccessTurns;
        if (this.turn === terminalTurn) {
          const error = new Error("synthetic delayed post-rollover model failure");
          error.code = "MODEL_TURN_FAILED";
          throw error;
        }
        if (this.turn < terminalTurn) {
          return {
            action: { action: "press_key", code: "Enter" },
            usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 5 },
          };
        }
      }
      return {
        action: { action: "finish", reason: "PARTIAL" },
        usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 5 },
      };
    }
    if (
      this.modelFailure &&
      (this.turn === 15 || (this.retryFailure && this.turn === 16))
    ) {
      const error = new Error("synthetic model failure");
      error.code = "MODEL_TURN_FAILED";
      throw error;
    }
    if (
      this.modelFailure &&
      this.terminalFailureAfterSuccessTurns !== null
    ) {
      const terminalTurn = 17 + this.terminalFailureAfterSuccessTurns;
      if (this.turn === terminalTurn) {
        const error = new Error("synthetic delayed model failure");
        error.code = "MODEL_TURN_FAILED";
        throw error;
      }
      if (this.turn < terminalTurn && this.turn >= 16) {
        return {
          action: { action: "press_key", code: "Enter" },
          ...(this.rolloverAfterRestart && this.turn === 16
            ? {
                usage: {
                  inputTokens: 55_000,
                  cachedInputTokens: 50_000,
                  outputTokens: 10,
                },
              }
            : {}),
        };
      }
    }
    return this.turn <= 14
      ? { action: "press_key", code: "Enter" }
      : { action: "finish", reason: "PARTIAL" };
  }

  resetSession() {
    const expectedFailureTurn = this.modelRollover ? 2 : 15;
    if (!this.restartSuccess || this.turn !== expectedFailureTurn) {
      const error = new Error("synthetic unsafe reset");
      error.code = "MODEL_SESSION_RESET_UNSAFE";
      throw error;
    }
    this.sessionGeneration += 1;
    return Object.freeze({
      status: "RESET",
      nextInvocation: "EXEC",
      sessionGeneration: this.sessionGeneration,
    });
  }

  rotateSession() {
    const initialRollover = this.modelRollover && this.turn === 1;
    const postRestartRollover = this.rolloverAfterRestart && this.turn === 16;
    if (!initialRollover && !postRestartRollover) {
      const error = new Error("synthetic unsafe rotation");
      error.code = "MODEL_SESSION_ROTATION_UNSAFE";
      throw error;
    }
    this.sessionGeneration += 1;
    return Object.freeze({
      status: "ROTATED",
      nextInvocation: "EXEC",
      sessionGeneration: this.sessionGeneration,
    });
  }
}

function cloneRun(run, variant) {
  const parent = path.join(temporaryRoot, "variants", variant);
  mkdirSync(parent, { recursive: true });
  const runRoot = path.join(parent, path.basename(run.runRoot));
  cpSync(run.runRoot, runRoot, { recursive: true, errorOnExist: true });
  return { runRoot, runnerRoot: path.join(runRoot, "runner") };
}

function rewriteJournal(run, mutate) {
  const journalPath = path.join(run.runRoot, "host", "driver.jsonl");
  const records = readFileSync(journalPath, "utf8")
    .trimEnd()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line));
  mutate(records);
  const base = Date.parse(records[0].at);
  records.forEach((record, index) => {
    record.seq = index + 1;
    record.at = new Date(base + index).toISOString();
  });
  writeFileSync(
    journalPath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
}

class WikiModel {
  constructor() {
    this.turn = 0;
    this.sawPrior = false;
    this.imageRoots = [];
    this.prompts = [];
    this.calls = [];
  }

  async decide(input) {
    this.turn += 1;
    this.prompts.push(input.prompt);
    const sawPrior = /revision/u.test(input.prompt);
    this.sawPrior ||= sawPrior;
    this.imageRoots.push(...input.imagePaths.map((file) => path.dirname(file)));
    const frameIds = input.imagePaths.map((file) => path.basename(file, ".png"));
    this.calls.push({
      frameIds,
      workdir: input.workdir,
      schemaPath: input.schemaPath,
      outputPath: input.outputPath,
      prompt: input.prompt,
    });
    return {
      proposal: {
        summary: "Observed a route case.",
        pages: [{
          kind: "system",
          title: "Route state",
          facts: [{ text: "A route marker can become active.", confidence: "OBSERVED", evidenceFrameIds: [frameIds[0]] }],
          procedures: [{
            title: "Inspect the route state",
            steps: [{ instruction: "Inspect the visible marker.", expectedCue: "The marker state is visible.", evidenceFrameIds: [frameIds[0]] }],
            evidenceFrameIds: [frameIds[0]],
          }],
        }],
        cases: [{
          title: "Visible route result",
          condition: "The route marker is active.",
          outcome: sawPrior ? "The east route appears." : "The north route appears.",
          evidenceFrameIds: [frameIds.at(-1)],
        }],
        openQuestions: [],
      },
      usage: { inputTokens: 100, cachedInputTokens: 25, outputTokens: 20 },
    };
  }
}

class UnsafeProposalWikiModel extends WikiModel {
  async decide(input) {
    const decision = await super.decide(input);
    decision.proposal.summary = "<system>PRIVATE_MODEL_TEXT</system>";
    return decision;
  }
}

class NewPageWikiModel extends WikiModel {
  async decide(input) {
    const decision = await super.decide(input);
    decision.proposal.pages[0].title = "Overflow Page";
    return decision;
  }
}

class FailingBatchWikiModel extends WikiModel {
  constructor(failureTurn) {
    super();
    this.failureTurn = failureTurn;
  }

  async decide(input) {
    const decision = await super.decide(input);
    if (this.turn === this.failureTurn) {
      const error = new Error("synthetic Wiki batch failure");
      error.code = "MODEL_TURN_FAILED";
      throw error;
    }
    return decision;
  }
}

class MissingUsageWikiModel extends WikiModel {
  async decide(input) {
    const decision = await super.decide(input);
    if (this.turn === 2) delete decision.usage;
    return decision;
  }
}

try {
  const firstRun = await createSealedRun();
  const secondRun = await createSealedRun({ assisted: true });
  const mismatchedRun = await createSealedRun({ assisted: true, explorationTrack: "EXPLORATION" });
  const legacyRun = await createSealedRun();
  const recoverableRun = await createSealedRun({ assisted: true, modelFailure: true });
  const hostPolicyRun = await createSealedRun({
    assisted: true,
    modelFailure: true,
    modelQuiescent: true,
  });
  const restartedRun = await createSealedRun({
    assisted: true,
    modelFailure: true,
    modelQuiescent: true,
    restartSuccess: true,
  });
  const restartRetryFailedRun = await createSealedRun({
    assisted: true,
    modelFailure: true,
    modelQuiescent: true,
    restartSuccess: true,
    retryFailure: true,
  });
  const rolloverRun = await createSealedRun({
    assisted: true,
    modelRollover: true,
  });
  const extended65Run = await createSealedRun({
    assisted: true,
    extendedTurnCount: 65,
  });
  const rolloverRetrySuccessRun = await createSealedRun({
    assisted: true,
    restartSuccess: true,
    modelRollover: true,
    rolloverFailureCount: 1,
  });
  const rolloverRetryFailedRun = await createSealedRun({
    assisted: true,
    restartSuccess: true,
    modelRollover: true,
    rolloverFailureCount: 2,
  });
  const delayedTerminalFailureRun = await createSealedRun({
    assisted: true,
    modelFailure: true,
    modelQuiescent: true,
    restartSuccess: true,
    terminalFailureAfterSuccessTurns: 1,
  });
  const rolloverBeforeFailureRun = await createSealedRun({
    assisted: true,
    restartSuccess: true,
    modelRollover: true,
    rolloverFailureCount: 1,
    terminalFailureAfterSuccessTurns: 1,
  });
  const rolloverAfterRestartRun = await createSealedRun({
    assisted: true,
    modelFailure: true,
    modelQuiescent: true,
    restartSuccess: true,
    terminalFailureAfterSuccessTurns: 0,
    rolloverAfterRestart: true,
  });
  const legacyJournalPath = path.join(legacyRun.runRoot, "host", "driver.jsonl");
  const legacyRecords = readFileSync(legacyJournalPath, "utf8").trimEnd().split(/\r?\n/u).map((line) => JSON.parse(line));
  delete legacyRecords.find((entry) => entry.type === "attached").knowledgeContext;
  writeFileSync(legacyJournalPath, `${legacyRecords.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

  const ingress = await loadVisionRunForWiki(firstRun.runRoot);
  assert.equal(ingress.hostStatus, "SEALED");
  assert.equal(ingress.source.status, "PARTIAL");
  assert.equal(ingress.source.explorationTrack, "EXPLORATION");
  assert.equal(ingress.source.availableFrameIds.length, 15);
  assert.equal(ingress.selectedFrameIds.length, 12);
  assert.equal(ingress.verifiedImages.length, 12);
  assert.deepEqual(ingress.analysisBatches.map((batch) => batch.frameIds.length), [12, 3]);
  assert.equal(
    readFileSync(path.join(firstRun.runRoot, "host", "driver.jsonl"), "utf8")
      .includes("model_rollover_validated"),
    false,
  );
  const assistedIngress = await loadVisionRunForWiki(secondRun.runRoot);
  assert.equal(assistedIngress.source.explorationTrack, "ASSISTED_EXPLORATION");
  const extended65Ingress = await loadVisionRunForWiki(extended65Run.runRoot);
  assert.equal(extended65Ingress.source.availableFrameIds.length, 65);
  assert.equal(extended65Ingress.selectedFrameIds.length, 12);
  assert.deepEqual(
    extended65Ingress.analysisBatches.map((batch) => batch.frameIds.length),
    [12, 12, 12, 12, 12, 5],
  );
  assert.deepEqual(
    extended65Ingress.analysisBatches.flatMap((batch) => batch.frameIds),
    extended65Ingress.source.availableFrameIds,
  );
  assert.equal(
    new Set(extended65Ingress.analysisBatches.flatMap((batch) => batch.frameIds)).size,
    65,
  );
  const extended65Model = new WikiModel();
  const extended65Campaign = path.join(temporaryRoot, "extended-65-campaign");
  const extended65Revision = await buildWikiRevision({
    runDirectory: extended65Run.runRoot,
    campaignDirectory: extended65Campaign,
    model: extended65Model,
  });
  assert.equal(extended65Model.turn, 6);
  assert.equal(extended65Revision.revision, 1);
  assert.equal(extended65Revision.selectedFrames, 65);
  assert.equal(extended65Revision.modelCalls, 6);
  assert.deepEqual(extended65Model.calls.map((call) => call.frameIds.length), [12, 12, 12, 12, 12, 5]);
  assert.equal(new Set(extended65Model.calls.map((call) => call.workdir)).size, 6);
  assert.equal(new Set(extended65Model.calls.map((call) => call.schemaPath)).size, 6);
  assert.equal(new Set(extended65Model.calls.map((call) => call.outputPath)).size, 6);
  const extended65Snapshot = JSON.parse(readFileSync(extended65Revision.snapshotFile, "utf8"));
  assert.equal(extended65Snapshot.sources.length, 1);
  assert.equal(extended65Snapshot.revision, 1);

  const failingBatchModel = new FailingBatchWikiModel(3);
  const failingBatchCampaign = path.join(temporaryRoot, "failing-batch-campaign");
  await assert.rejects(
    () => buildWikiRevision({
      runDirectory: extended65Run.runRoot,
      campaignDirectory: failingBatchCampaign,
      model: failingBatchModel,
    }),
    /synthetic Wiki batch failure/u,
  );
  assert.equal(failingBatchModel.turn, 3);
  assert.deepEqual(readdirSync(path.join(failingBatchCampaign, "revisions")), []);
  assert.equal(readdirSync(failingBatchCampaign).some((name) => name.startsWith(".wiki-build-")), false);
  const retryAfterBatchFailure = await buildWikiRevision({
    runDirectory: extended65Run.runRoot,
    campaignDirectory: failingBatchCampaign,
    model: new WikiModel(),
  });
  assert.equal(retryAfterBatchFailure.revision, 1);

  const missingUsageRevision = await buildWikiRevision({
    runDirectory: firstRun.runRoot,
    campaignDirectory: path.join(temporaryRoot, "missing-usage-campaign"),
    model: new MissingUsageWikiModel(),
  });
  const missingUsage = JSON.parse(readFileSync(
    path.join(path.dirname(missingUsageRevision.snapshotFile), "usage.json"),
    "utf8",
  ));
  assert.equal(missingUsage.schemaVersion, "atlas/wiki-model-usage/2");
  assert.deepEqual(missingUsage.tokens, {
    semantics: "TURN_DELTA",
    completeness: "PARTIAL",
    reportedTurns: 1,
    missingTurns: 1,
    knownTotals: {
      inputTokens: 100,
      cachedInputTokens: 25,
      outputTokens: 20,
      totalTokens: 120,
    },
  });
  assert.equal(Object.hasOwn(extended65Revision, "checkpointAck"), false);

  const checkpointCampaign = path.join(temporaryRoot, "checkpoint-campaign");
  const checkpointRequest = Object.freeze({
    idempotencyKey: "wiki-checkpoint-0001",
    baseRevision: 0,
  });
  const checkpointModel = new WikiModel();
  const checkpointRevision = await buildWikiRevision({
    runDirectory: firstRun.runRoot,
    campaignDirectory: checkpointCampaign,
    model: checkpointModel,
    checkpointRequest,
  });
  assert.equal(checkpointModel.turn, 2);
  assert.equal(Object.isFrozen(checkpointRevision.checkpointAck), true);
  assert.deepEqual(
    Object.keys(checkpointRevision.checkpointAck).sort(),
    [
      "baseRevision",
      "idempotencyKey",
      "playerContextSha256",
      "revision",
      "snapshotSha256",
      "sourceArtifactDigest",
    ],
  );
  assert.equal(checkpointRevision.checkpointAck.baseRevision, 0);
  assert.equal(checkpointRevision.checkpointAck.revision, 1);
  assert.equal(checkpointRevision.checkpointAck.idempotencyKey, checkpointRequest.idempotencyKey);
  const checkpointRoot = path.dirname(checkpointRevision.snapshotFile);
  const checkpointAckFile = path.join(checkpointRoot, "checkpoint-ack.json");
  const storedCheckpointAck = JSON.parse(readFileSync(checkpointAckFile, "utf8"));
  assert.equal(storedCheckpointAck.schemaVersion, "atlas/wiki-checkpoint-ack/1");
  assert.equal(
    storedCheckpointAck.snapshotSha256,
    createHash("sha256").update(readFileSync(checkpointRevision.snapshotFile)).digest("hex"),
  );
  assert.equal(
    storedCheckpointAck.playerContextSha256,
    createHash("sha256").update(readFileSync(checkpointRevision.playerContextFile)).digest("hex"),
  );
  const replayCheckpointModel = new WikiModel();
  const replayCheckpoint = await buildWikiRevision({
    runDirectory: firstRun.runRoot,
    campaignDirectory: checkpointCampaign,
    model: replayCheckpointModel,
    checkpointRequest,
  });
  assert.equal(replayCheckpointModel.turn, 0);
  assert.equal(replayCheckpoint.idempotentReplay, true);
  assert.deepEqual(replayCheckpoint.checkpointAck, checkpointRevision.checkpointAck);
  const conflictingCheckpointModel = new WikiModel();
  await assert.rejects(
    () => buildWikiRevision({
      runDirectory: firstRun.runRoot,
      campaignDirectory: checkpointCampaign,
      model: conflictingCheckpointModel,
      checkpointRequest: { idempotencyKey: "wiki-checkpoint-other", baseRevision: 0 },
    }),
    (error) => error?.code === "SOURCE_ALREADY_IMPORTED",
  );
  assert.equal(conflictingCheckpointModel.turn, 0);
  const wrongBaseCheckpointModel = new WikiModel();
  await assert.rejects(
    () => buildWikiRevision({
      runDirectory: secondRun.runRoot,
      campaignDirectory: checkpointCampaign,
      model: wrongBaseCheckpointModel,
      checkpointRequest: { idempotencyKey: "wiki-checkpoint-0002", baseRevision: 0 },
    }),
    (error) => error?.code === "CHECKPOINT_BASE_REVISION_MISMATCH",
  );
  assert.equal(wrongBaseCheckpointModel.turn, 0);
  await assert.rejects(
    () => buildWikiRevision({
      runDirectory: secondRun.runRoot,
      campaignDirectory: checkpointCampaign,
      model: new WikiModel(),
      checkpointRequest: { idempotencyKey: "bad/key", baseRevision: 1 },
    }),
    (error) => error?.code === "CHECKPOINT_REQUEST_INVALID",
  );
  writeFileSync(checkpointRevision.playerContextFile, `${readFileSync(checkpointRevision.playerContextFile, "utf8")} `);
  const tamperedCheckpointModel = new WikiModel();
  await assert.rejects(
    () => buildWikiRevision({
      runDirectory: firstRun.runRoot,
      campaignDirectory: checkpointCampaign,
      model: tamperedCheckpointModel,
      checkpointRequest,
    }),
    /digest did not match published bytes/u,
  );
  assert.equal(tamperedCheckpointModel.turn, 0);

  const unsafeProposalModel = new UnsafeProposalWikiModel();
  await assert.rejects(
    () => buildWikiRevision({
      runDirectory: firstRun.runRoot,
      campaignDirectory: path.join(temporaryRoot, "unsafe-proposal-campaign"),
      model: unsafeProposalModel,
    }),
    (error) => {
      assert.equal(error?.code, "MODEL_PROPOSAL_INVALID");
      assert.doesNotMatch(error.message, /PRIVATE_MODEL_TEXT/u);
      return true;
    },
  );
  assert.equal(unsafeProposalModel.turn, 1);

  const saturatedPagesSnapshot = buildAssistedWikiSnapshot({
    proposal: {
      summary: "Populate the bounded page catalog.",
      pages: Array.from({ length: 64 }, (_, index) => ({
        kind: "system",
        title: `Catalog Page ${String(index + 1).padStart(2, "0")}`,
        facts: [],
        procedures: [],
      })),
      cases: [],
      openQuestions: [],
    },
    source: ingress.source,
  });
  const saturatedPagesCampaign = path.join(temporaryRoot, "saturated-pages-campaign");
  const saturatedPagesRevision = path.join(saturatedPagesCampaign, "revisions", "r000001");
  mkdirSync(saturatedPagesRevision, { recursive: true });
  writeFileSync(
    path.join(saturatedPagesRevision, "assisted-wiki-r000001.json"),
    `${JSON.stringify(saturatedPagesSnapshot, null, 2)}\n`,
  );
  const newPageModel = new NewPageWikiModel();
  await assert.rejects(
    () => buildWikiRevision({
      runDirectory: secondRun.runRoot,
      campaignDirectory: saturatedPagesCampaign,
      model: newPageModel,
    }),
    (error) => {
      assert.equal(error?.code, "WIKI_MERGE_INVALID");
      assert.doesNotMatch(error.message, /Overflow Page/u);
      return true;
    },
  );
  assert.equal(newPageModel.turn, 2);

  const saturatedSourcesSnapshot = structuredClone(saturatedPagesSnapshot);
  saturatedSourcesSnapshot.pages = [];
  saturatedSourcesSnapshot.sources = Array.from({ length: 256 }, (_, index) => ({
    ...structuredClone(ingress.source),
    artifactDigest: createHash("sha256").update(`preflight-source-${index}`).digest("hex"),
  })).sort((left, right) => left.artifactDigest.localeCompare(right.artifactDigest));
  const saturatedSourcesCampaign = path.join(temporaryRoot, "saturated-sources-campaign");
  const saturatedSourcesRevision = path.join(saturatedSourcesCampaign, "revisions", "r000001");
  mkdirSync(saturatedSourcesRevision, { recursive: true });
  writeFileSync(
    path.join(saturatedSourcesRevision, "assisted-wiki-r000001.json"),
    `${JSON.stringify(saturatedSourcesSnapshot, null, 2)}\n`,
  );
  const preflightModel = new WikiModel();
  await assert.rejects(
    () => buildWikiRevision({
      runDirectory: secondRun.runRoot,
      campaignDirectory: saturatedSourcesCampaign,
      model: preflightModel,
    }),
    (error) => {
      assert.equal(error?.code, "WIKI_INPUT_PRECHECK_FAILED");
      return true;
    },
  );
  assert.equal(preflightModel.turn, 0);
  await assert.rejects(
    () => loadVisionRunForWiki(mismatchedRun.runRoot),
    /does not match the Host knowledge receipt/u,
  );
  await assert.rejects(() => loadVisionRunForWiki(legacyRun.runRoot), /knowledge receipt is invalid/u);
  const legacyIngress = await loadVisionRunForWiki(legacyRun.runRoot, { allowLegacyUnattested: true });
  assert.equal(legacyIngress.source.explorationTrack, "EXPLORATION");
  assert.equal(legacyIngress.source.knowledgeAttestation, "LEGACY_OPERATOR_CONFIRMED");
  assert.equal(parseWikiBuilderCommandLine(["--confirm-openai-upload", "--run", firstRun.runRoot]).allowLegacyUnattested, false);
  assert.equal(parseWikiBuilderCommandLine(["--confirm-openai-upload", "--allow-legacy-unattested", "--run", firstRun.runRoot]).allowLegacyUnattested, true);
  assert.equal(
    parseWikiBuilderCommandLine([
      "--confirm-openai-upload",
      "--allow-recoverable-model-failure",
      "--run",
      recoverableRun.runRoot,
    ]).allowRecoverableModelFailure,
    true,
  );
  assert.throws(
    () => parseWikiBuilderCommandLine([
      "--confirm-openai-upload",
      "--allow-legacy-unattested",
      "--allow-recoverable-model-failure",
      "--run",
      recoverableRun.runRoot,
    ]),
    /cannot be combined/u,
  );

  await assert.rejects(
    () => loadVisionRunForWiki(recoverableRun.runRoot),
    /requires explicit operator recovery/u,
  );
  const recoveredIngress = await loadVisionRunForWiki(
    recoverableRun.runRoot,
    { allowRecoverableModelFailure: true },
  );
  assert.equal(recoveredIngress.hostStatus, "QUARANTINED");
  assert.deepEqual(
    {
      terminationKind: recoveredIngress.source.provenance.terminationKind,
      acceptanceBasis: recoveredIngress.source.provenance.acceptanceBasis,
      stopCode: recoveredIngress.source.provenance.stopCode,
      failedTurn: recoveredIngress.source.provenance.failedTurn,
    },
    {
      terminationKind: "MODEL_DECISION_FAILED_NO_ACTION",
      acceptanceBasis: "EXPLICIT_OPERATOR_RECOVERY",
      stopCode: "MODEL_TURN_FAILED",
      failedTurn: 15,
    },
  );
  assert.match(recoveredIngress.source.provenance.journalSha256, /^[a-f0-9]{64}$/u);

  const legacyFailureShape = cloneRun(recoverableRun, "legacy-failure-shape");
  rewriteJournal(legacyFailureShape, (records) => {
    delete records.find((record) => record.type === "model_turn_failed").errorCode;
  });
  const legacyFailureIngress = await loadVisionRunForWiki(
    legacyFailureShape.runRoot,
    { allowRecoverableModelFailure: true },
  );
  assert.equal(legacyFailureIngress.source.provenance.stopCode, "MODEL_TURN_FAILED");

  const diagnosedFailure = cloneRun(recoverableRun, "diagnosed-failure");
  rewriteJournal(diagnosedFailure, (records) => {
    records.find((record) => record.type === "model_turn_failed").codexErrorInfo = {
      category: "HTTP_CONNECTION_FAILED",
      httpStatus: 503,
      retryable: true,
    };
  });
  const diagnosedIngress = await loadVisionRunForWiki(
    diagnosedFailure.runRoot,
    { allowRecoverableModelFailure: true },
  );
  assert.equal(diagnosedIngress.source.provenance.stopCode, "MODEL_TURN_FAILED");

  const validDiagnosticCombinations = [
    { category: "UNAVAILABLE", httpStatus: null, retryable: false },
    { category: "CONTEXT_WINDOW_EXCEEDED", httpStatus: null, retryable: false },
    { category: "SERVER_OVERLOADED", httpStatus: null, retryable: true },
    { category: "INTERNAL_SERVER_ERROR", httpStatus: null, retryable: true },
    { category: "HTTP_CONNECTION_FAILED", httpStatus: 400, retryable: false },
    { category: "RESPONSE_STREAM_DISCONNECTED", httpStatus: null, retryable: true },
    { category: "RESPONSE_TOO_MANY_FAILED_ATTEMPTS", httpStatus: 503, retryable: false },
  ];
  for (const [index, codexErrorInfo] of validDiagnosticCombinations.entries()) {
    const validDiagnostic = cloneRun(recoverableRun, `valid-diagnostic-${index}`);
    rewriteJournal(validDiagnostic, (records) => {
      records.find((record) => record.type === "model_turn_failed").codexErrorInfo = codexErrorInfo;
    });
    const validDiagnosticIngress = await loadVisionRunForWiki(
      validDiagnostic.runRoot,
      { allowRecoverableModelFailure: true },
    );
    assert.equal(validDiagnosticIngress.source.provenance.stopCode, "MODEL_TURN_FAILED");
  }

  const malformedDiagnostics = [
    { category: "HTTP_CONNECTION_FAILED", httpStatus: 503, retryable: true, raw: "secret" },
    { category: "NOT_ALLOWLISTED", httpStatus: null, retryable: false },
    { category: "HTTP_CONNECTION_FAILED", httpStatus: "503", retryable: true },
    { category: "HTTP_CONNECTION_FAILED", httpStatus: 700, retryable: true },
    { category: "UNAVAILABLE", httpStatus: null, retryable: "false" },
    { category: "UNAVAILABLE", httpStatus: null, retryable: true },
    { category: "CONTEXT_WINDOW_EXCEEDED", httpStatus: 400, retryable: false },
    { category: "CONTEXT_WINDOW_EXCEEDED", httpStatus: null, retryable: true },
    { category: "SERVER_OVERLOADED", httpStatus: null, retryable: false },
    { category: "SERVER_OVERLOADED", httpStatus: 503, retryable: true },
    { category: "HTTP_CONNECTION_FAILED", httpStatus: 503, retryable: false },
    { category: "HTTP_CONNECTION_FAILED", httpStatus: 400, retryable: true },
    { category: "RESPONSE_TOO_MANY_FAILED_ATTEMPTS", httpStatus: 503, retryable: true },
  ];
  for (const [index, codexErrorInfo] of malformedDiagnostics.entries()) {
    const malformedDiagnostic = cloneRun(recoverableRun, `malformed-diagnostic-${index}`);
    rewriteJournal(malformedDiagnostic, (records) => {
      records.find((record) => record.type === "model_turn_failed").codexErrorInfo = codexErrorInfo;
    });
    await assert.rejects(
      () => loadVisionRunForWiki(malformedDiagnostic.runRoot, {
        allowRecoverableModelFailure: true,
      }),
      /codex error info|invalid shape/u,
    );
  }

  const recoveryCampaign = path.join(temporaryRoot, "recovery-campaign");
  const rejectedModel = new WikiModel();
  await assert.rejects(
    () => buildWikiRevision({
      runDirectory: recoverableRun.runRoot,
      campaignDirectory: recoveryCampaign,
      model: rejectedModel,
    }),
    /requires explicit operator recovery/u,
  );
  assert.equal(rejectedModel.turn, 0);
  const recoveryModel = new WikiModel();
  const recoveredRevision = await buildWikiRevision({
    runDirectory: recoverableRun.runRoot,
    campaignDirectory: recoveryCampaign,
    model: recoveryModel,
    allowRecoverableModelFailure: true,
  });
  assert.equal(recoveryModel.turn, 2);
  assert.doesNotMatch(
    recoveryModel.prompts[0],
    /QUARANTINED|MODEL_TURN_FAILED|MODEL_DECISION_FAILED_NO_ACTION|EXPLICIT_OPERATOR_RECOVERY|journalSha256/u,
  );
  const recoveredSnapshot = JSON.parse(readFileSync(recoveredRevision.snapshotFile, "utf8"));
  assert.equal(recoveredSnapshot.schemaVersion, ASSISTED_WIKI_SCHEMA_VERSION);
  assert.deepEqual(
    recoveredSnapshot.sources[0].provenance,
    recoveredIngress.source.provenance,
  );
  const recoveredSourceReceipt = JSON.parse(
    readFileSync(path.join(path.dirname(recoveredRevision.snapshotFile), "source.json"), "utf8"),
  );
  assert.equal(recoveredSourceReceipt.schemaVersion, "atlas/assisted-wiki-source/3");
  assert.deepEqual(recoveredSourceReceipt.analysisBatches.map((batch) => batch.frameIds.length), [12, 3]);
  assert.equal(recoveredSourceReceipt.selectedFrameIds.length, 15);
  assert.deepEqual(recoveredSourceReceipt.provenance, recoveredIngress.source.provenance);
  await assert.rejects(
    () => buildWikiRevision({
      runDirectory: recoverableRun.runRoot,
      campaignDirectory: recoveryCampaign,
      model: recoveryModel,
      allowRecoverableModelFailure: true,
    }),
    /already imported/u,
  );
  assert.equal(recoveryModel.turn, 2);

  const otherCause = cloneRun(recoverableRun, "other-cause");
  rewriteJournal(otherCause, (records) => {
    records.find((record) => record.type === "quarantine").errorCode = "OTHER_FAILURE";
  });
  await assert.rejects(
    () => loadVisionRunForWiki(otherCause.runRoot, {
      allowRecoverableModelFailure: true,
    }),
    /non-recoverable failure cause/u,
  );

  const invalidUsageCause = cloneRun(recoverableRun, "invalid-usage-cause");
  rewriteJournal(invalidUsageCause, (records) => {
    const failureIndex = records.findIndex((record) => record.type === "model_turn_failed");
    records.splice(failureIndex, 0, {
      seq: 0,
      at: records[failureIndex].at,
      type: "model_turn_usage_invalid",
    });
  });
  await assert.rejects(
    () => loadVisionRunForWiki(invalidUsageCause.runRoot, {
      allowRecoverableModelFailure: true,
    }),
    /non-recoverable failure cause/u,
  );

  for (const [variant, recordType] of [
    ["failure-extra-field", "model_turn_failed"],
    ["usage-extra-field", "model_turn_usage"],
    ["served-extra-field", "frame_served"],
  ]) {
    const malformed = cloneRun(recoverableRun, variant);
    rewriteJournal(malformed, (records) => {
      const failureIndex = records.findIndex((record) => record.type === "model_turn_failed");
      const target = recordType === "model_turn_usage"
        ? records[failureIndex - 1]
        : recordType === "frame_served"
          ? records[failureIndex - 2]
          : records[failureIndex];
      target.unknown = "not allowed";
    });
    await assert.rejects(
      () => loadVisionRunForWiki(malformed.runRoot, {
        allowRecoverableModelFailure: true,
      }),
      /invalid shape/u,
    );
  }

  const postFailureAction = cloneRun(recoverableRun, "post-failure-action");
  rewriteJournal(postFailureAction, (records) => {
    const failureIndex = records.findIndex((record) => record.type === "model_turn_failed");
    records.splice(failureIndex + 1, 0, {
      type: "decision",
      action: { action: "press_key", code: "Enter" },
      frameId: "F000015",
    });
  });
  await assert.rejects(
    () => loadVisionRunForWiki(postFailureAction.runRoot, {
      allowRecoverableModelFailure: true,
    }),
    /terminal tail|action after/u,
  );

  const unsettledInput = cloneRun(recoverableRun, "unsettled-input");
  rewriteJournal(unsettledInput, (records) => {
    const tapIndex = records.findIndex((record) =>
      record.type === "tap_receipt" && record.receipt?.delivery === "DELIVERED");
    records[tapIndex + 2].source = "observe";
  });
  await assert.rejects(
    () => loadVisionRunForWiki(unsettledInput.runRoot, {
      allowRecoverableModelFailure: true,
    }),
    /not settled by waitFrame/u,
  );

  const badReceipt = cloneRun(recoverableRun, "bad-receipt");
  rewriteJournal(badReceipt, (records) => {
    records.find((record) => record.type === "end_receipt").reason = "ABORT";
  });
  await assert.rejects(
    () => loadVisionRunForWiki(badReceipt.runRoot, {
      allowRecoverableModelFailure: true,
    }),
    /successful termination/u,
  );

  const hostPolicyIngress = await loadVisionRunForWiki(hostPolicyRun.runRoot);
  assert.equal(hostPolicyIngress.hostStatus, "SEALED");
  assert.equal(hostPolicyIngress.source.provenance.acceptanceBasis, "HOST_POLICY");
  assert.equal(
    hostPolicyIngress.source.provenance.terminationKind,
    "MODEL_DECISION_FAILED_NO_ACTION",
  );

  const restartedIngress = await loadVisionRunForWiki(restartedRun.runRoot);
  assert.equal(restartedIngress.hostStatus, "SEALED");
  assert.deepEqual(
    {
      terminationKind: restartedIngress.source.provenance.terminationKind,
      acceptanceBasis: restartedIngress.source.provenance.acceptanceBasis,
      stopCode: restartedIngress.source.provenance.stopCode,
      failedTurn: restartedIngress.source.provenance.failedTurn,
    },
    {
      terminationKind: "NORMAL",
      acceptanceBasis: "STANDARD",
      stopCode: null,
      failedTurn: null,
    },
  );

  const restartRetryFailedIngress = await loadVisionRunForWiki(
    restartRetryFailedRun.runRoot,
  );
  assert.equal(restartRetryFailedIngress.hostStatus, "SEALED");
  assert.deepEqual(
    {
      terminationKind: restartRetryFailedIngress.source.provenance.terminationKind,
      acceptanceBasis: restartRetryFailedIngress.source.provenance.acceptanceBasis,
      stopCode: restartRetryFailedIngress.source.provenance.stopCode,
      failedTurn: restartRetryFailedIngress.source.provenance.failedTurn,
    },
    {
      terminationKind: "MODEL_DECISION_FAILED_NO_ACTION",
      acceptanceBasis: "HOST_POLICY",
      stopCode: "MODEL_TURN_FAILED",
      failedTurn: 16,
    },
  );

  const rolloverIngress = await loadVisionRunForWiki(rolloverRun.runRoot);
  assert.equal(rolloverIngress.hostStatus, "SEALED");
  assert.equal(rolloverIngress.source.provenance.terminationKind, "NORMAL");
  assert.equal(rolloverIngress.source.provenance.acceptanceBasis, "STANDARD");
  const rolloverJournal = readFileSync(
    path.join(rolloverRun.runRoot, "host", "driver.jsonl"),
    "utf8",
  ).trimEnd().split(/\r?\n/u).map((line) => JSON.parse(line));
  const rolloverValidationIndex = rolloverJournal.findIndex((record) =>
    record.type === "model_rollover_validated");
  assert.notEqual(rolloverValidationIndex, -1);
  assert.equal(rolloverJournal[rolloverValidationIndex - 1].type, "decision");
  assert.equal(rolloverJournal[rolloverValidationIndex - 2].type, "model_turn_usage");
  assert.deepEqual(
    Object.fromEntries(Object.entries(rolloverJournal[rolloverValidationIndex]).filter(([key]) =>
      !["seq", "at", "type"].includes(key))),
    {
      rolloverOrdinal: 1,
      sessionGeneration: 1,
      turn: 2,
      frameId: rolloverJournal[rolloverValidationIndex - 1].frameId,
      frameSha256: rolloverJournal[rolloverValidationIndex - 3].sha256,
    },
  );

  const rolloverRetrySuccessIngress = await loadVisionRunForWiki(
    rolloverRetrySuccessRun.runRoot,
  );
  assert.equal(rolloverRetrySuccessIngress.hostStatus, "SEALED");
  assert.equal(rolloverRetrySuccessIngress.source.provenance.terminationKind, "NORMAL");
  assert.equal(rolloverRetrySuccessIngress.source.provenance.acceptanceBasis, "STANDARD");
  assert.equal(
    readFileSync(path.join(rolloverRetrySuccessRun.runRoot, "host", "driver.jsonl"), "utf8")
      .includes("model_rollover_validated"),
    false,
    "an honest failed successor leaves endurance unvalidated without discarding gameplay evidence",
  );

  const rolloverRetryFailedIngress = await loadVisionRunForWiki(
    rolloverRetryFailedRun.runRoot,
  );
  assert.equal(rolloverRetryFailedIngress.hostStatus, "SEALED");
  assert.equal(
    rolloverRetryFailedIngress.source.provenance.terminationKind,
    "MODEL_DECISION_FAILED_NO_ACTION",
  );
  assert.equal(rolloverRetryFailedIngress.source.provenance.acceptanceBasis, "HOST_POLICY");
  assert.equal(rolloverRetryFailedIngress.source.provenance.failedTurn, 3);

  for (const [run, failedTurn, expectedRollovers] of [
    [delayedTerminalFailureRun, 18, 0],
    [rolloverBeforeFailureRun, 5, 1],
    [rolloverAfterRestartRun, 17, 1],
  ]) {
    const delayedIngress = await loadVisionRunForWiki(run.runRoot);
    assert.equal(delayedIngress.hostStatus, "SEALED");
    assert.deepEqual(
      {
        terminationKind: delayedIngress.source.provenance.terminationKind,
        acceptanceBasis: delayedIngress.source.provenance.acceptanceBasis,
        stopCode: delayedIngress.source.provenance.stopCode,
        failedTurn: delayedIngress.source.provenance.failedTurn,
      },
      {
        terminationKind: "MODEL_DECISION_FAILED_NO_ACTION",
        acceptanceBasis: "HOST_POLICY",
        stopCode: "MODEL_TURN_FAILED",
        failedTurn,
      },
    );
    const records = readFileSync(path.join(run.runRoot, "host", "driver.jsonl"), "utf8")
      .trimEnd()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line));
    assert.equal(records.filter((record) =>
      record.type === "model_turn_failed").length, 2);
    assert.equal(records.filter((record) =>
      record.type === "model_restart_authorized").length, 1);
    assert.equal(records.filter((record) =>
      record.type === "model_session_reset").length, 1);
    assert.equal(records.filter((record) =>
      record.type === "model_session_rotated").length, expectedRollovers);
  }

  const delayedThirdFailure = cloneRun(
    delayedTerminalFailureRun,
    "delayed-third-failure",
  );
  rewriteJournal(delayedThirdFailure, (records) => {
    const terminalFailureIndex = records.findLastIndex((record) =>
      record.type === "model_turn_failed");
    records.splice(terminalFailureIndex + 1, 0, {
      ...records[terminalFailureIndex],
    });
  });
  await assert.rejects(
    () => loadVisionRunForWiki(delayedThirdFailure.runRoot),
    /unsupported model decision failure count/u,
  );

  const delayedSecondReset = cloneRun(
    delayedTerminalFailureRun,
    "delayed-second-reset",
  );
  rewriteJournal(delayedSecondReset, (records) => {
    const resetIndex = records.findIndex((record) =>
      record.type === "model_session_reset");
    records.splice(resetIndex + 1, 0, {
      ...records[resetIndex],
      restartOrdinal: 2,
      sessionGeneration: 2,
    });
  });
  await assert.rejects(
    () => loadVisionRunForWiki(delayedSecondReset.runRoot),
    /audited successful sequence|exactly one model restart/u,
  );

  const delayedSecondFailureNonterminal = cloneRun(
    delayedTerminalFailureRun,
    "delayed-second-failure-nonterminal",
  );
  rewriteJournal(delayedSecondFailureNonterminal, (records) => {
    const failureIndex = records.findLastIndex((record) =>
      record.type === "model_turn_failed");
    const served = records[failureIndex - 2];
    records.splice(failureIndex + 1, 0,
      {
        type: "frame_served",
        frameId: served.frameId,
        sha256: served.sha256,
      },
      {
        type: "model_turn_usage",
        turn: records[failureIndex].turn + 1,
        usageMissing: true,
      },
      {
        type: "decision",
        action: { action: "press_key", code: "Enter" },
        frameId: served.frameId,
      });
  });
  await assert.rejects(
    () => loadVisionRunForWiki(delayedSecondFailureNonterminal.runRoot),
    /terminal tail/u,
  );

  const delayedPostFailureInput = cloneRun(
    delayedTerminalFailureRun,
    "delayed-post-failure-input",
  );
  rewriteJournal(delayedPostFailureInput, (records) => {
    const failureIndex = records.findLastIndex((record) =>
      record.type === "model_turn_failed");
    records.splice(failureIndex + 1, 0, {
      type: "tap_receipt",
      requestId: "forbidden-after-terminal-failure",
      code: "Enter",
      frameId: records[failureIndex - 2].frameId,
      receipt: { delivery: "DELIVERED" },
    });
  });
  await assert.rejects(
    () => loadVisionRunForWiki(delayedPostFailureInput.runRoot),
    /terminal tail|terminal boundary/u,
  );

  const delayedSuccessOrderMismatch = cloneRun(
    delayedTerminalFailureRun,
    "delayed-success-order-mismatch",
  );
  rewriteJournal(delayedSuccessOrderMismatch, (records) => {
    const usageIndex = records.findIndex((record) =>
      record.type === "model_turn_usage" && record.turn === 17);
    [records[usageIndex], records[usageIndex + 1]] = [
      records[usageIndex + 1],
      records[usageIndex],
    ];
  });
  await assert.rejects(
    () => loadVisionRunForWiki(delayedSuccessOrderMismatch.runRoot),
    /successful model frame receipt|model turn sequence|model turn usage/u,
  );

  const delayedTerminalHashMismatch = cloneRun(
    delayedTerminalFailureRun,
    "delayed-terminal-hash-mismatch",
  );
  rewriteJournal(delayedTerminalHashMismatch, (records) => {
    const failureIndex = records.findLastIndex((record) =>
      record.type === "model_turn_failed");
    records[failureIndex - 2].sha256 = "0".repeat(64);
  });
  await assert.rejects(
    () => loadVisionRunForWiki(delayedTerminalHashMismatch.runRoot),
    /model failure evidence boundary/u,
  );

  const sharedGenerationMismatch = cloneRun(
    rolloverAfterRestartRun,
    "delayed-shared-generation-mismatch",
  );
  rewriteJournal(sharedGenerationMismatch, (records) => {
    records.find((record) =>
      record.type === "model_session_rotated").sessionGeneration += 1;
  });
  await assert.rejects(
    () => loadVisionRunForWiki(sharedGenerationMismatch.runRoot),
    /rollover audit does not match its model boundary/u,
  );

  const missingFailedRetryReset = cloneRun(
    restartRetryFailedRun,
    "failed-retry-missing-reset",
  );
  rewriteJournal(missingFailedRetryReset, (records) => {
    records.splice(records.findIndex((record) => record.type === "model_session_reset"), 1);
  });
  await assert.rejects(
    () => loadVisionRunForWiki(missingFailedRetryReset.runRoot),
    /audited successful sequence|exact audited reset/u,
  );

  const failedRetryTurnMismatch = cloneRun(
    restartRetryFailedRun,
    "failed-retry-turn-mismatch",
  );
  rewriteJournal(failedRetryTurnMismatch, (records) => {
    const failures = records.filter((record) => record.type === "model_turn_failed");
    failures[1].turn += 1;
  });
  await assert.rejects(
    () => loadVisionRunForWiki(failedRetryTurnMismatch.runRoot),
    /failure evidence boundary|failed restarted model turn/u,
  );

  const failedRetryGenerationMismatch = cloneRun(
    restartRetryFailedRun,
    "failed-retry-generation-mismatch",
  );
  rewriteJournal(failedRetryGenerationMismatch, (records) => {
    records.find((record) => record.type === "model_session_reset").sessionGeneration = 2;
  });
  await assert.rejects(
    () => loadVisionRunForWiki(failedRetryGenerationMismatch.runRoot),
    /does not match the failed turn/u,
  );

  const duplicateTerminalFailure = cloneRun(
    restartRetryFailedRun,
    "failed-retry-duplicate-terminal",
  );
  rewriteJournal(duplicateTerminalFailure, (records) => {
    const failureIndexes = records
      .map((record, index) => record.type === "model_turn_failed" ? index : -1)
      .filter((index) => index !== -1);
    records.splice(failureIndexes[1] + 1, 0, { ...records[failureIndexes[1]] });
  });
  await assert.rejects(
    () => loadVisionRunForWiki(duplicateTerminalFailure.runRoot),
    /unsupported model decision failure count/u,
  );

  const postTerminalFailureAction = cloneRun(
    restartRetryFailedRun,
    "failed-retry-post-action",
  );
  rewriteJournal(postTerminalFailureAction, (records) => {
    const failureIndexes = records
      .map((record, index) => record.type === "model_turn_failed" ? index : -1)
      .filter((index) => index !== -1);
    records.splice(failureIndexes[1] + 1, 0, {
      type: "decision",
      action: { action: "press_key", code: "Enter" },
      frameId: records[failureIndexes[1] - 2].frameId,
    });
  });
  await assert.rejects(
    () => loadVisionRunForWiki(postTerminalFailureAction.runRoot),
    /terminal tail|terminal boundary/u,
  );

  const rolloverResetGenerationMismatch = cloneRun(
    rolloverRetrySuccessRun,
    "rollover-reset-generation-mismatch",
  );
  rewriteJournal(rolloverResetGenerationMismatch, (records) => {
    records.find((record) => record.type === "model_session_reset").sessionGeneration = 1;
  });
  await assert.rejects(
    () => loadVisionRunForWiki(rolloverResetGenerationMismatch.runRoot),
    /does not match the failed turn/u,
  );

  const rolloverRetryFrameMismatch = cloneRun(
    rolloverRetrySuccessRun,
    "rollover-retry-frame-mismatch",
  );
  rewriteJournal(rolloverRetryFrameMismatch, (records) => {
    const resetIndex = records.findIndex((record) => record.type === "model_session_reset");
    records[resetIndex + 1].sha256 = "0".repeat(64);
  });
  await assert.rejects(
    () => loadVisionRunForWiki(rolloverRetryFrameMismatch.runRoot),
    /did not reuse the verified frame/u,
  );

  const rolloverRetryMissingReset = cloneRun(
    rolloverRetryFailedRun,
    "rollover-retry-missing-reset",
  );
  rewriteJournal(rolloverRetryMissingReset, (records) => {
    records.splice(records.findIndex((record) => record.type === "model_session_reset"), 1);
  });
  await assert.rejects(
    () => loadVisionRunForWiki(rolloverRetryMissingReset.runRoot),
    /audited successful sequence|exact audited reset/u,
  );

  const malformedRollover = cloneRun(rolloverRun, "rollover-extra-field");
  rewriteJournal(malformedRollover, (records) => {
    records.find((record) => record.type === "model_rollover_authorized").unknown = true;
  });
  await assert.rejects(
    () => loadVisionRunForWiki(malformedRollover.runRoot),
    /rollover authorization has an invalid shape/u,
  );

  const duplicateRollover = cloneRun(rolloverRun, "rollover-duplicate");
  rewriteJournal(duplicateRollover, (records) => {
    const authorizationIndex = records.findIndex((record) =>
      record.type === "model_rollover_authorized");
    const rotationIndex = records.findIndex((record) => record.type === "model_session_rotated");
    records.splice(rotationIndex + 1, 0, {
      ...records[authorizationIndex],
    }, {
      ...records[rotationIndex],
    });
  });
  await assert.rejects(
    () => loadVisionRunForWiki(duplicateRollover.runRoot),
    /out of order|does not match|invalid shape/u,
  );

  const missingRotation = cloneRun(rolloverRun, "rollover-missing-rotation");
  rewriteJournal(missingRotation, (records) => {
    records.splice(records.findIndex((record) => record.type === "model_session_rotated"), 1);
  });
  await assert.rejects(
    () => loadVisionRunForWiki(missingRotation.runRoot),
    /audit pair is incomplete/u,
  );

  const reversedRollover = cloneRun(rolloverRun, "rollover-reversed");
  rewriteJournal(reversedRollover, (records) => {
    const authorizationIndex = records.findIndex((record) =>
      record.type === "model_rollover_authorized");
    const rotationIndex = records.findIndex((record) => record.type === "model_session_rotated");
    [records[authorizationIndex], records[rotationIndex]] = [
      records[rotationIndex],
      records[authorizationIndex],
    ];
  });
  await assert.rejects(
    () => loadVisionRunForWiki(reversedRollover.runRoot),
    /out of order/u,
  );

  const rolloverHashMismatch = cloneRun(rolloverRun, "rollover-hash-mismatch");
  rewriteJournal(rolloverHashMismatch, (records) => {
    records.find((record) => record.type === "model_rollover_authorized").frameSha256 = "0".repeat(64);
  });
  await assert.rejects(
    () => loadVisionRunForWiki(rolloverHashMismatch.runRoot),
    /does not match its model boundary/u,
  );

  const rolloverReServedMismatch = cloneRun(rolloverRun, "rollover-reserved-mismatch");
  rewriteJournal(rolloverReServedMismatch, (records) => {
    const rotationIndex = records.findIndex((record) => record.type === "model_session_rotated");
    records[rotationIndex + 1].sha256 = "0".repeat(64);
  });
  await assert.rejects(
    () => loadVisionRunForWiki(rolloverReServedMismatch.runRoot),
    /did not re-serve/u,
  );

  const rolloverNonAuditGap = cloneRun(rolloverRun, "rollover-non-audit-gap");
  rewriteJournal(rolloverNonAuditGap, (records) => {
    const rotationIndex = records.findIndex((record) => record.type === "model_session_rotated");
    records.splice(rotationIndex + 1, 0, { type: "state", state: "DECIDING" });
  });
  await assert.rejects(
    () => loadVisionRunForWiki(rolloverNonAuditGap.runRoot),
    /rotated model frame receipt|invalid shape/u,
  );

  for (const [variant, field] of [
    ["generation", "sessionGeneration"],
    ["ordinal", "rolloverOrdinal"],
  ]) {
    const mismatch = cloneRun(rolloverRun, `rollover-${variant}-mismatch`);
    rewriteJournal(mismatch, (records) => {
      records.find((record) => record.type === "model_session_rotated")[field] = 2;
    });
    await assert.rejects(
      () => loadVisionRunForWiki(mismatch.runRoot),
      /does not match its model boundary/u,
    );
  }

  const rolloverResultOrder = cloneRun(rolloverRun, "rollover-result-order");
  rewriteJournal(rolloverResultOrder, (records) => {
    const rotationIndex = records.findIndex((record) => record.type === "model_session_rotated");
    [records[rotationIndex + 2], records[rotationIndex + 3]] = [
      records[rotationIndex + 3],
      records[rotationIndex + 2],
    ];
  });
  await assert.rejects(
    () => loadVisionRunForWiki(rolloverResultOrder.runRoot),
    /model turn usage|invalid shape/u,
  );

  const malformedValidation = cloneRun(rolloverRun, "rollover-validation-extra-field");
  rewriteJournal(malformedValidation, (records) => {
    records.find((record) => record.type === "model_rollover_validated").unknown = true;
  });
  await assert.rejects(
    () => loadVisionRunForWiki(malformedValidation.runRoot),
    /rollover validation has an invalid shape/u,
  );

  const missingValidation = cloneRun(rolloverRun, "rollover-validation-missing");
  rewriteJournal(missingValidation, (records) => {
    records.splice(records.findIndex((record) => record.type === "model_rollover_validated"), 1);
  });
  await assert.rejects(
    () => loadVisionRunForWiki(missingValidation.runRoot),
    /missing its immediate validation audit/u,
  );

  const duplicateValidation = cloneRun(rolloverRun, "rollover-validation-duplicate");
  rewriteJournal(duplicateValidation, (records) => {
    const validationIndex = records.findIndex((record) => record.type === "model_rollover_validated");
    records.splice(validationIndex + 1, 0, { ...records[validationIndex] });
  });
  await assert.rejects(
    () => loadVisionRunForWiki(duplicateValidation.runRoot),
    /forged or duplicate/u,
  );

  const outOfOrderValidation = cloneRun(rolloverRun, "rollover-validation-out-of-order");
  rewriteJournal(outOfOrderValidation, (records) => {
    const validationIndex = records.findIndex((record) => record.type === "model_rollover_validated");
    [records[validationIndex - 1], records[validationIndex]] = [
      records[validationIndex],
      records[validationIndex - 1],
    ];
  });
  await assert.rejects(
    () => loadVisionRunForWiki(outOfOrderValidation.runRoot),
    /decision|invalid shape|missing its immediate/u,
  );

  for (const [variant, field, mutate] of [
    ["hash", "frameSha256", () => "0".repeat(64)],
    ["generation", "sessionGeneration", (value) => value + 1],
    ["turn", "turn", (value) => value + 1],
    ["ordinal", "rolloverOrdinal", (value) => value + 1],
  ]) {
    const mismatch = cloneRun(rolloverRun, `rollover-validation-${variant}-mismatch`);
    rewriteJournal(mismatch, (records) => {
      const validation = records.find((record) => record.type === "model_rollover_validated");
      validation[field] = mutate(validation[field]);
    });
    await assert.rejects(
      () => loadVisionRunForWiki(mismatch.runRoot),
      /validation does not match its decision boundary/u,
    );
  }

  const validationNonAuditGap = cloneRun(rolloverRun, "rollover-validation-non-audit-gap");
  rewriteJournal(validationNonAuditGap, (records) => {
    const validationIndex = records.findIndex((record) => record.type === "model_rollover_validated");
    records.splice(validationIndex, 0, { type: "state", state: "DECIDING" });
  });
  await assert.rejects(
    () => loadVisionRunForWiki(validationNonAuditGap.runRoot),
    /missing its immediate validation audit/u,
  );

  const forgedValidation = cloneRun(firstRun, "rollover-validation-forged-without-rollover");
  rewriteJournal(forgedValidation, (records) => {
    const endingIndex = records.findIndex((record) => record.type === "state" && record.state === "ENDING");
    records.splice(endingIndex, 0, {
      type: "model_rollover_validated",
      rolloverOrdinal: 1,
      sessionGeneration: 1,
      turn: 15,
      frameId: "F000015",
      frameSha256: "0".repeat(64),
    });
  });
  await assert.rejects(
    () => loadVisionRunForWiki(forgedValidation.runRoot),
    /forged or duplicate/u,
  );

  const resetlessDecision = cloneRun(restartedRun, "restart-resetless-decision");
  rewriteJournal(resetlessDecision, (records) => {
    const retained = records.filter((record) =>
      !new Set(["model_restart_authorized", "model_session_reset"]).has(record.type));
    records.splice(0, records.length, ...retained);
  });
  await assert.rejects(
    () => loadVisionRunForWiki(resetlessDecision.runRoot),
    /terminal tail|audited successful sequence/u,
  );

  const duplicateRestart = cloneRun(restartedRun, "restart-duplicate");
  rewriteJournal(duplicateRestart, (records) => {
    const authorizationIndex = records.findIndex((record) =>
      record.type === "model_restart_authorized");
    const resetIndex = records.findIndex((record) => record.type === "model_session_reset");
    records.splice(
      resetIndex + 1,
      0,
      { ...records[authorizationIndex] },
      { ...records[resetIndex] },
    );
  });
  await assert.rejects(
    () => loadVisionRunForWiki(duplicateRestart.runRoot),
    /exactly one model restart|audited successful sequence/u,
  );

  const outOfOrderRestart = cloneRun(restartedRun, "restart-out-of-order");
  rewriteJournal(outOfOrderRestart, (records) => {
    const authorizationIndex = records.findIndex((record) =>
      record.type === "model_restart_authorized");
    const resetIndex = records.findIndex((record) => record.type === "model_session_reset");
    [records[authorizationIndex], records[resetIndex]] = [
      records[resetIndex],
      records[authorizationIndex],
    ];
  });
  await assert.rejects(
    () => loadVisionRunForWiki(outOfOrderRestart.runRoot),
    /out of order/u,
  );

  const malformedRestart = cloneRun(restartedRun, "restart-malformed");
  rewriteJournal(malformedRestart, (records) => {
    records.find((record) => record.type === "model_restart_authorized").unknown = true;
  });
  await assert.rejects(
    () => loadVisionRunForWiki(malformedRestart.runRoot),
    /invalid shape/u,
  );

  const mismatchedResetReceipt = cloneRun(restartedRun, "restart-receipt-mismatch");
  rewriteJournal(mismatchedResetReceipt, (records) => {
    records.find((record) => record.type === "model_session_reset").sessionGeneration = 2;
  });
  await assert.rejects(
    () => loadVisionRunForWiki(mismatchedResetReceipt.runRoot),
    /does not match the failed turn/u,
  );

  const wikiModel = new WikiModel();
  const first = await buildWikiRevision({ runDirectory: firstRun.runRoot, campaignDirectory: campaignRoot, model: wikiModel });
  const legacySnapshot = JSON.parse(readFileSync(first.snapshotFile, "utf8"));
  legacySnapshot.schemaVersion = "atlas/assisted-wiki-snapshot/1";
  delete legacySnapshot.evidenceSets;
  legacySnapshot.sources.forEach((source) => delete source.provenance);
  writeFileSync(first.snapshotFile, `${JSON.stringify(legacySnapshot, null, 2)}\n`);
  await assert.rejects(
    () => buildWikiRevision({ runDirectory: firstRun.runRoot, campaignDirectory: campaignRoot, model: wikiModel }),
    /already imported/u,
  );
  const second = await buildWikiRevision({ runDirectory: secondRun.runRoot, campaignDirectory: campaignRoot, model: wikiModel });
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  assert.equal(wikiModel.sawPrior, true);
  assert.equal(wikiModel.imageRoots.every((root) => root.includes(".wiki-build-") && !root.startsWith(firstRun.runRoot) && !root.startsWith(secondRun.runRoot)), true);

  const secondSnapshot = JSON.parse(readFileSync(second.snapshotFile, "utf8"));
  assert.equal(secondSnapshot.schemaVersion, ASSISTED_WIKI_SCHEMA_VERSION);
  assert.equal(secondSnapshot.sources.some((source) =>
    source.provenance.acceptanceBasis === "MIGRATED_LEGACY"), true);
  const unchangedLegacySnapshot = JSON.parse(readFileSync(first.snapshotFile, "utf8"));
  assert.equal(unchangedLegacySnapshot.schemaVersion, "atlas/assisted-wiki-snapshot/1");
  assert.equal(Object.prototype.hasOwnProperty.call(unchangedLegacySnapshot.sources[0], "provenance"), false);
  assert.equal(secondSnapshot.cases.length, 2);
  assert.deepEqual(secondSnapshot.sources.map((source) => source.explorationTrack).sort(), ["ASSISTED_EXPLORATION", "EXPLORATION"]);
  const playerContext = validateKnowledgeContext(JSON.parse(readFileSync(second.playerContextFile, "utf8")));
  assert.equal(playerContext.revision, 2);
  assert.equal(playerContext.guidance.filter((item) => item.kind === "CASE").length, 2);
  assert.doesNotMatch(JSON.stringify(playerContext), /F\d{6}|artifactDigest|evidenceFrameIds|Enter|press_key/u);
  assert.match(readFileSync(second.wikiIndex, "utf8"), /Assisted Wiki/u);

  const assistedArtifactName = readdirSync(path.join(secondRun.runnerRoot, "runs-public"))[0];
  const assistedHandoff = JSON.parse(readFileSync(path.join(secondRun.runnerRoot, "runs-public", assistedArtifactName, "handoff.json"), "utf8"));
  assert.equal(assistedHandoff.header.track, "ASSISTED_EXPLORATION");
  assert.equal(assistedHandoff.payload.manifest.validity, "ASSISTED");

  const publicArtifactName = readdirSync(path.join(firstRun.runnerRoot, "runs-public"))[0];
  const handoff = JSON.parse(readFileSync(path.join(firstRun.runnerRoot, "runs-public", publicArtifactName, "handoff.json"), "utf8"));
  const framePath = path.join(firstRun.runnerRoot, "runs-public", publicArtifactName, handoff.payload.frames[0].mediaRef);
  const beforeDigest = createHash("sha256").update(ingress.verifiedImages[0].bytes).digest("hex");
  writeFileSync(framePath, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("tampered")]));
  assert.equal(createHash("sha256").update(ingress.verifiedImages[0].bytes).digest("hex"), beforeDigest);
  await assert.rejects(() => loadVisionRunForWiki(firstRun.runRoot));

  console.log("assisted_wiki_integration: sealed evidence, immutable staging, two revisions, and bounded feedback passed");
} finally {
  const canonical = realpathSync(temporaryRoot);
  const canonicalTemp = realpathSync(tmpdir());
  assert.equal(canonical.startsWith(canonicalTemp + path.sep), true);
  assert.equal(path.basename(canonical).startsWith("atlas-assisted-wiki-integration-"), true);
  rmSync(canonical, { recursive: true, force: true });
}
