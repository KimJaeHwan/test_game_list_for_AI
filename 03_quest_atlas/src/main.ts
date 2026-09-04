import { createSubmissionTemplate, exportKnowledgeMarkdown } from './eval/index.ts';
import { createGameState, createSessionBundle, createViewModel, reduceGame, sessionRunId, type GameState } from './engine/index.ts';
import { generateWorld } from './content/generator.ts';
import type { WorldConfig } from './content/schema.ts';
import { createShell, renderApp, type AppViewModel, type InputFeedbackView } from './ui/index.ts';

const shell = createShell();

function seedParam(name: string, fallback: number): number {
  const value = Number(new URLSearchParams(window.location.search).get(name));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

let config: WorldConfig = {
  scenarioSeed: seedParam('scenario', 7301),
  layoutSeed: seedParam('layout', 11),
  visualSeed: seedParam('visual', 1),
  sessionSeed: seedParam('session', 29),
};
let state: GameState = createGameState(generateWorld(config));
let titleMode = true;
let paused = false;
let inputFeedback: InputFeedbackView[] = [];

const allowedCodes = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'KeyB', 'KeyF',
  'KeyC', 'KeyE', 'KeyR', 'KeyN', 'Escape',
]);

function recordInput(code: string, active: boolean): void {
  const now = performance.now();
  const existing = inputFeedback.find((entry) => entry.key === code);
  if (existing) {
    existing.active = active;
    existing.changedAt = now;
  } else inputFeedback.push({ key: code, active, changedAt: now });
  inputFeedback = inputFeedback.slice(-12);
}

function freshState(nextConfig = config): void {
  config = nextConfig;
  state = createGameState(generateWorld(config));
  titleMode = false;
  paused = false;
  inputFeedback = [];
  shell.focus();
}

function download(filename: string, data: string, type: string): void {
  const blob = new Blob([data], { type });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(href);
}

function exportPackage(): void {
  const bundle = createSessionBundle(state);
  const baseTemplate = createSubmissionTemplate(sessionRunId(state));
  const template = {
    ...baseTemplate,
    entities: [],
    claims: [],
    procedures: [],
    evidence: state.observations.map((observation) => ({
      id: `EV-${observation.id}`,
      observationIds: [observation.id],
      note: `${observation.sourceName}에서 확인한 원문 근거`,
    })),
    unknowns: ['플레이로 확인하지 못한 사실을 여기에 기록하세요.'],
  };
  download(`${bundle.runId}-session.json`, JSON.stringify(bundle, null, 2), 'application/json');
  download(`${bundle.runId}-knowledge.json`, JSON.stringify(template, null, 2), 'application/json');
  download(`${bundle.runId}-WIKI.md`, exportKnowledgeMarkdown(template), 'text/markdown');
  shell.setStatus('세션 JSON, knowledge.json, WIKI.md를 내보냈습니다.');
}

function titleView(): AppViewModel {
  const view = createViewModel(state, inputFeedback);
  view.phase = 'title';
  view.briefing = undefined;
  view.world = undefined;
  view.dialogue = undefined;
  return view;
}

function handleKey(code: string): void {
  if (paused) {
    if (code === 'Enter') {
      paused = false;
      shell.setStatus('입력이 재개되었습니다.');
    }
    return;
  }
  if (titleMode) {
    if (code === 'Enter') {
      titleMode = false;
      shell.setStatus('한 번만 표시되는 세션 브리핑입니다.');
    }
    return;
  }
  if (state.phase === 'briefing') {
    if (code === 'Enter' || code === 'ArrowRight') reduceGame(state, { type: 'briefing-next' });
    else if (code === 'ArrowLeft') reduceGame(state, { type: 'briefing-previous' });
    else if (code === 'Escape') titleMode = true;
    return;
  }
  if (state.phase === 'result') {
    if (code === 'KeyE') exportPackage();
    else if (code === 'KeyR') freshState(config);
    else if (code === 'KeyN') freshState({
      ...config,
      layoutSeed: Number(config.layoutSeed) + 1,
      visualSeed: Number(config.visualSeed) + 1,
      sessionSeed: Number(config.sessionSeed) + 1,
    });
    else if (code === 'Escape') titleMode = true;
    return;
  }
  if (code === 'Tab') reduceGame(state, { type: 'toggle-ledger' });
  else if (state.phase === 'ledger') {
    if (code === 'ArrowUp' || code === 'ArrowLeft') reduceGame(state, { type: 'move-ledger', delta: -1 });
    else if (code === 'ArrowDown' || code === 'ArrowRight') reduceGame(state, { type: 'move-ledger', delta: 1 });
    else if (code === 'KeyB' || code === 'Enter') reduceGame(state, { type: 'toggle-bookmark' });
    else if (code === 'KeyF') reduceGame(state, { type: 'cycle-ledger-filter' });
  } else if (state.dialogue) {
    if (code === 'Enter' || code === 'Escape') reduceGame(state, { type: 'dismiss-dialogue' });
  } else {
    if (code === 'ArrowLeft' || code === 'ArrowUp') reduceGame(state, { type: 'move-selection', delta: -1 });
    else if (code === 'ArrowRight' || code === 'ArrowDown') reduceGame(state, { type: 'move-selection', delta: 1 });
    else if (code === 'Enter') reduceGame(state, { type: 'activate-selection' });
    else if (code === 'KeyC') reduceGame(state, { type: 'cycle-sidebar', delta: 1 });
  }
}

shell.canvas.addEventListener('keydown', (event) => {
  if (!allowedCodes.has(event.code)) return;
  event.preventDefault();
  if (event.repeat) return;
  recordInput(event.code, true);
  handleKey(event.code);
});

shell.canvas.addEventListener('keyup', (event) => {
  if (!allowedCodes.has(event.code)) return;
  event.preventDefault();
  recordInput(event.code, false);
});

function pauseForFocusLoss(): void {
  if (titleMode || state.phase === 'result') return;
  paused = true;
  inputFeedback = inputFeedback.map((entry) => ({ ...entry, active: false, changedAt: performance.now() }));
  shell.setStatus('포커스 손실로 입력이 일시 정지되었습니다. ENTER로 재개하세요.');
}

window.addEventListener('blur', pauseForFocusLoss);
shell.canvas.addEventListener('blur', pauseForFocusLoss);

shell.canvas.addEventListener('focus', () => {
  if (!paused) shell.setStatus('키보드 입력 활성화 · 공식 평가 관찰 영역은 캔버스뿐입니다.');
});

function frame(now: number): void {
  const view = titleMode ? titleView() : createViewModel(state, inputFeedback);
  view.paused = paused;
  renderApp(shell.context, view, now);
  requestAnimationFrame(frame);
}

shell.focus();
requestAnimationFrame(frame);
