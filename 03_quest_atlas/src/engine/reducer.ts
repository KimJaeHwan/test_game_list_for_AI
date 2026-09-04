import type { Effect, NPC, Predicate, Quest } from '../content/schema.ts';
import { effectLabel, itemCount, predicatesMet, questReadyToTurnIn, refreshQuestAvailability } from './rules.ts';
import { stateFingerprint } from './state.ts';
import type { ActionTarget, GameAction, GameState, Notice, ObservationRecord } from './types.ts';

function findName(state: GameState, entityId: string): string {
  return state.world.regions.find((entity) => entity.id === entityId)?.nameKo
    ?? state.world.npcs.find((entity) => entity.id === entityId)?.nameKo
    ?? state.world.items.find((entity) => entity.id === entityId)?.nameKo
    ?? state.world.encounters.find((entity) => entity.id === entityId)?.nameKo
    ?? state.world.recipes.find((entity) => entity.id === entityId)?.nameKo
    ?? state.world.quests.find((entity) => entity.id === entityId)?.titleKo
    ?? entityId;
}

function addNotice(state: GameState, text: string, tone: Notice['tone'] = 'neutral'): void {
  state.notices = [...state.notices.slice(-2), {
    id: `notice-${state.actionCount}-${state.eventSeq}`,
    text,
    tone,
    createdAt: performance.now(),
  }];
}

function addEvent(state: GameState, type: string, detail: string): void {
  state.eventSeq += 1;
  state.events.push({ seq: state.eventSeq, actionIndex: state.actionCount, type, detail, stateHash: stateFingerprint(state) });
}

function revealCues(state: GameState, cueIds: string[], fallbackSourceId: string): string | undefined {
  let latest: string | undefined;
  for (const cueId of cueIds) {
    if (state.observations.some((observation) => observation.cueId === cueId)) continue;
    const cue = state.world.evidenceCues.find((candidate) => candidate.id === cueId);
    if (!cue) continue;
    for (const observation of state.observations) observation.fresh = false;
    const region = state.world.regions.find((candidate) => candidate.id === state.currentRegionId);
    const id = `OBS-${String(state.observations.length + 1).padStart(3, '0')}`;
    const record: ObservationRecord = {
      id,
      cueId,
      kind: cue.kind === 'visual' ? 'inspect' : cue.kind === 'result' ? 'outcome' : cue.kind,
      sourceId: cue.sourceId || fallbackSourceId,
      sourceName: findName(state, cue.sourceId || fallbackSourceId),
      regionId: state.currentRegionId,
      regionName: region?.nameKo ?? state.currentRegionId,
      worldTime: state.time,
      tide: state.tide,
      text: cue.ko,
      actionIndex: state.actionCount,
      factIds: [...cue.factIds],
      bookmarked: false,
      fresh: true,
    };
    state.observations.push(record);
    for (const rumor of state.world.rumors) {
      if (rumor.evidenceCueIds[0] === cueId && !state.rumorsHeard.includes(rumor.id)) state.rumorsHeard.push(rumor.id);
    }
    latest = id;
    addEvent(state, 'observation', `${id}:${cueId}`);
  }
  return latest;
}

function addItem(state: GameState, itemId: string, count: number): void {
  const previous = itemCount(state, itemId);
  state.inventory[itemId] = previous + count;
  if (state.inventory[itemId] <= 0) delete state.inventory[itemId];
  if (count > 0 && previous === 0) {
    const item = state.world.items.find((candidate) => candidate.id === itemId);
    const sourceCues = item?.sources
      .filter((source) => predicatesMet(state, source.conditions))
      .flatMap((source) => source.evidenceCueIds) ?? [];
    revealCues(state, sourceCues, itemId);
  }
}

function startQuest(state: GameState, questId: string): void {
  if (state.questStates[questId] !== 'available' && state.questStates[questId] !== 'locked') return;
  const quest = state.world.quests.find((candidate) => candidate.id === questId);
  if (!quest || !predicatesMet(state, quest.prerequisites)) return;
  state.questStates[questId] = 'active';
  state.questProgress[questId] = {};
  revealCues(state, quest.evidenceCueIds, quest.id);
  addNotice(state, `새 조사: ${quest.titleKo}`, 'positive');
  addEvent(state, 'quest-start', questId);
}

