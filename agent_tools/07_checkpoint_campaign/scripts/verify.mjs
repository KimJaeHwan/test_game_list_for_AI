import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  CheckpointCampaignOrchestrator,
  CampaignLedgerStore,
  DeterministicCampaignLedger,
  buildShardManifest,
  campaignDigest,
  createRelevantContextSelector,
  createShardedKnowledgeContextBuilder,
} from "../src/index.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const budget = Object.freeze({ turns: 20, keyAttempts: 20, frames: 30, elapsedMs: 20000, checkpoints: 3 });
const checkpointPolicy = Object.freeze({ modelInputTokens: 1000, keyAttempts: 5, frames: 8, onMissingUsage: true });
const accounting = Object.freeze({ turns: 2, keyAttempts: 3, frames: 4, elapsedMs: 1000 });
const context = (revision, label = "Known route") => ({
  schemaVersion: "atlas/player-knowledge-context/1",
  track: "ASSISTED",
  revision,
  guidance: [{ kind: "FACT", title: label, body: "A visible landmark identifies the safe route." }],
});
const contextDigest = (value) => sha(JSON.stringify(value));
const partial = (ordinal) => {
  const sourceDigest = sha(`source-${ordinal}`);
  return {
    status: "SEALED",
    reason: "PARTIAL",
    sourceDigest,
    sourceRef: `sealed:${ordinal}`,
    accounting,
    continuation: {
      schemaVersion: "atlas/vision-checkpoint-continuation/1",
      status: "CHECKPOINT_REQUIRED",
      causes: ["KEY_ATTEMPTS"],
      boundary: {
        completedTurns: accounting.turns,
        keyAttempts: accounting.keyAttempts,
        observations: accounting.frames,
        modelSessionGeneration: ordinal - 1,
        frameId: `F${ordinal}`,
        frameSha256: sha(`frame-${ordinal}`),
        knowledgeRevision: null,
        knowledgeContextSha256: null,
      },
      sealDigests: [sourceDigest],
    },
  };
};
const terminal = (ordinal, reason = "COMPLETE") => ({
  status: "SEALED",
  reason,
  sourceDigest: sha(`source-${ordinal}`),
  sourceRef: `sealed:${ordinal}`,
  accounting,
});
const ackFor = (request) => {
  const knowledge = context(request.baseRevision + 1);
  return {
    schemaVersion: "atlas/wiki-checkpoint-ack/1",
    idempotencyKey: request.idempotencyKey,
    sourceArtifactDigest: request.sourceDigest,
    baseRevision: request.baseRevision,
    revision: request.baseRevision + 1,
    snapshotSha256: sha(`snapshot-${request.baseRevision + 1}`),
    playerContextSha256: contextDigest(knowledge),
  };
};

async function test(name, fn) {
  try {
    await fn();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    process.stderr.write(`not ok - ${name}\n`);
    throw error;
  }
}

function makeCampaign(overrides = {}) {
  return new CheckpointCampaignOrchestrator({
    campaignId: "campaign:1",
    budget,
    checkpointPolicy,
    playSegment: async () => terminal(1),
    publishWiki: async (request) => ackFor(request),
    loadContext: async ({ revision }) => context(revision),
    ...overrides,
  });
}

await test("repeats fresh segments only after exact ACK and verified context", async () => {
  const calls = [];
  const campaign = makeCampaign({
    playSegment: async (request) => {
      calls.push(["play", request.segmentOrdinal, request.sessionMode, request.knowledgeContext?.revision ?? 0, request.remainingBudget.turns]);
      return request.segmentOrdinal < 3 ? partial(request.segmentOrdinal) : terminal(request.segmentOrdinal);
    },
    publishWiki: async (request) => {
      calls.push(["publish", request.baseRevision, request.idempotencyKey]);
      return ackFor(request);
    },
    loadContext: async (request) => {
      calls.push(["load", request.revision]);
      return context(request.revision);
    },
  });
  const result = await campaign.run();
  assert.equal(result.status, "FINISHED");
  assert.equal(result.reason, "COMPLETE");
  assert.equal(result.segments, 3);
  assert.equal(result.checkpoints, 2);
  assert.equal(result.revision, 2);
  assert.deepEqual(result.remaining, { turns: 14, keyAttempts: 11, frames: 18, elapsedMs: 17000, checkpoints: 1 });
  assert.deepEqual(calls.map((call) => call[0]), ["play", "publish", "load", "play", "publish", "load", "play"]);
  assert.deepEqual(calls.filter((call) => call[0] === "play").map((call) => call.slice(1)), [
    [1, "FRESH", 0, 20],
    [2, "FRESH", 1, 18],
    [3, "FRESH", 2, 16],
  ]);
});

