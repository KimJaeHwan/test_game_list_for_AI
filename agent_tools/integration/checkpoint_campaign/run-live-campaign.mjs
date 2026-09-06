import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  findCodexExecutable,
  runVisionSegment,
  visionArmDelay,
} from "../../05_vision_agent_host/scripts/run-codex-player.mjs";
import { CodexWikiModelPort } from "../../06_assisted_wiki_loop/src/index.mjs";
import { CheckpointCampaignOrchestrator } from "../../07_checkpoint_campaign/src/index.mjs";
import { buildWikiRevision } from "../assisted_wiki_loop/build-wiki.mjs";
import { createCheckpointCampaignIntegration } from "./adapter.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(HERE, "../..");
const CONFIRM = "--confirm-openai-upload";
const CHECKPOINTS = "--checkpoints";
const DEFAULT_CHECKPOINTS = 3;
const MAX_CHECKPOINTS = 10;
const SEGMENT_POLICY = Object.freeze({
  turns: 40,
  keys: 20,
  observations: 60,
  elapsedMs: 900000,
  modelRestarts: 1,
  modelSessionInputTokens: 55000,
});
const CHECKPOINT_POLICY = Object.freeze({
  modelInputTokens: 45000,
  keyAttempts: 12,
  frames: 24,
  onMissingUsage: true,
});

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export function parseCampaignCommandLine(args) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) throw new TypeError("args must be strings");
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { help: true };
  let confirmed = false;
  let checkpoints = DEFAULT_CHECKPOINTS;
  let checkpointsSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === CONFIRM && !confirmed) {
      confirmed = true;
    } else if (value === CHECKPOINTS && !checkpointsSeen && args[index + 1] !== undefined) {
      const raw = args[index + 1];
      if (!/^[1-9][0-9]*$/u.test(raw)) fail("COMMAND_LINE_INVALID", "--checkpoints must be a positive integer");
      checkpoints = Number(raw);
      checkpointsSeen = true;
      index += 1;
    } else {
      fail("COMMAND_LINE_INVALID", "unknown or duplicate command-line option");
    }
  }
  if (!confirmed) fail("REMOTE_UPLOAD_NOT_CONFIRMED", "explicit OpenAI screenshot upload confirmation is required");
  if (!Number.isSafeInteger(checkpoints) || checkpoints < 1 || checkpoints > MAX_CHECKPOINTS) {
    fail("COMMAND_LINE_INVALID", `--checkpoints must be from 1 to ${MAX_CHECKPOINTS}`);
  }
  return Object.freeze({ help: false, confirmed: true, checkpoints });
}

function printHelp() {
  process.stdout.write([
    "Usage: campaign-player.cmd --confirm-openai-upload [--checkpoints 3]",
    "",
    "The confirmation covers every game screenshot sent to the player and Wiki model.",
    "The run is finite. --checkpoints accepts 1 through 10.",
    "Default checkpoint triggers: 45000 model input tokens, 12 key attempts,",
    "24 frames, or missing usage. This occurs before the 55000-token rollover.",
    "",
    "Required environment:",
    "  ATLAS_TARGET_HWND=<operator-selected window handle>",
    "",
    "Optional environment:",
    "  ATLAS_CAPTURE_REGION=x,y,width,height",
    "  ATLAS_ALLOWED_KEYS=ArrowUp,ArrowDown,Enter,...",
    "  ATLAS_CODEX_EXE=<absolute codex executable>",
    "  ATLAS_VISION_STATE_DIR=<absolute play evidence root>",
    "  ATLAS_VISION_ARM_DELAY_MS=5000",
    "  ATLAS_CHECKPOINT_STATE_DIR=<absolute campaign parent directory>",
    "",
  ].join("\n"));
}

function stateRoot(source) {
  const configured = source.ATLAS_CHECKPOINT_STATE_DIR;
  if (configured !== undefined && (typeof configured !== "string" || !path.isAbsolute(configured))) {
    fail("STATE_DIRECTORY_INVALID", "ATLAS_CHECKPOINT_STATE_DIR must be absolute");
  }
  const root = path.resolve(configured ?? path.join(TOOL_ROOT, ".local", "checkpoint-campaign"));
  mkdirSync(root, { recursive: true });
  return root;
}

