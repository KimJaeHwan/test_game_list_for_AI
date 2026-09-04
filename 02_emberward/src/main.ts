import './style.css';
import {
  TICKS_PER_SECOND,
  VIEW_HEIGHT,
  VIEW_WIDTH,
  createGame,
  createReport,
  emptyInput,
  stateFingerprint,
  stepGame,
  type FrameInput,
  type GameConfig,
  type GameState,
  type Track,
} from './game.ts';
import { renderGame } from './render.ts';

interface KeyLog {
  sequence: number;
  event: 'keydown' | 'keyup' | 'focus-lost' | 'focus-restored';
  code: string;
  key: string;
  repeat: boolean;
  wallMs: number;
  appliedTick: number;
  scene: string;
}

interface StoredRun {
  schemaVersion: 1;
  runId: string;
  savedAt: string;
  report: ReturnType<typeof createReport>;
  keys: KeyLog[];
  events: GameState['events'];
}

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('Missing #app');

app.innerHTML = `
  <section class="site-shell" aria-label="EMBERWARD keyboard visual benchmark">
    <header class="topbar">
      <div class="brand-lockup">
        <span class="brand-index">02</span>
        <div>
          <p>CONTINUOUS VISUAL CONTROL TEST</p>
          <h1>EMBERWARD <span>// 마지막 봉화</span></h1>
        </div>
      </div>
      <div class="status-pills" aria-hidden="true">
        <span><i class="live-dot"></i> KEYBOARD ONLY</span>
        <span>PIXEL OBSERVATION</span>
        <span>60 TICK SIM</span>
      </div>
    </header>

    <div class="stage-layout">
      <div class="canvas-frame">
        <canvas width="${VIEW_WIDTH}" height="${VIEW_HEIGHT}" tabindex="0" aria-label="EMBERWARD game canvas"></canvas>
        <div class="scanline" aria-hidden="true"></div>
      </div>
      <aside class="telemetry-panel" aria-label="Run telemetry">
        <div>
          <p class="eyebrow">LIVE EVALUATION</p>
          <h2 id="scene-name">READY</h2>
        </div>
        <dl class="telemetry-grid">
          <div><dt>TRACK</dt><dd id="track-value">REALTIME</dd></div>
          <div><dt>SIM TICK</dt><dd id="tick-value">00000</dd></div>
          <div><dt>STATE HASH</dt><dd id="hash-value">--------</dd></div>
          <div><dt>OBS PROFILE</dt><dd>640×360 · 15 FPS</dd></div>
        </dl>
        <div class="meter-block">
          <div><span>MISSION PROGRESS</span><strong id="progress-value">0%</strong></div>
          <div class="meter"><i id="progress-meter"></i></div>
        </div>
        <div class="meter-block">
          <div><span>CUE RESPONSE</span><strong id="cue-value">0%</strong></div>
          <div class="meter amber"><i id="cue-meter"></i></div>
        </div>
        <div class="telemetry-note">
          <strong>평가 경계</strong>
          <p>게임 상태·DOM·좌표 API를 사용하지 않고 영상과 실제 키 이벤트만으로 완주하도록 설계했습니다.</p>
        </div>
        <div class="event-feed">
          <span>LATEST EVENT</span>
          <p id="event-value">타이틀 메뉴 대기 중</p>
        </div>
      </aside>
    </div>

    <footer class="footer-strip">
      <span>고정 틱 결정론</span>
      <span>시드 기반 콘텐츠</span>
      <span>KEYDOWN / KEYUP 로그</span>
      <span>VCS 분리 평가</span>
      <strong>마우스 게임 입력 비활성</strong>
    </footer>
  </section>
`;

const canvas = app.querySelector<HTMLCanvasElement>('canvas')!;
const context = canvas.getContext('2d')!;
if (!canvas || !context) throw new Error('Canvas 2D is unavailable');

const sceneName = document.querySelector<HTMLElement>('#scene-name');
const trackValue = document.querySelector<HTMLElement>('#track-value');
const tickValue = document.querySelector<HTMLElement>('#tick-value');
const hashValue = document.querySelector<HTMLElement>('#hash-value');
const progressValue = document.querySelector<HTMLElement>('#progress-value');
const progressMeter = document.querySelector<HTMLElement>('#progress-meter');
const cueValue = document.querySelector<HTMLElement>('#cue-value');
const cueMeter = document.querySelector<HTMLElement>('#cue-meter');
const eventValue = document.querySelector<HTMLElement>('#event-value');

