import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildAssistedWikiSnapshot,
  buildAssistedWikiSnapshotFromDeltas,
  createPlayerKnowledgeContext,
  migrateAssistedWikiSnapshot,
  persistAssistedWikiSnapshot,
  renderAssistedWiki,
  validateAssistedWikiSnapshot,
  validateKnowledgeProposal,
  validateSource,
} from "../../06_assisted_wiki_loop/src/core/index.mjs";
import {
  CodexWikiModelPort,
  createKnowledgeProposalSchema,
} from "../../06_assisted_wiki_loop/src/model/index.mjs";
import { validateKnowledgeContext } from "../../05_vision_agent_host/src/supervisor/index.mjs";
import { findCodexExecutable } from "../../05_vision_agent_host/scripts/run-codex-player.mjs";
import { createWikiAnalysisPrompt, loadVisionRunForWiki } from "./vision-run-ingress.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(SCRIPT_DIRECTORY, "..", "..");
const CONFIRMATION = "--confirm-openai-upload";
const LEGACY_CONFIRMATION = "--allow-legacy-unattested";
const MODEL_FAILURE_RECOVERY = "--allow-recoverable-model-failure";
const REVISION_DIRECTORY = /^r(\d{6})$/u;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_PLAYER_CONTEXT_BYTES = 8192;
const MAX_CHECKPOINT_ACK_BYTES = 4096;
const CHECKPOINT_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const EMPTY_PREFLIGHT_PROPOSAL = Object.freeze({
  summary: "",
  pages: Object.freeze([]),
  cases: Object.freeze([]),
  openQuestions: Object.freeze([]),
});

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function coreValidation(code, message, operation) {
  try {
    return operation();
  } catch {
    fail(code, message);
  }
}

function preflightWikiBuildInputs(previousSnapshot, source) {
  coreValidation(
    "WIKI_INPUT_PRECHECK_FAILED",
    "verified source or campaign state exceeded the bounded Wiki contract",
    () => {
      validateSource(source);
      buildAssistedWikiSnapshot({
        previousSnapshot,
        proposal: EMPTY_PREFLIGHT_PROPOSAL,
        source,
      });
    },
  );
}

