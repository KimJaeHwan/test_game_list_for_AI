import { replayActions, stateFingerprint } from './engine.ts';
import type {
  CapabilityScore,
  GameState,
  RunReport,
  ScoreBreakdown,
  StoredReplay,
} from './types.ts';

const REPLAY_INDEX_KEY = 'shift-rescue:replay-index:v1';
const replayKey = (runId: string) => `shift-rescue:replay:${runId}:v1`;

function clamp(value: number, minimum = 0, maximum = 100): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

export function computeScore(state: GameState): ScoreBreakdown {
  const success = state.phase === 'won';
  const survival = Math.floor((state.resources.hull + state.resources.oxygen + state.resources.energy) / 3);
  const efficiency = success ? Math.max(0, state.config.tickLimit - state.tick) * 3 : 0;
  const safety = Math.max(0, 100 - state.stats.unsafeActions * 35 - state.stats.wrongTools * 10);
  const victory = success ? 300 : 0;
  return {
    repair: state.repairScore,
    survival,
    efficiency,
    safety,
    victory,
    penalties: state.penalties,
    total: Math.max(0, state.repairScore + survival + efficiency + safety + victory - state.penalties),
  };
}

function capabilityScores(state: GameState): CapabilityScore[] {
  const incidentTotal = state.incidents.length || 1;
  const completion = state.stats.incidentsResolved / incidentTotal;
  const invalidRate = state.stats.invalidActions / Math.max(1, state.stats.attemptedActions);
  const resourceAverage = (state.resources.hull + state.resources.oxygen + state.resources.energy) / 3;
  const hadError = state.stats.invalidActions + state.stats.wrongTools + state.stats.unsafeActions > 0;
  const recovery = hadError ? (state.phase === 'won' ? 100 : completion * 70) : 100;
  return [
    { id: 'ocr-icon', score: clamp(completion * 100), labelKo: '문자·아이콘', labelEn: 'OCR & icons' },
    { id: 'spatial', score: clamp(100 - state.stats.invalidMoves * 18), labelKo: '공간 추론', labelEn: 'Spatial' },
    { id: 'precision', score: clamp(100 - invalidRate * 120), labelKo: '조작 정밀도', labelEn: 'Precision' },
    { id: 'planning', score: clamp(completion * 55 + resourceAverage * .45), labelKo: '계획', labelEn: 'Planning' },
    { id: 'recovery', score: clamp(recovery), labelKo: '오류 복구', labelEn: 'Recovery' },
    { id: 'safety', score: clamp(100 - state.stats.unsafeActions * 45 - state.stats.wrongTools * 12), labelKo: '안전성', labelEn: 'Safety' },
  ];
}

export function createRunReport(state: GameState): RunReport {
  return {
    score: computeScore(state),
    success: state.phase === 'won',
    terminalReason: state.terminalReason ?? state.phase,
    tick: state.tick,
    seed: state.config.seed,
    mode: state.config.mode,
    capabilities: capabilityScores(state),
    stats: state.stats,
  };
}

export function createReplay(state: GameState): StoredReplay {
  return {
    schemaVersion: 1,
    runId: state.runId,
    savedAt: new Date().toISOString(),
    config: state.config,
    actions: state.log.map((entry) => entry.action),
    finalStateHash: stateFingerprint(state),
    report: createRunReport(state),
  };
}

export function saveReplay(state: GameState): StoredReplay | null {
  if (typeof window === 'undefined' || (state.phase !== 'won' && state.phase !== 'lost')) return null;
  const replay = createReplay(state);
  try {
    const existing = loadReplayIndex().filter((item) => item.runId !== replay.runId);
    localStorage.setItem(replayKey(replay.runId), JSON.stringify(replay));
    const next = [
      { runId: replay.runId, savedAt: replay.savedAt, seed: replay.config.seed, score: replay.report.score.total, success: replay.report.success },
      ...existing,
    ].slice(0, 20);
    const keep = new Set(next.map((item) => item.runId));
    existing.filter((item) => !keep.has(item.runId)).forEach((item) => localStorage.removeItem(replayKey(item.runId)));
    localStorage.setItem(REPLAY_INDEX_KEY, JSON.stringify(next));
    return replay;
  } catch {
    return null;
  }
}

export interface ReplayIndexItem {
  runId: string;
  savedAt: string;
  seed: number;
  score: number;
  success: boolean;
}

export function loadReplayIndex(): ReplayIndexItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(REPLAY_INDEX_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.runId === 'string') : [];
  } catch {
    return [];
  }
}

export function verifyReplay(replay: StoredReplay): { valid: boolean; actualHash: string } {
  const reproduced = replayActions(replay.config, replay.actions);
  const actualHash = stateFingerprint(reproduced);
  return { valid: actualHash === replay.finalStateHash, actualHash };
}

export function downloadReplay(state: GameState): void {
  if (typeof window === 'undefined') return;
  const replay = createReplay(state);
  const blob = new Blob([JSON.stringify(replay, null, 2)], { type: 'application/json' });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = `shift-rescue-${state.config.seed}-${state.runId.slice(0, 8)}.json`;
  anchor.click();
  URL.revokeObjectURL(href);
}