function completeQuest(state: GameState, quest: Quest): void {
  if (state.questStates[quest.id] === 'complete') return;
  state.questStates[quest.id] = 'complete';
  state.questCompletions[quest.id] = (state.questCompletions[quest.id] ?? 0) + 1;
  for (const reward of quest.rewards) applyEffect(state, reward);
  revealCues(state, quest.evidenceCueIds, quest.id);
  addNotice(state, `조사 완료: ${quest.titleKo}`, 'positive');
  addEvent(state, 'quest-complete', quest.id);
  if (quest.repeatable) {
    state.questStates[quest.id] = 'available';
    state.questProgress[quest.id] = {};
  }
}

function applyEffect(state: GameState, effect: Effect): void {
  if (effect.kind === 'giveItem') addItem(state, effect.itemId, effect.count ?? 1);
  else if (effect.kind === 'takeItem') addItem(state, effect.itemId, -(effect.count ?? 1));
  else if (effect.kind === 'startQuest') startQuest(state, effect.questId);
  else if (effect.kind === 'completeQuest') {
    const quest = state.world.quests.find((candidate) => candidate.id === effect.questId);
    if (quest) completeQuest(state, quest);
  } else if (effect.kind === 'setFlag') state.flags[effect.flag] = effect.value;
  else if (effect.kind === 'setTime') state.time = effect.value;
  else if (effect.kind === 'setTide') state.tide = effect.value;
  else if (effect.kind === 'chooseBranch') {
    if (state.branch && state.branch !== effect.value) return;
    state.branch = effect.value;
  } else if (effect.kind === 'unlockRegion') {
    if (!state.unlockedRegions.includes(effect.regionId)) state.unlockedRegions.push(effect.regionId);
  } else state.reputation[effect.faction] += effect.amount;
  addEvent(state, 'effect', effectLabel(effect));
}

function recordObjective(state: GameState, key: string): void {
  for (const quest of state.world.quests) {
    if (state.questStates[quest.id] !== 'active') continue;
    const progress = state.questProgress[quest.id] ?? (state.questProgress[quest.id] = {});
    progress[key] = (progress[key] ?? 0) + 1;
  }
}

function canPay(state: GameState, costs: { itemId: string; count: number }[]): boolean {
  return costs.every((cost) => itemCount(state, cost.itemId) >= cost.count);
}

function recipeCanCraft(state: GameState, recipeId: string): boolean {
  const recipe = state.world.recipes.find((candidate) => candidate.id === recipeId);
  if (!recipe || !predicatesMet(state, recipe.conditions)) return false;
  return recipe.inputs.every((group) => group.alternatives.some((input) => itemCount(state, input.itemId) >= input.count));
}

function exitCanUse(state: GameState, targetRegionId: string, conditions: Predicate[]): boolean {
  void targetRegionId;
  return predicatesMet(state, conditions);
}

