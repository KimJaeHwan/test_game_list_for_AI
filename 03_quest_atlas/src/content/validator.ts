import { contentCounts, ruleGraphHash } from "./generator.ts";
import type {
  Effect, FactValue, GeneratedWorld, Objective, Predicate, ValidationIssue, ValidationResult,
} from "./schema.ts";

const MINIMUMS = {
  regions: 6,
  npcs: 12,
  quests: 14,
  mainQuests: 6,
  sideQuests: 5,
  hiddenQuests: 2,
  repeatableQuests: 1,
  items: 22,
  encounters: 7,
  recipes: 7,
} as const;

export function validateWorld(world: GeneratedWorld): ValidationResult {
  const issues: ValidationIssue[] = [];
  const counts = contentCounts(world);
  for (const [key, minimum] of Object.entries(MINIMUMS) as [keyof typeof MINIMUMS, number][]) {
    if (counts[key] < minimum) {
      issues.push(error("content_count", key + " 콘텐츠가 " + counts[key] + "개뿐입니다. 최소 " + minimum + "개가 필요합니다."));
    }
  }

  checkUnique(world.regions, "region", issues);
  checkUnique(world.npcs, "npc", issues);
  checkUnique(world.quests, "quest", issues);
  checkUnique(world.items, "item", issues);
  checkUnique(world.encounters, "encounter", issues);
  checkUnique(world.recipes, "recipe", issues);
  checkUnique(world.shops, "shop", issues);
  checkUnique(world.rumors, "rumor", issues);
  checkUnique(world.facts, "fact", issues);
  checkUnique(world.evidenceCues, "evidence cue", issues);

  const regionIds = new Set(world.regions.map((entry) => entry.id));
  const npcIds = new Set(world.npcs.map((entry) => entry.id));
  const questIds = new Set(world.quests.map((entry) => entry.id));
  const itemIds = new Set(world.items.map((entry) => entry.id));
  const encounterIds = new Set(world.encounters.map((entry) => entry.id));
  const recipeIds = new Set(world.recipes.map((entry) => entry.id));
  const rumorIds = new Set(world.rumors.map((entry) => entry.id));
  const factIds = new Set(world.facts.map((entry) => entry.id));
  const cueIds = new Set(world.evidenceCues.map((entry) => entry.id));
  const sourceIds = new Set<string>([
    ...regionIds, ...npcIds, ...questIds, ...itemIds, ...encounterIds, ...recipeIds,
    ...world.shops.map((entry) => entry.id), ...rumorIds,
  ]);

  for (const region of world.regions) {
    if (!region.nameKo.trim() || !region.summaryKo.trim()) issues.push(error("missing_korean_text", "지역의 한국어 표시 텍스트가 비었습니다.", region.id));
    for (const exit of region.exits) {
      requireId(regionIds, exit.to, "missing_exit_region", region.id + "의 출구 대상이 없습니다.", issues);
      exit.conditions.forEach((predicate) => checkPredicate(predicate, { questIds, itemIds, rumorIds }, issues, region.id));
      checkCues(exit.evidenceCueIds, cueIds, region.id, issues);
    }
  }

  for (const npc of world.npcs) {
    requireId(regionIds, npc.regionId, "missing_npc_region", "NPC의 배치 지역이 없습니다.", issues, npc.id);
    if (!npc.nameKo.trim() || !npc.titleKo.trim()) issues.push(error("missing_korean_text", "NPC의 한국어 이름 또는 직함이 비었습니다.", npc.id));
    for (const line of npc.dialogue) {
      if (!line.ko.trim()) issues.push(error("missing_korean_text", "대사 텍스트가 비었습니다.", npc.id));
      line.conditions.forEach((predicate) => checkPredicate(predicate, { questIds, itemIds, rumorIds }, issues, npc.id));
      line.effects.forEach((effect) => checkEffect(effect, { questIds, itemIds, regionIds }, issues, npc.id));
      checkCues(line.evidenceCueIds, cueIds, npc.id, issues);
    }
  }

  for (const quest of world.quests) {
    requireId(npcIds, quest.giverNpcId, "missing_quest_giver", "퀘스트 제공 NPC가 없습니다.", issues, quest.id);
    requireId(npcIds, quest.turnInNpcId, "missing_turnin_npc", "퀘스트 완료 NPC가 없습니다.", issues, quest.id);
    quest.prerequisites.forEach((predicate) => checkPredicate(predicate, { questIds, itemIds, rumorIds }, issues, quest.id));
    quest.objectives.forEach((objective) => checkObjective(objective, { npcIds, itemIds, encounterIds, recipeIds, regionIds }, issues, quest.id));
    quest.rewards.forEach((effect) => checkEffect(effect, { questIds, itemIds, regionIds }, issues, quest.id));
    checkCues(quest.evidenceCueIds, cueIds, quest.id, issues);
  }

  for (const item of world.items) {
    if (!item.nameKo.trim() || !item.descriptionKo.trim() || item.useKo.length === 0) {
      issues.push(error("incomplete_item_text", "아이템의 한국어 설명 또는 사용처가 비었습니다.", item.id));
    }
    if (item.sources.length === 0) issues.push(error("missing_item_source", "아이템 획득처가 없습니다.", item.id));
    for (const source of item.sources) {
      requireId(sourceIds, source.sourceId, "missing_item_source", "아이템 획득처 ID가 존재하지 않습니다.", issues, item.id);
      checkCues(source.evidenceCueIds, cueIds, item.id, issues);
    }
  }

  for (const encounter of world.encounters) {
    requireId(regionIds, encounter.regionId, "missing_encounter_region", "조우 지역이 없습니다.", issues, encounter.id);
    if (encounter.requiredItemId) requireId(itemIds, encounter.requiredItemId, "missing_required_item", "조우 요구 아이템이 없습니다.", issues, encounter.id);
    encounter.spawnConditions.forEach((predicate) => checkPredicate(predicate, { questIds, itemIds, rumorIds }, issues, encounter.id));
    for (const drop of encounter.drops) {
      requireId(itemIds, drop.itemId, "missing_drop_item", "드롭 아이템이 없습니다.", issues, encounter.id);
      checkCues(drop.evidenceCueIds, cueIds, encounter.id, issues);
    }
    checkCues(encounter.evidenceCueIds, cueIds, encounter.id, issues);
  }

  for (const recipe of world.recipes) {
    requireId(npcIds, recipe.stationNpcId, "missing_station_npc", "제작 담당 NPC가 없습니다.", issues, recipe.id);
    if (recipe.inputs.length === 0 || recipe.outputs.length === 0) issues.push(error("empty_recipe", "제작식의 입력 또는 출력이 비었습니다.", recipe.id));
    for (const group of recipe.inputs) {
      if (group.alternatives.length === 0) issues.push(error("empty_ingredient_group", "대체 재료 그룹이 비었습니다.", recipe.id));
      for (const option of group.alternatives) requireId(itemIds, option.itemId, "missing_recipe_item", "제작 재료가 없습니다.", issues, recipe.id);
    }
    for (const output of recipe.outputs) requireId(itemIds, output.itemId, "missing_recipe_output", "제작 결과가 없습니다.", issues, recipe.id);
    checkCues(recipe.evidenceCueIds, cueIds, recipe.id, issues);
  }

  for (const shop of world.shops) {
    requireId(npcIds, shop.npcId, "missing_shop_npc", "상점 NPC가 없습니다.", issues, shop.id);
    for (const offer of shop.offers) {
      for (const entry of [...offer.costs, ...offer.rewards]) requireId(itemIds, entry.itemId, "missing_offer_item", "거래 아이템이 없습니다.", issues, shop.id);
      checkCues(offer.evidenceCueIds, cueIds, shop.id, issues);
    }
  }

  for (const rumor of world.rumors) {
    requireId(npcIds, rumor.speakerNpcId, "missing_rumor_speaker", "소문 화자가 없습니다.", issues, rumor.id);
    if (!rumor.claimKo.trim() || !rumor.correctionKo.trim()) issues.push(error("missing_rumor_text", "소문 또는 반례 텍스트가 비었습니다.", rumor.id));
    if (rumor.evidenceCueIds.length < 2) issues.push(error("rumor_without_counterexample", "소문에는 주장과 반례 근거가 모두 필요합니다.", rumor.id));
    checkCues(rumor.evidenceCueIds, cueIds, rumor.id, issues);
  }

  for (const fact of world.facts) {
    if (fact.evidenceCueIds.length === 0) issues.push(error("fact_without_evidence", "사실에 관찰 근거가 없습니다.", fact.id));
    checkCues(fact.evidenceCueIds, cueIds, fact.id, issues);
  }
  for (const cue of world.evidenceCues) {
    if (!cue.ko.trim()) issues.push(error("empty_evidence_text", "관찰 근거의 한국어 텍스트가 비었습니다.", cue.id));
    if (!sourceIds.has(cue.sourceId)) issues.push(error("missing_evidence_source", "관찰 근거의 화면 출처가 없습니다.", cue.id));
    for (const factId of cue.factIds) requireId(factIds, factId, "missing_evidence_fact", "관찰 근거가 가리키는 사실이 없습니다.", issues, cue.id);
  }

  const actionableCueIds = new Set<string>();
  const markActionable = (ids: string[]): void => ids.forEach((id) => actionableCueIds.add(id));
  world.regions.forEach((region) => region.exits.forEach((exit) => markActionable(exit.evidenceCueIds)));
  world.npcs.forEach((npc) => npc.dialogue.forEach((line) => markActionable(line.evidenceCueIds)));
  world.quests.forEach((quest) => markActionable(quest.evidenceCueIds));
  world.items.forEach((item) => item.sources.forEach((source) => markActionable(source.evidenceCueIds)));
  world.encounters.forEach((encounter) => {
    markActionable(encounter.evidenceCueIds);
    encounter.drops.forEach((drop) => markActionable(drop.evidenceCueIds));
  });
  world.recipes.forEach((recipe) => markActionable(recipe.evidenceCueIds));
  world.shops.forEach((shop) => shop.offers.forEach((offer) => markActionable(offer.evidenceCueIds)));
  for (const cue of world.evidenceCues) {
    if (!actionableCueIds.has(cue.id)) issues.push(error("unreachable_evidence_cue", "어떤 플레이 행동에도 연결되지 않은 관찰 근거입니다.", cue.id));
  }

  if (world.scenarioHash !== ruleGraphHash(world)) {
    issues.push(error("scenario_hash_mismatch", "scenarioHash가 현재 규칙 그래프와 일치하지 않습니다."));
  }
  validateBranchContract(world, issues);
  validateMainReachability(world, issues);
  return { valid: !issues.some((issue) => issue.severity === "error"), issues };
}