function totalBudget(checkpoints) {
  const segments = checkpoints + 1;
  return Object.freeze({
    turns: SEGMENT_POLICY.turns * segments,
    keyAttempts: SEGMENT_POLICY.keys * segments,
    frames: SEGMENT_POLICY.observations * segments,
    elapsedMs: SEGMENT_POLICY.elapsedMs * segments,
    checkpoints,
  });
}

function safeTokenCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) fail("MODEL_USAGE_INVALID", `${label} must be a nonnegative safe integer`);
  return value;
}

function addTokenCount(left, right, label) {
  const value = left + right;
  if (!Number.isSafeInteger(value)) fail("MODEL_USAGE_INVALID", `${label} overflowed`);
  return value;
}

export function aggregateTokens(records) {
  if (!Array.isArray(records)) throw new TypeError("usage records must be an array");
  const totals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let reportedTurns = 0;
  let missingTurns = 0;
  let known = false;
  for (const record of records) {
    if (!record) continue;
    if (record.semantics !== "TURN_DELTA" || !["COMPLETE", "PARTIAL", "UNKNOWN"].includes(record.completeness)) {
      fail("MODEL_USAGE_INVALID", "usage semantics or completeness is invalid");
    }
    reportedTurns = addTokenCount(reportedTurns, safeTokenCount(record.reportedTurns, "reportedTurns"), "reportedTurns");
    missingTurns = addTokenCount(missingTurns, safeTokenCount(record.missingTurns, "missingTurns"), "missingTurns");
    if (record.knownTotals) {
      known = true;
      for (const key of Object.keys(totals)) {
        totals[key] = addTokenCount(totals[key], safeTokenCount(record.knownTotals[key], key), key);
      }
      if (record.knownTotals.cachedInputTokens > record.knownTotals.inputTokens ||
          record.knownTotals.totalTokens !== record.knownTotals.inputTokens + record.knownTotals.outputTokens) {
        fail("MODEL_USAGE_INVALID", "usage totals are inconsistent");
      }
    }
  }
  if (known && (totals.cachedInputTokens > totals.inputTokens || totals.totalTokens !== totals.inputTokens + totals.outputTokens)) {
    fail("MODEL_USAGE_INVALID", "aggregate usage totals are inconsistent");
  }
  return {
    semantics: "TURN_DELTA",
    completeness: reportedTurns === 0 ? "UNKNOWN" : missingTurns === 0 ? "COMPLETE" : "PARTIAL",
    reportedTurns,
    missingTurns,
    knownTotals: known ? totals : null,
  };
}

export function shouldPublishTerminalEvidence(result) {
  return result?.status === "FINISHED" && Number.isSafeInteger(result.segments) && result.segments > 0;
}

function unavailableCost() {
  return {
    status: "UNAVAILABLE",
    actualChargedAmount: null,
    estimatedAmount: null,
    currency: null,
    reason: "MONETARY_COST_NOT_REPORTED_BY_CODEX_CLI",
  };
}

function safeFailure(error) {
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
    ? error.code
    : "CHECKPOINT_CAMPAIGN_FAILED";
  return { status: "FAILED", code };
}