function samePath(left, right) {
  const a = path.normalize(left);
  const b = path.normalize(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function writeExclusive(filePath, value) {
  const handle = openSync(filePath, "wx", 0o600);
  try {
    writeFileSync(handle, value);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function writeJsonExclusive(filePath, value) {
  writeExclusive(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function checkpointRequestValue(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail("CHECKPOINT_REQUEST_INVALID", "checkpointRequest must be a plain object");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    fail("CHECKPOINT_REQUEST_INVALID", "checkpointRequest cannot contain symbol keys");
  }
  keys.sort();
  if (keys.length !== 2 || keys[0] !== "baseRevision" || keys[1] !== "idempotencyKey") {
    fail("CHECKPOINT_REQUEST_INVALID", "checkpointRequest must contain exactly idempotencyKey and baseRevision");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!Object.prototype.hasOwnProperty.call(descriptors.baseRevision, "value") ||
    !Object.prototype.hasOwnProperty.call(descriptors.idempotencyKey, "value")) {
    fail("CHECKPOINT_REQUEST_INVALID", "checkpointRequest must contain data properties only");
  }
  if (!CHECKPOINT_IDEMPOTENCY_KEY.test(value.idempotencyKey) ||
    !Number.isSafeInteger(value.baseRevision) || value.baseRevision < 0) {
    fail("CHECKPOINT_REQUEST_INVALID", "checkpointRequest fields are invalid");
  }
  return Object.freeze({ idempotencyKey: value.idempotencyKey, baseRevision: value.baseRevision });
}

function boundedRegularFile(filePath, root, maximum, label) {
  let entry;
  try {
    entry = lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("CAMPAIGN_STATE_INVALID", `${label} could not be inspected`);
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size === 0 || entry.size > maximum ||
    !samePath(realpathSync(filePath), filePath) || !samePath(path.dirname(filePath), root)) {
    fail("CAMPAIGN_STATE_INVALID", `${label} is invalid`);
  }
  return readFileSync(filePath);
}

function recoverCheckpointAck(revisionsRoot, snapshot, sourceArtifactDigest, request) {
  const revisionName = `r${String(snapshot.revision).padStart(6, "0")}`;
  const revisionRoot = path.join(revisionsRoot, revisionName);
  const ackBytes = boundedRegularFile(
    path.join(revisionRoot, "checkpoint-ack.json"),
    revisionRoot,
    MAX_CHECKPOINT_ACK_BYTES,
    "checkpoint acknowledgment",
  );
  if (ackBytes === null) return null;
  let ack;
  try {
    ack = JSON.parse(ackBytes.toString("utf8"));
  } catch {
    fail("CAMPAIGN_STATE_INVALID", "checkpoint acknowledgment is invalid JSON");
  }
  const expectedKeys = [
    "baseRevision",
    "idempotencyKey",
    "playerContextSha256",
    "revision",
    "schemaVersion",
    "snapshotSha256",
    "sourceArtifactDigest",
  ];
  if (ack === null || typeof ack !== "object" || Array.isArray(ack) ||
    Object.keys(ack).sort().some((key, index) => key !== expectedKeys[index]) ||
    Object.keys(ack).length !== expectedKeys.length ||
    ack.schemaVersion !== "atlas/wiki-checkpoint-ack/1" ||
    !CHECKPOINT_IDEMPOTENCY_KEY.test(ack.idempotencyKey) ||
    !Number.isSafeInteger(ack.baseRevision) || ack.baseRevision < 0 ||
    !Number.isSafeInteger(ack.revision) || ack.revision !== snapshot.revision ||
    ack.baseRevision + 1 !== ack.revision ||
    !SHA256.test(ack.sourceArtifactDigest) || !SHA256.test(ack.snapshotSha256) ||
    !SHA256.test(ack.playerContextSha256) ||
    !snapshot.sources.some((source) => source.artifactDigest === ack.sourceArtifactDigest)) {
    fail("CAMPAIGN_STATE_INVALID", "checkpoint acknowledgment failed validation");
  }
  if (
    ack.sourceArtifactDigest !== sourceArtifactDigest ||
    ack.idempotencyKey !== request.idempotencyKey ||
    ack.baseRevision !== request.baseRevision
  ) return null;
  const snapshotBytes = boundedRegularFile(
    path.join(revisionRoot, `assisted-wiki-r${String(snapshot.revision).padStart(6, "0")}.json`),
    revisionRoot,
    MAX_SNAPSHOT_BYTES,
    "checkpoint snapshot",
  );
  const contextBytes = boundedRegularFile(
    path.join(revisionRoot, "player-context.json"),
    revisionRoot,
    MAX_PLAYER_CONTEXT_BYTES,
    "checkpoint player context",
  );
  try {
    validateKnowledgeContext(JSON.parse(contextBytes.toString("utf8")));
  } catch {
    fail("CAMPAIGN_STATE_INVALID", "checkpoint player context failed validation");
  }
  if (sha256Bytes(snapshotBytes) !== ack.snapshotSha256 ||
    sha256Bytes(contextBytes) !== ack.playerContextSha256) {
    fail("CAMPAIGN_STATE_INVALID", "checkpoint artifact digest did not match published bytes");
  }
  return Object.freeze({
    idempotencyKey: ack.idempotencyKey,
    sourceArtifactDigest: ack.sourceArtifactDigest,
    baseRevision: ack.baseRevision,
    revision: ack.revision,
    snapshotSha256: ack.snapshotSha256,
    playerContextSha256: ack.playerContextSha256,
  });
}

function canonicalCampaignDirectory(candidate) {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate) || candidate.includes("\0")) {
    fail("CAMPAIGN_DIRECTORY_INVALID", "campaign directory must be absolute");
  }
  const requested = path.resolve(candidate);
  mkdirSync(requested, { recursive: true });
  const entry = lstatSync(requested);
  const canonical = realpathSync(requested);
  if (!entry.isDirectory() || entry.isSymbolicLink() || !samePath(requested, canonical)) {
    fail("CAMPAIGN_DIRECTORY_INVALID", "campaign directory must be canonical");
  }
  return canonical;
}

function readPreviousSnapshot(revisionsRoot) {
  const revisions = [];
  for (const entry of readdirSync(revisionsRoot, { withFileTypes: true })) {
    const match = REVISION_DIRECTORY.exec(entry.name);
    if (!match) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail("CAMPAIGN_STATE_INVALID", "revision entry is not a directory");
    revisions.push({ number: Number(match[1]), name: entry.name });
  }
  revisions.sort((left, right) => left.number - right.number);
  revisions.forEach((entry, index) => {
    if (entry.number !== index + 1) fail("CAMPAIGN_STATE_INVALID", "revision sequence is not contiguous");
  });
  if (revisions.length === 0) return { snapshot: null, nextRevision: 1 };
  const latest = revisions.at(-1);
  const revisionRoot = path.join(revisionsRoot, latest.name);
  const canonicalRevision = realpathSync(revisionRoot);
  if (!samePath(revisionRoot, canonicalRevision) || !samePath(path.dirname(canonicalRevision), revisionsRoot)) {
    fail("CAMPAIGN_STATE_INVALID", "revision escaped campaign state");
  }
  const snapshotPath = path.join(revisionRoot, `assisted-wiki-r${String(latest.number).padStart(6, "0")}.json`);
  let bytes;
  try {
    const entry = lstatSync(snapshotPath);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size === 0 || entry.size > MAX_SNAPSHOT_BYTES) throw new Error();
    if (!samePath(snapshotPath, realpathSync(snapshotPath))) throw new Error();
    bytes = readFileSync(snapshotPath);
  } catch {
    fail("CAMPAIGN_STATE_INVALID", "latest revision snapshot is missing or invalid");
  }
  let snapshot;
  try {
    snapshot = migrateAssistedWikiSnapshot(JSON.parse(bytes.toString("utf8")));
    validateAssistedWikiSnapshot(snapshot);
  } catch {
    fail("CAMPAIGN_STATE_INVALID", "latest revision snapshot failed validation");
  }
  if (snapshot.revision !== latest.number) fail("CAMPAIGN_STATE_INVALID", "snapshot revision does not match its directory");
  return { snapshot, nextRevision: latest.number + 1 };
}

function usageRecord(usages) {
  if (!Array.isArray(usages) || usages.length < 1 || usages.length > 10) {
    fail("MODEL_USAGE_INVALID", "Wiki model usage call count is invalid");
  }
  const totals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  let reportedTurns = 0;
  let missingTurns = 0;
  for (const usage of usages) {
    if (usage === undefined) {
      missingTurns += 1;
      continue;
    }
    const keys = usage !== null && typeof usage === "object" && !Array.isArray(usage)
      ? Object.keys(usage).sort()
      : [];
    if (
      keys.length !== 3 ||
      !["cachedInputTokens", "inputTokens", "outputTokens"].every((key, index) => keys[index] === key) ||
      !keys.every((key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0 && !Object.is(usage[key], -0)) ||
      usage.cachedInputTokens > usage.inputTokens
    ) fail("MODEL_USAGE_INVALID", "Wiki model usage did not match the bounded token schema");
    for (const key of ["inputTokens", "cachedInputTokens", "outputTokens"]) {
      totals[key] += usage[key];
      if (!Number.isSafeInteger(totals[key])) fail("MODEL_USAGE_INVALID", "Wiki model usage total overflowed");
    }
    if (!Number.isSafeInteger(totals.inputTokens + totals.outputTokens)) {
      fail("MODEL_USAGE_INVALID", "Wiki model total token usage overflowed");
    }
    reportedTurns += 1;
  }
  const completeness = reportedTurns === 0
    ? "UNKNOWN"
    : missingTurns === 0 ? "COMPLETE" : "PARTIAL";
  const tokens = {
    semantics: "TURN_DELTA",
    completeness,
    reportedTurns,
    missingTurns,
    knownTotals: reportedTurns === 0 ? null : {
      ...totals,
      totalTokens: totals.inputTokens + totals.outputTokens,
    },
  };
  return {
    schemaVersion: "atlas/wiki-model-usage/2",
    tokens,
    monetaryCost: {
      status: "UNAVAILABLE",
      actualChargedAmount: null,
      estimatedAmount: null,
      currency: null,
      reason: "MONETARY_COST_NOT_REPORTED_BY_CODEX_CLI",
    },
  };
}

function publishMarkdown(publishRoot, rendered) {
  const wikiRoot = path.join(publishRoot, "wiki");
  mkdirSync(wikiRoot, { recursive: false });
  for (const file of rendered.files) {
    if (
      typeof file.path !== "string" || !/^[a-z0-9_./-]+$/u.test(file.path) ||
      path.posix.isAbsolute(file.path) || path.posix.normalize(file.path) !== file.path ||
      file.path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) fail("WIKI_RENDER_INVALID", "renderer returned an unsafe path");
    const output = path.join(wikiRoot, ...file.path.split("/"));
    const relative = path.relative(wikiRoot, output);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) fail("WIKI_RENDER_INVALID", "renderer path escaped wiki root");
    mkdirSync(path.dirname(output), { recursive: true });
    writeExclusive(output, file.content);
  }
}

function safeCleanup(workRoot, campaignRoot) {
  if (!workRoot) return;
  const candidate = path.resolve(workRoot);
  if (!samePath(path.dirname(candidate), campaignRoot) || !path.basename(candidate).startsWith(".wiki-build-")) {
    fail("WORK_DIRECTORY_INVALID", "refused to clean an unexpected work directory");
  }
  try {
    rmSync(candidate, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    fail("WORK_DIRECTORY_CLEANUP_FAILED", "could not remove the private Wiki work directory");
  }
}

export function parseWikiBuilderCommandLine(args) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) throw new TypeError("args must be strings");
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { help: true };
  let confirmed = false;
  let allowLegacyUnattested = false;
  let allowRecoverableModelFailure = false;
  let runDirectory;
  let campaignDirectory;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === CONFIRMATION && !confirmed) confirmed = true;
    else if (argument === LEGACY_CONFIRMATION && !allowLegacyUnattested) allowLegacyUnattested = true;
    else if (argument === MODEL_FAILURE_RECOVERY && !allowRecoverableModelFailure) {
      allowRecoverableModelFailure = true;
    }
    else if (argument === "--run" && runDirectory === undefined && index + 1 < args.length) runDirectory = args[++index];
    else if (argument === "--campaign" && campaignDirectory === undefined && index + 1 < args.length) campaignDirectory = args[++index];
    else fail("COMMAND_LINE_INVALID", "unknown, duplicate, or incomplete command-line option");
  }
  if (allowLegacyUnattested && allowRecoverableModelFailure) {
    fail("COMMAND_LINE_INVALID", "legacy and model-failure recovery options cannot be combined");
  }
  return {
    help: false,
    confirmed,
    allowLegacyUnattested,
    allowRecoverableModelFailure,
    runDirectory,
    campaignDirectory,
  };
}