await test("publish failure waits and retries the identical request without replaying play", async () => {
  let plays = 0;
  const publishes = [];
  const campaign = makeCampaign({
    playSegment: async () => (++plays === 1 ? partial(1) : terminal(2)),
    publishWiki: async (request) => {
      publishes.push(structuredClone(request));
      if (publishes.length === 1) throw Object.assign(new Error("secret remote text"), { code: "WIKI_UNAVAILABLE" });
      return ackFor(request);
    },
  });
  const waiting = await campaign.run();
  assert.equal(waiting.status, "WAITING_FOR_WIKI");
  assert.equal(plays, 1);
  const finished = await campaign.run();
  assert.equal(finished.status, "FINISHED");
  assert.equal(plays, 2);
  assert.deepEqual(publishes[0], publishes[1]);
  assert.equal(publishes[0].idempotencyKey, campaignDigest({
    campaignId: "campaign:1", segmentOrdinal: 1, sourceDigest: sha("source-1"), baseRevision: 0,
  }));
  assert.doesNotMatch(JSON.stringify(campaign.ledgerSnapshot()), /secret remote text/u);
});

await test("context failure retries context only and never republishes", async () => {
  let plays = 0;
  let publishes = 0;
  let loads = 0;
  const campaign = makeCampaign({
    playSegment: async () => (++plays === 1 ? partial(1) : terminal(2)),
    publishWiki: async (request) => { publishes += 1; return ackFor(request); },
    loadContext: async ({ revision }) => {
      loads += 1;
      if (loads === 1) throw Object.assign(new Error("temporary"), { code: "CONTEXT_UNAVAILABLE" });
      return context(revision);
    },
  });
  assert.equal((await campaign.run()).status, "WAITING_FOR_CONTEXT");
  assert.deepEqual([plays, publishes, loads], [1, 1, 1]);
  assert.equal((await campaign.run()).status, "FINISHED");
  assert.deepEqual([plays, publishes, loads], [2, 1, 2]);
});

await test("mismatched ACK fails closed before context or next play", async () => {
  let plays = 0;
  let loads = 0;
  const campaign = makeCampaign({
    playSegment: async () => { plays += 1; return partial(1); },
    publishWiki: async (request) => ({ ...ackFor(request), sourceArtifactDigest: sha("wrong") }),
    loadContext: async () => { loads += 1; return context(1); },
  });
  const result = await campaign.run();
  assert.equal(result.status, "FAILED");
  assert.equal(result.reason, "INVALID_WIKI_ACK");
  assert.deepEqual([plays, loads], [1, 0]);
});

await test("PARTIAL without continuation is a normal terminal outcome", async () => {
  let publishes = 0;
  const result = await makeCampaign({
    playSegment: async () => ({ ...terminal(1, "PARTIAL") }),
    publishWiki: async () => { publishes += 1; },
  }).run();
  assert.equal(result.status, "FINISHED");
  assert.equal(result.reason, "PARTIAL");
  assert.equal(publishes, 0);
});

await test("depleted cumulative budget publishes the seal but never starts another fresh segment", async () => {
  let plays = 0;
  let publishes = 0;
  const campaign = makeCampaign({
    budget: { turns: 4, keyAttempts: 6, frames: 8, elapsedMs: 2000, checkpoints: 3 },
    playSegment: async () => { plays += 1; return partial(plays); },
    publishWiki: async (request) => { publishes += 1; return ackFor(request); },
  });
  const result = await campaign.run();
  assert.equal(result.status, "FINISHED");
  assert.equal(result.reason, "PARTIAL");
  assert.deepEqual([plays, publishes, result.segments, result.checkpoints], [2, 2, 2, 2]);
  assert.deepEqual(result.remaining, { turns: 0, keyAttempts: 0, frames: 0, elapsedMs: 0, checkpoints: 1 });
});

await test("zero checkpoint budget ends PARTIAL without publishing or starting a new segment", async () => {
  let plays = 0;
  let publishes = 0;
  const result = await makeCampaign({
    budget: { ...budget, checkpoints: 0 },
    playSegment: async () => { plays += 1; return partial(1); },
    publishWiki: async () => { publishes += 1; },
  }).run();
  assert.equal(result.status, "FINISHED");
  assert.equal(result.reason, "PARTIAL");
  assert.deepEqual([plays, publishes], [1, 0]);
});

await test("over-budget sealed segment fails before publish", async () => {
  let publishes = 0;
  const tooLarge = {
    ...terminal(1),
    accounting: { turns: 21, keyAttempts: 0, frames: 0, elapsedMs: 0 },
  };
  const result = await makeCampaign({
    playSegment: async () => tooLarge,
    publishWiki: async () => { publishes += 1; },
  }).run();
  assert.equal(result.reason, "BUDGET_EXCEEDED");
  assert.equal(publishes, 0);
});