let titleMode = true;
let guideMode = false;
let titleSelection = 0;
let resultSelection = 0;
let contentSeed = 4201;
let visualSeed = 1;
let track: Track = 'realtime';
let game: GameState | null = null;
let runStartedAt = 0;
let savedRunHash = '';
let focusLost = false;
let accumulator = 0;
let syncAccumulator = 0;
let previousTime = performance.now();
let keySequence = 0;
let keyLog: KeyLog[] = [];
const heldKeys = new Set<string>();
const keyFlash = new Map<string, number>();
let attackEffectStartedAt = Number.NEGATIVE_INFINITY;
let runeEffectStartedAt = Number.NEGATIVE_INFINITY;
let edgeInput = emptyInput();

const allowedCodes = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Enter',
  'Space',
  'ShiftLeft',
  'ShiftRight',
  'Digit1',
  'Escape',
]);

function normalizedFlashCode(code: string): string {
  return code === 'ShiftRight' ? 'ShiftLeft' : code;
}

function logKey(event: KeyLog['event'], code: string, key: string, repeat: boolean): void {
  keyLog.push({
    sequence: keySequence,
    event,
    code,
    key,
    repeat,
    wallMs: Math.round(performance.now() - runStartedAt),
    appliedTick: game?.tick ?? 0,
    scene: game?.scene ?? 'title',
  });
  keySequence += 1;
}

function resetEdges(): void {
  edgeInput = emptyInput();
}

function startRun(overrides: Partial<GameConfig> = {}): void {
  game = createGame({
    contentSeed,
    visualSeed,
    track,
    ...overrides,
  });
  titleMode = false;
  guideMode = false;
  resultSelection = 0;
  focusLost = false;
  accumulator = 0;
  syncAccumulator = 0;
  heldKeys.clear();
  resetEdges();
  keyLog = [];
  keySequence = 0;
  attackEffectStartedAt = Number.NEGATIVE_INFINITY;
  runeEffectStartedAt = Number.NEGATIVE_INFINITY;
  runStartedAt = performance.now();
  savedRunHash = '';
  canvas.focus();
}

function backToTitle(): void {
  titleMode = true;
  guideMode = false;
  game = null;
  heldKeys.clear();
  resetEdges();
  titleSelection = 0;
  canvas.focus();
}

function changeTitleValue(direction: number): void {
  if (titleSelection === 1) contentSeed = Math.max(1, Math.min(999999, contentSeed + direction));
  else if (titleSelection === 2) visualSeed = (visualSeed + direction + 3) % 3;
  else if (titleSelection === 3) track = track === 'realtime' ? 'sync' : 'realtime';
}

function handleTitleKey(code: string): void {
  if (code === 'ArrowUp') titleSelection = Math.max(0, titleSelection - 1);
  else if (code === 'ArrowDown') titleSelection = Math.min(3, titleSelection + 1);
  else if (code === 'ArrowLeft') changeTitleValue(-1);
  else if (code === 'ArrowRight') changeTitleValue(1);
  else if (code === 'Enter' && titleSelection === 0) {
    titleMode = false;
    guideMode = true;
    canvas.focus();
  }
}