function validateBranchContract(world: GeneratedWorld, issues: ValidationIssue[]): void {
  const choices = world.npcs.flatMap((npc) => npc.dialogue.flatMap((line) =>
    line.effects.filter((effect): effect is Extract<Effect, { kind: "chooseBranch" }> => effect.kind === "chooseBranch"),
  ));
  if (!choices.some((effect) => effect.value === "wardens") || !choices.some((effect) => effect.value === "salvagers")) {
    issues.push(error("incomplete_branch", "두 진영 선택 효과가 모두 선언되어야 합니다.", "main_05_divided"));
  }
  const coreRecipe = world.recipes.find((recipe) => recipe.id === "recipe_beacon_core");
  const branchGroup = coreRecipe?.inputs.find((group) =>
    group.alternatives.some((option) => option.itemId === "wardens_seal") &&
    group.alternatives.some((option) => option.itemId === "salvagers_mark"),
  );
  if (!branchGroup) issues.push(error("branch_dead_end", "두 진영 증표가 모두 최종 제작식의 대체재여야 합니다.", "recipe_beacon_core"));
}

function validateMainReachability(world: GeneratedWorld, issues: ValidationIssue[]): void {
  const items = new Set(world.session.startingItems.filter((entry) => entry.count > 0).map((entry) => entry.itemId));
  const completed = new Set<string>();
  const started = new Set<string>();
  const visited = new Set<string>(["ashen_harbor"]);
  const flags = new Map<string, FactValue>();
  const branches = new Set<string>();
  const encounters = new Set<string>();
  const crafted = new Set<string>();
  const talked = new Set<string>();
  const heardRumors = new Set<string>();

  const predicateTrue = (predicate: Predicate): boolean => {
    switch (predicate.kind) {
      case "hasItem": return items.has(predicate.itemId);
      case "questState":
        if (predicate.state === "complete") return completed.has(predicate.questId);
        if (predicate.state === "active") return started.has(predicate.questId) && !completed.has(predicate.questId);
        return true;
      case "worldFlag": return flags.get(predicate.flag) === predicate.value;
      case "time": return true;
      case "tide": return true;
      case "branch": return branches.has(predicate.value);
      case "rumorHeard": return heardRumors.has(predicate.rumorId);
    }
  };
  const all = (predicates: Predicate[]): boolean => predicates.every(predicateTrue);
  const applyEffect = (effect: Effect): void => {
    switch (effect.kind) {
      case "giveItem": items.add(effect.itemId); break;
      case "takeItem": break;
      case "startQuest": started.add(effect.questId); break;
      case "completeQuest": completed.add(effect.questId); break;
      case "setFlag": flags.set(effect.flag, effect.value); break;
      case "setTime": break;
      case "setTide": break;
      case "chooseBranch": branches.add(effect.value); break;
      case "unlockRegion": visited.add(effect.regionId); break;
      case "reputation": break;
    }
  };
  const objectiveTrue = (objective: Objective): boolean => {
    switch (objective.kind) {
      case "talk": return talked.has(objective.npcId);
      case "collect": return items.has(objective.itemId);
      case "craft": return crafted.has(objective.recipeId);
      case "encounter": return encounters.has(objective.encounterId);
      case "visit": return visited.has(objective.regionId);
      case "setFlag": return flags.get(objective.flag) === objective.value;
      case "chooseBranch": return branches.has(objective.branch);
    }
  };

  for (let pass = 0; pass < 80; pass += 1) {
    const before = stableReachabilityState({ items, completed, started, visited, flags, branches, encounters, crafted, talked, heardRumors });
    for (const region of world.regions) {
      if (!visited.has(region.id)) continue;
      for (const exit of region.exits) if (all(exit.conditions)) visited.add(exit.to);
    }
    for (const npc of world.npcs) {
      if (!visited.has(npc.regionId)) continue;
      talked.add(npc.id);
      for (const rumor of world.rumors) if (rumor.speakerNpcId === npc.id) heardRumors.add(rumor.id);
      for (const line of npc.dialogue) if (all(line.conditions)) line.effects.forEach(applyEffect);
    }
    for (const shop of world.shops) {
      const npc = world.npcs.find((entry) => entry.id === shop.npcId);
      if (!npc || !visited.has(npc.regionId)) continue;
      for (const offer of shop.offers) {
        if (all(offer.conditions) && offer.costs.every((cost) => items.has(cost.itemId))) {
          offer.rewards.forEach((reward) => items.add(reward.itemId));
        }
      }
    }
    for (const recipe of world.recipes) {
      const npc = world.npcs.find((entry) => entry.id === recipe.stationNpcId);
      if (!npc || !visited.has(npc.regionId) || !all(recipe.conditions)) continue;
      if (recipe.inputs.every((group) => group.alternatives.some((option) => items.has(option.itemId)))) {
        crafted.add(recipe.id);
        recipe.outputs.forEach((output) => items.add(output.itemId));
      }
    }
    for (const encounter of world.encounters) {
      if (!visited.has(encounter.regionId) || !all(encounter.spawnConditions)) continue;
      if (encounter.requiredItemId && !items.has(encounter.requiredItemId)) continue;
      encounters.add(encounter.id);
      encounter.drops.filter((drop) => all(drop.conditions)).forEach((drop) => items.add(drop.itemId));
    }
    for (const quest of world.quests) {
      if (!started.has(quest.id) || completed.has(quest.id) || !all(quest.prerequisites)) continue;
      if (quest.objectives.every(objectiveTrue)) {
        completed.add(quest.id);
        quest.rewards.forEach(applyEffect);
      }
    }
    const after = stableReachabilityState({ items, completed, started, visited, flags, branches, encounters, crafted, talked, heardRumors });
    if (before === after) break;
  }

  for (const quest of world.quests.filter((entry) => entry.category === "main")) {
    if (!completed.has(quest.id)) issues.push(error("unreachable_main_quest", "선언형 도달성 검사에서 메인 퀘스트를 완료할 수 없습니다.", quest.id));
  }
  if (flags.get("atlas_complete") !== true) issues.push(error("unreachable_final_state", "최종 atlas_complete 상태에 도달할 수 없습니다.", "main_06_beacon"));
}