await test("ledger is deterministic and excludes model operational payloads", async () => {
  const run = async () => {
    const campaign = makeCampaign();
    await campaign.run();
    return campaign.ledgerSnapshot();
  };
  const [a, b] = await Promise.all([run(), run()]);
  assert.deepEqual(a, b);
  const serialized = JSON.stringify(a);
  assert.doesNotMatch(serialized, /plan|coordinate|ArrowUp|sourceRef/u);
});

const shardItems = [
  { id: "item-a", kind: "FACT", title: "Boss combat", body: "The enemy takes damage.", sourceOrdinal: 2, namespace: "general", pageKind: "BATTLE" },
  { id: "item-b", kind: "PROCEDURE", title: "Village route", body: "Travel north from the city.", sourceOrdinal: 1, namespace: "general", pageKind: "ROUTE" },
  { id: "item-c", kind: "CASE", title: "Odd statue", body: "A statue glows nearby.", sourceOrdinal: 2, namespace: "general", pageKind: "NOTE" },
];

await test("manifest routing is deterministic, automatic, and topic plus episode sharded", () => {
  const a = buildShardManifest({ revision: 3, items: shardItems });
  const b = buildShardManifest({ revision: 3, items: [...shardItems].reverse() });
  assert.deepEqual(a, b);
  assert.deepEqual(a.shards.map(({ path }) => path), [
    "episodes/e000001.json", "episodes/e000002.json", "topics/combat.json",
    "topics/general.json", "topics/navigation.json",
  ]);
  assert.throws(() => buildShardManifest({
    revision: 3,
    items: [{ ...shardItems[0], path: "topics/chosen.json" }],
  }), /invalid shape/u);
});

await test("selector accepts trusted topK only and rejects model path or rank", () => {
  const selector = createRelevantContextSelector({ topK: 2 });
  const selected = selector.select({
    revision: 3,
    items: shardItems,
    currentText: "boss enemy combat",
    currentEpisodeOrdinal: 2,
  });
  assert.equal(selected.itemIds[0], "item-a");
  assert.equal(selected.itemIds.length, 2);
  assert.throws(() => selector.select({
    revision: 3,
    items: shardItems,
    currentText: "boss",
    currentEpisodeOrdinal: 2,
    rank: ["item-c"],
  }), /invalid shape/u);
  assert.throws(() => createRelevantContextSelector({ topK: 2, rank: "model" }), /invalid shape/u);
});

await test("trusted page kind routes Korean content and builds the next player context", () => {
  const korean = {
    id: "item-k",
    kind: "FACT",
    title: "첫 번째 수호자",
    body: "방패를 든 상대를 관찰했다.",
    sourceOrdinal: 3,
    namespace: "general",
    pageKind: "BATTLE",
  };
  const built = createShardedKnowledgeContextBuilder({ topK: 1 }).build({
    revision: 4,
    items: [korean, ...shardItems],
    currentText: "첫 번째 수호자",
    currentEpisodeOrdinal: 3,
  });
  assert.ok(built.manifest.shards.some(({ path, itemIds }) => path === "topics/combat.json" && itemIds.includes("item-k")));
  assert.deepEqual(built.selection.itemIds, ["item-k"]);
  assert.equal(built.knowledgeContext.guidance[0].title, korean.title);
});

await test("ledger store survives reload and detects tamper, conflict, and interrupted CAS", () => {
  const cells = new Map();
  let failCas = false;
  const storage = {
    read: (key) => cells.get(key),
    createExclusive: (key, value) => {
      if (cells.has(key)) return false;
      cells.set(key, value);
      return true;
    },
    compareAndSwap: (key, expected, next) => {
      if (failCas || cells.get(key) !== expected) return false;
      cells.set(key, next);
      return true;
    },
  };
  const store = new CampaignLedgerStore(storage);
  const ledger = new DeterministicCampaignLedger({ campaignId: "campaign:persist", budget, store });
  ledger.record("SEGMENT_STARTED", { segmentOrdinal: 1, baseRevision: 0, remaining: budget });
  const recovered = new CampaignLedgerStore(storage).load("campaign:persist");
  assert.deepEqual(recovered, ledger.snapshot());
  assert.throws(
    () => new DeterministicCampaignLedger({ campaignId: "campaign:persist", budget, store }),
    (error) => error?.code === "LEDGER_CONFLICT",
  );

  failCas = true;
  const before = ledger.snapshot();
  assert.throws(
    () => ledger.record("SEGMENT_STARTED", { segmentOrdinal: 2, baseRevision: 0, remaining: budget }),
    (error) => error?.code === "LEDGER_CONFLICT",
  );
  assert.deepEqual(ledger.snapshot(), before);
  failCas = false;

  const key = "campaign-ledger:campaign:persist";
  cells.set(key, cells.get(key).replace('"baseRevision":0', '"baseRevision":1'));
  assert.throws(() => store.load("campaign:persist"), /digest|chain/u);
});

process.stdout.write("checkpoint campaign verification passed\n");