export async function buildWikiRevision({
  runDirectory,
  campaignDirectory,
  model,
  onProgress = () => {},
  allowLegacyUnattested = false,
  allowRecoverableModelFailure = false,
  checkpointRequest,
}) {
  if (!model || typeof model.decide !== "function") throw new TypeError("model port is required");
  const checkpoint = checkpointRequestValue(checkpointRequest);
  const campaignRoot = canonicalCampaignDirectory(campaignDirectory);
  const revisionsRoot = path.join(campaignRoot, "revisions");
  mkdirSync(revisionsRoot, { recursive: true });
  const canonicalRevisions = realpathSync(revisionsRoot);
  if (!samePath(revisionsRoot, canonicalRevisions) || !samePath(path.dirname(canonicalRevisions), campaignRoot)) {
    fail("CAMPAIGN_STATE_INVALID", "revisions directory escaped campaign root");
  }
  const { snapshot: previousSnapshot, nextRevision } = readPreviousSnapshot(canonicalRevisions);
  onProgress("Validating sealed play evidence...");
  const ingress = await loadVisionRunForWiki(runDirectory, {
    allowLegacyUnattested,
    allowRecoverableModelFailure,
  });
  if (previousSnapshot?.sources.some((source) => source.artifactDigest === ingress.source.artifactDigest)) {
    if (checkpoint !== undefined) {
      const checkpointAck = recoverCheckpointAck(
        canonicalRevisions,
        previousSnapshot,
        ingress.source.artifactDigest,
        checkpoint,
      );
      if (checkpointAck !== null) {
        return {
          status: "PUBLISHED",
          track: "ASSISTED",
          revision: checkpointAck.revision,
          checkpointAck,
          idempotentReplay: true,
          remoteImageUpload: "CONFIRMED",
        };
      }
    }
    fail("SOURCE_ALREADY_IMPORTED", "source artifact was already imported; a new play run is required");
  }
  const actualBaseRevision = previousSnapshot?.revision ?? 0;
  if (checkpoint !== undefined && checkpoint.baseRevision !== actualBaseRevision) {
    fail("CHECKPOINT_BASE_REVISION_MISMATCH", "checkpoint base revision does not match campaign state");
  }
  preflightWikiBuildInputs(previousSnapshot, ingress.source);
  const priorKnowledge = previousSnapshot === null
    ? null
    : validateKnowledgeContext(JSON.parse(createPlayerKnowledgeContext(previousSnapshot, { maxBytes: 4096 })));

  let workRoot;
  let primaryError;
  try {
    workRoot = mkdtempSync(path.join(campaignRoot, ".wiki-build-"));
    const modelRoot = path.join(workRoot, "model");
    const evidenceRoot = path.join(workRoot, "verified-evidence");
    mkdirSync(modelRoot, { recursive: false });
    mkdirSync(evidenceRoot, { recursive: false });
    const imagePathByFrameId = new Map();
    for (const image of ingress.analysisBatches.flatMap((batch) => batch.verifiedImages)) {
      const output = path.join(evidenceRoot, `${image.frameId}.png`);
      writeExclusive(output, image.bytes);
      imagePathByFrameId.set(image.frameId, output);
    }
    const decisions = [];
    const deltas = [];
    for (const batch of ingress.analysisBatches) {
      const batchName = `b${String(batch.batchOrdinal).padStart(6, "0")}`;
      const batchRoot = path.join(modelRoot, batchName);
      mkdirSync(batchRoot, { recursive: false });
      const imagePaths = batch.frameIds.map((frameId) => imagePathByFrameId.get(frameId));
      const schemaPath = path.join(batchRoot, "knowledge-proposal.schema.json");
      const outputPath = path.join(batchRoot, "knowledge-proposal.json");
      writeJsonExclusive(schemaPath, createKnowledgeProposalSchema(batch.frameIds));
      const prompt = createWikiAnalysisPrompt(batch.evidenceIndex, priorKnowledge);
      onProgress(
        `Generating assisted wiki proposal batch ${batch.batchOrdinal}/${ingress.analysisBatches.length} from ${imagePaths.length} verified frames...`,
      );
      const decision = await model.decide({
        prompt,
        imagePaths,
        schemaPath,
        outputPath,
        workdir: batchRoot,
      });
      const batchSource = { ...ingress.source, availableFrameIds: batch.frameIds };
      const proposal = coreValidation(
        "MODEL_PROPOSAL_INVALID",
        "Wiki model proposal failed the bounded knowledge contract",
        () => validateKnowledgeProposal(decision?.proposal, batchSource),
      );
      decisions.push(decision);
      deltas.push({
        batchOrdinal: batch.batchOrdinal,
        frameIds: batch.frameIds,
        proposal,
      });
    }
    const snapshot = coreValidation(
      "WIKI_MERGE_INVALID",
      "Wiki proposals could not be merged into the current campaign revision",
      () => buildAssistedWikiSnapshotFromDeltas({ previousSnapshot, deltas, source: ingress.source }),
    );
    if (snapshot.revision !== nextRevision) fail("CAMPAIGN_STATE_INVALID", "computed revision is inconsistent");
    const contextText = createPlayerKnowledgeContext(snapshot, { maxBytes: 4096 });
    const context = validateKnowledgeContext(JSON.parse(contextText));
    const rendered = renderAssistedWiki(snapshot);
    const usage = usageRecord(decisions.map((decision) => decision?.usage));
    const analyzedFrameIds = ingress.analysisBatches.flatMap((batch) => batch.frameIds);
    const analysisBatches = ingress.analysisBatches.map((batch) => ({
      batchOrdinal: batch.batchOrdinal,
      frameIds: batch.frameIds,
    }));

    const publishRoot = path.join(workRoot, "publish");
    mkdirSync(publishRoot, { recursive: false });
    const temporarySnapshotPath = await persistAssistedWikiSnapshot(publishRoot, snapshot);
    publishMarkdown(publishRoot, rendered);
    const temporaryContextPath = path.join(publishRoot, "player-context.json");
    writeJsonExclusive(temporaryContextPath, context);
    writeJsonExclusive(path.join(publishRoot, "usage.json"), usage);
    writeJsonExclusive(path.join(publishRoot, "source.json"), {
      schemaVersion: "atlas/assisted-wiki-source/3",
      hostStatus: ingress.hostStatus,
      contentStatus: ingress.source.status,
      explorationTrack: ingress.source.explorationTrack,
      knowledgeAttestation: ingress.source.knowledgeAttestation,
      provenance: ingress.source.provenance,
      artifactDigest: ingress.source.artifactDigest,
      selectedFrameIds: analyzedFrameIds,
      analysisBatches,
    });
    const checkpointAck = checkpoint === undefined
      ? undefined
      : Object.freeze({
          idempotencyKey: checkpoint.idempotencyKey,
          sourceArtifactDigest: ingress.source.artifactDigest,
          baseRevision: checkpoint.baseRevision,
          revision: snapshot.revision,
          snapshotSha256: sha256Bytes(readFileSync(temporarySnapshotPath)),
          playerContextSha256: sha256Bytes(readFileSync(temporaryContextPath)),
        });
    if (checkpointAck !== undefined) {
      writeJsonExclusive(path.join(publishRoot, "checkpoint-ack.json"), {
        schemaVersion: "atlas/wiki-checkpoint-ack/1",
        ...checkpointAck,
      });
    }

    const revisionName = `r${String(snapshot.revision).padStart(6, "0")}`;
    const finalRoot = path.join(canonicalRevisions, revisionName);
    renameSync(publishRoot, finalRoot);
    const snapshotFile = path.join(finalRoot, path.basename(temporarySnapshotPath));
    return {
      status: "PUBLISHED",
      track: "ASSISTED",
      revision: snapshot.revision,
      source: {
        hostStatus: ingress.hostStatus,
        contentStatus: ingress.source.status,
        explorationTrack: ingress.source.explorationTrack,
        knowledgeAttestation: ingress.source.knowledgeAttestation,
        provenance: ingress.source.provenance,
      },
      selectedFrames: analyzedFrameIds.length,
      modelCalls: ingress.analysisBatches.length,
      pages: snapshot.pages.length,
      cases: snapshot.cases.length,
      openQuestions: snapshot.openQuestions.length,
      wikiIndex: path.join(finalRoot, "wiki", "index.md"),
      snapshotFile,
      playerContextFile: path.join(finalRoot, "player-context.json"),
      usage: usage.tokens,
      monetaryCost: usage.monetaryCost,
      remoteImageUpload: "CONFIRMED",
      ...(checkpointAck === undefined ? {} : { checkpointAck }),
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      safeCleanup(workRoot, campaignRoot);
    } catch (cleanupError) {
      if (primaryError === undefined) throw cleanupError;
    }
  }
}

