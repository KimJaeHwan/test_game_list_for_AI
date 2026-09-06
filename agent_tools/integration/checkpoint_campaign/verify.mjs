import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AgentLoopSupervisor, PlayerRunnerStdioClient } from "../../05_vision_agent_host/src/index.mjs";
import { CheckpointCampaignOrchestrator } from "../../07_checkpoint_campaign/src/index.mjs";
import { createCheckpointCampaignIntegration } from "./adapter.mjs";
import { aggregateTokens, parseCampaignCommandLine, shouldPublishTerminalEvidence } from "./run-live-campaign.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(HERE, "../..");
const BOOTSTRAP = path.join(TOOL_ROOT, "integration", "assisted_wiki_loop", "synthetic-bootstrap.mjs");
const RUNNER_ENTRY = path.join(TOOL_ROOT, "01_player_runner", "src", "stdio-server.mjs");
const root = mkdtempSync(path.join(tmpdir(), "atlas-checkpoint-integration-"));
const playerInstances = [];

function environment(runnerRoot, launchTicket, track) {
  const names = ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP"];
  return {
    ...Object.fromEntries(names.flatMap((name) => typeof process.env[name] === "string" ? [[name, process.env[name]]] : [])),
    ATLAS_RUNNER_BOOTSTRAP: BOOTSTRAP,
    ATLAS_LAUNCH_TICKET: launchTicket,
    ATLAS_WIKI_INTEGRATION_RUNNER_ROOT: runnerRoot,
    ATLAS_WIKI_INTEGRATION_EXTENDED_RUN: "1",
    ATLAS_EXPLORATION_TRACK: track,
  };
}

class FreshPlayerModel {
  constructor(terminal) {
    this.terminal = terminal;
    this.turns = 0;
    playerInstances.push(this);
  }
  isQuiescent() { return true; }
  async decide() {
    this.turns += 1;
    return {
      action: this.terminal
        ? { action: "finish", reason: "COMPLETE" }
        : { action: "press_key", code: "Enter" },
      usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 5 },
    };
  }
}

