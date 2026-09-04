import type {
  Effect,
  GeneratedWorld,
  Objective,
  Predicate,
  TruthFact,
} from "../content/schema.ts";
import type { CanonicalFact, JsonValue } from "./types.ts";

const predicateNames: Readonly<Record<string, string>> = {
  connectsToWithConditions: "연결",
  procedure: "퀘스트 절차",
  hasSource: "획득처",
  spawnAndDrops: "출현 및 획득",
  transforms: "제작식",
  buy: "구매",
  exchange: "교환",
  toggles: "상태 전환",
  setsFlag: "상태 변화",
  mutuallyExclusive: "상호 배타",
  gives: "보상",
  claims: "소문",
  correctedByObservation: "검증 결과",
  scenarioBinder: "필수 접합재",
  requiresItem: "필요 아이템",
  scenarioCatalyst: "필수 촉매",
};

const sourceKindNames: Readonly<Record<string, string>> = {
  gather: "채집",
  encounter: "조우",
  quest: "퀘스트",
  shop: "상점",
  exchange: "교환",
  craft: "제작",
};

const questStateNames: Readonly<Record<string, string>> = {
  available: "수락 가능",
  active: "진행 중",
  complete: "완료",
};

function nameMap(world: GeneratedWorld): Map<string, string> {
  const names = new Map<string, string>();
  for (const region of world.regions) names.set(region.id, region.nameKo);
  for (const npc of world.npcs) names.set(npc.id, npc.nameKo);
  for (const quest of world.quests) names.set(quest.id, quest.titleKo);
  for (const item of world.items) names.set(item.id, item.nameKo);
  for (const encounter of world.encounters) names.set(encounter.id, encounter.nameKo);
  for (const recipe of world.recipes) names.set(recipe.id, recipe.nameKo);
  for (const shop of world.shops) names.set(shop.id, shop.nameKo);
  for (const rumor of world.rumors) names.set(rumor.id, "소문: " + rumor.claimKo);
  names.set("wardens", "수호대");
  names.set("salvagers", "인양단");
  names.set("harbor_compact", "안개항 계약");
  names.set("beacon_lit", "봉화 점등");
  names.set("sluice_open", "광산 수문 열림");
  names.set("branch_resolved", "항로 계약 확정");
  names.set("atlas_complete", "항로 기록 완성");
  names.set("day", "낮");
  names.set("night", "밤");
  names.set("low", "썰물");
  names.set("high", "밀물");
  return names;
}

function display(names: ReadonlyMap<string, string>, value: string): string {
  return names.get(value) ?? value;
}

function predicates(values: readonly Predicate[], names: ReadonlyMap<string, string>): JsonValue[] {
  return values.map((predicate): JsonValue => {
    switch (predicate.kind) {
      case "hasItem": return { 종류: "아이템 보유", 대상: display(names, predicate.itemId), 수량: predicate.count ?? 1 };
      case "questState": return { 종류: "퀘스트 상태", 대상: display(names, predicate.questId), 상태: questStateNames[predicate.state] ?? predicate.state };
      case "worldFlag": return { 종류: "세계 상태", 대상: display(names, predicate.flag), 값: translateValue(predicate.value, names) };
      case "time": return { 종류: "시간", 값: display(names, predicate.value) };
      case "tide": return { 종류: "조수", 값: display(names, predicate.value) };
      case "branch": return { 종류: "계약", 값: display(names, predicate.value) };
      case "rumorHeard": return { 종류: "소문 확인", 대상: display(names, predicate.rumorId) };
    }
  });
}

function effects(values: readonly Effect[], names: ReadonlyMap<string, string>): JsonValue[] {
  return values.map((effect): JsonValue => {
    switch (effect.kind) {
      case "giveItem": return { 종류: "아이템 획득", 대상: display(names, effect.itemId), 수량: effect.count ?? 1 };
      case "takeItem": return { 종류: "아이템 소모", 대상: display(names, effect.itemId), 수량: effect.count ?? 1 };
      case "startQuest": return { 종류: "퀘스트 시작", 대상: display(names, effect.questId) };
      case "completeQuest": return { 종류: "퀘스트 완료", 대상: display(names, effect.questId) };
      case "setFlag": return { 종류: "세계 상태", 대상: display(names, effect.flag), 값: translateValue(effect.value, names) };
      case "setTime": return { 종류: "시간 변경", 값: display(names, effect.value) };
      case "setTide": return { 종류: "조수 변경", 값: display(names, effect.value) };
      case "chooseBranch": return { 종류: "계약 선택", 값: display(names, effect.value) };
      case "unlockRegion": return { 종류: "지역 해금", 대상: display(names, effect.regionId) };
      case "reputation": return { 종류: "평판", 대상: display(names, effect.faction), 수량: effect.amount };
    }
  });
}

