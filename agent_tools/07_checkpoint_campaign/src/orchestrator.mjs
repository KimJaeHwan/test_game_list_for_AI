import { knowledgeContextReceipt, validateKnowledgeContext } from "../../05_vision_agent_host/src/supervisor/KnowledgeContext.mjs";

import {
  DeterministicCampaignLedger,
  campaignDigest,
  coarseCampaignErrorCode,
  validateAccounting,
  validateBudget,
} from "./ledger.mjs";

const DIGEST = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/u;
const RECEIPT_SCHEMA = "atlas/vision-checkpoint-continuation/1";
const ACK_SCHEMA = "atlas/wiki-checkpoint-ack/1";
const CAUSES = new Set(["MODEL_INPUT_TOKENS", "MODEL_USAGE_MISSING", "KEY_ATTEMPTS", "FRAMES"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value, keys, label) {
  if (!isRecord(value)) throw new TypeError(`${label} must be a plain object`);
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} has an invalid shape`);
  }
}

function count(value, label, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0) || Object.is(value, -0)) {
    throw new TypeError(`${label} must be a ${positive ? "positive" : "nonnegative"} safe integer`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new TypeError(`${label} must be a SHA-256 digest`);
  return value;
}

function safeId(value, label) {
  if (typeof value !== "string" || !ID.test(value)) throw new TypeError(`${label} must be a safe opaque identifier`);
  return value;
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) freeze(nested);
  }
  return value;
}

function cloneFreeze(value) {
  return freeze(structuredClone(value));
}

function validateCheckpointPolicy(value) {
  exact(value, ["modelInputTokens", "keyAttempts", "frames", "onMissingUsage"], "checkpointPolicy");
  for (const key of ["modelInputTokens", "keyAttempts", "frames"]) count(value[key], `checkpointPolicy.${key}`);
  if (typeof value.onMissingUsage !== "boolean") throw new TypeError("checkpointPolicy.onMissingUsage must be a boolean");
  if (value.modelInputTokens === 0 && value.keyAttempts === 0 && value.frames === 0 && value.onMissingUsage === false) {
    throw new TypeError("checkpointPolicy must enable a trigger");
  }
  return cloneFreeze(value);
}

function validateContinuation(value, sourceDigest, accounting) {
  exact(value, ["schemaVersion", "status", "causes", "boundary", "sealDigests"], "continuation");
  if (value.schemaVersion !== RECEIPT_SCHEMA || value.status !== "CHECKPOINT_REQUIRED") {
    throw new TypeError("continuation schema or status is invalid");
  }
  if (!Array.isArray(value.causes) || value.causes.length === 0 || new Set(value.causes).size !== value.causes.length || value.causes.some((cause) => !CAUSES.has(cause))) {
    throw new TypeError("continuation causes are invalid");
  }
  exact(value.boundary, ["completedTurns", "keyAttempts", "observations", "modelSessionGeneration", "frameId", "frameSha256", "knowledgeRevision", "knowledgeContextSha256"], "continuation boundary");
  const boundary = {
    completedTurns: count(value.boundary.completedTurns, "completedTurns"),
    keyAttempts: count(value.boundary.keyAttempts, "keyAttempts"),
    observations: count(value.boundary.observations, "observations"),
    modelSessionGeneration: count(value.boundary.modelSessionGeneration, "modelSessionGeneration"),
    frameId: safeId(value.boundary.frameId, "frameId"),
    frameSha256: digest(value.boundary.frameSha256, "frameSha256"),
    knowledgeRevision: value.boundary.knowledgeRevision === null ? null : count(value.boundary.knowledgeRevision, "knowledgeRevision", { positive: true }),
    knowledgeContextSha256: value.boundary.knowledgeContextSha256 === null ? null : digest(value.boundary.knowledgeContextSha256, "knowledgeContextSha256"),
  };
  if ((boundary.knowledgeRevision === null) !== (boundary.knowledgeContextSha256 === null)) throw new TypeError("knowledge boundary is incomplete");
  if (boundary.completedTurns !== accounting.turns || boundary.keyAttempts !== accounting.keyAttempts || boundary.observations !== accounting.frames) {
    throw new TypeError("continuation accounting does not match the sealed segment");
  }
  if (!Array.isArray(value.sealDigests) || value.sealDigests.length === 0 || new Set(value.sealDigests).size !== value.sealDigests.length) {
    throw new TypeError("sealDigests are invalid");
  }
  const seals = value.sealDigests.map((item, index) => digest(item, `sealDigests[${index}]`));
  if (!seals.includes(sourceDigest)) throw new TypeError("sourceDigest is not bound by the seal receipt");
  return cloneFreeze({ ...value, boundary, sealDigests: seals });
}

function validateSegment(value) {
  if (!isRecord(value)) throw new TypeError("segment result must be a plain object");
  const keys = value.continuation === undefined
    ? ["status", "reason", "sourceDigest", "sourceRef", "accounting"]
    : ["status", "reason", "sourceDigest", "sourceRef", "accounting", "continuation"];
  exact(value, keys, "segment result");
  if (value.status !== "SEALED" || !["COMPLETE", "PARTIAL", "ABORT"].includes(value.reason)) {
    throw new TypeError("segment status or reason is invalid");
  }
  const projected = {
    status: "SEALED",
    reason: value.reason,
    sourceDigest: digest(value.sourceDigest, "sourceDigest"),
    sourceRef: safeId(value.sourceRef, "sourceRef"),
    accounting: validateAccounting(value.accounting),
  };
  if (value.continuation !== undefined) {
    if (value.reason !== "PARTIAL") throw new TypeError("only PARTIAL segments can contain a continuation receipt");
    projected.continuation = validateContinuation(value.continuation, projected.sourceDigest, projected.accounting);
  }
  return cloneFreeze(projected);
}

function validateAck(value, expected) {
  exact(value, ["schemaVersion", "idempotencyKey", "sourceArtifactDigest", "baseRevision", "revision", "snapshotSha256", "playerContextSha256"], "wiki ACK");
  if (value.schemaVersion !== ACK_SCHEMA) throw new TypeError("wiki ACK schema is invalid");
  const ack = {
    schemaVersion: ACK_SCHEMA,
    idempotencyKey: digest(value.idempotencyKey, "idempotencyKey"),
    sourceArtifactDigest: digest(value.sourceArtifactDigest, "sourceArtifactDigest"),
    baseRevision: count(value.baseRevision, "baseRevision"),
    revision: count(value.revision, "revision", { positive: true }),
    snapshotSha256: digest(value.snapshotSha256, "snapshotSha256"),
    playerContextSha256: digest(value.playerContextSha256, "playerContextSha256"),
  };
  if (ack.idempotencyKey !== expected.idempotencyKey || ack.sourceArtifactDigest !== expected.sourceDigest || ack.baseRevision !== expected.baseRevision || ack.revision !== expected.baseRevision + 1) {
    throw new TypeError("wiki ACK does not exactly bind the publish request");
  }
  return cloneFreeze(ack);
}

function subtractBudget(remaining, accounting) {
  const next = { ...remaining };
  for (const key of ["turns", "keyAttempts", "frames", "elapsedMs"]) {
    if (accounting[key] > next[key]) throw Object.assign(new Error("sealed segment exceeded campaign budget"), { code: "BUDGET_EXCEEDED" });
    next[key] -= accounting[key];
  }
  return validateBudget(next, "remaining");
}

function errorCode(error, fallback) {
  return coarseCampaignErrorCode(error?.code ?? fallback);
}

export class CheckpointCampaignOrchestrator {
  #playSegment;
  #publishWiki;
  #loadContext;
  #ledger;
  #state = "CREATED";
  #reason = null;
  #remaining;
  #revision = 0;
  #context;
  #segments = 0;
  #checkpoints = 0;
  #pending = null;
  #running = false;

  constructor({ campaignId, budget, checkpointPolicy, initialKnowledgeContext, playSegment, publishWiki, loadContext, ledgerStore }) {
    if (typeof playSegment !== "function" || typeof publishWiki !== "function" || typeof loadContext !== "function") {
      throw new TypeError("playSegment, publishWiki, and loadContext must be functions");
    }
    this.campaignId = safeId(campaignId, "campaignId");
    this.budget = validateBudget(budget);
    this.checkpointPolicy = validateCheckpointPolicy(checkpointPolicy);
    this.#remaining = this.budget;
    if (initialKnowledgeContext !== undefined) {
      this.#context = validateKnowledgeContext(initialKnowledgeContext);
      this.#revision = this.#context.revision;
    }
    this.#playSegment = playSegment;
    this.#publishWiki = publishWiki;
    this.#loadContext = loadContext;
    this.#ledger = new DeterministicCampaignLedger({ campaignId: this.campaignId, budget: this.budget, store: ledgerStore });
  }

  get state() { return this.#state; }

  ledgerSnapshot() { return this.#ledger.snapshot(); }

  #summary() {
    return cloneFreeze({
      status: this.#state,
      reason: this.#reason,
      campaignId: this.campaignId,
      segments: this.#segments,
      checkpoints: this.#checkpoints,
      revision: this.#revision,
      remaining: this.#remaining,
      ledgerDigest: this.#ledger.snapshot().headDigest,
    });
  }

  #fail(reason) {
    const code = coarseCampaignErrorCode(reason);
    this.#state = "FAILED";
    this.#reason = code;
    this.#pending = null;
    this.#ledger.record("CAMPAIGN_FAILED", {
      reason: code, segments: this.#segments, checkpoints: this.#checkpoints,
      revision: this.#revision, remaining: this.#remaining,
    });
    return this.#summary();
  }

  #finish(reason) {
    this.#state = "FINISHED";
    this.#reason = reason;
    this.#ledger.record("CAMPAIGN_FINISHED", {
      reason,
      segments: this.#segments,
      checkpoints: this.#checkpoints,
      revision: this.#revision,
      remaining: this.#remaining,
    });
    return this.#summary();
  }

  async #publishPending() {
    const request = this.#pending.publishRequest;
    let rawAck;
    try {
      rawAck = await this.#publishWiki(cloneFreeze(request));
    } catch (error) {
      this.#state = "WAITING_FOR_WIKI";
      this.#reason = errorCode(error, "WIKI_UNAVAILABLE");
      this.#ledger.record("WIKI_PUBLISH_WAITING", {
        segmentOrdinal: this.#pending.segmentOrdinal,
        idempotencyKey: request.idempotencyKey,
        errorCode: this.#reason,
      });
      return false;
    }
    let ack;
    try { ack = validateAck(rawAck, request); } catch { this.#fail("INVALID_WIKI_ACK"); return false; }
    this.#pending.ack = ack;
    this.#ledger.record("WIKI_ACKED", {
      segmentOrdinal: this.#pending.segmentOrdinal,
      idempotencyKey: ack.idempotencyKey,
      sourceDigest: ack.sourceArtifactDigest,
      baseRevision: ack.baseRevision,
      revision: ack.revision,
      snapshotDigest: ack.snapshotSha256,
      contextDigest: ack.playerContextSha256,
    });
    return true;
  }

  async #loadPendingContext() {
    const { ack, segmentOrdinal, publishRequest, stopAfterCheckpoint } = this.#pending;
    let rawContext;
    try {
      rawContext = await this.#loadContext(cloneFreeze({
        revision: ack.revision,
        playerContextSha256: ack.playerContextSha256,
      }));
    } catch (error) {
      this.#state = "WAITING_FOR_CONTEXT";
      this.#reason = errorCode(error, "CONTEXT_UNAVAILABLE");
      this.#ledger.record("CONTEXT_LOAD_WAITING", {
        segmentOrdinal, idempotencyKey: publishRequest.idempotencyKey, errorCode: this.#reason,
      });
      return false;
    }
    let context;
    try {
      context = validateKnowledgeContext(rawContext);
      const receipt = knowledgeContextReceipt(context);
      if (context.revision !== ack.revision || receipt.sha256 !== ack.playerContextSha256) throw new TypeError("context does not match ACK");
    } catch { this.#fail("INVALID_KNOWLEDGE_CONTEXT"); return false; }
    this.#context = context;
    this.#revision = ack.revision;
    this.#ledger.record("CONTEXT_ACTIVATED", {
      segmentOrdinal,
      revision: ack.revision,
      contextDigest: ack.playerContextSha256,
    });
    this.#pending = null;
    if (stopAfterCheckpoint) {
      this.#finish("PARTIAL");
    } else {
      this.#state = "RUNNING";
      this.#reason = null;
    }
    return true;
  }

  async run() {
    if (this.#running) throw new Error("campaign run is already in progress");
    if (["FINISHED", "FAILED"].includes(this.#state)) return this.#summary();
    this.#running = true;
    try {
      if (this.#state === "WAITING_FOR_WIKI") {
        if (!await this.#publishPending()) return this.#summary();
        if (!await this.#loadPendingContext()) return this.#summary();
        if (this.#state === "FINISHED") return this.#summary();
      } else if (this.#state === "WAITING_FOR_CONTEXT") {
        if (!await this.#loadPendingContext()) return this.#summary();
        if (this.#state === "FINISHED") return this.#summary();
      } else {
        this.#state = "RUNNING";
      }

      for (;;) {
        const segmentOrdinal = this.#segments + 1;
        this.#ledger.record("SEGMENT_STARTED", { segmentOrdinal, baseRevision: this.#revision, remaining: this.#remaining });
        let rawSegment;
        try {
          rawSegment = await this.#playSegment(cloneFreeze({
            sessionMode: "FRESH",
            campaignId: this.campaignId,
            segmentOrdinal,
            knowledgeContext: this.#context ?? null,
            remainingBudget: this.#remaining,
            checkpointPolicy: this.checkpointPolicy,
          }));
        } catch (error) { return this.#fail(errorCode(error, "PLAY_SEGMENT_FAILED")); }
        let segment;
        try { segment = validateSegment(rawSegment); } catch { return this.#fail("INVALID_SEGMENT_RECEIPT"); }
        let remaining;
        try { remaining = subtractBudget(this.#remaining, segment.accounting); } catch { return this.#fail("BUDGET_EXCEEDED"); }
        const consumesCheckpoint = segment.continuation !== undefined && remaining.checkpoints > 0;
        if (consumesCheckpoint) {
          this.#checkpoints += 1;
          remaining = validateBudget({ ...remaining, checkpoints: remaining.checkpoints - 1 }, "remaining");
        }
        this.#segments = segmentOrdinal;
        this.#remaining = remaining;
        this.#ledger.record("SEGMENT_SEALED", {
          segmentOrdinal, reason: segment.reason, sourceDigest: segment.sourceDigest,
          accounting: segment.accounting, remaining,
        });

        if (segment.continuation === undefined) {
          return this.#finish(segment.reason);
        }
        if (!consumesCheckpoint) return this.#finish("PARTIAL");
        const stopAfterCheckpoint = this.#remaining.checkpoints === 0 ||
          ["turns", "keyAttempts", "frames", "elapsedMs"].some((key) => this.#remaining[key] === 0);
        const publishRequest = cloneFreeze({
          sourceRef: segment.sourceRef,
          sourceDigest: segment.sourceDigest,
          baseRevision: this.#revision,
          idempotencyKey: campaignDigest({ campaignId: this.campaignId, segmentOrdinal, sourceDigest: segment.sourceDigest, baseRevision: this.#revision }),
        });
        this.#pending = { segmentOrdinal, publishRequest, ack: null, stopAfterCheckpoint };
        this.#ledger.record("WIKI_PUBLISH_REQUESTED", {
          segmentOrdinal,
          idempotencyKey: publishRequest.idempotencyKey,
          sourceDigest: publishRequest.sourceDigest,
          baseRevision: publishRequest.baseRevision,
        });
        if (!await this.#publishPending()) return this.#summary();
        if (!await this.#loadPendingContext()) return this.#summary();
        if (this.#state === "FINISHED") return this.#summary();
      }
    } finally {
      this.#running = false;
    }
  }
}

export { ACK_SCHEMA, RECEIPT_SCHEMA };
