import {
  RUNE_KO,
  RUNES,
  SIGIL_KO,
  SIGILS,
  TARGET_TIME_TICKS,
  TICKS_PER_SECOND,
  VIEW_HEIGHT,
  VIEW_WIDTH,
  altarPosition,
  createReport,
  obstaclesFor,
  sceneWidth,
  type BossCueKind,
  type GameState,
  type Point,
  type Rune,
  type Sigil,
} from './game.ts';

export interface RenderMeta {
  titleMode: boolean;
  titleSelection: number;
  contentSeed: number;
  visualSeed: number;
  track: 'realtime' | 'sync';
  resultSelection: number;
  focusLost: boolean;
  keyFlash: ReadonlyMap<string, number>;
  now: number;
}

interface Palette {
  void: string;
  ground: string;
  groundAlt: string;
  line: string;
  text: string;
  muted: string;
  mint: string;
  gold: string;
  danger: string;
  blue: string;
}

const PALETTES: Palette[] = [
  {
    void: '#050c0b',
    ground: '#0b1916',
    groundAlt: '#10231d',
    line: '#29463c',
    text: '#edf6e9',
    muted: '#8ba298',
    mint: '#78e3b5',
    gold: '#f3c66b',
    danger: '#ff6b62',
    blue: '#77bfe9',
  },
  {
    void: '#080a11',
    ground: '#121625',
    groundAlt: '#181d30',
    line: '#38415d',
    text: '#f4f1e9',
    muted: '#9da4ba',
    mint: '#7ed8cc',
    gold: '#e9b96e',
    danger: '#f16f78',
    blue: '#89aef5',
  },
  {
    void: '#100909',
    ground: '#201410',
    groundAlt: '#2a1c15',
    line: '#5b3d2b',
    text: '#fff1db',
    muted: '#b49c88',
    mint: '#8fd7aa',
    gold: '#ffc267',
    danger: '#ff715d',
    blue: '#82c6d8',
  },
];

function paletteFor(visualSeed: number): Palette {
  return PALETTES[Math.abs(visualSeed) % PALETTES.length];
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const resolved = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.roundRect(x, y, width, height, resolved);
}

function label(
  context: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  size = 18,
  color = '#fff',
  align: CanvasTextAlign = 'left',
  weight = 600,
): void {
  context.fillStyle = color;
  context.font = `${weight} ${size}px "Pretendard", "Noto Sans KR", system-ui, sans-serif`;
  context.textAlign = align;
  context.textBaseline = 'middle';
  context.fillText(value, x, y);
}