function objectives(values: readonly Objective[], names: ReadonlyMap<string, string>): JsonValue[] {
  return values.map((objective): JsonValue => {
    switch (objective.kind) {
      case "talk": return { 종류: "대화", 대상: display(names, objective.npcId), 수량: objective.count ?? 1 };
      case "collect": return { 종류: "수집", 대상: display(names, objective.itemId), 수량: objective.count };
      case "craft": return { 종류: "제작", 대상: display(names, objective.recipeId), 수량: objective.count ?? 1 };
      case "encounter": return { 종류: "조우", 대상: display(names, objective.encounterId), 수량: objective.count ?? 1 };
      case "visit": return { 종류: "방문", 대상: display(names, objective.regionId) };
      case "setFlag": return { 종류: "세계 상태", 대상: display(names, objective.flag), 값: translateValue(objective.value, names) };
      case "chooseBranch": return { 종류: "계약 선택", 대상: display(names, objective.branch) };
    }
  });
}

function translateValue(value: string | number | boolean, names: ReadonlyMap<string, string>): JsonValue {
  return typeof value === "string" ? display(names, value) : value;
}

function stacks(values: readonly { itemId: string; count: number }[], names: ReadonlyMap<string, string>): JsonValue[] {
  return values.map((entry) => ({ 아이템: display(names, entry.itemId), 수량: entry.count }));
}

function baseFact(fact: TruthFact, names: ReadonlyMap<string, string>): CanonicalFact {
  const rawObject = Array.isArray(fact.object)
    ? fact.object.map((value) => typeof value === "string" ? display(names, value) : value)
    : translateValue(fact.object, names);
  return {
    id: fact.id,
    subject: display(names, fact.subject),
    predicate: predicateNames[fact.predicate] ?? fact.predicate,
    object: rawObject,
    conditions: [],
    weight: fact.importance === "core" ? 3 : fact.importance === "exception" ? 2 : 1,
    evidenceCueIds: [...fact.evidenceCueIds],
  };
}

/** Converts private generated content into the display-language contract expected from an agent submission. */
export function canonicalFactsFromWorld(world: GeneratedWorld): CanonicalFact[] {
  const names = nameMap(world);
  return world.facts.map((truth): CanonicalFact => {
    const result = baseFact(truth, names);
    const route = world.regions.flatMap((region) => region.exits.map((exit) => ({ region, exit })))
      .find(({ exit }) => truth.id === "route_" + exit.id);
    if (route) return {
      ...result,
      subject: route.region.nameKo,
      object: display(names, route.exit.to),
      conditions: predicates(route.exit.conditions, names),
    };

    const quest = world.quests.find((entry) => truth.id === "quest_" + entry.id);
    if (quest) return {
      ...result,
      subject: quest.titleKo,
      object: { 목표: objectives(quest.objectives, names), 보상: effects(quest.rewards, names) },
      conditions: predicates(quest.prerequisites, names),
    };

    const item = world.items.find((entry) => truth.id === "item_" + entry.id + "_source");
    if (item) return {
      ...result,
      subject: item.nameKo,
      object: item.sources.map((source) => ({
        방식: sourceKindNames[source.kind] ?? source.kind,
        대상: display(names, source.sourceId),
        조건: predicates(source.conditions, names),
      })),
    };

    const encounter = world.encounters.find((entry) => truth.id === "encounter_" + entry.id);
    if (encounter) return {
      ...result,
      subject: encounter.nameKo,
      object: {
        획득: stacks(encounter.drops, names),
        반복: encounter.respawns,
      },
      conditions: [
        ...predicates(encounter.spawnConditions, names),
        ...(encounter.requiredItemId ? [{ 종류: "아이템 보유", 대상: display(names, encounter.requiredItemId), 수량: 1 }] : []),
      ],
    };

    const recipe = world.recipes.find((entry) => truth.id === "recipe_" + entry.id);
    if (recipe) return {
      ...result,
      subject: recipe.nameKo,
      object: {
        재료: recipe.inputs.map((group) => group.alternatives.map((entry) => ({ 아이템: display(names, entry.itemId), 수량: entry.count }))),
        결과: stacks(recipe.outputs, names),
      },
      conditions: predicates(recipe.conditions, names),
    };

    for (const shop of world.shops) {
      const offer = shop.offers.find((entry) => truth.id === "offer_" + entry.id);
      if (offer) return {
        ...result,
        subject: shop.nameKo,
        object: { 비용: stacks(offer.costs, names), 보상: stacks(offer.rewards, names) },
        conditions: predicates(offer.conditions, names),
      };
    }
    return result;
  });
}
