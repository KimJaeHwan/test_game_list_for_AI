import type { GeneratedWorld } from '../content/schema.ts';
import { initialQuestStates, refreshQuestAvailability } from './rules.ts';
import type { GameState, SessionBundle } from './types.ts';

function hash32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function createGameState(world: GeneratedWorld): GameState {
  const firstRegion = world.regions[0];
  if (!firstRegion) throw new Error('Generated world has no regions.');
  const state: GameState = {
    world,
    phase: 'briefing',
    briefingPage: 1,
    currentRegionId: firstRegion.id,
    selectedTargetIndex: 0,
    sidebarPanel: 'quests',
    ledgerCursor: 0,
    ledgerFilter: 'all',
    dialogue: null,
    time: world.session.time,
    tide: world.session.tide,
    inventory: Object.fromEntries(world.session.startingItems.map((item) => [item.itemId, item.count])),
    questStates: initialQuestStates(world.quests),
    questProgress: Object.fromEntries(world.quests.map((quest) => [quest.id, {}])),
    questCompletions: {},
    flags: {},
    unlockedRegions: [firstRegion.id],
    visitedRegions: [firstRegion.id],
    completedEncounters: {},
    craftedRecipes: {},
    talkedTo: {},
    rumorsHeard: [],
    branch: null,
    reputation: { wardens: 0, salvagers: 0 },
    observations: [],
    actionLog: [],
    actionCount: 0,
    actionBudget: 150,
    eventSeq: 0,
    events: [],
    notices: [],
    success: null,
    terminalReason: null,
  };
  refreshQuestAvailability(state);
  return state;
}

function fingerprintSnapshot(state: GameState): object {
  return {
    config: state.world.config,
    scenarioHash: state.world.scenarioHash,
    phase: state.phase,
    briefingPage: state.briefingPage,
    currentRegionId: state.currentRegionId,
    selectedTargetIndex: state.selectedTargetIndex,
    time: state.time,
    tide: state.tide,
    inventory: state.inventory,
    questStates: state.questStates,
    questProgress: state.questProgress,
    questCompletions: state.questCompletions,
    flags: state.flags,
    unlockedRegions: state.unlockedRegions,
    visitedRegions: state.visitedRegions,
    completedEncounters: state.completedEncounters,
    craftedRecipes: state.craftedRecipes,
    talkedTo: state.talkedTo,
    rumorsHeard: state.rumorsHeard,
    branch: state.branch,
    reputation: state.reputation,
    observations: state.observations.map(({ fresh: _fresh, ...observation }) => observation),
    actionLog: state.actionLog,
    actionCount: state.actionCount,
    success: state.success,
    terminalReason: state.terminalReason,
  };
}

export function stateFingerprint(state: GameState): string {
  return hash32(JSON.stringify(fingerprintSnapshot(state)));
}

export function sessionRunId(state: GameState): string {
  const { scenarioSeed, layoutSeed, visualSeed, sessionSeed } = state.world.config;
  return `qa-${hash32(`${String(scenarioSeed)}:${String(layoutSeed)}:${String(visualSeed)}:${String(sessionSeed)}`)}`;
}

export function createSessionBundle(state: GameState): SessionBundle {
  return {
    schemaVersion: 1,
    runId: sessionRunId(state),
    stateHash: stateFingerprint(state),
    actionCount: state.actionCount,
    terminalReason: state.terminalReason,
    success: state.success === true,
    observations: state.observations.map((observation) => ({
      id: observation.id,
      kind: observation.kind,
      sourceName: observation.sourceName,
      regionName: observation.regionName,
      worldTime: observation.worldTime,
      tide: observation.tide,
      text: observation.text,
      actionIndex: observation.actionIndex,
      bookmarked: observation.bookmarked,
    })),
    events: state.events.map((event) => ({
      seq: event.seq,
      actionIndex: event.actionIndex,
      type: event.type,
      stateHash: event.stateHash,
    })),
    actions: state.actionLog.map((action) => ({ ...action })),
  };
}