interface ReferenceSets {
  questIds: Set<string>;
  itemIds: Set<string>;
  rumorIds: Set<string>;
}

function checkPredicate(predicate: Predicate, refs: ReferenceSets, issues: ValidationIssue[], owner: string): void {
  if (predicate.kind === "hasItem") requireId(refs.itemIds, predicate.itemId, "missing_predicate_item", "조건 아이템이 없습니다.", issues, owner);
  if (predicate.kind === "questState") requireId(refs.questIds, predicate.questId, "missing_predicate_quest", "조건 퀘스트가 없습니다.", issues, owner);
  if (predicate.kind === "rumorHeard") requireId(refs.rumorIds, predicate.rumorId, "missing_predicate_rumor", "조건 소문이 없습니다.", issues, owner);
}

function checkEffect(
  effect: Effect,
  refs: { questIds: Set<string>; itemIds: Set<string>; regionIds: Set<string> },
  issues: ValidationIssue[],
  owner: string,
): void {
  if (effect.kind === "giveItem" || effect.kind === "takeItem") requireId(refs.itemIds, effect.itemId, "missing_effect_item", "효과 아이템이 없습니다.", issues, owner);
  if (effect.kind === "startQuest" || effect.kind === "completeQuest") requireId(refs.questIds, effect.questId, "missing_effect_quest", "효과 퀘스트가 없습니다.", issues, owner);
  if (effect.kind === "unlockRegion") requireId(refs.regionIds, effect.regionId, "missing_effect_region", "효과 지역이 없습니다.", issues, owner);
}