function downloadRun(): void {
  if (!game) return;
  const report = createReport(game);
  const payload: StoredRun = {
    schemaVersion: 1,
    runId: `${report.config.contentSeed}-${Date.now().toString(36)}`,
    savedAt: new Date().toISOString(),
    report,
    keys: keyLog,
    events: game.events,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = `emberward-${report.config.contentSeed}-${report.finalStateHash}.json`;
  anchor.click();
  URL.revokeObjectURL(href);
}

function handleResultKey(code: string): void {
  if (!game) return;
  if (code === 'ArrowUp') resultSelection = Math.max(0, resultSelection - 1);
  else if (code === 'ArrowDown') resultSelection = Math.min(3, resultSelection + 1);
  else if (code === 'Enter') {
    if (resultSelection === 0) startRun();
    else if (resultSelection === 1) {
      contentSeed += 1;
      startRun();
    } else if (resultSelection === 2) downloadRun();
    else backToTitle();
  }
}

function markGameplayEdge(code: string): void {
  if (!game) return;
  if (code === 'Enter') edgeInput.interactPressed = true;
  else if (code === 'Space') edgeInput.attackPressed = true;
  else if (code === 'Digit1') edgeInput.runePressed = true;
  else if (code === 'Escape') edgeInput.escapePressed = true;
  if (game.scene === 'rune') {
    if (code === 'ArrowUp' || code === 'ArrowLeft') edgeInput.menuPreviousPressed = true;
    if (code === 'ArrowDown' || code === 'ArrowRight') edgeInput.menuNextPressed = true;
  }
}

function clearHeldKeys(reason: KeyLog['event']): void {
  for (const code of heldKeys) logKey('keyup', code, code, false);
  heldKeys.clear();
  if (game && game.scene !== 'result') logKey(reason, '', '', false);
}

document.addEventListener('keydown', (event) => {
  if (!allowedCodes.has(event.code)) return;
  event.preventDefault();
  keyFlash.set(normalizedFlashCode(event.code), performance.now() + 170);
  if (event.repeat) {
    if (game && !titleMode) logKey('keydown', event.code, event.key, true);
    return;
  }
  if (focusLost && event.code === 'Enter') {
    focusLost = false;
    logKey('focus-restored', event.code, event.key, false);
    heldKeys.clear();
    resetEdges();
    return;
  }
  if (guideMode) {
    if (event.code === 'Enter') startRun();
    else if (event.code === 'Escape') backToTitle();
    return;
  }
  if (titleMode) {
    handleTitleKey(event.code);
    return;
  }
  if (game?.scene === 'result') {
    handleResultKey(event.code);
    return;
  }
  if (game?.scene === 'boss') {
    if (event.code === 'Space') attackEffectStartedAt = performance.now();
    if (event.code === 'Digit1') runeEffectStartedAt = performance.now();
  }
  heldKeys.add(event.code);
  logKey('keydown', event.code, event.key, false);
  markGameplayEdge(event.code);
});

document.addEventListener('keyup', (event) => {
  if (!allowedCodes.has(event.code)) return;
  event.preventDefault();
  if (titleMode || game?.scene === 'result') return;
  heldKeys.delete(event.code);
  logKey('keyup', event.code, event.key, false);
});

window.addEventListener('blur', () => {
  if (titleMode || !game || game.scene === 'result') return;
  clearHeldKeys('focus-lost');
  focusLost = true;
  resetEdges();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && game && game.scene !== 'result') {
    clearHeldKeys('focus-lost');
    focusLost = true;
    resetEdges();
  }
});

canvas.addEventListener('pointerdown', () => {
  canvas.focus();
});

canvas.addEventListener('contextmenu', (event) => event.preventDefault());

function currentInput(includeEdges: boolean): FrameInput {
  const inRuneMenu = game?.scene === 'rune';
  return {
    up: !inRuneMenu && heldKeys.has('ArrowUp'),
    down: !inRuneMenu && heldKeys.has('ArrowDown'),
    left: !inRuneMenu && heldKeys.has('ArrowLeft'),
    right: !inRuneMenu && heldKeys.has('ArrowRight'),
    guard: heldKeys.has('ShiftLeft') || heldKeys.has('ShiftRight'),
    interactPressed: includeEdges && edgeInput.interactPressed,
    attackPressed: includeEdges && edgeInput.attackPressed,
    runePressed: includeEdges && edgeInput.runePressed,
    menuPreviousPressed: includeEdges && edgeInput.menuPreviousPressed,
    menuNextPressed: includeEdges && edgeInput.menuNextPressed,
    escapePressed: includeEdges && edgeInput.escapePressed,
  };
}

function hasControlInput(input: FrameInput): boolean {
  return input.up
    || input.down
    || input.left
    || input.right
    || input.guard
    || input.interactPressed
    || input.attackPressed
    || input.runePressed
    || input.menuPreviousPressed
    || input.menuNextPressed
    || input.escapePressed;
}

function advanceRealtime(delta: number): void {
  if (!game) return;
  accumulator += delta;
  const stepMs = 1000 / TICKS_PER_SECOND;
  let firstStep = true;
  while (accumulator >= stepMs) {
    stepGame(game, currentInput(firstStep));
    firstStep = false;
    accumulator -= stepMs;
    if (game.scene === 'result') break;
  }
  if (!firstStep) resetEdges();
}

