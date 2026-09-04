export const VIEW_WIDTH = 960;
export const VIEW_HEIGHT = 540;
export const TICKS_PER_SECOND = 60;
export const TIME_LIMIT_TICKS = 180 * TICKS_PER_SECOND;
export const TARGET_TIME_TICKS = 120 * TICKS_PER_SECOND;

export type Track = 'realtime' | 'sync';
export type Scene = 'guardian' | 'forest' | 'mural' | 'altar' | 'rune' | 'boss' | 'beacon' | 'result';
export type Sigil = 'moon' | 'leaf' | 'flame';
export type Rune = 'frost' | 'ember' | 'storm';
export type BossCueKind = 'cone' | 'wave' | 'open' | 'rune';

export const SIGILS: readonly Sigil[] = ['moon', 'leaf', 'flame'];
export const RUNES: readonly Rune[] = ['frost', 'ember', 'storm'];

export const SIGIL_KO: Record<Sigil, string> = {
  moon: '달',
  leaf: '잎',
  flame: '불꽃',
};

export const RUNE_KO: Record<Rune, string> = {
  frost: '서리',
  ember: '잿불',
  storm: '폭풍',
};

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GameConfig {
  contentSeed: number;
  visualSeed: number;
  track: Track;
}

export interface FrameInput {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  guard: boolean;
  interactPressed: boolean;
  attackPressed: boolean;
  runePressed: boolean;
  menuPreviousPressed: boolean;
  menuNextPressed: boolean;
  escapePressed: boolean;
}

export interface ItemCandidate {
  sigil: Sigil;
  x: number;
  y: number;
}

export interface BossCue {
  kind: BossCueKind;
  startedAt: number;
  duration: number;
  targetX: number;
  responded: boolean;
  success: boolean;
}

export interface Milestones {
  clue: boolean;
  item: boolean;
  altar: boolean;
  rune: boolean;
  boss: boolean;
  beacon: boolean;
}

export interface GameStats {
  moveTicks: number;
  collisionTicks: number;
  invalidActions: number;
  wrongItems: number;
  altarMistakes: number;
  wrongRune: number;
  cueSeen: number;
  cueCorrect: number;
  bossHits: number;
  retryCount: number;
}

export interface GameEvent {
  seq: number;
  tick: number;
  type: string;
  detail: string;
  stateHash: string;
}

export interface GameState {
  config: GameConfig;
  scene: Scene;
  tick: number;
  sceneTick: number;
  player: Point;
  playerHp: number;
  maxHp: number;
  correctItem: Sigil;
  muralSequence: Sigil[];
  altarProgress: Sigil[];
  weakness: Rune;
  equippedRune: Rune | null;
  runeSelection: number;
  items: ItemCandidate[];
  bossPattern: BossCueKind[];
  bossPatternIndex: number;
  bossHp: number;
  bossMaxHp: number;
  bossCue: BossCue | null;
  nextCueTick: number;
  dialogPage: number;
  muralVisible: boolean;
  milestones: Milestones;
  stats: GameStats;
  penalty: number;
  message: string;
  messageUntil: number;
  success: boolean | null;
  terminalReason: string | null;
  events: GameEvent[];
}

export interface GameReport {
  success: boolean;
  terminalReason: string;
  ticks: number;
  seconds: number;
  progress: number;
  cueResponse: number;
  health: number;
  efficiency: number;
  vcs: number;
  keyboardControl: number;
  memory: number;
  stats: GameStats;
  config: GameConfig;
  finalStateHash: string;
}

