import { createCatalog, type ContentCatalog, type ScenarioOptions } from "./catalog.ts";
import type {
  ContentCounts, Direction, GeneratedWorld, Point, Seed, TruthFact, VisualTheme, WorldConfig,
} from "./schema.ts";

export const DEFAULT_WORLD_CONFIG: WorldConfig = {
  scenarioSeed: "atlas-scenario-01",
  layoutSeed: "atlas-layout-01",
  visualSeed: "atlas-visual-01",
  sessionSeed: "atlas-session-01",
};

const THEMES: VisualTheme[] = [
  { palette: { ink: "#e8e1cf", panel: "#16272b", accent: "#e7b85c", water: "#31778a", danger: "#d86655" }, iconVariant: 0 },
  { palette: { ink: "#edf0e6", panel: "#20223a", accent: "#8fd1ba", water: "#586fa7", danger: "#e47a72" }, iconVariant: 1 },
  { palette: { ink: "#fff0d0", panel: "#30231d", accent: "#f19a61", water: "#3d8191", danger: "#c84d62" }, iconVariant: 2 },
];

export function generateWorld(config: WorldConfig = DEFAULT_WORLD_CONFIG): GeneratedWorld {
  const normalized = normalizeConfig(config);
  const options = scenarioOptionsFromSeed(normalized.scenarioSeed);
  const catalog = createCatalog(options);
  const scenarioHash = ruleGraphHash(catalog);
  applyLayout(catalog, normalized.layoutSeed);
  applyVisuals(catalog, normalized.visualSeed);
  const sessionRng = seededRandom(normalized.sessionSeed);
  const rotation = shuffle(catalog.encounters.map((encounter) => encounter.id), sessionRng);

  return {
    config: normalized,
    scenarioHash,
    ...catalog,
    theme: clone(THEMES[hashSeed(normalized.visualSeed) % THEMES.length]!),
    session: {
      time: sessionRng() < 0.5 ? "day" : "night",
      tide: sessionRng() < 0.5 ? "low" : "high",
      repeatRotation: rotation,
      startingItems: [{ itemId: "coin", count: 6 }],
    },
  };
}

export function truthFacts(world: GeneratedWorld): TruthFact[] {
  return world.facts.map((fact) => ({ ...fact, evidenceCueIds: [...fact.evidenceCueIds], object: Array.isArray(fact.object) ? [...fact.object] : fact.object }));
}

export function contentCounts(world: GeneratedWorld): ContentCounts {
  const categoryCount = (category: GeneratedWorld["quests"][number]["category"]): number =>
    world.quests.filter((quest) => quest.category === category).length;
  return {
    regions: world.regions.length,
    npcs: world.npcs.length,
    quests: world.quests.length,
    mainQuests: categoryCount("main"),
    sideQuests: categoryCount("side"),
    hiddenQuests: categoryCount("hidden"),
    repeatableQuests: categoryCount("repeatable"),
    items: world.items.length,
    encounters: world.encounters.length,
    recipes: world.recipes.length,
    shops: world.shops.length,
    offers: world.shops.reduce((total, shop) => total + shop.offers.length, 0),
    rumors: world.rumors.length,
    facts: world.facts.length,
    evidenceCues: world.evidenceCues.length,
  };
}

export function scenarioOptionsFromSeed(seed: Seed): ScenarioOptions {
  const value = hashSeed(seed);
  return {
    lampBinder: (value & 1) === 0 ? "forest_resin" : "moon_dust",
    mineTide: (value & 2) === 0 ? "low" : "high",
    wispWard: (value & 4) === 0 ? "signal_flare" : "herbal_tonic",
    prismCatalyst: (value & 8) === 0 ? "true_pearl" : "wisp_dust",
    branchBonus: (value & 16) === 0 ? "wardens" : "salvagers",
  };
}

export function ruleGraphHash(catalog: ContentCatalog | GeneratedWorld): string {
  const semanticSnapshot = {
    facts: [...catalog.facts]
      .map((fact) => ({ id: fact.id, subject: fact.subject, predicate: fact.predicate, object: fact.object, importance: fact.importance }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    quests: [...catalog.quests]
      .map((quest) => ({ id: quest.id, prerequisites: quest.prerequisites, objectives: quest.objectives, rewards: quest.rewards, branchGroup: quest.branchGroup }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    recipes: [...catalog.recipes]
      .map((recipe) => ({ id: recipe.id, inputs: recipe.inputs, outputs: recipe.outputs, conditions: recipe.conditions }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    encounters: [...catalog.encounters]
      .map((encounter) => ({ id: encounter.id, spawnConditions: encounter.spawnConditions, requiredItemId: encounter.requiredItemId, drops: encounter.drops }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    offers: catalog.shops.flatMap((shop) => shop.offers.map((offer) => ({ shopId: shop.id, ...offer })))
      .sort((left, right) => left.id.localeCompare(right.id)),
    branches: catalog.npcs.flatMap((npc) => npc.dialogue.flatMap((line) => line.effects.filter((effect) => effect.kind === "chooseBranch")))
      .sort((left, right) => left.value.localeCompare(right.value)),
    rumors: [...catalog.rumors]
      .map((rumor) => ({ id: rumor.id, truth: rumor.truth, correctionKo: rumor.correctionKo }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
  return "sg_" + hashText(stableStringify(semanticSnapshot)).toString(16).padStart(8, "0");
}

function normalizeConfig(config: WorldConfig): WorldConfig {
  return {
    scenarioSeed: String(config.scenarioSeed),
    layoutSeed: String(config.layoutSeed),
    visualSeed: String(config.visualSeed),
    sessionSeed: String(config.sessionSeed),
  };
}

function applyLayout(catalog: ContentCatalog, seed: Seed): void {
  const rng = seededRandom(seed);
  const positions = shuffle(catalog.regions.map((region) => ({ ...region.mapPosition })), rng);
  const positionById = new Map<string, Point>();
  catalog.regions.forEach((region, index) => {
    region.mapPosition = positions[index]!;
    positionById.set(region.id, region.mapPosition);
  });
  for (const region of catalog.regions) {
    for (const exit of region.exits) {
      exit.direction = directionBetween(region.mapPosition, positionById.get(exit.to) ?? region.mapPosition);
    }
  }
  catalog.npcs = shuffle(catalog.npcs, rng);
  catalog.encounters = shuffle(catalog.encounters, rng);
  catalog.items = shuffle(catalog.items, rng);
}

function applyVisuals(catalog: ContentCatalog, seed: Seed): void {
  const variant = hashSeed(seed) % THEMES.length;
  for (const region of catalog.regions) region.visualKey += "_v" + variant;
  for (const npc of catalog.npcs) npc.visualKey += "_v" + variant;
  for (const item of catalog.items) item.visualKey += "_v" + variant;
  for (const encounter of catalog.encounters) encounter.visualKey += "_v" + variant;
}

function directionBetween(from: Point, to: Point): Direction {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "east" : "west";
  return dy >= 0 ? "south" : "north";
}

function seededRandom(seed: Seed): () => number {
  let state = hashSeed(seed) || 0x6d2b79f5;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(values: T[], rng: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(rng() * (index + 1));
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}

function hashSeed(seed: Seed): number {
  return hashText(String(seed));
}

function hashText(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + stableStringify(record[key])).join(",") + "}";
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
