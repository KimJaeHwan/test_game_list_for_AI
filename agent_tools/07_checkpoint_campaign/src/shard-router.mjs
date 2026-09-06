import { campaignDigest } from "./ledger.mjs";
import { validateKnowledgeContext } from "../../05_vision_agent_host/src/supervisor/KnowledgeContext.mjs";

const KINDS = new Set(["FACT", "PROCEDURE", "CASE", "OPEN_QUESTION"]);
const PAGE_TOPICS = Object.freeze({
  BATTLE: "combat",
  QUEST: "quests",
  CHARACTER: "characters",
  ITEM: "items",
  LOCATION: "locations",
  ROUTE: "navigation",
  MECHANIC: "mechanics",
});
const PAGE_KINDS = new Set([...Object.keys(PAGE_TOPICS), "NOTE"]);
const NAMESPACES = new Set(["combat", "quests", "characters", "items", "locations", "navigation", "mechanics", "general"]);
const TOPICS = Object.freeze([
  ["combat", ["attack", "battle", "boss", "combat", "damage", "enemy", "fight", "weapon", "공격", "보스", "전투", "적", "피해"]],
  ["quests", ["mission", "objective", "quest", "task", "과제", "목표", "임무", "퀘스트"]],
  ["characters", ["character", "companion", "npc", "person", "동료", "인물", "캐릭터"]],
  ["items", ["armor", "inventory", "item", "loot", "potion", "갑옷", "물약", "아이템", "전리품"]],
  ["locations", ["area", "building", "city", "dungeon", "location", "room", "village", "도시", "던전", "마을", "장소"]],
  ["navigation", ["door", "east", "map", "north", "route", "south", "travel", "west", "길", "동쪽", "문", "북쪽", "서쪽", "지도"]],
  ["mechanics", ["ability", "level", "mechanic", "rule", "skill", "stat", "규칙", "기술", "능력", "레벨"]],
]);
const TEXT = /^[^\u0000-\u001f\u007f-\u009f]{1,2000}$/u;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/u;