function checkObjective(
  objective: Objective,
  refs: { npcIds: Set<string>; itemIds: Set<string>; encounterIds: Set<string>; recipeIds: Set<string>; regionIds: Set<string> },
  issues: ValidationIssue[],
  owner: string,
): void {
  if (objective.kind === "talk") requireId(refs.npcIds, objective.npcId, "missing_objective_npc", "목표 NPC가 없습니다.", issues, owner);
  if (objective.kind === "collect") requireId(refs.itemIds, objective.itemId, "missing_objective_item", "목표 아이템이 없습니다.", issues, owner);
  if (objective.kind === "encounter") requireId(refs.encounterIds, objective.encounterId, "missing_objective_encounter", "목표 조우가 없습니다.", issues, owner);
  if (objective.kind === "craft") requireId(refs.recipeIds, objective.recipeId, "missing_objective_recipe", "목표 제작식이 없습니다.", issues, owner);
  if (objective.kind === "visit") requireId(refs.regionIds, objective.regionId, "missing_objective_region", "목표 지역이 없습니다.", issues, owner);
}

function checkUnique(entries: { id: string }[], label: string, issues: ValidationIssue[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) issues.push(error("duplicate_id", label + " ID가 중복됩니다.", entry.id));
    seen.add(entry.id);
  }
}