function paragraph(
  context: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  color: string,
  size = 18,
): number {
  const words = value.split(' ');
  const lines: string[] = [];
  let current = '';
  context.font = `600 ${size}px "Pretendard", "Noto Sans KR", system-ui, sans-serif`;
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (context.measureText(candidate).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  for (const [index, line] of lines.entries()) label(context, line, x, y + index * lineHeight, size, color);
  return lines.length;
}

function drawSigil(
  context: CanvasRenderingContext2D,
  sigil: Sigil,
  x: number,
  y: number,
  size: number,
  color: string,
): void {
  context.save();
  context.translate(x, y);
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = Math.max(2, size * 0.09);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  if (sigil === 'moon') {
    context.beginPath();
    context.arc(0, 0, size * 0.45, Math.PI * 0.25, Math.PI * 1.75);
    context.arc(size * 0.2, 0, size * 0.34, Math.PI * 1.65, Math.PI * 0.35, true);
    context.closePath();
    context.fill();
  } else if (sigil === 'leaf') {
    context.beginPath();
    context.moveTo(0, -size * 0.48);
    context.bezierCurveTo(size * 0.55, -size * 0.22, size * 0.45, size * 0.36, 0, size * 0.48);
    context.bezierCurveTo(-size * 0.45, size * 0.2, -size * 0.5, -size * 0.25, 0, -size * 0.48);
    context.stroke();
    context.beginPath();
    context.moveTo(-size * 0.12, size * 0.34);
    context.lineTo(size * 0.16, -size * 0.28);
    context.stroke();
  } else {
    context.beginPath();
    context.moveTo(0, -size * 0.52);
    context.bezierCurveTo(size * 0.48, -size * 0.12, size * 0.4, size * 0.28, 0, size * 0.5);
    context.bezierCurveTo(-size * 0.42, size * 0.24, -size * 0.42, -size * 0.1, -size * 0.12, -size * 0.31);
    context.bezierCurveTo(-size * 0.1, -size * 0.08, size * 0.02, size * 0.04, size * 0.14, size * 0.08);
    context.bezierCurveTo(size * 0.18, -size * 0.14, size * 0.1, -size * 0.32, 0, -size * 0.52);
    context.fill();
  }
  context.restore();
}

function drawRune(
  context: CanvasRenderingContext2D,
  rune: Rune,
  x: number,
  y: number,
  size: number,
  color: string,
): void {
  context.save();
  context.translate(x, y);
  context.strokeStyle = color;
  context.lineWidth = Math.max(2, size * 0.08);
  context.lineCap = 'round';
  context.beginPath();
  if (rune === 'frost') {
    for (let index = 0; index < 3; index += 1) {
      context.moveTo(0, -size * 0.48);
      context.lineTo(0, size * 0.48);
      context.rotate(Math.PI / 3);
    }
  } else if (rune === 'ember') {
    context.moveTo(-size * 0.35, size * 0.42);
    context.lineTo(0, -size * 0.46);
    context.lineTo(size * 0.35, size * 0.42);
    context.lineTo(-size * 0.28, size * 0.1);
    context.lineTo(size * 0.28, size * 0.1);
  } else {
    context.moveTo(-size * 0.42, -size * 0.28);
    context.lineTo(size * 0.05, -size * 0.05);
    context.lineTo(-size * 0.08, size * 0.08);
    context.lineTo(size * 0.42, size * 0.3);
  }
  context.stroke();
  context.restore();
}

function objectiveFor(state: GameState): string {
  if (state.scene === 'guardian') return '수호자에게 다가가 임무를 받으세요';
  if (state.scene === 'forest') return `단서: ${SIGIL_KO[state.correctItem]} 문양의 불씨를 찾으세요`;
  if (state.scene === 'mural') return '폐허의 벽화를 조사하고 문양 순서를 기억하세요';
  if (state.scene === 'altar') return `기억한 순서대로 제단 작동 · ${state.altarProgress.length}/3`;
  if (state.scene === 'rune') return '수호자가 말한 약점 룬을 장착하세요';
  if (state.scene === 'boss') return '수호자의 예고 동작을 읽고 대응하세요';
  if (state.scene === 'beacon') return '봉화에 불씨를 설치해 점화하세요';
  return '평가 종료';
}

function drawAmbient(context: CanvasRenderingContext2D, state: GameState, palette: Palette, cameraX: number): void {
  const width = sceneWidth(state.scene);
  context.fillStyle = palette.ground;
  context.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
  context.save();
  context.translate(-cameraX, 0);
  context.strokeStyle = palette.line;
  context.lineWidth = 1;
  context.globalAlpha = 0.34;
  for (let x = 0; x <= width; x += 48) {
    context.beginPath();
    context.moveTo(x, 72);
    context.lineTo(x, VIEW_HEIGHT);
    context.stroke();
  }
  for (let y = 72; y <= VIEW_HEIGHT; y += 48) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }
  context.globalAlpha = 1;
  for (let index = 0; index < 20; index += 1) {
    const phase = (state.tick * (0.18 + index * 0.002) + index * 71 + state.config.visualSeed * 37) % (VIEW_HEIGHT + 80);
    const x = (index * 137 + state.config.visualSeed * 53) % width;
    context.fillStyle = index % 3 === 0 ? palette.gold : palette.muted;
    context.globalAlpha = 0.18 + (index % 4) * 0.05;
    context.fillRect(x, phase - 40, 2, 10);
  }
  context.globalAlpha = 1;
  for (const rect of obstaclesFor(state.scene)) {
    roundedRect(context, rect.x, rect.y, rect.w, rect.h, 12);
    context.fillStyle = palette.groundAlt;
    context.fill();
    context.strokeStyle = palette.line;
    context.lineWidth = 2;
    context.stroke();
    context.fillStyle = palette.line;
    context.globalAlpha = 0.4;
    context.fillRect(rect.x + 12, rect.y + 12, rect.w - 24, 4);
    context.globalAlpha = 1;
  }
  context.restore();
}