export function availableTargets(state: GameState): ActionTarget[] {
  const region = state.world.regions.find((candidate) => candidate.id === state.currentRegionId);
  if (!region) return [];
  const targets: ActionTarget[] = [];
  for (const exit of region.exits) {
    const destination = state.world.regions.find((candidate) => candidate.id === exit.to);
    const enabled = exitCanUse(state, exit.to, exit.conditions);
    targets.push({ id: `travel:${exit.id}`, kind: 'travel', entityId: exit.id, title: `${destination?.nameKo ?? exit.to}로 이동`, subtitle: exit.direction.toUpperCase(), disabled: !enabled, stateLabel: enabled ? undefined : '경로 잠김' });
  }
  for (const npc of state.world.npcs.filter((candidate) => candidate.regionId === region.id)) {
    targets.push({ id: `talk:${npc.id}`, kind: 'talk', entityId: npc.id, title: npc.nameKo, subtitle: npc.titleKo, disabled: false });
  }
  for (const encounter of state.world.encounters.filter((candidate) => candidate.regionId === region.id)) {
    const available = predicatesMet(state, encounter.spawnConditions) && (!encounter.requiredItemId || itemCount(state, encounter.requiredItemId) > 0);
    const exhausted = !encounter.respawns && (state.completedEncounters[encounter.id] ?? 0) > 0;
    targets.push({ id: `encounter:${encounter.id}`, kind: 'encounter', entityId: encounter.id, title: encounter.nameKo, subtitle: encounter.kind === 'gather' ? '현장 조사·채집' : '조건 기반 조우', disabled: !available || exhausted, stateLabel: exhausted ? '조사 완료' : available ? undefined : '현재 관찰 불가' });
  }
  for (const recipe of state.world.recipes.filter((candidate) => state.world.npcs.find((npc) => npc.id === candidate.stationNpcId)?.regionId === region.id)) {
    targets.push({ id: `craft:${recipe.id}`, kind: 'craft', entityId: recipe.id, title: recipe.nameKo, subtitle: '제작 공정 실행', disabled: !recipeCanCraft(state, recipe.id), stateLabel: recipeCanCraft(state, recipe.id) ? undefined : '재료 또는 조건 부족' });
  }
  for (const shop of state.world.shops.filter((candidate) => state.world.npcs.find((npc) => npc.id === candidate.npcId)?.regionId === region.id)) {
    for (const offer of shop.offers) {
      const enabled = predicatesMet(state, offer.conditions) && canPay(state, offer.costs);
      const rewardNames = offer.rewards.map((reward) => findName(state, reward.itemId)).join(', ');
      targets.push({ id: `offer:${shop.id}:${offer.id}`, kind: 'offer', entityId: `${shop.id}:${offer.id}`, title: rewardNames, subtitle: offer.kind === 'buy' ? `${shop.nameKo} 구매` : `${shop.nameKo} 교환`, disabled: !enabled, stateLabel: enabled ? undefined : '비용 또는 조건 부족' });
    }
  }
  if (state.world.npcs.some((npc) => npc.regionId === region.id && npc.roles.includes('inn'))) {
    targets.push({ id: 'rest:time', kind: 'rest', entityId: 'time', title: state.time === 'day' ? '밤까지 기다리기' : '아침까지 기다리기', subtitle: '시간 상태 전환', disabled: false });
  }
  const mainComplete = state.world.quests.filter((quest) => quest.category === 'main').every((quest) => state.questStates[quest.id] === 'complete');
  if (mainComplete) targets.push({ id: 'finish:archive', kind: 'finish', entityId: 'archive', title: '조사 종료 및 기록 제출', subtitle: '세션 번들 생성', disabled: false });
  return targets;
}

function clampSelection(state: GameState): void {
  const count = availableTargets(state).length;
  state.selectedTargetIndex = count === 0 ? 0 : ((state.selectedTargetIndex % count) + count) % count;
}

function incrementAction(state: GameState): void {
  state.actionCount += 1;
  if (state.actionCount >= state.actionBudget && state.phase !== 'result') finishSession(state, 'budget-exhausted');
}

function talkToNpc(state: GameState, npc: NPC): void {
  incrementAction(state);
  if (state.phase === 'result') return;
  state.talkedTo[npc.id] = (state.talkedTo[npc.id] ?? 0) + 1;
  recordObjective(state, `talk:${npc.id}`);

  const readyQuest = state.world.quests.find((quest) => quest.turnInNpcId === npc.id && questReadyToTurnIn(state, quest));
  if (readyQuest) completeQuest(state, readyQuest);
  else {
    const offeredQuest = state.world.quests.find((quest) => quest.giverNpcId === npc.id && state.questStates[quest.id] === 'available' && predicatesMet(state, quest.prerequisites));
    if (offeredQuest) startQuest(state, offeredQuest.id);
  }

  const matchingLines = npc.dialogue
    .filter((candidate) => predicatesMet(state, candidate.conditions))
    .filter((candidate) => !candidate.effects.some((effect) => effect.kind === 'chooseBranch' && state.branch !== null));
  const line = [...matchingLines].sort((left, right) => right.conditions.length - left.conditions.length)[0];
  if (!line) {
    state.dialogue = { npcId: npc.id, lineId: 'branch-closed', text: '이미 다른 항로 계약이 확정되어 이 선택은 닫혔습니다.' };
    addEvent(state, 'talk', `${npc.id}:branch-closed`);
    refreshQuestAvailability(state);
    return;
  }
  for (const matchingLine of matchingLines) {
    for (const effect of matchingLine.effects) applyEffect(state, effect);
  }
  const observationId = revealCues(state, matchingLines.flatMap((matchingLine) => matchingLine.evidenceCueIds), npc.id);
  state.dialogue = { npcId: npc.id, lineId: line.id, text: line.ko, observationId };
  addEvent(state, 'talk', `${npc.id}:${line.id}`);
  refreshQuestAvailability(state);
}