async function createSealedSegment(request) {
  const hostRunId = randomUUID();
  const runDirectory = path.join(root, hostRunId);
  const runnerRoot = path.join(runDirectory, "runner");
  const hostRoot = path.join(runDirectory, "host");
  const launchTicket = randomUUID();
  mkdirSync(runDirectory, { recursive: false });
  writeFileSync(path.join(runDirectory, "operator-consent.json"), `${JSON.stringify({
    schemaVersion: "atlas/vision-agent-operator-consent/1",
    hostRunId,
    openAIImageUploadConfirmed: true,
    confirmedAt: new Date().toISOString(),
  }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  const runner = await PlayerRunnerStdioClient.start({
    executable: process.execPath,
    args: [RUNNER_ENTRY],
    env: environment(runnerRoot, launchTicket, request.knowledgeContext === null ? "EXPLORATION" : "ASSISTED_EXPLORATION"),
    requestTimeoutMs: 5000,
    closeGraceMs: 2000,
  });
  const terminal = request.segmentOrdinal === 2;
  const model = new FreshPlayerModel(terminal);
  try {
    const supervisor = new AgentLoopSupervisor({
      runner,
      model,
      workdir: hostRoot,
      idFactory: randomUUID,
      policy: {
        turns: 40,
        keys: 30,
        observations: 30,
        elapsedMs: 60000,
        modelRestarts: 0,
        modelSessionInputTokens: 0,
      },
      checkpointPolicy: terminal ? undefined : request.checkpointPolicy,
      knowledgeContext: request.knowledgeContext ?? undefined,
      policyProfile: "ROLLOVER_ENDURANCE_2X",
    });
    const hostResult = await supervisor.run({ launchTicket });
    assert.equal(hostResult.status, "SEALED");
    const accounting = hostResult.continuation === undefined
      ? { turns: model.turns, keyAttempts: 0, frames: 1, elapsedMs: 100 }
      : {
          turns: hostResult.continuation.boundary.completedTurns,
          keyAttempts: hostResult.continuation.boundary.keyAttempts,
          frames: hostResult.continuation.boundary.observations,
          elapsedMs: 1000,
        };
    return {
      runDirectory,
      hostResult,
      accounting,
      routingHint: {
        currentText: terminal ? "new unexplored room" : "boss combat shield warning",
        currentEpisodeOrdinal: request.segmentOrdinal,
      },
    };
  } finally {
    await runner.close();
  }
}

class WikiModel {
  constructor(callSizes) { this.callSizes = callSizes; }
  async decide(input) {
    const frameIds = input.imagePaths.map((file) => path.basename(file, ".png"));
    this.callSizes.push(frameIds.length);
    return {
      proposal: {
        summary: "Observed a boss shield rule.",
        pages: [{
          kind: "system",
          title: "Boss combat",
          facts: [{
            text: "The boss shield changes after a visible warning.",
            confidence: "OBSERVED",
            evidenceFrameIds: [frameIds[0]],
          }],
          procedures: [],
        }],
        cases: [],
        openQuestions: [],
      },
      usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 },
    };
  }
}

async function testEndToEnd() {
  const campaignDirectory = path.join(root, "campaign");
  const playRequests = [];
  const wikiCallSizes = [];
  const modelFactoryInputs = [];
  const ports = createCheckpointCampaignIntegration({
    campaignDirectory,
    topK: 1,
    executeSegment: async (request) => {
      playRequests.push(structuredClone(request));
      return createSealedSegment(request);
    },
    wikiModelFactory: async (input) => {
      modelFactoryInputs.push(structuredClone(input));
      return new WikiModel(wikiCallSizes);
    },
  });
  const campaign = new CheckpointCampaignOrchestrator({
    campaignId: "offline-campaign",
    budget: { turns: 50, keyAttempts: 40, frames: 50, elapsedMs: 60000, checkpoints: 2 },
    checkpointPolicy: { modelInputTokens: 0, keyAttempts: 0, frames: 25, onMissingUsage: false },
    ...ports,
  });
  const result = await campaign.run();
  assert.equal(result.status, "FINISHED", JSON.stringify(result));
  assert.equal(result.reason, "COMPLETE");
  assert.equal(result.segments, 2);
  assert.equal(result.checkpoints, 1);
  assert.equal(result.revision, 1);
  assert.equal(playerInstances.length, 2);
  assert.notEqual(playerInstances[0], playerInstances[1]);
  assert.deepEqual(wikiCallSizes, [12, 12, 1]);
  assert.equal(playRequests.every((request) => request.sessionMode === "FRESH"), true);
  assert.equal(playRequests[0].knowledgeContext, null);
  assert.equal(playRequests[1].knowledgeContext.revision, 1);
  assert.equal(playRequests[1].knowledgeContext.guidance.length, 1);
  assert.match(JSON.stringify(playRequests[1].knowledgeContext), /Boss combat|boss shield/u);
  assert.match(modelFactoryInputs[0].sourceRef, /^S[0-9]{6}$/u);
  assert.doesNotMatch(modelFactoryInputs[0].sourceRef, /[\\/]|atlas-checkpoint/u);

  const episodeRevision = path.join(campaignDirectory, "episodes", "e000001", "revisions", "r000001");
  const routingRevision = path.join(campaignDirectory, "routing", "r000001");
  assert.equal(existsSync(path.join(episodeRevision, "checkpoint-ack.json")), true);
  assert.equal(existsSync(path.join(routingRevision, "manifest.json")), true);
  assert.equal(existsSync(path.join(routingRevision, "topics", "combat.json")), true);
  assert.equal(existsSync(path.join(routingRevision, "episodes", "e000001.json")), true);
  assert.equal(existsSync(path.join(campaignDirectory, "revisions")), false);
  const manifest = JSON.parse(readFileSync(path.join(routingRevision, "manifest.json"), "utf8"));
  assert.equal(manifest.shards.some((shard) => shard.path === "topics/combat.json"), true);
  assert.equal(manifest.shards.some((shard) => shard.path === "episodes/e000001.json"), true);
  assert.equal(JSON.stringify(campaign.ledgerSnapshot()).includes(root), false);

  const terminalAck = await ports.publishTerminalEvidence({ baseRevision: result.revision });
  const replayAck = await ports.publishTerminalEvidence({ baseRevision: result.revision });
  assert.deepEqual(replayAck, terminalAck);
  assert.equal(terminalAck.revision, 2);
  assert.deepEqual(wikiCallSizes, [12, 12, 1, 1]);
  assert.equal(existsSync(path.join(campaignDirectory, "episodes", "e000002", "revisions", "r000001", "checkpoint-ack.json")), true);
  assert.equal(existsSync(path.join(campaignDirectory, "routing", "r000002", "manifest.json")), true);
}

async function testPartialWithoutContinuationIsTerminal() {
  let publishes = 0;
  const campaign = new CheckpointCampaignOrchestrator({
    campaignId: "terminal-partial",
    budget: { turns: 2, keyAttempts: 2, frames: 2, elapsedMs: 1000, checkpoints: 1 },
    checkpointPolicy: { modelInputTokens: 1, keyAttempts: 0, frames: 0, onMissingUsage: false },
    playSegment: async () => ({
      status: "SEALED",
      reason: "PARTIAL",
      sourceDigest: "a".repeat(64),
      sourceRef: "terminal:partial",
      accounting: { turns: 1, keyAttempts: 0, frames: 1, elapsedMs: 10 },
    }),
    publishWiki: async () => { publishes += 1; },
    loadContext: async () => { throw new Error("must not load"); },
  });
  const result = await campaign.run();
  assert.equal(result.status, "FINISHED");
  assert.equal(result.reason, "PARTIAL");
  assert.equal(publishes, 0);
}

function testLiveCommandSafety() {
  assert.deepEqual(
    parseCampaignCommandLine(["--confirm-openai-upload"]),
    { help: false, confirmed: true, checkpoints: 3 },
  );
  assert.equal(parseCampaignCommandLine(["--help"]).help, true);
  assert.equal(parseCampaignCommandLine(["--confirm-openai-upload", "--checkpoints", "10"]).checkpoints, 10);
  assert.throws(() => parseCampaignCommandLine([]), /confirmation/u);
  assert.throws(() => parseCampaignCommandLine(["--confirm-openai-upload", "--checkpoints", "11"]), /1 to 10/u);
  assert.throws(
    () => parseCampaignCommandLine(["--confirm-openai-upload", "--checkpoints", "2", "--checkpoints", "3"]),
    /duplicate/u,
  );
  assert.equal(shouldPublishTerminalEvidence({ status: "FINISHED", segments: 1 }), true);
  assert.equal(shouldPublishTerminalEvidence({ status: "FAILED", segments: 1 }), false);
  assert.equal(shouldPublishTerminalEvidence({ status: "WAITING_FOR_WIKI", segments: 1 }), false);
  assert.deepEqual(aggregateTokens([
    {
      semantics: "TURN_DELTA",
      completeness: "COMPLETE",
      reportedTurns: 1,
      missingTurns: 0,
      knownTotals: { inputTokens: 10, cachedInputTokens: 5, outputTokens: 2, totalTokens: 12 },
    },
    {
      semantics: "TURN_DELTA",
      completeness: "PARTIAL",
      reportedTurns: 1,
      missingTurns: 1,
      knownTotals: { inputTokens: 20, cachedInputTokens: 10, outputTokens: 3, totalTokens: 23 },
    },
  ]).knownTotals, { inputTokens: 30, cachedInputTokens: 15, outputTokens: 5, totalTokens: 35 });
  assert.throws(() => aggregateTokens([{
    semantics: "TURN_DELTA",
    completeness: "COMPLETE",
    reportedTurns: 1,
    missingTurns: 0,
    knownTotals: {
      inputTokens: Number.MAX_SAFE_INTEGER,
      cachedInputTokens: 0,
      outputTokens: 1,
      totalTokens: Number.MAX_SAFE_INTEGER,
    },
  }]), /inconsistent|overflow/u);
}

try {
  await testEndToEnd();
  process.stdout.write("ok - sealed checkpoint publishes 25 frames as 12/12/1 and activates routed context in a fresh segment\n");
  await testPartialWithoutContinuationIsTerminal();
  process.stdout.write("ok - PARTIAL without continuation is terminal\n");
  testLiveCommandSafety();
  process.stdout.write("ok - live command requires explicit upload consent and finite checkpoints\n");
  process.stdout.write("checkpoint campaign integration verification passed\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