function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, keys, label) {
  if (!isRecord(value)) throw new TypeError(`${label} must be a plain object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new TypeError(`${label} has an invalid shape`);
}
function integer(value, label, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0) || Object.is(value, -0)) throw new TypeError(`${label} is invalid`);
  return value;
}
function text(value, label) {
  if (typeof value !== "string" || !TEXT.test(value) || value.normalize("NFC") !== value) throw new TypeError(`${label} is invalid`);
  return value;
}
function safeId(value) { if (typeof value !== "string" || !ID.test(value)) throw new TypeError("item id is invalid"); return value; }
function words(value) { return new Set(value.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? []); }
function topicFor(item) {
  if (PAGE_TOPICS[item.pageKind]) return PAGE_TOPICS[item.pageKind];
  if (item.namespace !== "general") return item.namespace;
  const corpus = words(`${item.title} ${item.body}`);
  let winner = "general";
  let best = 0;
  for (const [topic, vocabulary] of TOPICS) {
    const score = vocabulary.reduce((sum, token) => sum + (corpus.has(token) ? 1 : 0), 0);
    if (score > best) { best = score; winner = topic; }
  }
  return winner;
}
function episodeFor(sourceOrdinal) { return `e${String(sourceOrdinal).padStart(6, "0")}`; }
function validateItems(items) {
  if (!Array.isArray(items) || items.length > 10000) throw new TypeError("items must be a bounded array");
  const projected = items.map((item, index) => {
    exact(item, ["id", "kind", "title", "body", "sourceOrdinal", "namespace", "pageKind"], `item ${index}`);
    if (!KINDS.has(item.kind)) throw new TypeError(`item ${index} kind is invalid`);
    if (!NAMESPACES.has(item.namespace) || !PAGE_KINDS.has(item.pageKind)) {
      throw new TypeError(`item ${index} routing metadata is invalid`);
    }
    return Object.freeze({
      id: safeId(item.id),
      kind: item.kind,
      title: text(item.title, "title"),
      body: text(item.body, "body"),
      sourceOrdinal: integer(item.sourceOrdinal, "sourceOrdinal", { positive: true }),
      namespace: item.namespace,
      pageKind: item.pageKind,
    });
  });
  if (new Set(projected.map(({ id }) => id)).size !== projected.length) throw new TypeError("item ids must be unique");
  return projected;
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) freeze(nested);
  }
  return value;
}

export function buildShardManifest(value) {
  exact(value, ["revision", "items"], "manifest input");
  const revision = integer(value.revision, "revision", { positive: true });
  const items = validateItems(value.items).toSorted((a, b) => a.id.localeCompare(b.id, "en"));
  const buckets = new Map();
  const add = (path, item) => buckets.set(path, [...(buckets.get(path) ?? []), item.id]);
  for (const item of items) {
    add(`topics/${topicFor(item)}.json`, item);
    add(`episodes/${episodeFor(item.sourceOrdinal)}.json`, item);
  }
  const shards = [...buckets].map(([path, itemIds]) => Object.freeze({ path, itemIds: itemIds.toSorted() }))
    .toSorted((a, b) => a.path.localeCompare(b.path, "en"));
  return freeze({
    schemaVersion: "atlas/wiki-shard-manifest/1",
    revision,
    shards,
    digest: campaignDigest({ revision, shards }),
  });
}

export function createRelevantContextSelector(options) {
  exact(options, ["topK"], "selector options");
  const { topK } = options;
  integer(topK, "topK", { positive: true });
  if (topK > 32) throw new TypeError("topK cannot exceed 32");
  return Object.freeze({
    select(value) {
      exact(value, ["revision", "items", "currentText", "currentEpisodeOrdinal"], "selector input");
      const revision = integer(value.revision, "revision", { positive: true });
      const currentEpisodeOrdinal = integer(value.currentEpisodeOrdinal, "currentEpisodeOrdinal", { positive: true });
      const currentWords = words(text(value.currentText, "currentText"));
      const currentTopic = topicFor({ title: value.currentText, body: "", namespace: "general", pageKind: "NOTE" });
      const scored = validateItems(value.items).map((item) => {
        const overlap = [...words(`${item.title} ${item.body}`)].reduce((sum, token) => sum + (currentWords.has(token) ? 1 : 0), 0);
        const topicBoost = topicFor(item) === currentTopic && currentTopic !== "general" ? 2 : 0;
        const distance = Math.abs(item.sourceOrdinal - currentEpisodeOrdinal);
        const episodeBoost = distance === 0 ? 2 : distance === 1 ? 1 : 0;
        return { item, score: overlap * 4 + topicBoost + episodeBoost };
      }).toSorted((a, b) => b.score - a.score || b.item.sourceOrdinal - a.item.sourceOrdinal || a.item.id.localeCompare(b.item.id, "en"));
      const selected = scored.slice(0, topK).map(({ item }) => item);
      return freeze({
        schemaVersion: "atlas/relevant-context-selection/1",
        revision,
        itemIds: selected.map(({ id }) => id),
        items: selected,
      });
    },
  });
}

export function createShardedKnowledgeContextBuilder(options) {
  exact(options, ["topK"], "context builder options");
  const selector = createRelevantContextSelector(options);
  return Object.freeze({
    build(value) {
      const manifest = buildShardManifest({ revision: value?.revision, items: value?.items });
      const selection = selector.select(value);
      const knowledgeContext = validateKnowledgeContext({
        schemaVersion: "atlas/player-knowledge-context/1",
        track: "ASSISTED",
        revision: selection.revision,
        guidance: selection.items.map(({ kind, title, body }) => ({ kind, title, body })),
      });
      return freeze({ manifest, selection, knowledgeContext });
    },
  });
}
