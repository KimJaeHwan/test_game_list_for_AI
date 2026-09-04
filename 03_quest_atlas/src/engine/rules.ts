import type { Effect, Predicate, Quest } from '../content/schema.ts';
import type { GameState, QuestRuntimeState } from './types.ts';

export function itemCount(state: GameState, itemId: string): number {
  return state.inventory[itemId] ?? 0;
}

export function predicateMet(state: GameState, predicate: Predicate): boolean {
  if (predicate.kind === 'hasItem') return itemCount(state, predicate.itemId) >= (predicate.count ?? 1);
  if (predicate.kind === 'questState') return state.questStates[predicate.questId] === predicate.state;
  if (predicate.kind === 'worldFlag') return state.flags[predicate.flag] === predicate.value;
  if (predicate.kind === 'time') return state.time === predicate.value;
  if (predicate.kind === 'tide') return state.tide === predicate.value;
  if (predicate.kind === 'branch') return state.branch === predicate.value;
  return state.rumorsHeard.includes(predicate.rumorId);
}

export function predicatesMet(state: GameState, predicates: Predicate[]): boolean {
  return predicates.every((predicate) => predicateMet(state, predicate));
}

export function ingredientsAvailable(state: GameState, quest: Quest): boolean {
  return quest.objectives.every((objective) => {
    if (objective.kind === 'collect') return itemCount(state, objective.itemId) >= objective.count;
    if (objective.kind === 'talk') return (state.questProgress[quest.id]?.[`talk:${objective.npcId}`] ?? 0) >= (objective.count ?? 1);
    if (objective.kind === 'craft') return (state.questProgress[quest.id]?.[`craft:${objective.recipeId}`] ?? 0) >= (objective.count ?? 1);
    if (objective.kind === 'encounter') return (state.questProgress[quest.id]?.[`encounter:${objective.encounterId}`] ?? 0) >= (objective.count ?? 1);
    if (objective.kind === 'visit') return (state.questProgress[quest.id]?.[`visit:${objective.regionId}`] ?? 0) >= 1;
    if (objective.kind === 'setFlag') return state.flags[objective.flag] === objective.value;
    return state.branch === objective.branch;
  });
}

export function questReadyToTurnIn(state: GameState, quest: Quest): boolean {
  return state.questStates[quest.id] === 'active' && ingredientsAvailable(state, quest);
}

export function refreshQuestAvailability(state: GameState): void {
  for (const quest of state.world.quests) {
    const current = state.questStates[quest.id];
    if (current === 'active' || current === 'complete' || current === 'failed') continue;
    state.questStates[quest.id] = predicatesMet(state, quest.prerequisites) ? 'available' : 'locked';
  }
}

export function effectLabel(effect: Effect): string {
  if (effect.kind === 'giveItem') return `give:${effect.itemId}:${effect.count ?? 1}`;
  if (effect.kind === 'takeItem') return `take:${effect.itemId}:${effect.count ?? 1}`;
  if (effect.kind === 'startQuest') return `quest-start:${effect.questId}`;
  if (effect.kind === 'completeQuest') return `quest-complete:${effect.questId}`;
  if (effect.kind === 'setFlag') return `flag:${effect.flag}:${String(effect.value)}`;
  if (effect.kind === 'setTime') return `time:${effect.value}`;
  if (effect.kind === 'setTide') return `tide:${effect.value}`;
  if (effect.kind === 'chooseBranch') return `branch:${effect.value}`;
  if (effect.kind === 'unlockRegion') return `unlock:${effect.regionId}`;
  return `reputation:${effect.faction}:${effect.amount}`;
}

export function initialQuestStates(quests: Quest[]): Record<string, QuestRuntimeState> {
  return Object.fromEntries(quests.map((quest) => [quest.id, quest.prerequisites.length === 0 ? 'available' : 'locked']));
}
