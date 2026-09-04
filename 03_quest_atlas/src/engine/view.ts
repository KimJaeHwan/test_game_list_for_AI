import type { AppViewModel, InputFeedbackView, QuestView, StateNoticeView } from '../ui/types.ts';
import { predicateMet } from './rules.ts';
import { availableTargets } from './reducer.ts';
import { sessionRunId } from './state.ts';
import type { GameState } from './types.ts';

const ITEM_GLYPHS: Record<string, string[]> = {
  resource: ['✦', '◇', '△'],
  drop: ['◆', '●', '✧'],
  crafted: ['⬡', '✣', '◈'],
  tool: ['⌁', '◐', '⬢'],
  quest: ['▣', '✥', '▤'],
  token: ['⬟', '✶', '◉'],
  currency: ['●', '⬢', '◆'],
  decoy: ['○', '◇', '▽'],
};

function visualGlyph(category: string, variant: number): string {
  const choices = ITEM_GLYPHS[category] ?? ['•', '◆', '◇'];
  return choices[((variant % choices.length) + choices.length) % choices.length] ?? '•';
}

function weatherLabel(rotation: string[]): string {
  const key = rotation[0] ?? '';
  const index = [...key].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 3;
  return ['옅은 안개', '해무', '잔비'][index] ?? '옅은 안개';
}

function questViews(state: GameState): QuestView[] {
  return state.world.quests
    .filter((quest) => state.questStates[quest.id] !== 'locked' || quest.category !== 'hidden')
    .map((quest) => {
      const status = state.questStates[quest.id];
      const completeObjectives = quest.objectives.filter((objective) => {
        if (objective.kind === 'collect') return (state.inventory[objective.itemId] ?? 0) >= objective.count;
        if (objective.kind === 'talk') return (state.questProgress[quest.id]?.[`talk:${objective.npcId}`] ?? 0) >= (objective.count ?? 1);
        if (objective.kind === 'craft') return (state.questProgress[quest.id]?.[`craft:${objective.recipeId}`] ?? 0) >= (objective.count ?? 1);
        if (objective.kind === 'encounter') return (state.questProgress[quest.id]?.[`encounter:${objective.encounterId}`] ?? 0) >= (objective.count ?? 1);
        if (objective.kind === 'visit') return (state.questProgress[quest.id]?.[`visit:${objective.regionId}`] ?? 0) >= 1;
        if (objective.kind === 'setFlag') return state.flags[objective.flag] === objective.value;
        return state.branch === objective.branch;
      }).length;
      return {
        id: quest.id,
        title: quest.titleKo,
        kind: quest.category,
        status,
        progressLabel: status === 'complete' ? '완료' : status === 'active' ? `${completeObjectives}/${quest.objectives.length}` : status === 'available' ? '발견 가능' : '잠김',
      };
    });
}

