import { createHash } from "node:crypto";

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const EVENT_TYPES = new Set([
  "CAMPAIGN_STARTED",
  "SEGMENT_STARTED",
  "SEGMENT_SEALED",
  "WIKI_PUBLISH_REQUESTED",
  "WIKI_PUBLISH_WAITING",
  "WIKI_ACKED",
  "CONTEXT_LOAD_WAITING",
  "CONTEXT_ACTIVATED",
  "CAMPAIGN_FINISHED",
  "CAMPAIGN_FAILED",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) throw new TypeError(`${label} must be a plain object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} has an invalid shape`);
  }
}

function safeCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`${label} must be a nonnegative safe integer`);
  }
  return value;
}

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError(`${label} must be a safe opaque identifier`);
  }
  return value;
}

function safeDigest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new TypeError(`${label} must be a canonical SHA-256 digest`);
  }
  return value;
}

function safeErrorCode(value) {
  return typeof value === "string" && ERROR_CODE.test(value) ? value : "PORT_FAILURE";
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function validateBudget(value, label = "budget") {
  exactKeys(value, ["turns", "keyAttempts", "frames", "elapsedMs", "checkpoints"], label);
  return Object.freeze({
    turns: safeCount(value.turns, `${label}.turns`),
    keyAttempts: safeCount(value.keyAttempts, `${label}.keyAttempts`),
    frames: safeCount(value.frames, `${label}.frames`),
    elapsedMs: safeCount(value.elapsedMs, `${label}.elapsedMs`),
    checkpoints: safeCount(value.checkpoints, `${label}.checkpoints`),
  });
}

function validateAccounting(value) {
  exactKeys(value, ["turns", "keyAttempts", "frames", "elapsedMs"], "accounting");
  return Object.freeze({
    turns: safeCount(value.turns, "accounting.turns"),
    keyAttempts: safeCount(value.keyAttempts, "accounting.keyAttempts"),
    frames: safeCount(value.frames, "accounting.frames"),
    elapsedMs: safeCount(value.elapsedMs, "accounting.elapsedMs"),
  });
}

function validatePayload(type, value) {
  switch (type) {
    case "CAMPAIGN_STARTED":
      exactKeys(value, ["campaignId", "budget"], "campaign start");
      return { campaignId: safeId(value.campaignId, "campaignId"), budget: validateBudget(value.budget) };
    case "SEGMENT_STARTED":
      exactKeys(value, ["segmentOrdinal", "baseRevision", "remaining"], "segment start");
      return {
        segmentOrdinal: safeCount(value.segmentOrdinal, "segmentOrdinal"),
        baseRevision: safeCount(value.baseRevision, "baseRevision"),
        remaining: validateBudget(value.remaining, "remaining"),
      };
    case "SEGMENT_SEALED":
      exactKeys(value, ["segmentOrdinal", "reason", "sourceDigest", "accounting", "remaining"], "sealed segment");
      if (!["COMPLETE", "PARTIAL", "ABORT"].includes(value.reason)) throw new TypeError("segment reason is invalid");
      return {
        segmentOrdinal: safeCount(value.segmentOrdinal, "segmentOrdinal"),
        reason: value.reason,
        sourceDigest: safeDigest(value.sourceDigest, "sourceDigest"),
        accounting: validateAccounting(value.accounting),
        remaining: validateBudget(value.remaining, "remaining"),
      };
    case "WIKI_PUBLISH_REQUESTED":
      exactKeys(value, ["segmentOrdinal", "idempotencyKey", "sourceDigest", "baseRevision"], "publish request");
      return {
        segmentOrdinal: safeCount(value.segmentOrdinal, "segmentOrdinal"),
        idempotencyKey: safeDigest(value.idempotencyKey, "idempotencyKey"),
        sourceDigest: safeDigest(value.sourceDigest, "sourceDigest"),
        baseRevision: safeCount(value.baseRevision, "baseRevision"),
      };
    case "WIKI_PUBLISH_WAITING":
    case "CONTEXT_LOAD_WAITING":
      exactKeys(value, ["segmentOrdinal", "idempotencyKey", "errorCode"], "waiting event");
      return {
        segmentOrdinal: safeCount(value.segmentOrdinal, "segmentOrdinal"),
        idempotencyKey: safeDigest(value.idempotencyKey, "idempotencyKey"),
        errorCode: safeErrorCode(value.errorCode),
      };
    case "WIKI_ACKED":
      exactKeys(value, [
        "segmentOrdinal", "idempotencyKey", "sourceDigest", "baseRevision", "revision",
        "snapshotDigest", "contextDigest",
      ], "wiki ack");
      return {
        segmentOrdinal: safeCount(value.segmentOrdinal, "segmentOrdinal"),
        idempotencyKey: safeDigest(value.idempotencyKey, "idempotencyKey"),
        sourceDigest: safeDigest(value.sourceDigest, "sourceDigest"),
        baseRevision: safeCount(value.baseRevision, "baseRevision"),
        revision: safeCount(value.revision, "revision"),
        snapshotDigest: safeDigest(value.snapshotDigest, "snapshotDigest"),
        contextDigest: safeDigest(value.contextDigest, "contextDigest"),
      };
    case "CONTEXT_ACTIVATED":
      exactKeys(value, ["segmentOrdinal", "revision", "contextDigest"], "context activation");
      return {
        segmentOrdinal: safeCount(value.segmentOrdinal, "segmentOrdinal"),
        revision: safeCount(value.revision, "revision"),
        contextDigest: safeDigest(value.contextDigest, "contextDigest"),
      };
    case "CAMPAIGN_FINISHED":
      exactKeys(value, ["reason", "segments", "checkpoints", "revision", "remaining"], "campaign finish");
      if (!["COMPLETE", "PARTIAL", "ABORT"].includes(value.reason)) throw new TypeError("finish reason is invalid");
      return {
        reason: value.reason,
        segments: safeCount(value.segments, "segments"),
        checkpoints: safeCount(value.checkpoints, "checkpoints"),
        revision: safeCount(value.revision, "revision"),
        remaining: validateBudget(value.remaining, "remaining"),
      };
    case "CAMPAIGN_FAILED":
      exactKeys(value, ["reason", "segments", "checkpoints", "revision", "remaining"], "campaign failure");
      if (typeof value.reason !== "string" || !ERROR_CODE.test(value.reason)) throw new TypeError("failure reason is invalid");
      return {
        reason: value.reason,
        segments: safeCount(value.segments, "segments"),
        checkpoints: safeCount(value.checkpoints, "checkpoints"),
        revision: safeCount(value.revision, "revision"),
        remaining: validateBudget(value.remaining, "remaining"),
      };
    default:
      throw new TypeError("ledger event type is invalid");
  }
}

export class DeterministicCampaignLedger {
  #entries = [];
  #store;

  constructor({ campaignId, budget, store } = {}) {
    this.campaignId = safeId(campaignId, "campaignId");
    if (store !== undefined && !(store instanceof CampaignLedgerStore)) {
      throw new TypeError("store must be a CampaignLedgerStore");
    }
    this.#store = store;
    this.record("CAMPAIGN_STARTED", { campaignId: this.campaignId, budget });
  }

  record(type, payload) {
    if (!EVENT_TYPES.has(type)) throw new TypeError("ledger event type is invalid");
    const projected = validatePayload(type, payload);
    const core = {
      sequence: this.#entries.length + 1,
      type,
      previousDigest: this.#entries.at(-1)?.digest ?? "0".repeat(64),
      payload: clone(projected),
    };
    const entry = deepFreeze({ ...core, digest: hash(core) });
    const candidate = [...this.#entries, entry];
    const snapshot = projectSnapshot(this.campaignId, candidate);
    if (this.#store) {
      if (this.#entries.length === 0) this.#store.initialize(snapshot);
      else this.#store.commit(this.#entries.at(-1).digest, snapshot);
    }
    this.#entries = candidate;
    return entry;
  }

  snapshot() {
    return projectSnapshot(this.campaignId, this.#entries);
  }
}

function projectSnapshot(campaignId, entries) {
  return deepFreeze({
    schemaVersion: "atlas/checkpoint-campaign-ledger/1",
    campaignId,
    entries: clone(entries),
    headDigest: entries.at(-1).digest,
  });
}

export function verifyCampaignLedgerSnapshot(value) {
  exactKeys(value, ["schemaVersion", "campaignId", "entries", "headDigest"], "ledger snapshot");
  if (value.schemaVersion !== "atlas/checkpoint-campaign-ledger/1") throw new TypeError("ledger schema is invalid");
  const campaignId = safeId(value.campaignId, "campaignId");
  if (!Array.isArray(value.entries) || value.entries.length === 0) throw new TypeError("ledger entries are invalid");
  let previousDigest = "0".repeat(64);
  const entries = value.entries.map((entry, index) => {
    exactKeys(entry, ["sequence", "type", "previousDigest", "payload", "digest"], `ledger entry ${index}`);
    if (entry.sequence !== index + 1 || entry.previousDigest !== previousDigest || !EVENT_TYPES.has(entry.type)) {
      throw new TypeError("ledger chain metadata is invalid");
    }
    const payload = validatePayload(entry.type, entry.payload);
    const core = { sequence: entry.sequence, type: entry.type, previousDigest, payload: clone(payload) };
    const expectedDigest = hash(core);
    if (safeDigest(entry.digest, "entry digest") !== expectedDigest) throw new TypeError("ledger entry digest is invalid");
    previousDigest = expectedDigest;
    return deepFreeze({ ...core, digest: expectedDigest });
  });
  if (safeDigest(value.headDigest, "headDigest") !== previousDigest) throw new TypeError("ledger head digest is invalid");
  if (entries[0].type !== "CAMPAIGN_STARTED" || entries[0].payload.campaignId !== campaignId) {
    throw new TypeError("ledger campaign binding is invalid");
  }
  return projectSnapshot(campaignId, entries);
}

export class CampaignLedgerStore {
  #storage;

  constructor(storage) {
    exactKeys(storage, ["read", "createExclusive", "compareAndSwap"], "ledger storage");
    for (const name of ["read", "createExclusive", "compareAndSwap"]) {
      if (typeof storage[name] !== "function") throw new TypeError(`ledger storage.${name} must be a function`);
    }
    this.#storage = storage;
  }

  #key(campaignId) {
    return `campaign-ledger:${safeId(campaignId, "campaignId")}`;
  }

  initialize(snapshot) {
    const verified = verifyCampaignLedgerSnapshot(snapshot);
    const serialized = canonical(verified);
    if (this.#storage.createExclusive(this.#key(verified.campaignId), serialized) !== true) {
      throw Object.assign(new Error("campaign ledger already exists"), { code: "LEDGER_CONFLICT" });
    }
  }

  commit(previousHeadDigest, snapshot) {
    safeDigest(previousHeadDigest, "previousHeadDigest");
    const verified = verifyCampaignLedgerSnapshot(snapshot);
    const key = this.#key(verified.campaignId);
    const current = this.#storage.read(key);
    if (typeof current !== "string") throw Object.assign(new Error("campaign ledger is missing"), { code: "LEDGER_MISSING" });
    let currentVerified;
    try { currentVerified = verifyCampaignLedgerSnapshot(JSON.parse(current)); }
    catch { throw Object.assign(new Error("campaign ledger was tampered with"), { code: "LEDGER_TAMPERED" }); }
    if (currentVerified.headDigest !== previousHeadDigest) {
      throw Object.assign(new Error("campaign ledger head changed"), { code: "LEDGER_CONFLICT" });
    }
    const next = canonical(verified);
    if (this.#storage.compareAndSwap(key, current, next) !== true) {
      throw Object.assign(new Error("campaign ledger compare-and-swap failed"), { code: "LEDGER_CONFLICT" });
    }
  }

  load(campaignId) {
    const stored = this.#storage.read(this.#key(campaignId));
    if (typeof stored !== "string") return undefined;
    return verifyCampaignLedgerSnapshot(JSON.parse(stored));
  }
}

export {
  canonical as canonicalCampaignJson,
  hash as campaignDigest,
  safeErrorCode as coarseCampaignErrorCode,
  validateAccounting,
  validateBudget,
};