function drawCharacter(context: CanvasRenderingContext2D, state: GameState, palette: Palette, cameraX: number): void {
  const x = state.player.x - cameraX;
  const y = state.player.y;
  const bob = Math.sin(state.tick / 8) * 1.5;
  context.save();
  context.translate(x, y + bob);
  context.fillStyle = '#07110f';
  context.beginPath();
  context.ellipse(0, 14, 18, 7, 0, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = palette.mint;
  context.beginPath();
  context.moveTo(-13, -2);
  context.lineTo(0, -22);
  context.lineTo(13, -2);
  context.lineTo(9, 18);
  context.lineTo(-9, 18);
  context.closePath();
  context.fill();
  context.strokeStyle = palette.text;
  context.lineWidth = 2;
  context.stroke();
  context.fillStyle = palette.gold;
  context.fillRect(-3, -17, 6, 24);
  context.restore();
}

function drawInteractMarker(context: CanvasRenderingContext2D, point: Point, cameraX: number, palette: Palette): void {
  const x = point.x - cameraX;
  const pulse = 1 + Math.sin(performance.now() / 180) * 0.08;
  context.save();
  context.translate(x, point.y - 48);
  context.scale(pulse, pulse);
  roundedRect(context, -33, -15, 66, 30, 8);
  context.fillStyle = '#07110fe6';
  context.fill();
  context.strokeStyle = palette.gold;
  context.lineWidth = 2;
  context.stroke();
  label(context, 'ENTER', 0, 1, 12, palette.gold, 'center', 800);
  context.restore();
}

function drawGuardian(context: CanvasRenderingContext2D, state: GameState, palette: Palette): void {
  const pulse = 22 + Math.sin(state.tick / 18) * 3;
  context.strokeStyle = palette.blue;
  context.globalAlpha = 0.25;
  context.lineWidth = 3;
  context.beginPath();
  context.arc(480, 135, pulse, 0, Math.PI * 2);
  context.stroke();
  context.globalAlpha = 1;
  context.fillStyle = palette.blue;
  context.beginPath();
  context.arc(480, 135, 17, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = palette.text;
  context.fillRect(474, 122, 12, 25);
  label(context, '봉화 수호자', 480, 174, 14, palette.muted, 'center');
  drawInteractMarker(context, { x: 480, y: 135 }, 0, palette);
  if (state.dialogPage < 0) return;
  roundedRect(context, 100, 286, 760, 176, 14);
  context.fillStyle = '#050c0bf2';
  context.fill();
  context.strokeStyle = palette.gold;
  context.lineWidth = 2;
  context.stroke();
  label(context, state.dialogPage === 0 ? '수호자의 단서' : '수호자의 경고', 135, 322, 15, palette.gold, 'left', 800);
  if (state.dialogPage === 0) {
    paragraph(context, `숲에서 ${SIGIL_KO[state.correctItem]} 문양이 새겨진 불씨를 가져오세요. 모양을 정확히 기억해야 합니다.`, 135, 360, 690, 30, palette.text, 21);
  } else {
    paragraph(context, `봉화탑 수호자의 보호막은 ${RUNE_KO[state.weakness]} 룬에 약합니다. 폐허에서 그 룬을 장착하세요.`, 135, 360, 690, 30, palette.text, 21);
  }
  label(context, 'ENTER · 다음', 820, 430, 13, palette.muted, 'right', 700);
}

function drawForest(context: CanvasRenderingContext2D, state: GameState, palette: Palette, cameraX: number): void {
  context.save();
  context.translate(-cameraX, 0);
  for (let x = 120; x < 1400; x += 165) {
    const y = 105 + ((x * 17 + state.config.visualSeed * 29) % 310);
    context.fillStyle = palette.line;
    context.beginPath();
    context.moveTo(x, y - 35);
    context.lineTo(x - 26, y + 20);
    context.lineTo(x + 26, y + 20);
    context.closePath();
    context.fill();
    context.fillStyle = '#34291d';
    context.fillRect(x - 4, y + 18, 8, 24);
  }
  for (const item of state.items) {
    const pulse = 30 + Math.sin((state.tick + item.x) / 16) * 4;
    context.strokeStyle = palette.gold;
    context.globalAlpha = 0.28;
    context.lineWidth = 3;
    context.beginPath();
    context.arc(item.x, item.y, pulse, 0, Math.PI * 2);
    context.stroke();
    context.globalAlpha = 1;
    context.fillStyle = '#07110f';
    roundedRect(context, item.x - 30, item.y - 30, 60, 60, 12);
    context.fill();
    context.strokeStyle = palette.gold;
    context.stroke();
    drawSigil(context, item.sigil, item.x, item.y, 38, palette.gold);
    label(context, SIGIL_KO[item.sigil], item.x, item.y + 47, 14, palette.text, 'center', 800);
  }
  context.restore();
  const nearest = [...state.items].sort((a, b) => Math.hypot(a.x - state.player.x, a.y - state.player.y) - Math.hypot(b.x - state.player.x, b.y - state.player.y))[0];
  if (nearest && Math.hypot(nearest.x - state.player.x, nearest.y - state.player.y) < 92) drawInteractMarker(context, nearest, cameraX, palette);
}

function drawMuralRoom(context: CanvasRenderingContext2D, state: GameState, palette: Palette): void {
  roundedRect(context, 350, 88, 260, 98, 12);
  context.fillStyle = palette.groundAlt;
  context.fill();
  context.strokeStyle = palette.blue;
  context.lineWidth = 2;
  context.stroke();
  label(context, '기억의 벽화', 480, 120, 18, palette.blue, 'center', 800);
  label(context, '세 문양의 순서', 480, 150, 14, palette.muted, 'center');
  drawInteractMarker(context, { x: 480, y: 145 }, 0, palette);
  if (!state.muralVisible) return;
  context.fillStyle = '#020706ed';
  context.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
  roundedRect(context, 125, 90, 710, 350, 18);
  context.fillStyle = palette.groundAlt;
  context.fill();
  context.strokeStyle = palette.blue;
  context.lineWidth = 3;
  context.stroke();
  label(context, '벽화의 기록 · 순서를 기억하세요', 480, 137, 21, palette.text, 'center', 800);
  state.muralSequence.forEach((sigil, index) => {
    const x = 280 + index * 200;
    context.fillStyle = '#07110f';
    context.beginPath();
    context.arc(x, 260, 68, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = palette.gold;
    context.lineWidth = 2;
    context.stroke();
    drawSigil(context, sigil, x, 250, 74, palette.gold);
    label(context, `${index + 1} · ${SIGIL_KO[sigil]}`, x, 345, 18, palette.text, 'center', 800);
  });
  label(context, 'ENTER · 벽화를 닫고 제단으로 이동', 480, 404, 14, palette.muted, 'center', 700);
}

function drawAltars(context: CanvasRenderingContext2D, state: GameState, palette: Palette): void {
  for (const sigil of SIGILS) {
    const point = altarPosition(sigil);
    const completed = state.altarProgress.includes(sigil);
    roundedRect(context, point.x - 55, point.y - 45, 110, 90, 14);
    context.fillStyle = completed ? '#183e32' : palette.groundAlt;
    context.fill();
    context.strokeStyle = completed ? palette.mint : palette.gold;
    context.lineWidth = completed ? 4 : 2;
    context.stroke();
    drawSigil(context, sigil, point.x, point.y - 4, 46, completed ? palette.mint : palette.gold);
    label(context, SIGIL_KO[sigil], point.x, point.y + 60, 15, palette.text, 'center', 800);
  }
  const nearestSigil = [...SIGILS].sort((a, b) => {
    const left = altarPosition(a);
    const right = altarPosition(b);
    return Math.hypot(left.x - state.player.x, left.y - state.player.y)
      - Math.hypot(right.x - state.player.x, right.y - state.player.y);
  })[0];
  const nearest = altarPosition(nearestSigil);
  if (Math.hypot(nearest.x - state.player.x, nearest.y - state.player.y) < 95) drawInteractMarker(context, nearest, 0, palette);
  label(context, `입력 ${state.altarProgress.length} / 3`, 480, 265, 18, palette.muted, 'center', 800);
}

function drawRuneMenu(context: CanvasRenderingContext2D, state: GameState, palette: Palette): void {
  context.fillStyle = palette.ground;
  context.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
  label(context, '룬 장착 제단', 480, 103, 28, palette.text, 'center', 800);
  label(context, '수호자의 말을 기억해 약점 룬을 선택하세요', 480, 140, 16, palette.muted, 'center');
  RUNES.forEach((rune, index) => {
    const y = 215 + index * 82;
    roundedRect(context, 260, y - 31, 440, 62, 10);
    context.fillStyle = state.runeSelection === index ? '#203d35' : palette.groundAlt;
    context.fill();
    context.strokeStyle = state.runeSelection === index ? palette.mint : palette.line;
    context.lineWidth = state.runeSelection === index ? 3 : 1;
    context.stroke();
    drawRune(context, rune, 310, y, 36, state.runeSelection === index ? palette.mint : palette.muted);
    label(context, `${RUNE_KO[rune]} 룬`, 355, y, 20, palette.text, 'left', 800);
    if (state.runeSelection === index) label(context, '▶', 675, y, 20, palette.mint, 'right', 900);
  });
  label(context, '↑ ↓ 선택   ENTER 장착', 480, 485, 14, palette.muted, 'center', 700);
}

function cueLabel(kind: BossCueKind): string {
  if (kind === 'cone') return '부채꼴 위험';
  if (kind === 'wave') return '원형 파동';
  if (kind === 'open') return '갑옷 개방';
  return '룬 공명';
}

function drawBoss(context: CanvasRenderingContext2D, state: GameState, palette: Palette): void {
  const bossX = 480;
  const bossY = 150;
  const cue = state.bossCue;
  if (cue?.kind === 'cone') {
    context.fillStyle = '#ff6b6240';
    context.strokeStyle = palette.danger;
    context.lineWidth = 3;
    context.beginPath();
    context.moveTo(bossX, bossY + 28);
    context.lineTo(cue.targetX - 130, VIEW_HEIGHT);
    context.lineTo(cue.targetX + 130, VIEW_HEIGHT);
    context.closePath();
    context.fill();
    context.stroke();
  }
  if (cue?.kind === 'wave') {
    const progress = Math.min(1, (state.tick - cue.startedAt) / cue.duration);
    context.strokeStyle = palette.danger;
    context.lineWidth = 5;
    context.globalAlpha = 0.9 - progress * 0.3;
    context.beginPath();
    context.arc(bossX, bossY, 55 + progress * 285, 0, Math.PI * 2);
    context.stroke();
    context.globalAlpha = 1;
  }
  if (cue?.kind === 'open') {
    context.fillStyle = '#f3c66b35';
    context.beginPath();
    context.arc(bossX, bossY, 75 + Math.sin(state.tick / 8) * 8, 0, Math.PI * 2);
    context.fill();
  }
  context.fillStyle = cue?.kind === 'open' ? palette.gold : palette.danger;
  roundedRect(context, bossX - 42, bossY - 38, 84, 76, 18);
  context.fill();
  context.strokeStyle = palette.text;
  context.lineWidth = 3;
  context.stroke();
  context.fillStyle = '#07110f';
  context.fillRect(bossX - 20, bossY - 8, 40, 11);
  if (cue?.kind === 'rune') drawRune(context, state.weakness, bossX, bossY - 76, 54, palette.blue);
  label(context, '봉화의 수호자', bossX, bossY + 58, 16, palette.text, 'center', 800);
  const barWidth = 250;
  context.fillStyle = '#07110f';
  context.fillRect(355, 55, barWidth, 13);
  context.fillStyle = palette.danger;
  context.fillRect(355, 55, barWidth * (state.bossHp / state.bossMaxHp), 13);
  if (cue) {
    roundedRect(context, 360, 248, 240, 46, 10);
    context.fillStyle = '#050c0bd9';
    context.fill();
    context.strokeStyle = cue.responded && cue.success ? palette.mint : palette.danger;
    context.stroke();
    label(context, cueLabel(cue.kind), 480, 272, 18, cue.responded && cue.success ? palette.mint : palette.text, 'center', 900);
  } else {
    label(context, '다음 움직임 관찰 중…', 480, 272, 15, palette.muted, 'center');
  }
}

function drawBeacon(context: CanvasRenderingContext2D, state: GameState, palette: Palette): void {
  const pulse = 48 + Math.sin(state.tick / 12) * 7;
  context.fillStyle = palette.gold;
  context.globalAlpha = 0.16;
  context.beginPath();
  context.arc(480, 145, pulse, 0, Math.PI * 2);
  context.fill();
  context.globalAlpha = 1;
  context.strokeStyle = palette.gold;
  context.lineWidth = 5;
  context.beginPath();
  context.moveTo(450, 190);
  context.lineTo(480, 95);
  context.lineTo(510, 190);
  context.stroke();
  drawSigil(context, state.correctItem, 480, 140, 48, palette.gold);
  label(context, '고대 봉화', 480, 220, 18, palette.text, 'center', 800);
  drawInteractMarker(context, { x: 480, y: 145 }, 0, palette);
}

function drawHud(context: CanvasRenderingContext2D, state: GameState, palette: Palette): void {
  context.fillStyle = '#040a09ee';
  context.fillRect(0, 0, VIEW_WIDTH, 70);
  context.strokeStyle = palette.line;
  context.beginPath();
  context.moveTo(0, 70);
  context.lineTo(VIEW_WIDTH, 70);
  context.stroke();
  label(context, objectiveFor(state), 24, 25, 16, palette.text, 'left', 800);
  label(context, `SEED ${state.config.contentSeed} · ${state.config.track.toUpperCase()}`, 24, 50, 12, palette.muted, 'left', 700);
  const remaining = Math.max(0, 180 - state.tick / TICKS_PER_SECOND);
  label(context, `${remaining.toFixed(1)}s`, 925, 25, 17, remaining < 30 ? palette.danger : palette.gold, 'right', 900);
  label(context, `HP ${'◆'.repeat(state.playerHp)}${'◇'.repeat(state.maxHp - state.playerHp)}`, 925, 50, 14, palette.mint, 'right', 800);
  if (state.message) {
    roundedRect(context, 205, 466, 550, 48, 10);
    context.fillStyle = '#040a09ed';
    context.fill();
    context.strokeStyle = palette.line;
    context.stroke();
    label(context, state.message, 480, 490, 15, palette.text, 'center', 750);
  }
}

function drawKeyFeedback(context: CanvasRenderingContext2D, meta: RenderMeta, palette: Palette): void {
  const keys = [
    ['ArrowUp', '↑'], ['ArrowDown', '↓'], ['ArrowLeft', '←'], ['ArrowRight', '→'],
    ['Enter', 'ENTER'], ['Space', 'SPACE'], ['ShiftLeft', 'SHIFT'], ['Digit1', '1'],
  ] as const;
  let x = 18;
  const y = 520;
  for (const [code, name] of keys) {
    const width = name.length > 2 ? 55 : 30;
    roundedRect(context, x, y - 15, width, 25, 6);
    const active = (meta.keyFlash.get(code) ?? 0) > meta.now;
    context.fillStyle = active ? palette.mint : '#07110fd9';
    context.fill();
    context.strokeStyle = active ? palette.text : palette.line;
    context.stroke();
    label(context, name, x + width / 2, y - 2, 10, active ? '#07110f' : palette.muted, 'center', 800);
    x += width + 6;
  }
}

function drawTitle(context: CanvasRenderingContext2D, meta: RenderMeta, palette: Palette): void {
  context.fillStyle = palette.void;
  context.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
  for (let index = 0; index < 36; index += 1) {
    const x = (index * 83 + meta.visualSeed * 31) % VIEW_WIDTH;
    const y = (index * 47 + meta.now * 0.018) % VIEW_HEIGHT;
    context.fillStyle = index % 4 === 0 ? palette.gold : palette.line;
    context.globalAlpha = 0.2 + (index % 3) * 0.08;
    context.fillRect(x, y, 2, 14);
  }
  context.globalAlpha = 1;
  label(context, '02 / VISUAL KEYBOARD RPG', 70, 78, 13, palette.mint, 'left', 800);
  label(context, 'EMBERWARD', 70, 132, 44, palette.text, 'left', 900);
  label(context, '마지막 봉화', 72, 174, 22, palette.gold, 'left', 800);
  paragraph(context, '연속 영상만 보고 키보드로 이동·기억·메뉴·전투를 수행하는 결정론적 AI 조작 평가', 72, 215, 465, 28, palette.muted, 17);
  const entries = [
    ['평가 시작', 'ENTER'],
    ['콘텐츠 시드', String(meta.contentSeed)],
    ['비주얼 변형', String(meta.visualSeed)],
    ['평가 트랙', meta.track.toUpperCase()],
  ];
  entries.forEach(([name, value], index) => {
    const y = 310 + index * 49;
    roundedRect(context, 70, y - 19, 470, 39, 8);
    context.fillStyle = meta.titleSelection === index ? '#17352d' : '#0b1715';
    context.fill();
    context.strokeStyle = meta.titleSelection === index ? palette.mint : palette.line;
    context.lineWidth = meta.titleSelection === index ? 2 : 1;
    context.stroke();
    label(context, meta.titleSelection === index ? `▶  ${name}` : name, 88, y, 15, palette.text, 'left', 800);
    label(context, value, 520, y, 14, meta.titleSelection === index ? palette.mint : palette.muted, 'right', 800);
  });
  roundedRect(context, 590, 70, 300, 410, 14);
  context.fillStyle = '#091411';
  context.fill();
  context.strokeStyle = palette.line;
  context.stroke();
  label(context, 'KEYBOARD ONLY', 620, 110, 14, palette.gold, 'left', 900);
  const controls = [
    ['방향키', '이동 / 메뉴 선택'],
    ['ENTER', '대화 / 조사 / 확정'],
    ['SPACE', '공격'],
    ['SHIFT', '누르고 방어'],
    ['1', '약점 룬 사용'],
    ['ESC', '메뉴 취소'],
  ];
  controls.forEach(([key, action], index) => {
    const y = 160 + index * 47;
    roundedRect(context, 620, y - 15, 74, 30, 6);
    context.fillStyle = '#101f1b';
    context.fill();
    context.strokeStyle = palette.line;
    context.stroke();
    label(context, key, 657, y, 11, palette.mint, 'center', 900);
    label(context, action, 714, y, 13, palette.text, 'left', 650);
  });
  label(context, '↑↓ 선택 · ←→ 값 변경 · ENTER 시작', 620, 453, 12, palette.muted, 'left', 650);
}

function drawResult(context: CanvasRenderingContext2D, state: GameState, meta: RenderMeta, palette: Palette): void {
  const report = createReport(state);
  context.fillStyle = palette.void;
  context.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
  label(context, report.success ? 'BEACON RESTORED' : 'MISSION ENDED', 70, 74, 13, report.success ? palette.mint : palette.danger, 'left', 900);
  label(context, report.success ? '봉화 점화 완료' : '평가 종료', 70, 118, 34, palette.text, 'left', 900);
  label(context, `VCS ${report.vcs}`, 70, 170, 42, palette.gold, 'left', 900);
  const stats = [
    ['진행도', `${report.progress}%`],
    ['예고 대응', `${report.cueResponse}%`],
    ['키보드 제어', `${report.keyboardControl}`],
    ['기억', `${report.memory}`],
    ['완료 시간', `${report.seconds}s`],
    ['상태 해시', report.finalStateHash],
  ];
  stats.forEach(([name, value], index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = 70 + column * 245;
    const y = 240 + row * 68;
    label(context, name, x, y, 12, palette.muted, 'left', 700);
    label(context, value, x, y + 27, 20, palette.text, 'left', 850);
  });
  roundedRect(context, 590, 76, 300, 380, 14);
  context.fillStyle = '#091411';
  context.fill();
  context.strokeStyle = palette.line;
  context.stroke();
  label(context, 'RUN REPORT', 620, 111, 14, palette.gold, 'left', 900);
  const options = ['같은 시드 재도전', '다음 시드', 'JSON 리포트 저장', '타이틀로'];
  options.forEach((option, index) => {
    const y = 178 + index * 58;
    roundedRect(context, 620, y - 19, 240, 38, 7);
    context.fillStyle = meta.resultSelection === index ? '#17352d' : '#0d1a17';
    context.fill();
    context.strokeStyle = meta.resultSelection === index ? palette.mint : palette.line;
    context.stroke();
    label(context, meta.resultSelection === index ? `▶ ${option}` : option, 638, y, 14, palette.text, 'left', 750);
  });
  label(context, '↑↓ 선택 · ENTER', 620, 425, 12, palette.muted, 'left', 700);
}

export function renderGame(
  context: CanvasRenderingContext2D,
  state: GameState | null,
  meta: RenderMeta,
): void {
  const palette = paletteFor(meta.visualSeed);
  if (meta.titleMode || !state) {
    drawTitle(context, meta, palette);
    return;
  }
  if (state.scene === 'result') {
    drawResult(context, state, meta, palette);
    return;
  }
  if (state.scene === 'rune') {
    drawRuneMenu(context, state, palette);
    drawHud(context, state, palette);
    drawKeyFeedback(context, meta, palette);
    return;
  }
  const worldWidth = sceneWidth(state.scene);
  const cameraX = Math.max(0, Math.min(worldWidth - VIEW_WIDTH, state.player.x - VIEW_WIDTH / 2));
  drawAmbient(context, state, palette, cameraX);
  if (state.scene === 'guardian') drawGuardian(context, state, palette);
  else if (state.scene === 'forest') drawForest(context, state, palette, cameraX);
  else if (state.scene === 'mural') drawMuralRoom(context, state, palette);
  else if (state.scene === 'altar') drawAltars(context, state, palette);
  else if (state.scene === 'boss') drawBoss(context, state, palette);
  else if (state.scene === 'beacon') drawBeacon(context, state, palette);
  drawCharacter(context, state, palette, cameraX);
  drawHud(context, state, palette);
  drawKeyFeedback(context, meta, palette);

  if (meta.focusLost) {
    context.fillStyle = '#020706df';
    context.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
    roundedRect(context, 225, 190, 510, 160, 14);
    context.fillStyle = palette.groundAlt;
    context.fill();
    context.strokeStyle = palette.danger;
    context.lineWidth = 3;
    context.stroke();
    label(context, '입력 포커스 손실', 480, 235, 25, palette.text, 'center', 900);
    label(context, '평가가 일시 정지되었습니다', 480, 277, 16, palette.muted, 'center', 650);
    label(context, 'ENTER · 재개', 480, 321, 14, palette.gold, 'center', 800);
  }
}

export function targetSeconds(): number {
  return TARGET_TIME_TICKS / TICKS_PER_SECOND;
}