export function createViewModel(state: GameState, inputFeedback: InputFeedbackView[] = []): AppViewModel {
  const currentRegion = state.world.regions.find((region) => region.id === state.currentRegionId) ?? state.world.regions[0];
  const xValues = state.world.regions.map((region) => region.mapPosition.x);
  const yValues = state.world.regions.map((region) => region.mapPosition.y);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);
  const normalizedPosition = (value: number, minimum: number, maximum: number): number => maximum === minimum ? 0.5 : (value - minimum) / (maximum - minimum);
  const visibleObservations = state.phase === 'ledger'
    ? state.observations.filter((observation) => state.ledgerFilter === 'all'
      || (state.ledgerFilter === 'bookmarked' ? observation.bookmarked : observation.kind === state.ledgerFilter))
    : state.observations;
  const selectedObservation = visibleObservations[state.ledgerCursor];
  const visibleRegionIds = new Set(state.visitedRegions);
  for (const regionId of state.visitedRegions) {
    const visitedRegion = state.world.regions.find((region) => region.id === regionId);
    for (const exit of visitedRegion?.exits ?? []) visibleRegionIds.add(exit.to);
  }
  const visibleRegions = state.world.regions.filter((region) => visibleRegionIds.has(region.id));
  const visibleEdges = state.world.regions
    .filter((region) => state.visitedRegions.includes(region.id))
    .flatMap((region) => region.exits.map((exit) => ({ region, exit })));
  const targets = availableTargets(state);
  const notices: StateNoticeView[] = state.notices.map((notice) => ({
    id: notice.id,
    text: notice.text,
    tone: notice.tone,
    createdAt: notice.createdAt,
    durationMs: 2200,
  }));
  const phaseLabel = state.phase === 'briefing' ? 'MISSION BRIEFING'
    : state.phase === 'ledger' ? 'EVIDENCE LEDGER'
      : state.phase === 'result' ? 'SESSION REPORT'
        : 'FIELD EXPLORATION';
  const mainQuests = state.world.quests.filter((quest) => quest.category === 'main');
  const completedMain = mainQuests.filter((quest) => state.questStates[quest.id] === 'complete').length;
  const view: AppViewModel = {
    phase: state.phase,
    title: { title: 'QUEST ATLAS', subtitle: '안개항 조사록', sessionLabel: sessionRunId(state) },
    seeds: [{ label: 'RUN', value: sessionRunId(state) }],
    session: {
      runId: sessionRunId(state),
      phaseLabel,
      worldTime: state.time === 'day' ? '낮' : '밤',
      actionCount: state.actionCount,
      actionBudget: state.actionBudget,
      observedCount: state.observations.length,
      totalDiscoverable: state.world.evidenceCues.length,
    },
    world: currentRegion ? {
      areaName: '안개항',
      locationName: currentRegion.nameKo,
      description: currentRegion.summaryKo,
      clock: state.time === 'day' ? '낮' : '밤',
      tide: state.tide === 'low' ? '썰물' : '밀물',
      weather: weatherLabel(state.world.session.repeatRotation),
      nodes: visibleRegions.map((region) => ({
        id: region.id,
        name: region.nameKo,
        kind: 'place',
        x: normalizedPosition(region.mapPosition.x, minX, maxX),
        y: normalizedPosition(region.mapPosition.y, minY, maxY),
        visited: state.visitedRegions.includes(region.id),
        current: region.id === state.currentRegionId,
        available: state.visitedRegions.includes(region.id) || visibleEdges.some(({ exit }) => exit.to === region.id && exit.conditions.every((condition) => predicateMet(state, condition))),
      })),
      edges: visibleEdges.map(({ region, exit }) => ({
        from: region.id,
        to: exit.to,
        locked: !exit.conditions.every((condition) => predicateMet(state, condition)),
      })),
      targets: targets.map((target, index) => ({
        id: target.id,
        title: target.title,
        subtitle: target.subtitle,
        selected: index === state.selectedTargetIndex,
        disabled: target.disabled,
        stateLabel: target.stateLabel,
        icon: target.kind === 'travel' ? '↗' : target.kind === 'talk' ? '◆' : target.kind === 'encounter' ? '◉' : target.kind === 'craft' ? '⚒' : target.kind === 'offer' ? '◇' : target.kind === 'rest' ? '☾' : '✓',
      })),
    } : undefined,
    dialogue: state.dialogue ? {
      speaker: state.world.npcs.find((npc) => npc.id === state.dialogue?.npcId)?.nameKo ?? state.dialogue.npcId,
      role: state.world.npcs.find((npc) => npc.id === state.dialogue?.npcId)?.titleKo,
      text: state.dialogue.text,
      observationId: state.dialogue.observationId,
      canAdvance: true,
    } : undefined,
    quests: questViews(state),
    inventory: state.world.items
      .filter((item) => (state.inventory[item.id] ?? 0) > 0)
      .map((item) => ({
        id: item.id,
        name: item.nameKo,
        count: state.inventory[item.id] ?? 0,
        category: item.category,
        icon: visualGlyph(item.category, state.world.theme.iconVariant),
      })),
    observations: visibleObservations.map((observation, index) => ({
      id: observation.id,
      kind: observation.kind,
      source: observation.sourceName,
      area: observation.regionName,
      worldTime: observation.worldTime === 'day' ? '낮' : '밤',
      text: observation.text,
      bookmarked: observation.bookmarked,
      fresh: observation.fresh,
      selected: state.phase === 'ledger' && (selectedObservation?.id === observation.id || index === state.ledgerCursor),
    })),
    sidebarPanel: state.sidebarPanel,
    briefing: state.phase === 'briefing' ? { page: state.briefingPage, totalPages: 2, acknowledged: state.briefingPage >= 2 } : undefined,
    ledger: state.phase === 'ledger' ? { cursor: state.ledgerCursor, filter: state.ledgerFilter } : undefined,
    result: state.phase === 'result' ? {
      heading: state.success ? '항로등 기록 완료' : '조사 세션 종료',
      summary: `${completedMain}/${mainQuests.length} 메인 조사 · ${state.observations.length}개 원문 관찰`,
      scoreLines: [
        { label: '메인 콘텐츠', value: completedMain, max: mainQuests.length },
        { label: '관찰 근거', value: state.observations.length, max: state.world.evidenceCues.length },
        { label: '지역 발견', value: state.visitedRegions.length, max: state.world.regions.length },
      ],
      exports: [
        { id: 'session', label: '탐색 세션 JSON', filename: `${sessionRunId(state)}-session.json`, ready: true },
        { id: 'knowledge', label: 'knowledge.json 템플릿', filename: `${sessionRunId(state)}-knowledge.json`, ready: true },
        { id: 'wiki', label: 'WIKI.md 템플릿', filename: `${sessionRunId(state)}-WIKI.md`, ready: true },
      ],
      replayStatus: `STATE ${stateFingerprintSafe(state)}`,
      transferStatus: '동일 SCENARIO + 새 LAYOUT에서 문서 전이를 검증하세요.',
    } : undefined,
    notices,
    inputFeedback,
    theme: {
      accent: state.world.theme.palette.accent,
      accentSoft: state.world.theme.palette.water,
      mapTint: state.world.theme.palette.panel,
    },
  };
  return view;
}

function stateFingerprintSafe(state: GameState): string {
  const questSummary = state.world.quests.map((quest) => `${quest.id}:${state.questStates[quest.id]}`).join('|');
  let hash = 2166136261;
  const text = `${state.world.scenarioHash}:${state.currentRegionId}:${state.actionCount}:${questSummary}`;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}