function checkCues(ids: string[], cueIds: Set<string>, owner: string, issues: ValidationIssue[]): void {
  if (ids.length === 0) issues.push(error("missing_evidence", "관찰 근거가 비었습니다.", owner));
  for (const id of ids) requireId(cueIds, id, "missing_evidence_cue", "관찰 근거 ID가 존재하지 않습니다.", issues, owner);
}

function requireId(
  ids: Set<string>,
  id: string,
  code: string,
  message: string,
  issues: ValidationIssue[],
  owner?: string,
): void {
  if (!ids.has(id)) issues.push(error(code, message + " [" + id + "]", owner));
}

function stableReachabilityState(state: {
  items: Set<string>; completed: Set<string>; started: Set<string>; visited: Set<string>;
  flags: Map<string, FactValue>; branches: Set<string>; encounters: Set<string>;
  crafted: Set<string>; talked: Set<string>; heardRumors: Set<string>;
}): string {
  const set = (values: Set<string>): string => [...values].sort().join(",");
  return [
    set(state.items), set(state.completed), set(state.started), set(state.visited),
    JSON.stringify([...state.flags].sort(([left], [right]) => left.localeCompare(right))),
    set(state.branches), set(state.encounters), set(state.crafted), set(state.talked), set(state.heardRumors),
  ].join("|");
}

function error(code: string, message: string, entityId?: string): ValidationIssue {
  return { severity: "error", code, message, entityId };
}