function performEncounter(state: GameState, encounterId: string): void {
  const encounter = state.world.encounters.find((candidate) => candidate.id === encounterId);
  if (!encounter || !predicatesMet(state, encounter.spawnConditions)) return;
  incrementAction(state);
  if (state.phase === 'result') return;
  state.completedEncounters[encounter.id] = (state.completedEncounters[encounter.id] ?? 0) + 1;
  recordObjective(state, `encounter:${encounter.id}`);
  revealCues(state, encounter.evidenceCueIds, encounter.id);
  const received: string[] = [];
  for (const drop of encounter.drops) {
    if (!predicatesMet(state, drop.conditions)) continue;
    addItem(state, drop.itemId, drop.count);
    revealCues(state, drop.evidenceCueIds, encounter.id);
    received.push(`${findName(state, drop.itemId)} ×${drop.count}`);
  }
  addNotice(state, received.length > 0 ? `획득: ${received.join(', ')}` : '새로운 결과를 관찰했습니다.', 'positive');
  addEvent(state, 'encounter', encounter.id);
  refreshQuestAvailability(state);
}

function craftRecipe(state: GameState, recipeId: string): void {
  const recipe = state.world.recipes.find((candidate) => candidate.id === recipeId);
  if (!recipe || !recipeCanCraft(state, recipeId)) return;
  incrementAction(state);
  if (state.phase === 'result') return;
  for (const group of recipe.inputs) {
    const selected = group.alternatives.find((input) => itemCount(state, input.itemId) >= input.count);
    if (selected) addItem(state, selected.itemId, -selected.count);
  }
  for (const output of recipe.outputs) addItem(state, output.itemId, output.count);
  state.craftedRecipes[recipe.id] = (state.craftedRecipes[recipe.id] ?? 0) + 1;
  recordObjective(state, `craft:${recipe.id}`);
  revealCues(state, recipe.evidenceCueIds, recipe.id);
  addNotice(state, `제작 완료: ${recipe.nameKo}`, 'positive');
  addEvent(state, 'craft', recipe.id);
  refreshQuestAvailability(state);
}

function useOffer(state: GameState, entityId: string): void {
  const [shopId, offerId] = entityId.split(':');
  const offer = state.world.shops.find((shop) => shop.id === shopId)?.offers.find((candidate) => candidate.id === offerId);
  if (!offer || !predicatesMet(state, offer.conditions) || !canPay(state, offer.costs)) return;
  incrementAction(state);
  if (state.phase === 'result') return;
  for (const cost of offer.costs) addItem(state, cost.itemId, -cost.count);
  for (const reward of offer.rewards) addItem(state, reward.itemId, reward.count);
  revealCues(state, offer.evidenceCueIds, shopId);
  addNotice(state, `거래 결과: ${offer.rewards.map((reward) => `${findName(state, reward.itemId)} ×${reward.count}`).join(', ')}`, 'positive');
  addEvent(state, 'offer', entityId);
  refreshQuestAvailability(state);
}

function finishSession(state: GameState, reason: 'archive-complete' | 'budget-exhausted' | 'abandoned'): void {
  state.phase = 'result';
  state.dialogue = null;
  state.terminalReason = reason;
  state.success = reason === 'archive-complete';
  addEvent(state, 'session-end', reason);
}

