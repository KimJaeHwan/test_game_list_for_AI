import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { knowledgeContextReceipt, validateKnowledgeContext } from "../../05_vision_agent_host/src/supervisor/KnowledgeContext.mjs";
import { buildShardManifest, campaignDigest, createRelevantContextSelector } from "../../07_checkpoint_campaign/src/index.mjs";
import { buildWikiRevision } from "../assisted_wiki_loop/build-wiki.mjs";
import { loadVisionRunForWiki } from "../assisted_wiki_loop/vision-run-ingress.mjs";

const DIGEST = /^[a-f0-9]{64}$/u;
const SOURCE_REF = /^S[0-9]{6}$/u;
const ACK_SCHEMA = "atlas/wiki-checkpoint-ack/1";
const ROUTING_SCHEMA = "atlas/checkpoint-routing-receipt/1";
const MAX_CONTEXT_BYTES = 8192;

function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, keys, label) {
  if (!record(value)) throw new TypeError(`${label} must be a plain object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new TypeError(`${label} has an invalid shape`);
}
function digest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new TypeError(`${label} must be a SHA-256 digest`);
  return value;
}
function count(value, label, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0) || Object.is(value, -0)) throw new TypeError(`${label} must be a safe integer`);
  return value;
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) freeze(nested);
  }
  return value;
}
function cloneFreeze(value) { return freeze(structuredClone(value)); }
function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function canonicalDirectory(directory, label) {
  if (typeof directory !== "string" || !path.isAbsolute(directory) || directory.includes("\0")) throw new TypeError(`${label} must be absolute`);
  mkdirSync(directory, { recursive: true });
  const entry = lstatSync(directory);
  const canonical = realpathSync(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink() || !samePath(canonical, directory)) throw new TypeError(`${label} must be canonical`);
  return canonical;
}
function readBoundedJson(filePath, root, maximumBytes, label) {
  const requested = path.resolve(filePath);
  const relative = path.relative(path.resolve(root), requested);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) throw new TypeError(`${label} escaped its root`);
  const entry = lstatSync(requested);
  const canonical = realpathSync(requested);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size === 0 || entry.size > maximumBytes || !samePath(canonical, requested)) throw new TypeError(`${label} is invalid`);
  const bytes = readFileSync(canonical);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) };
}
function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}
function validateAccounting(value) {
  exact(value, ["turns", "keyAttempts", "frames", "elapsedMs"], "segment accounting");
  return Object.freeze({
    turns: count(value.turns, "accounting.turns"),
    keyAttempts: count(value.keyAttempts, "accounting.keyAttempts"),
    frames: count(value.frames, "accounting.frames"),
    elapsedMs: count(value.elapsedMs, "accounting.elapsedMs"),
  });
}
function validateRoutingHint(value, segmentOrdinal) {
  exact(value, ["currentText", "currentEpisodeOrdinal"], "routing hint");
  if (typeof value.currentText !== "string" || value.currentText.length === 0 || value.currentText.length > 2000 ||
      value.currentText.normalize("NFC") !== value.currentText || /[\u0000-\u001f\u007f-\u009f]/u.test(value.currentText)) {
    throw new TypeError("routing hint text is invalid");
  }
  if (count(value.currentEpisodeOrdinal, "currentEpisodeOrdinal", { positive: true }) !== segmentOrdinal) throw new TypeError("routing hint episode is invalid");
  return cloneFreeze(value);
}
function validatePlayBackendResult(value, segmentOrdinal) {
  exact(value, ["runDirectory", "hostResult", "accounting", "routingHint"], "play backend result");
  if (typeof value.runDirectory !== "string" || !path.isAbsolute(value.runDirectory)) throw new TypeError("runDirectory must be absolute");
  if (!record(value.hostResult) || value.hostResult.status !== "SEALED" || !["COMPLETE", "PARTIAL", "ABORT"].includes(value.hostResult.reason)) throw new TypeError("host result must be sealed");
  if (value.hostResult.continuation !== undefined && value.hostResult.reason !== "PARTIAL") throw new TypeError("only PARTIAL can continue");
  return {
    runDirectory: value.runDirectory,
    hostResult: value.hostResult,
    accounting: validateAccounting(value.accounting),
    routingHint: validateRoutingHint(value.routingHint, segmentOrdinal),
  };
}
function validatePlayRequest(value) {
  exact(value, ["sessionMode", "campaignId", "segmentOrdinal", "knowledgeContext", "remainingBudget", "checkpointPolicy"], "play request");
  if (value.sessionMode !== "FRESH") throw new TypeError("campaign segments must be fresh");
  count(value.segmentOrdinal, "segmentOrdinal", { positive: true });
  if (value.knowledgeContext !== null) validateKnowledgeContext(value.knowledgeContext);
  return value;
}
function validatePublishRequest(value) {
  exact(value, ["sourceRef", "sourceDigest", "baseRevision", "idempotencyKey"], "publish request");
  if (typeof value.sourceRef !== "string" || !SOURCE_REF.test(value.sourceRef)) throw new TypeError("sourceRef is invalid");
  digest(value.sourceDigest, "sourceDigest");
  count(value.baseRevision, "baseRevision");
  digest(value.idempotencyKey, "idempotencyKey");
  return value;
}

function verifyBuilderAck(result, request, publicationRoot) {
  if (!record(result) || result.status !== "PUBLISHED" || !record(result.checkpointAck)) throw new TypeError("Wiki builder omitted checkpoint ACK");
  const ack = result.checkpointAck;
  exact(ack, ["idempotencyKey", "sourceArtifactDigest", "baseRevision", "revision", "snapshotSha256", "playerContextSha256"], "builder ACK");
  if (ack.idempotencyKey !== request.idempotencyKey || ack.sourceArtifactDigest !== request.sourceDigest ||
      ack.baseRevision !== request.baseRevision || ack.revision !== request.baseRevision + 1) throw new TypeError("builder ACK does not bind request");
  digest(ack.snapshotSha256, "snapshotSha256");
  digest(ack.playerContextSha256, "playerContextSha256");
  const revisionRoot = path.join(publicationRoot, "revisions", `r${String(ack.revision).padStart(6, "0")}`);
  const playerContextFile = result.playerContextFile ?? path.join(revisionRoot, "player-context.json");
  const snapshotPath = result.snapshotFile ?? path.join(revisionRoot, `assisted-wiki-r${String(ack.revision).padStart(6, "0")}.json`);
  if (!samePath(path.dirname(playerContextFile), revisionRoot) || !samePath(path.dirname(snapshotPath), revisionRoot)) throw new TypeError("Wiki builder paths escaped publication root");
  const contextFile = readBoundedJson(playerContextFile, revisionRoot, MAX_CONTEXT_BYTES, "published context");
  const snapshotFile = readBoundedJson(snapshotPath, revisionRoot, 2 * 1024 * 1024, "published snapshot");
  if (sha256(contextFile.bytes) !== ack.playerContextSha256 || sha256(snapshotFile.bytes) !== ack.snapshotSha256) throw new TypeError("builder ACK digest mismatch");
  const ackFile = readBoundedJson(path.join(revisionRoot, "checkpoint-ack.json"), revisionRoot, 4096, "checkpoint ACK");
  exact(ackFile.value, ["schemaVersion", ...Object.keys(ack)], "checkpoint ACK file");
  if (ackFile.value.schemaVersion !== ACK_SCHEMA || Object.keys(ack).some((key) => ackFile.value[key] !== ack[key])) throw new TypeError("checkpoint ACK file mismatch");
  return { ack, context: validateKnowledgeContext(contextFile.value) };
}

function itemKey(item) { return campaignDigest({ kind: item.kind, title: item.title, body: item.body }); }
function catalogWithContext(catalog, context, sourceOrdinal) {
  const next = new Map(catalog);
  for (const guidance of context.guidance) {
    const key = itemKey(guidance);
    if (!next.has(key)) {
      next.set(key, Object.freeze({
        id: `K${key}`,
        kind: guidance.kind,
        title: guidance.title,
        body: guidance.body,
        sourceOrdinal,
        namespace: "general",
        pageKind: "NOTE",
      }));
    }
  }
  return next;
}

function persistRoutingRevision({ routingRoot, revision, manifest, items, selectedContext, sourceContextSha256 }) {
  const finalRoot = path.join(routingRoot, `r${String(revision).padStart(6, "0")}`);
  const workRoot = mkdtempSync(path.join(routingRoot, ".routing-"));
  try {
    writeJson(path.join(workRoot, "manifest.json"), manifest);
    writeJson(path.join(workRoot, "selected-context.json"), selectedContext);
    for (const shard of manifest.shards) {
      const output = path.join(workRoot, ...shard.path.split("/"));
      mkdirSync(path.dirname(output), { recursive: true });
      const ids = new Set(shard.itemIds);
      writeJson(output, {
        schemaVersion: "atlas/wiki-knowledge-shard/1",
        revision,
        path: shard.path,
        items: items.filter((item) => ids.has(item.id)),
      });
    }
    const selectedDigest = knowledgeContextReceipt(selectedContext).sha256;
    writeJson(path.join(workRoot, "receipt.json"), {
      schemaVersion: ROUTING_SCHEMA,
      revision,
      sourcePlayerContextSha256: sourceContextSha256,
      manifestDigest: manifest.digest,
      selectedContextSha256: selectedDigest,
      selectedItems: selectedContext.guidance.length,
    });
    renameSync(workRoot, finalRoot);
    return { contextFile: path.join(finalRoot, "selected-context.json"), selectedDigest };
  } catch (error) {
    if (samePath(path.dirname(workRoot), routingRoot) && path.basename(workRoot).startsWith(".routing-")) {
      rmSync(workRoot, { recursive: true, force: true });
    }
    throw error;
  }
}

/**
 * Bridges the campaign state machine to the existing Wiki publisher. The live
 * player boundary is injected because the current one-shot CLI does not expose
 * a reusable segment function.
 */
export function createCheckpointCampaignIntegration({
  campaignDirectory,
  executeSegment,
  wikiModelFactory,
  topK = 12,
  inspectRun = loadVisionRunForWiki,
  buildRevision = buildWikiRevision,
}) {
  if (typeof executeSegment !== "function" || typeof wikiModelFactory !== "function" ||
      typeof inspectRun !== "function" || typeof buildRevision !== "function") {
    throw new TypeError("integration ports are required");
  }
  count(topK, "topK", { positive: true });
  if (topK > 32) throw new TypeError("topK cannot exceed 32");
  const campaignRoot = canonicalDirectory(campaignDirectory, "campaignDirectory");
  const episodeRoot = canonicalDirectory(path.join(campaignRoot, "episodes"), "episode directory");
  const routingRoot = canonicalDirectory(path.join(campaignRoot, "routing"), "routing directory");
  const selector = createRelevantContextSelector({ topK });
  const sources = new Map();
  const contexts = new Map();
  const publishedAcks = new Map();
  const publishedSources = new Map();
  let lastSourceRef;
  let catalog = new Map();

  const playSegment = async (rawRequest) => {
    const request = validatePlayRequest(rawRequest);
    const backend = validatePlayBackendResult(await executeSegment(cloneFreeze(request)), request.segmentOrdinal);
    const ingress = await inspectRun(backend.runDirectory);
    const sourceDigest = digest(ingress?.source?.artifactDigest, "verified source digest");
    const sourceRef = `S${String(request.segmentOrdinal).padStart(6, "0")}`;
    if (sources.has(sourceRef)) throw new TypeError("sourceRef already exists");
    sources.set(sourceRef, Object.freeze({
      runDirectory: backend.runDirectory,
      sourceDigest,
      segmentOrdinal: request.segmentOrdinal,
      routingHint: backend.routingHint,
    }));
    lastSourceRef = sourceRef;
    return cloneFreeze({
      status: "SEALED",
      reason: backend.hostResult.reason,
      sourceDigest,
      sourceRef,
      accounting: backend.accounting,
      ...(backend.hostResult.continuation === undefined ? {} : { continuation: backend.hostResult.continuation }),
    });
  };

  const publishWiki = async (rawRequest) => {
    const request = validatePublishRequest(rawRequest);
    const source = sources.get(request.sourceRef);
    if (!source || source.sourceDigest !== request.sourceDigest) throw new TypeError("opaque sourceRef did not resolve");
    const replay = publishedAcks.get(request.idempotencyKey);
    if (replay !== undefined) return replay;
    const model = await wikiModelFactory(cloneFreeze({
      sourceRef: request.sourceRef,
      segmentOrdinal: source.segmentOrdinal,
      baseRevision: request.baseRevision,
    }));
    if (!model || typeof model.decide !== "function") throw new TypeError("wikiModelFactory must return a model port");
    const publicationRoot = canonicalDirectory(
      path.join(episodeRoot, `e${String(source.segmentOrdinal).padStart(6, "0")}`),
      "episode publication directory",
    );
    const result = await buildRevision({
      runDirectory: source.runDirectory,
      campaignDirectory: publicationRoot,
      model,
      checkpointRequest: {
        idempotencyKey: request.idempotencyKey,
        baseRevision: 0,
      },
    });
    const verified = verifyBuilderAck(result, { ...request, baseRevision: 0 }, publicationRoot);
    const candidateCatalog = catalogWithContext(catalog, verified.context, source.segmentOrdinal);
    const items = [...candidateCatalog.values()].sort((left, right) => left.id.localeCompare(right.id, "en"));
    const globalRevision = request.baseRevision + 1;
    const manifest = buildShardManifest({ revision: globalRevision, items });
    const selection = selector.select({
      revision: globalRevision,
      items,
      currentText: source.routingHint.currentText,
      currentEpisodeOrdinal: source.routingHint.currentEpisodeOrdinal,
    });
    const selectedContext = validateKnowledgeContext({
      schemaVersion: "atlas/player-knowledge-context/1",
      track: "ASSISTED",
      revision: globalRevision,
      guidance: selection.items.map(({ kind, title, body }) => ({ kind, title, body })),
    });
    const persisted = persistRoutingRevision({
      routingRoot,
      revision: globalRevision,
      manifest,
      items,
      selectedContext,
      sourceContextSha256: verified.ack.playerContextSha256,
    });
    catalog = candidateCatalog;
    contexts.set(globalRevision, Object.freeze({
      contextFile: persisted.contextFile,
      digest: persisted.selectedDigest,
    }));
    const campaignAck = Object.freeze({
      schemaVersion: ACK_SCHEMA,
      idempotencyKey: verified.ack.idempotencyKey,
      sourceArtifactDigest: verified.ack.sourceArtifactDigest,
      baseRevision: request.baseRevision,
      revision: globalRevision,
      snapshotSha256: verified.ack.snapshotSha256,
      playerContextSha256: persisted.selectedDigest,
    });
    publishedAcks.set(request.idempotencyKey, campaignAck);
    publishedSources.set(request.sourceDigest, campaignAck);
    return campaignAck;
  };

  const loadContext = async (rawRequest) => {
    exact(rawRequest, ["revision", "playerContextSha256"], "context request");
    const revision = count(rawRequest.revision, "revision", { positive: true });
    const expectedDigest = digest(rawRequest.playerContextSha256, "playerContextSha256");
    const stored = contexts.get(revision);
    if (!stored || stored.digest !== expectedDigest) throw new TypeError("context request does not match a routed revision");
    const loaded = readBoundedJson(stored.contextFile, path.dirname(stored.contextFile), MAX_CONTEXT_BYTES, "selected context");
    const context = validateKnowledgeContext(loaded.value);
    if (knowledgeContextReceipt(context).sha256 !== expectedDigest) throw new TypeError("selected context digest mismatch");
    return context;
  };

  const publishTerminalEvidence = async (rawRequest) => {
    exact(rawRequest, ["baseRevision"], "terminal publish request");
    const baseRevision = count(rawRequest.baseRevision, "baseRevision");
    if (lastSourceRef === undefined) throw new TypeError("no sealed source is available");
    const source = sources.get(lastSourceRef);
    if (publishedSources.has(source.sourceDigest)) return publishedSources.get(source.sourceDigest);
    return publishWiki({
      sourceRef: lastSourceRef,
      sourceDigest: source.sourceDigest,
      baseRevision,
      idempotencyKey: campaignDigest({
        purpose: "TERMINAL_EVIDENCE",
        sourceDigest: source.sourceDigest,
        baseRevision,
      }),
    });
  };

  return Object.freeze({ playSegment, publishWiki, loadContext, publishTerminalEvidence });
}