function advanceSync(delta: number): void {
  if (!game) return;
  syncAccumulator += delta;
  if (syncAccumulator < 100) return;
  syncAccumulator %= 100;
  const input = currentInput(true);
  const bossMayAdvance = game.scene === 'boss' && (!game.bossCue || game.bossCue.responded);
  if (!hasControlInput(input) && !bossMayAdvance) return;
  for (let index = 0; index < 6; index += 1) {
    stepGame(game, index === 0 ? input : currentInput(false));
    if (game.scene === 'result') break;
  }
  resetEdges();
}

function saveCompletedRun(): void {
  if (!game || game.scene !== 'result') return;
  const report = createReport(game);
  if (savedRunHash === report.finalStateHash) return;
  savedRunHash = report.finalStateHash;
  const run: StoredRun = {
    schemaVersion: 1,
    runId: `${report.config.contentSeed}-${Date.now().toString(36)}`,
    savedAt: new Date().toISOString(),
    report,
    keys: keyLog,
    events: game.events,
  };
  try {
    const indexKey = 'emberward:run-index:v1';
    const existing = JSON.parse(localStorage.getItem(indexKey) ?? '[]') as string[];
    const next = [run.runId, ...existing.filter((id) => id !== run.runId)].slice(0, 20);
    localStorage.setItem(`emberward:run:${run.runId}:v1`, JSON.stringify(run));
    for (const stale of existing.filter((id) => !next.includes(id))) localStorage.removeItem(`emberward:run:${stale}:v1`);
    localStorage.setItem(indexKey, JSON.stringify(next));
  } catch {
    // Storage availability is not part of the gameplay score.
  }
}

function sceneLabel(scene: GameState['scene'] | undefined): string {
  if (!scene) return 'READY';
  const labels: Record<GameState['scene'], string> = {
    guardian: '01 · BRIEFING',
    forest: '02 · FOREST',
    mural: '03 · MEMORY',
    altar: '04 · ALTARS',
    rune: '05 · RUNE MENU',
    boss: '06 · REALTIME BOSS',
    beacon: '07 · BEACON',
    result: 'RUN REPORT',
  };
  return labels[scene];
}

function updateTelemetry(): void {
  if (titleMode || guideMode || !game) {
    if (sceneName) sceneName.textContent = 'READY';
    if (trackValue) trackValue.textContent = track.toUpperCase();
    if (tickValue) tickValue.textContent = '00000';
    if (hashValue) hashValue.textContent = '--------';
    if (progressValue) progressValue.textContent = '0%';
    if (progressMeter) progressMeter.style.width = '0%';
    if (cueValue) cueValue.textContent = '0%';
    if (cueMeter) cueMeter.style.width = '0%';
    return;
  }
  const report = createReport(game);
  if (sceneName) sceneName.textContent = sceneLabel(game.scene);
  if (trackValue) trackValue.textContent = game.config.track.toUpperCase();
  if (tickValue) tickValue.textContent = String(game.tick).padStart(5, '0');
  if (hashValue) hashValue.textContent = stateFingerprint(game);
  if (progressValue) progressValue.textContent = `${report.progress}%`;
  if (progressMeter) progressMeter.style.width = `${report.progress}%`;
  if (cueValue) cueValue.textContent = `${report.cueResponse}%`;
  if (cueMeter) cueMeter.style.width = `${report.cueResponse}%`;
  if (eventValue) {
    const latest = game.events.at(-1);
    eventValue.textContent = latest ? `T${latest.tick} · ${latest.type} · ${latest.detail}` : game.message || '입력 대기 중';
  }
}

function frame(now: number): void {
  const delta = Math.min(100, now - previousTime);
  previousTime = now;
  if (!titleMode && game && game.scene !== 'result' && !focusLost) {
    if (game.config.track === 'realtime') advanceRealtime(delta);
    else advanceSync(delta);
  }
  saveCompletedRun();
  updateTelemetry();
  renderGame(context, game, {
    titleMode,
    guideMode,
    titleSelection,
    contentSeed,
    visualSeed,
    track,
    resultSelection,
    focusLost,
    keyFlash,
    guardActive: heldKeys.has('ShiftLeft') || heldKeys.has('ShiftRight'),
    attackEffectStartedAt,
    runeEffectStartedAt,
    now,
  });
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