function activateTarget(state: GameState): void {
  const target = availableTargets(state)[state.selectedTargetIndex];
  if (!target) return;
  if (target.disabled) {
    addNotice(state, target.stateLabel ?? '현재 실행할 수 없습니다.', 'warning');
    addEvent(state, 'blocked', target.id);
    return;
  }
  if (target.kind === 'travel') {
    const region = state.world.regions.find((candidate) => candidate.id === state.currentRegionId);
    const exit = region?.exits.find((candidate) => candidate.id === target.entityId);
    if (!exit) return;
    incrementAction(state);
    if (state.phase === 'result') return;
    state.currentRegionId = exit.to;
    if (!state.visitedRegions.includes(exit.to)) state.visitedRegions.push(exit.to);
    recordObjective(state, `visit:${exit.to}`);
    revealCues(state, exit.evidenceCueIds, exit.id);
    addNotice(state, `${findName(state, exit.to)}에 도착했습니다.`, 'neutral');
    addEvent(state, 'travel', exit.to);
  } else if (target.kind === 'talk') {
    const npc = state.world.npcs.find((candidate) => candidate.id === target.entityId);
    if (npc) talkToNpc(state, npc);
  } else if (target.kind === 'encounter') performEncounter(state, target.entityId);
  else if (target.kind === 'craft') craftRecipe(state, target.entityId);
  else if (target.kind === 'offer') useOffer(state, target.entityId);
  else if (target.kind === 'rest') {
    incrementAction(state);
    if (state.phase !== 'result') {
      state.time = state.time === 'day' ? 'night' : 'day';
      addNotice(state, state.time === 'day' ? '아침이 밝았습니다.' : '밤이 되었습니다.', 'neutral');
      addEvent(state, 'time', state.time);
      refreshQuestAvailability(state);
    }
  } else finishSession(state, 'archive-complete');
  state.selectedTargetIndex = 0;
  clampSelection(state);
}

export function reduceGame(state: GameState, action: GameAction): GameState {
  state.actionLog.push({ ...action });
  if (action.type === 'briefing-next' && state.phase === 'briefing') {
    if (state.briefingPage >= 2) state.phase = 'explore';
    else state.briefingPage += 1;
    return state;
  }
  if (action.type === 'briefing-previous' && state.phase === 'briefing') {
    state.briefingPage = Math.max(1, state.briefingPage - 1);
    return state;
  }
  if (action.type === 'finish-session') {
    finishSession(state, action.reason ?? 'abandoned');
    return state;
  }
  if (state.phase === 'result') return state;
  if (action.type === 'dismiss-dialogue') {
    state.dialogue = null;
    return state;
  }
  if (state.dialogue && action.type === 'activate-selection') {
    state.dialogue = null;
    return state;
  }
  if (action.type === 'toggle-ledger') {
    state.phase = state.phase === 'ledger' ? 'explore' : 'ledger';
    return state;
  }
  if (state.phase === 'ledger') {
    const visible = state.observations.filter((observation) => state.ledgerFilter === 'all' || (state.ledgerFilter === 'bookmarked' ? observation.bookmarked : observation.kind === state.ledgerFilter));
    if (action.type === 'move-ledger') state.ledgerCursor = visible.length === 0 ? 0 : (state.ledgerCursor + action.delta + visible.length) % visible.length;
    else if (action.type === 'toggle-bookmark') {
      const selected = visible[state.ledgerCursor];
      if (selected) selected.bookmarked = !selected.bookmarked;
    } else if (action.type === 'cycle-ledger-filter') {
      const filters: GameState['ledgerFilter'][] = ['all', 'bookmarked', 'dialogue', 'inspect', 'outcome', 'system', 'world'];
      state.ledgerFilter = filters[(filters.indexOf(state.ledgerFilter) + 1) % filters.length];
      state.ledgerCursor = 0;
    }
    return state;
  }
  if (state.phase !== 'explore') return state;
  if (action.type === 'move-selection') {
    state.selectedTargetIndex += action.delta;
    clampSelection(state);
  } else if (action.type === 'activate-selection') activateTarget(state);
  else if (action.type === 'cycle-sidebar') {
    const panels: GameState['sidebarPanel'][] = ['quests', 'inventory', 'observations'];
    state.sidebarPanel = panels[(panels.indexOf(state.sidebarPanel) + action.delta + panels.length) % panels.length];
  }
  return state;
}