function hash32(value: string | number): number {
  const text = String(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  return hash >>> 0;
}

function createRng(seed: number, namespace: string): () => number {
  let state = hash32(`${namespace}:${seed}`);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(input: readonly T[], rng: () => number): T[] {
  const values = [...input];
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }
  return values;
}

export function emptyInput(): FrameInput {
  return {
    up: false,
    down: false,
    left: false,
    right: false,
    guard: false,
    interactPressed: false,
    attackPressed: false,
    runePressed: false,
    menuPreviousPressed: false,
    menuNextPressed: false,
    escapePressed: false,
  };
}

export function createGame(config: Partial<GameConfig> = {}): GameState {
  const resolved: GameConfig = {
    contentSeed: config.contentSeed ?? 4201,
    visualSeed: config.visualSeed ?? 1,
    track: config.track ?? 'realtime',
  };
  const contentRng = createRng(resolved.contentSeed, 'content-v1');
  const itemOrder = shuffled(SIGILS, contentRng);
  const positions = shuffled([
    { x: 320, y: 190 },
    { x: 735, y: 345 },
    { x: 1160, y: 175 },
  ], contentRng);
  const patternBase: BossCueKind[] = ['wave', 'open', 'cone', 'rune', 'cone', 'open', 'wave', 'rune'];
  const rotation = Math.floor(contentRng() * patternBase.length);
  const pattern = [...patternBase.slice(rotation), ...patternBase.slice(0, rotation)];
  const state: GameState = {
    config: resolved,
    scene: 'guardian',
    tick: 0,
    sceneTick: 0,
    player: { x: 480, y: 430 },
    playerHp: 5,
    maxHp: 5,
    correctItem: itemOrder[0],
    muralSequence: shuffled(SIGILS, contentRng),
    altarProgress: [],
    weakness: shuffled(RUNES, contentRng)[0],
    equippedRune: null,
    runeSelection: 0,
    items: itemOrder.map((sigil, index) => ({ sigil, ...positions[index] })),
    bossPattern: pattern,
    bossPatternIndex: 0,
    bossHp: 4,
    bossMaxHp: 4,
    bossCue: null,
    nextCueTick: 75,
    dialogPage: -1,
    muralVisible: false,
    milestones: { clue: false, item: false, altar: false, rune: false, boss: false, beacon: false },
    stats: {
      moveTicks: 0,
      collisionTicks: 0,
      invalidActions: 0,
      wrongItems: 0,
      altarMistakes: 0,
      wrongRune: 0,
      cueSeen: 0,
      cueCorrect: 0,
      bossHits: 0,
      retryCount: 0,
    },
    penalty: 0,
    message: '수호자에게 다가가 ENTER로 대화하세요.',
    messageUntil: 240,
    success: null,
    terminalReason: null,
    events: [],
  };
  return state;
}

export function sceneWidth(scene: Scene): number {
  return scene === 'forest' ? 1440 : VIEW_WIDTH;
}

export function obstaclesFor(scene: Scene): Rect[] {
  if (scene === 'guardian') return [
    { x: 170, y: 230, w: 120, h: 55 },
    { x: 670, y: 230, w: 120, h: 55 },
  ];
  if (scene === 'forest') return [
    { x: 430, y: 90, w: 80, h: 210 },
    { x: 585, y: 330, w: 120, h: 120 },
    { x: 880, y: 70, w: 90, h: 230 },
    { x: 1010, y: 350, w: 100, h: 115 },
  ];
  if (scene === 'mural') return [
    { x: 240, y: 210, w: 100, h: 80 },
    { x: 620, y: 210, w: 100, h: 80 },
  ];
  if (scene === 'altar') return [
    { x: 390, y: 300, w: 70, h: 95 },
    { x: 500, y: 300, w: 70, h: 95 },
  ];
  return [];
}

function distance(left: Point, right: Point): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function collides(point: Point, rect: Rect, radius = 14): boolean {
  return point.x + radius > rect.x
    && point.x - radius < rect.x + rect.w
    && point.y + radius > rect.y
    && point.y - radius < rect.y + rect.h;
}

function showMessage(state: GameState, message: string, duration = 150): void {
  state.message = message;
  state.messageUntil = state.tick + duration;
}

function setScene(state: GameState, scene: Scene, player: Point): void {
  state.scene = scene;
  state.sceneTick = 0;
  state.player = { ...player };
  state.dialogPage = -1;
  state.muralVisible = false;
  addEvent(state, 'scene', scene);
}

function addEvent(state: GameState, type: string, detail: string): void {
  state.events.push({
    seq: state.events.length,
    tick: state.tick,
    type,
    detail,
    stateHash: stateFingerprint(state),
  });
}

function movePlayer(state: GameState, input: FrameInput): void {
  let xAxis = Number(input.right) - Number(input.left);
  let yAxis = Number(input.down) - Number(input.up);
  if (xAxis === 0 && yAxis === 0) return;
  state.stats.moveTicks += 1;
  const magnitude = Math.hypot(xAxis, yAxis);
  xAxis /= magnitude;
  yAxis /= magnitude;
  const speed = state.scene === 'boss' ? 3.15 : 2.75;
  const width = sceneWidth(state.scene);
  const next = {
    x: Math.max(26, Math.min(width - 26, state.player.x + xAxis * speed)),
    y: Math.max(82, Math.min(VIEW_HEIGHT - 28, state.player.y + yAxis * speed)),
  };
  if (obstaclesFor(state.scene).some((rect) => collides(next, rect))) {
    state.stats.collisionTicks += 1;
    return;
  }
  state.player = next;
}

function handleGuardian(state: GameState, input: FrameInput): void {
  if (state.dialogPage >= 0) {
    if (!input.interactPressed) return;
    if (state.dialogPage < 1) {
      state.dialogPage += 1;
      return;
    }
    state.milestones.clue = true;
    addEvent(state, 'milestone', 'clue');
    setScene(state, 'forest', { x: 80, y: 420 });
    showMessage(state, `${SIGIL_KO[state.correctItem]} 문양의 불씨를 찾으세요.`, 240);
    return;
  }
  movePlayer(state, input);
  if (!input.interactPressed) return;
  if (distance(state.player, { x: 480, y: 135 }) > 72) {
    state.stats.invalidActions += 1;
    showMessage(state, '상호작용 대상이 너무 멉니다.');
    return;
  }
  state.dialogPage = 0;
  addEvent(state, 'dialog', 'guardian-open');
}

function handleForest(state: GameState, input: FrameInput): void {
  movePlayer(state, input);
  if (!input.interactPressed) return;
  const nearest = [...state.items].sort((left, right) => distance(state.player, left) - distance(state.player, right))[0];
  if (!nearest || distance(state.player, nearest) > 68) {
    state.stats.invalidActions += 1;
    showMessage(state, '조사할 불씨가 가까이에 없습니다.');
    return;
  }
  if (nearest.sigil !== state.correctItem) {
    state.stats.wrongItems += 1;
    state.penalty += 40;
    addEvent(state, 'mistake', `wrong-item:${nearest.sigil}`);
    showMessage(state, '단서와 다른 문양입니다. 다시 확인하세요.', 180);
    return;
  }
  state.milestones.item = true;
  addEvent(state, 'milestone', 'item');
  setScene(state, 'mural', { x: 480, y: 440 });
  showMessage(state, '폐허의 벽화를 조사하세요.', 180);
}

function handleMural(state: GameState, input: FrameInput): void {
  if (state.muralVisible) {
    if (!input.interactPressed && !input.escapePressed) return;
    state.muralVisible = false;
    setScene(state, 'altar', { x: 480, y: 455 });
    showMessage(state, '기억한 순서대로 세 제단을 작동시키세요.', 240);
    return;
  }
  movePlayer(state, input);
  if (!input.interactPressed) return;
  if (distance(state.player, { x: 480, y: 125 }) > 74) {
    state.stats.invalidActions += 1;
    showMessage(state, '벽화에 더 가까이 가세요.');
    return;
  }
  state.muralVisible = true;
  addEvent(state, 'observation', 'mural-open');
}

const ALTAR_POSITIONS: Record<Sigil, Point> = {
  moon: { x: 225, y: 170 },
  leaf: { x: 480, y: 170 },
  flame: { x: 735, y: 170 },
};

export function altarPosition(sigil: Sigil): Point {
  return ALTAR_POSITIONS[sigil];
}

function handleAltar(state: GameState, input: FrameInput): void {
  movePlayer(state, input);
  if (!input.interactPressed) return;
  const nearest = SIGILS
    .map((sigil) => ({ sigil, position: ALTAR_POSITIONS[sigil] }))
    .sort((left, right) => distance(state.player, left.position) - distance(state.player, right.position))[0];
  if (distance(state.player, nearest.position) > 70) {
    state.stats.invalidActions += 1;
    showMessage(state, '활성화할 제단이 가까이에 없습니다.');
    return;
  }
  const expected = state.muralSequence[state.altarProgress.length];
  if (nearest.sigil !== expected) {
    state.stats.altarMistakes += 1;
    state.penalty += 50;
    state.altarProgress = [];
    addEvent(state, 'mistake', `altar:${nearest.sigil}`);
    showMessage(state, '문양 순서가 틀렸습니다. 처음부터 다시 입력하세요.', 210);
    return;
  }
  state.altarProgress.push(nearest.sigil);
  addEvent(state, 'altar', nearest.sigil);
  if (state.altarProgress.length < state.muralSequence.length) {
    showMessage(state, `제단 ${state.altarProgress.length}/3 활성화`, 100);
    return;
  }
  state.milestones.altar = true;
  addEvent(state, 'milestone', 'altar');
  setScene(state, 'rune', { x: 480, y: 400 });
  showMessage(state, '수호자의 약점 룬을 장착하세요.', 180);
}

function handleRune(state: GameState, input: FrameInput): void {
  if (input.menuPreviousPressed) state.runeSelection = Math.max(0, state.runeSelection - 1);
  if (input.menuNextPressed) state.runeSelection = Math.min(RUNES.length - 1, state.runeSelection + 1);
  if (!input.interactPressed) return;
  state.equippedRune = RUNES[state.runeSelection];
  if (state.equippedRune !== state.weakness) {
    state.stats.wrongRune += 1;
    state.penalty += 60;
    addEvent(state, 'mistake', `wrong-rune:${state.equippedRune}`);
  }
  state.milestones.rune = true;
  addEvent(state, 'milestone', `rune:${state.equippedRune}`);
  setScene(state, 'boss', { x: 480, y: 435 });
  state.nextCueTick = state.tick + 75;
  showMessage(state, '예고 표식을 보고 이동·방어·반격하세요.', 240);
}

function beginBossCue(state: GameState): void {
  const kind = state.bossPattern[state.bossPatternIndex % state.bossPattern.length];
  state.bossCue = {
    kind,
    startedAt: state.tick,
    duration: kind === 'wave' || kind === 'cone' ? 96 : 120,
    targetX: state.player.x,
    responded: false,
    success: false,
  };
  addEvent(state, 'boss-cue', kind);
}

function registerCueResponse(state: GameState, success: boolean, detail: string): void {
  const cue = state.bossCue;
  if (!cue || cue.responded) return;
  cue.responded = true;
  cue.success = success;
  if (success) {
    state.stats.cueCorrect += 1;
    addEvent(state, 'cue-response', `correct:${detail}`);
  } else {
    addEvent(state, 'cue-response', `wrong:${detail}`);
  }
}

function damagePlayer(state: GameState, detail: string): void {
  state.playerHp = Math.max(0, state.playerHp - 1);
  state.stats.bossHits += 1;
  addEvent(state, 'damage', detail);
  showMessage(state, '피격! 다음 예고를 다시 확인하세요.', 120);
  if (state.playerHp > 0) return;
  if (state.stats.retryCount === 0) {
    state.stats.retryCount = 1;
    state.playerHp = 3;
    state.penalty += 150;
    state.player = { x: 480, y: 435 };
    showMessage(state, '마지막 가호로 부활했습니다. 제한 시간은 계속됩니다.', 210);
    return;
  }
  finishGame(state, false, 'defeated');
}

function resolveBossCue(state: GameState, input: FrameInput): void {
  const cue = state.bossCue;
  if (!cue) return;
  state.stats.cueSeen += 1;
  if (cue.kind === 'wave') {
    if (!input.guard) {
      addEvent(state, 'cue-response', 'missed:wave');
      damagePlayer(state, 'wave');
    } else if (!cue.success) {
      cue.success = true;
      state.stats.cueCorrect += 1;
      addEvent(state, 'cue-response', 'correct:wave');
    }
  } else if (cue.kind === 'cone') {
    const success = Math.abs(state.player.x - cue.targetX) >= 125;
    cue.success = success;
    if (success) {
      state.stats.cueCorrect += 1;
      addEvent(state, 'cue-response', 'correct:cone');
    } else {
      damagePlayer(state, 'cone');
    }
  }
  state.bossCue = null;
  state.bossPatternIndex += 1;
  state.nextCueTick = state.tick + 48;
}

function handleBoss(state: GameState, input: FrameInput): void {
  movePlayer(state, input);
  if (!state.bossCue && state.tick >= state.nextCueTick) beginBossCue(state);
  const cue = state.bossCue;
  if (!cue) return;

  if (input.attackPressed) {
    if (cue.kind === 'open' && !cue.responded) {
      state.bossHp = Math.max(0, state.bossHp - 1);
      registerCueResponse(state, true, 'open');
      showMessage(state, '반격 성공!', 80);
    } else {
      state.stats.invalidActions += 1;
      showMessage(state, '공격 기회가 아닙니다.', 70);
    }
  }
  if (input.runePressed) {
    if (cue.kind === 'rune' && !cue.responded && state.equippedRune === state.weakness) {
      state.bossHp = Math.max(0, state.bossHp - 1);
      registerCueResponse(state, true, 'rune');
      showMessage(state, '약점 룬 적중!', 80);
    } else {
      state.stats.invalidActions += 1;
      if (cue.kind === 'rune' && !cue.responded) registerCueResponse(state, false, 'rune');
      showMessage(state, '룬이 반응하지 않았습니다.', 80);
    }
  }
  if (state.bossHp <= 0) {
    state.milestones.boss = true;
    addEvent(state, 'milestone', 'boss');
    setScene(state, 'beacon', { x: 480, y: 440 });
    showMessage(state, '봉화에 불씨를 설치하세요.', 210);
    return;
  }
  if (state.tick - cue.startedAt >= cue.duration) resolveBossCue(state, input);
}

function handleBeacon(state: GameState, input: FrameInput): void {
  movePlayer(state, input);
  if (!input.interactPressed) return;
  if (distance(state.player, { x: 480, y: 145 }) > 80) {
    state.stats.invalidActions += 1;
    showMessage(state, '봉화 가까이에서 ENTER를 누르세요.');
    return;
  }
  state.milestones.beacon = true;
  addEvent(state, 'milestone', 'beacon');
  finishGame(state, true, 'beacon-lit');
}

function finishGame(state: GameState, success: boolean, reason: string): void {
  state.success = success;
  state.terminalReason = reason;
  state.scene = 'result';
  state.sceneTick = 0;
  addEvent(state, 'terminal', reason);
}

export function stepGame(state: GameState, input: FrameInput): GameState {
  if (state.scene === 'result') return state;
  state.tick += 1;
  state.sceneTick += 1;
  if (state.tick >= TIME_LIMIT_TICKS) {
    finishGame(state, false, 'timeout');
    return state;
  }
  if (state.message && state.tick >= state.messageUntil) state.message = '';
  if (state.scene === 'guardian') handleGuardian(state, input);
  else if (state.scene === 'forest') handleForest(state, input);
  else if (state.scene === 'mural') handleMural(state, input);
  else if (state.scene === 'altar') handleAltar(state, input);
  else if (state.scene === 'rune') handleRune(state, input);
  else if (state.scene === 'boss') handleBoss(state, input);
  else if (state.scene === 'beacon') handleBeacon(state, input);
  return state;
}

function progressValue(milestones: Milestones): number {
  return Number(milestones.clue) * 0.10
    + Number(milestones.item) * 0.15
    + Number(milestones.altar) * 0.15
    + Number(milestones.rune) * 0.10
    + Number(milestones.boss) * 0.30
    + Number(milestones.beacon) * 0.20;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function createReport(state: GameState): GameReport {
  const progress = progressValue(state.milestones);
  const cueResponse = state.stats.cueSeen === 0
    ? 0
    : Math.min(1, state.stats.cueCorrect / state.stats.cueSeen);
  const health = state.playerHp / state.maxHp;
  const efficiency = state.success ? Math.min(1, TARGET_TIME_TICKS / state.tick) : 0;
  const controlPenalty = state.stats.invalidActions * 5
    + state.stats.collisionTicks / Math.max(1, state.stats.moveTicks) * 80;
  const keyboardControl = Math.round(100 * clamp01(1 - controlPenalty / 100));
  const memory = Math.round(100 * clamp01(1 - state.stats.altarMistakes * 0.34 - state.stats.wrongRune * 0.2));
  const vcs = Math.max(0, Math.round(100 * (
    progress * 0.60
    + cueResponse * 0.20
    + progress * health * 0.10
    + efficiency * 0.10
  ) - state.penalty / 20));
  return {
    success: state.success === true,
    terminalReason: state.terminalReason ?? 'in-progress',
    ticks: state.tick,
    seconds: Math.round(state.tick / TICKS_PER_SECOND * 10) / 10,
    progress: Math.round(progress * 100),
    cueResponse: Math.round(cueResponse * 100),
    health: Math.round(health * 100),
    efficiency: Math.round(efficiency * 100),
    vcs,
    keyboardControl,
    memory,
    stats: { ...state.stats },
    config: { ...state.config },
    finalStateHash: stateFingerprint(state),
  };
}

export function stateFingerprint(state: GameState): string {
  const snapshot = {
    config: state.config,
    scene: state.scene,
    tick: state.tick,
    sceneTick: state.sceneTick,
    player: {
      x: Math.round(state.player.x * 1000),
      y: Math.round(state.player.y * 1000),
    },
    playerHp: state.playerHp,
    correctItem: state.correctItem,
    muralSequence: state.muralSequence,
    altarProgress: state.altarProgress,
    weakness: state.weakness,
    equippedRune: state.equippedRune,
    runeSelection: state.runeSelection,
    items: state.items,
    bossPattern: state.bossPattern,
    bossPatternIndex: state.bossPatternIndex,
    bossHp: state.bossHp,
    bossCue: state.bossCue,
    nextCueTick: state.nextCueTick,
    milestones: state.milestones,
    stats: state.stats,
    penalty: state.penalty,
    success: state.success,
    terminalReason: state.terminalReason,
  };
  return hash32(JSON.stringify(snapshot)).toString(16).padStart(8, '0');
}