export async function main(args = process.argv.slice(2), source = process.env) {
  const command = parseCampaignCommandLine(args);
  if (command.help) {
    printHelp();
    return { status: "HELP" };
  }
  const campaignId = randomUUID();
  const campaignDirectory = path.join(stateRoot(source), campaignId);
  mkdirSync(campaignDirectory, { recursive: false });
  const playerRuns = [];
  const wikiRuns = [];
  let firstSegment = true;
  const executablePath = findCodexExecutable(source);
  const ports = createCheckpointCampaignIntegration({
    campaignDirectory,
    topK: 12,
    executeSegment: async (request) => {
      const armDelayMs = firstSegment ? visionArmDelay(source) : 0;
      if (firstSegment && armDelayMs > 0) {
        process.stdout.write(`Focus the approved target window now (${armDelayMs} ms).\n`);
      }
      firstSegment = false;
      const segment = await runVisionSegment({
        source,
        openAIImageUploadConfirmed: true,
        knowledgeContext: request.knowledgeContext ?? undefined,
        policy: SEGMENT_POLICY,
        checkpointPolicy: request.checkpointPolicy,
        armDelayMs,
      });
      playerRuns.push({
        segmentOrdinal: request.segmentOrdinal,
        hostRunId: segment.hostRunId,
        outputDirectory: segment.runDirectory,
        status: segment.supervisorResult.status,
        reason: segment.supervisorResult.reason,
        ...(segment.supervisorResult.stopCode ? { stopCode: segment.supervisorResult.stopCode } : {}),
        usage: segment.usageRecord.tokens,
        monetaryCost: segment.usageRecord.monetaryCost,
      });
      return {
        runDirectory: segment.runDirectory,
        hostResult: segment.supervisorResult,
        accounting: segment.accounting,
        routingHint: {
          currentText: "current episode",
          currentEpisodeOrdinal: request.segmentOrdinal,
        },
      };
    },
    wikiModelFactory: async () => new CodexWikiModelPort({
      executablePath,
      env: source,
      timeoutMs: 180000,
    }),
    buildRevision: async (options) => {
      const result = await buildWikiRevision({
        ...options,
        onProgress: (message) => process.stdout.write(`${message}\n`),
      });
      wikiRuns.push({
        episodeOrdinal: wikiRuns.length + 1,
        revision: result.revision,
        selectedFrames: result.selectedFrames,
        modelCalls: result.modelCalls,
        usage: result.usage,
        monetaryCost: result.monetaryCost,
      });
      return result;
    },
  });
  const campaign = new CheckpointCampaignOrchestrator({
    campaignId,
    budget: totalBudget(command.checkpoints),
    checkpointPolicy: CHECKPOINT_POLICY,
    playSegment: ports.playSegment,
    publishWiki: ports.publishWiki,
    loadContext: ports.loadContext,
  });
  let result = await campaign.run();
  for (let retry = 0; retry < 2 && ["WAITING_FOR_WIKI", "WAITING_FOR_CONTEXT"].includes(result.status); retry += 1) {
    result = await campaign.run();
  }
  let terminalAck;
  if (shouldPublishTerminalEvidence(result)) {
    terminalAck = await ports.publishTerminalEvidence({ baseRevision: result.revision });
  }
  const ledgerFile = path.join(campaignDirectory, "ledger.json");
  writeFileSync(ledgerFile, `${JSON.stringify(campaign.ledgerSnapshot(), null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  let terminalReceiptFile;
  if (terminalAck !== undefined) {
    terminalReceiptFile = path.join(campaignDirectory, "terminal-evidence-receipt.json");
    writeFileSync(terminalReceiptFile, `${JSON.stringify({
      schemaVersion: "atlas/terminal-evidence-publication/1",
      campaignId,
      campaignState: result.status,
      campaignReason: result.reason,
      accountingBoundary: "POST_CAMPAIGN_OUTSIDE_LEDGER",
      checkpointAck: terminalAck,
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
  const summary = {
    status: result.status,
    reason: result.reason,
    campaignId,
    segments: result.segments,
    checkpoints: result.checkpoints,
    campaignRevision: result.revision,
    wikiRevision: terminalAck?.revision ?? result.revision,
    remaining: result.remaining,
    player: {
      runs: playerRuns,
      usage: aggregateTokens(playerRuns.map((run) => run.usage)),
      monetaryCost: unavailableCost(),
    },
    wiki: {
      episodes: wikiRuns,
      modelCalls: wikiRuns.reduce((sum, run) => sum + (run.modelCalls ?? 0), 0),
      usage: aggregateTokens(wikiRuns.map((run) => run.usage)),
      monetaryCost: unavailableCost(),
      terminalEvidencePublished: terminalAck !== undefined,
      terminalEvidenceAccounting: terminalAck === undefined ? "NONE" : "POST_CAMPAIGN_OUTSIDE_LEDGER",
      ...(terminalReceiptFile === undefined ? {} : { terminalReceiptFile }),
    },
    ledgerDigest: result.ledgerDigest,
    ledgerFile,
    outputDirectory: campaignDirectory,
    remoteImageUpload: "CONFIRMED",
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify(safeFailure(error))}\n`);
    process.exitCode = 1;
  });
}