function requireCodexLogin(executablePath, environment) {
  const check = spawnSync(executablePath, ["login", "status"], {
    env: environment,
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    timeout: 15_000,
  });
  if (check.error || check.status !== 0) fail("CODEX_LOGIN_REQUIRED", "Codex CLI is not logged in");
}

function printHelp() {
  process.stdout.write([
    "Usage: wiki-builder.cmd --confirm-openai-upload --run <absolute vision outputDirectory> [--campaign <absolute campaign directory>] [--allow-legacy-unattested | --allow-recoverable-model-failure]",
    "",
    "All verified screenshots are uploaded to OpenAI in up to 10 fresh Wiki Agent turns of at most 12 images each.",
    "--allow-recoverable-model-failure accepts only the narrowly verified legacy MODEL_TURN_FAILED quarantine.",
    "The default campaign directory is agent_tools/.local/assisted-wiki/default.",
    "Each successful call publishes a new immutable ASSISTED revision and player-context.json.",
    "",
  ].join("\n"));
}

function safeFailure(error) {
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
    ? error.code
    : "WIKI_BUILD_FAILED";
  return { status: "FAILED", code };
}

export async function main(args = process.argv.slice(2), source = process.env) {
  const command = parseWikiBuilderCommandLine(args);
  if (command.help) {
    printHelp();
    return { status: "HELP" };
  }
  if (!command.confirmed) fail("REMOTE_UPLOAD_NOT_CONFIRMED", "explicit OpenAI screenshot upload confirmation is required");
  if (typeof command.runDirectory !== "string" || !path.isAbsolute(command.runDirectory)) {
    fail("RUN_DIRECTORY_REQUIRED", "--run must be an absolute Vision outputDirectory");
  }
  const campaignDirectory = command.campaignDirectory ?? path.join(TOOL_ROOT, ".local", "assisted-wiki", "default");
  if (!path.isAbsolute(campaignDirectory)) fail("CAMPAIGN_DIRECTORY_INVALID", "--campaign must be absolute");
  const executablePath = findCodexExecutable(source);
  const model = new CodexWikiModelPort({ executablePath, env: source, timeoutMs: 180_000 });
  requireCodexLogin(executablePath, model.env);
  const result = await buildWikiRevision({
    runDirectory: path.resolve(command.runDirectory),
    campaignDirectory: path.resolve(campaignDirectory),
    model,
    allowLegacyUnattested: command.allowLegacyUnattested,
    allowRecoverableModelFailure: command.allowRecoverableModelFailure,
    onProgress: (message) => process.stdout.write(`${message}\n`),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify(safeFailure(error))}\n`);
    process.exitCode = 1;
  });
}
