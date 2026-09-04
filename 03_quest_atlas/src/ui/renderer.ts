import { CANVAS_HEIGHT, CANVAS_WIDTH } from "./shell.ts";
import type {
  AppViewModel,
  DialogueView,
  ObservationKind,
  ObservationView,
  QuestStatus,
  QuestView,
  SeedView,
  SidebarPanel,
  WorldNodeView,
} from "./types.ts";

interface Palette {
  ink: string;
  muted: string;
  bg: string;
  panel: string;
  panelRaised: string;
  line: string;
  accent: string;
  accentSoft: string;
  positive: string;
  warning: string;
  negative: string;
  map: string;
}

const W = CANVAS_WIDTH;
const H = CANVAS_HEIGHT;
const FONT = '"Noto Sans KR", "Pretendard", "Malgun Gothic", sans-serif';

function palette(view: AppViewModel): Palette {
  return {
    ink: "#eef7f4",
    muted: "#8ea5a3",
    bg: "#071116",
    panel: "#0c1b21",
    panelRaised: "#12262b",
    line: "#294148",
    accent: view.theme?.accent ?? "#72e0bc",
    accentSoft: view.theme?.accentSoft ?? "#214f49",
    positive: "#78d6a7",
    warning: "#f0bd68",
    negative: "#eb7f77",
    map: view.theme?.mapTint ?? "#102c31",
  };
}

function roundedPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r = 12): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function panel(
  ctx: CanvasRenderingContext2D,
  p: Palette,
  x: number,
  y: number,
  w: number,
  h: number,
  fill = p.panel,
  stroke = p.line,
  radius = 14,
): void {
  roundedPath(ctx, x, y, w, h, radius);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  ctx.stroke();
}

function label(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  color: string,
  weight = 500,
  align: CanvasTextAlign = "left",
): void {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, x, y);
}

function clippedLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  size: number,
  color: string,
  weight = 500,
): void {
  ctx.font = `${weight} ${size}px ${FONT}`;
  let value = text;
  while (value.length > 1 && ctx.measureText(value).width > maxWidth) value = `${value.slice(0, -2)}…`;
  label(ctx, value, x, y, size, color, weight);
}

function wrapped(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
  size: number,
  color: string,
  weight = 500,
): void {
  ctx.font = `${weight} ${size}px ${FONT}`;
  const words = Array.from(text);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line + word;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word.trimStart();
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  const shown = lines.slice(0, maxLines);
  if (lines.length > maxLines && shown.length) {
    let last = shown[shown.length - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
    shown[shown.length - 1] = `${last}…`;
  }
  shown.forEach((row, index) => label(ctx, row, x, y + index * lineHeight, size, color, weight));
}

function drawBackdrop(ctx: CanvasRenderingContext2D, p: Palette, now: number): void {
  const gradient = ctx.createLinearGradient(0, 0, W, H);
  gradient.addColorStop(0, p.bg);
  gradient.addColorStop(0.58, "#09181e");
  gradient.addColorStop(1, "#071016");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = "rgba(114,224,188,0.035)";
  ctx.lineWidth = 1;
  for (let x = -40; x < W + 80; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x + (now / 100) % 40, 0);
    ctx.lineTo(x - 180 + (now / 100) % 40, H);
    ctx.stroke();
  }
}

function phaseName(view: AppViewModel): string {
  switch (view.phase) {
    case "title": return "SESSION SETUP";
    case "briefing": return "ONE-TIME BRIEFING";
    case "explore": return "FIELD RESEARCH";
    case "ledger": return "RAW OBSERVATION LEDGER";
    case "result": return "SESSION ARCHIVE";
  }
}

function drawTopbar(ctx: CanvasRenderingContext2D, view: AppViewModel, p: Palette): void {
  label(ctx, "QUEST ATLAS", 24, 35, 13, p.accent, 800);
  label(ctx, phaseName(view), 146, 35, 12, p.muted, 700);
  ctx.fillStyle = p.line;
  ctx.fillRect(24, 50, W - 48, 1);

  const seeds = view.seeds.slice(0, 4);
  let right = 1256;
  for (let index = seeds.length - 1; index >= 0; index -= 1) {
    const seed = seeds[index];
    ctx.font = `700 10px ${FONT}`;
    const value = `${seed.label} ${seed.value}`;
    const width = Math.max(112, ctx.measureText(value).width + 22);
    right -= width;
    roundedPath(ctx, right, 17, width - 6, 25, 7);
    ctx.fillStyle = "#102229";
    ctx.fill();
    label(ctx, value, right + (width - 6) / 2, 34, 10, p.muted, 700, "center");
  }
}

function drawSeedCards(ctx: CanvasRenderingContext2D, seeds: SeedView[], p: Palette): void {
  const visible = seeds.slice(0, 4);
  visible.forEach((seed, index) => {
    const x = 196 + index * 222;
    panel(ctx, p, x, 424, 204, 82, "rgba(12,27,33,0.92)");
    label(ctx, seed.label, x + 16, 449, 10, p.muted, 800);
    clippedLabel(ctx, String(seed.value), x + 16, 480, 172, 18, p.ink, 800);
  });
}

function drawTitle(ctx: CanvasRenderingContext2D, view: AppViewModel, p: Palette, now: number): void {
  drawTopbar(ctx, view, p);
  const pulse = 0.45 + Math.sin(now / 900) * 0.08;
  ctx.strokeStyle = `rgba(114,224,188,${pulse})`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(640, 218, 112, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(640, 218, 86, -0.4, 4.3);
  ctx.stroke();
  ctx.fillStyle = p.accentSoft;
  ctx.beginPath();
  ctx.arc(640, 218, 49, 0, Math.PI * 2);
  ctx.fill();
  label(ctx, "Q", 640, 242, 64, p.accent, 900, "center");

  label(ctx, view.title?.title ?? "QUEST ATLAS", 640, 345, 46, p.ink, 900, "center");
  label(ctx, view.title?.subtitle ?? "안개항 조사록", 640, 382, 20, p.muted, 600, "center");
  drawSeedCards(ctx, view.seeds, p);

  panel(ctx, p, 370, 544, 540, 86, "rgba(16,39,43,0.86)", p.accentSoft, 16);
  label(ctx, "게임을 탐색하고, 관찰 근거로 콘텐츠 구조를 기록하세요.", 640, 578, 16, p.ink, 650, "center");
  label(ctx, "ENTER  세션 브리핑 열기", 640, 609, 13, p.accent, 800, "center");
  label(ctx, view.title?.sessionLabel ?? view.session.runId, 640, 675, 11, p.muted, 600, "center");
}

function keyCard(ctx: CanvasRenderingContext2D, p: Palette, key: string, title: string, detail: string, x: number, y: number): void {
  panel(ctx, p, x, y, 512, 65, p.panelRaised, p.line, 11);
  roundedPath(ctx, x + 14, y + 13, 72, 39, 8);
  ctx.fillStyle = p.accentSoft;
  ctx.fill();
  ctx.strokeStyle = p.accent;
  ctx.stroke();
  label(ctx, key, x + 50, y + 39, 12, p.accent, 850, "center");
  label(ctx, title, x + 104, y + 28, 14, p.ink, 750);
  label(ctx, detail, x + 104, y + 49, 11, p.muted, 500);
}

function drawBriefing(ctx: CanvasRenderingContext2D, view: AppViewModel, p: Palette): void {
  drawTopbar(ctx, view, p);
  const page = Math.max(1, view.briefing?.page ?? 1);
  label(ctx, "조사 인터페이스", 82, 116, 28, p.ink, 850);
  label(ctx, `이 안내는 세션 시작 전에 한 번만 표시됩니다.  ${page} / ${Math.max(page, view.briefing?.totalPages ?? 1)}`, 82, 146, 12, p.warning, 650);

  if (page === 1) {
    keyCard(ctx, p, "←  →", "대상과 경로 선택", "강조된 큰 카드 사이를 순환합니다.", 82, 184);
    keyCard(ctx, p, "ENTER", "이동 · 조사 · 결정", "선택된 행동을 한 번 실행합니다.", 82, 263);
    keyCard(ctx, p, "C", "정보 패널", "퀘스트, 가방, 최근 관찰을 전환합니다.", 82, 342);
    keyCard(ctx, p, "TAB", "원문 관찰 장부", "확인한 대화와 결과를 OBS ID로 다시 봅니다.", 82, 421);
    keyCard(ctx, p, "B · F", "근거 정리", "북마크하거나 관찰 유형을 필터링합니다.", 82, 500);

    panel(ctx, p, 634, 184, 564, 381, "rgba(12,27,33,0.9)");
    label(ctx, "평가 원칙", 666, 226, 18, p.accent, 800);
    const rules = [
      ["01", "조작 속도와 반응 시간은 콘텐츠 점수에 포함되지 않습니다."],
      ["02", "화면은 관찰한 결과만 보여주며 규칙을 자동 해석하지 않습니다."],
      ["03", "대사, 상태 변화, 실패 결과도 서로 다른 근거가 될 수 있습니다."],
      ["04", "기록할 사실과 불확실성은 조사자가 직접 판단합니다."],
      ["05", "세션 종료 후 구조화 데이터와 위키를 내보낼 수 있습니다."],
    ];
    rules.forEach(([number, text], index) => {
      const y = 270 + index * 55;
      label(ctx, number, 668, y, 11, p.accent, 850);
      wrapped(ctx, text, 714, y, 432, 20, 2, 13, p.ink, 570);
    });
  } else {
    panel(ctx, p, 82, 184, 1116, 381, "rgba(12,27,33,0.9)");
    label(ctx, "세션 흐름", 116, 229, 18, p.accent, 800);
    const phases = [
      ["A", "탐색", "지역과 인물, 장치의 결과를 직접 관찰합니다."],
      ["B", "구조화", "원문 OBS ID를 근거로 관계와 절차를 기록합니다."],
      ["C", "재현", "같은 시드에서 작성한 절차가 다시 성립하는지 확인합니다."],
      ["D", "전이", "같은 규칙, 다른 배치에서도 문서가 유효한지 검사합니다."],
    ];
    phases.forEach(([mark, title, detail], index) => {
      const x = 116 + index * 264;
      ctx.fillStyle = index === 0 ? p.accent : p.accentSoft;
      ctx.beginPath();
      ctx.arc(x + 28, 312, 27, 0, Math.PI * 2);
      ctx.fill();
      label(ctx, mark, x + 28, 319, 16, index === 0 ? p.bg : p.accent, 900, "center");
      label(ctx, title, x, 370, 18, p.ink, 800);
      wrapped(ctx, detail, x, 402, 220, 22, 4, 13, p.muted, 520);
    });
  }

  label(ctx, page < (view.briefing?.totalPages ?? 1) ? "ENTER  다음" : "ENTER  조사 시작", 640, 632, 15, p.accent, 850, "center");
  label(ctx, "←  이전", 82, 678, 11, p.muted, 650);
}

function nodePoint(node: WorldNodeView): { x: number; y: number } {
  return { x: 74 + Math.max(0, Math.min(1, node.x)) * 764, y: 170 + Math.max(0, Math.min(1, node.y)) * 280 };
}

function nodeGlyph(kind: WorldNodeView["kind"]): string {
  switch (kind) {
    case "npc": return "N";
    case "resource": return "R";
    case "shop": return "S";
    case "workshop": return "W";
    case "landmark": return "L";
    default: return "•";
  }
}

function drawWorldMap(ctx: CanvasRenderingContext2D, view: AppViewModel, p: Palette): void {
  const world = view.world;
  panel(ctx, p, 24, 72, 850, 428, p.map, p.line, 16);
  if (!world) {
    label(ctx, "현장 데이터 대기 중", 449, 288, 16, p.muted, 650, "center");
    return;
  }

  label(ctx, world.areaName, 48, 108, 20, p.ink, 850);
  label(ctx, world.locationName, 48, 132, 12, p.accent, 700);
  label(ctx, [world.clock, world.tide, world.weather].filter(Boolean).join(" · "), 848, 110, 11, p.muted, 650, "right");

  const byId = new Map(world.nodes.map((node) => [node.id, node]));
  for (const edge of world.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    const a = nodePoint(from);
    const b = nodePoint(to);
    ctx.save();
    ctx.strokeStyle = edge.locked ? "rgba(142,165,163,0.22)" : "rgba(114,224,188,0.34)";
    ctx.lineWidth = edge.locked ? 1 : 2;
    if (edge.locked) ctx.setLineDash([5, 7]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }

  for (const node of world.nodes) {
    const point = nodePoint(node);
    const radius = node.current ? 18 : node.selected ? 15 : 12;
    if (node.current) {
      ctx.strokeStyle = "rgba(114,224,188,0.22)";
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius + 7, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = node.available === false ? "#16272b" : node.current ? p.accent : node.visited ? p.accentSoft : "#193138";
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = node.selected ? p.warning : p.line;
    ctx.lineWidth = node.selected ? 3 : 1;
    ctx.stroke();
    label(ctx, nodeGlyph(node.kind), point.x, point.y + 4, 10, node.current ? p.bg : p.ink, 850, "center");
    clippedLabel(ctx, node.name, point.x - 45, point.y + radius + 19, 90, 10, node.available === false ? p.muted : p.ink, 600);
    if (node.badge) {
      label(ctx, node.badge, point.x + radius + 3, point.y - radius, 9, p.warning, 850);
    }
  }
}

function drawDialogue(ctx: CanvasRenderingContext2D, dialogue: DialogueView, p: Palette): void {
  panel(ctx, p, 24, 514, 850, 182, p.panelRaised, p.line, 15);
  label(ctx, dialogue.speaker, 48, 548, 16, p.ink, 850);
  if (dialogue.role) label(ctx, dialogue.role, 48, 568, 10, p.muted, 650);
  if (dialogue.observationId) {
    panel(ctx, p, 732, 528, 116, 28, p.accentSoft, p.accentSoft, 7);
    label(ctx, dialogue.observationId, 790, 547, 10, p.accent, 850, "center");
  }
  wrapped(ctx, dialogue.text, 48, 596, dialogue.choices?.length ? 408 : 760, 24, 4, 14, p.ink, 520);

  dialogue.choices?.slice(0, 4).forEach((choice, index) => {
    const x = 480;
    const y = 571 + index * 28;
    if (choice.selected) {
      roundedPath(ctx, x, y - 17, 356, 24, 5);
      ctx.fillStyle = "rgba(114,224,188,0.12)";
      ctx.fill();
    }
    label(ctx, choice.key, x + 5, y, 11, choice.disabled ? p.muted : p.accent, 850);
    clippedLabel(ctx, choice.text, x + 35, y, 312, 11, choice.disabled ? p.muted : p.ink, choice.selected ? 700 : 520);
  });
}

function drawLocationActions(ctx: CanvasRenderingContext2D, view: AppViewModel, p: Palette): void {
  const world = view.world;
  panel(ctx, p, 24, 514, 850, 182, p.panelRaised, p.line, 15);
  label(ctx, "현재 장소", 48, 545, 10, p.muted, 800);
  label(ctx, world?.locationName ?? "—", 48, 574, 18, p.ink, 850);
  wrapped(ctx, world?.description ?? "대상을 선택하면 관찰 가능한 행동이 표시됩니다.", 48, 603, 340, 22, 3, 12, p.muted, 520);

  const targets = world?.targets ?? [];
  const selectedIndex = Math.max(0, targets.findIndex((target) => target.selected));
  const pageSize = 4;
  const pageCount = Math.max(1, Math.ceil(targets.length / pageSize));
  const pageIndex = Math.min(pageCount - 1, Math.floor(selectedIndex / pageSize));
  const visibleTargets = targets.slice(pageIndex * pageSize, pageIndex * pageSize + pageSize);
  if (targets.length > pageSize) {
    label(ctx, `‹  ${pageIndex + 1} / ${pageCount}  ›`, 848, 535, 9, p.muted, 750, "right");
  }

  visibleTargets.forEach((target, index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const x = 430 + col * 204;
    const y = 543 + row * 67;
    panel(ctx, p, x, y, 190, 55, target.selected ? "#173b3b" : p.panel, target.selected ? p.accent : p.line, 9);
    label(ctx, target.icon ?? String(index + 1), x + 19, y + 32, 12, target.disabled ? p.muted : p.accent, 850, "center");
    clippedLabel(ctx, target.title, x + 38, y + 25, 137, 12, target.disabled ? p.muted : p.ink, 700);
    if (target.subtitle || target.stateLabel) {
      clippedLabel(ctx, target.stateLabel ?? target.subtitle ?? "", x + 38, y + 43, 137, 9, p.muted, 520);
    }
  });
}

function questColor(status: QuestStatus, p: Palette): string {
  switch (status) {
    case "complete": return p.positive;
    case "failed": return p.negative;
    case "active": return p.accent;
    case "available": return p.warning;
    default: return p.muted;
  }
}

function drawQuestRows(ctx: CanvasRenderingContext2D, quests: QuestView[], p: Palette, x: number, y: number, width: number, maxRows: number): void {
  quests.slice(0, maxRows).forEach((quest, index) => {
    const rowY = y + index * 43;
    ctx.fillStyle = questColor(quest.status, p);
    ctx.beginPath();
    ctx.arc(x + 7, rowY - 4, quest.selected ? 5 : 3, 0, Math.PI * 2);
    ctx.fill();
    clippedLabel(ctx, quest.title, x + 21, rowY, width - 21, 11, quest.status === "locked" ? p.muted : p.ink, quest.selected ? 750 : 550);
    if (quest.progressLabel) clippedLabel(ctx, quest.progressLabel, x + 21, rowY + 17, width - 21, 9, p.muted, 500);
  });
}

function drawSidebar(ctx: CanvasRenderingContext2D, view: AppViewModel, p: Palette): void {
  const x = 894;
  panel(ctx, p, x, 72, 362, 624, "#09191f", p.line, 16);
  const active = view.sidebarPanel ?? "quests";
  const tabs: { id: SidebarPanel; text: string }[] = [
    { id: "quests", text: "QUESTS" },
    { id: "inventory", text: "BAG" },
    { id: "observations", text: "OBS" },
  ];
  tabs.forEach((tab, index) => {
    const tabX = x + 18 + index * 110;
    panel(ctx, p, tabX, 88, 102, 31, tab.id === active ? p.accentSoft : p.panel, tab.id === active ? p.accent : p.line, 7);
    label(ctx, tab.text, tabX + 51, 108, 9, tab.id === active ? p.accent : p.muted, 850, "center");
  });

  if (active === "quests") {
    const quests = view.quests.filter((quest) => quest.status !== "locked");
    label(ctx, "DISCOVERED QUESTS", x + 22, 151, 10, p.muted, 850);
    label(ctx, `${view.quests.filter((quest) => quest.status === "complete").length}/${view.quests.length}`, x + 338, 151, 10, p.accent, 750, "right");
    drawQuestRows(ctx, quests, p, x + 24, 187, 312, 11);
  } else if (active === "inventory") {
    label(ctx, "INVENTORY", x + 22, 151, 10, p.muted, 850);
    label(ctx, `${view.inventory.length} TYPES`, x + 338, 151, 9, p.accent, 650, "right");
    view.inventory.slice(0, 32).forEach((item, index) => {
      const col = index % 4;
      const row = Math.floor(index / 4);
      const itemX = x + 23 + col * 80;
      const itemY = 170 + row * 63;
      panel(ctx, p, itemX, itemY, 68, 53, item.selected ? "#173b3b" : p.panel, item.recent ? p.warning : p.line, 9);
      label(ctx, item.icon ?? item.name.slice(0, 1), itemX + 34, itemY + 24, 13, item.recent ? p.warning : p.accent, 800, "center");
      clippedLabel(ctx, item.name, itemX + 7, itemY + 43, 49, 8, p.muted, 520);
      label(ctx, String(item.count), itemX + 60, itemY + 45, 9, p.ink, 800, "right");
    });
  } else {
    label(ctx, "RAW OBSERVATIONS", x + 22, 151, 10, p.muted, 850);
    label(ctx, `${view.session.observedCount}`, x + 338, 151, 10, p.accent, 750, "right");
    view.observations.slice(-10).reverse().forEach((observation, index) => {
      const rowY = 180 + index * 48;
      label(ctx, observation.bookmarked ? "◆" : "◇", x + 24, rowY, 9, observation.bookmarked ? p.warning : p.muted, 800);
      label(ctx, observation.id, x + 42, rowY, 9, observation.fresh ? p.accent : p.muted, 800);
      clippedLabel(ctx, observation.text, x + 42, rowY + 17, 286, 10, p.ink, 520);
      label(ctx, `${observation.source} · ${observation.worldTime}`, x + 42, rowY + 33, 8, p.muted, 500);
    });
  }
  label(ctx, "C  NEXT PANEL", x + 338, 675, 9, p.muted, 700, "right");
}

function drawSessionStrip(ctx: CanvasRenderingContext2D, view: AppViewModel, p: Palette): void {
  const action = view.session.actionBudget === undefined
    ? `${view.session.actionCount} ACTIONS`
    : `${view.session.actionCount} / ${view.session.actionBudget} ACTIONS`;
  label(ctx, view.session.phaseLabel, 894, 62, 9, p.accent, 800);
  label(ctx, action, 1256, 62, 9, p.muted, 700, "right");
}

function drawExplore(ctx: CanvasRenderingContext2D, view: AppViewModel, p: Palette): void {
  drawTopbar(ctx, view, p);
  drawSessionStrip(ctx, view, p);
  drawWorldMap(ctx, view, p);
  if (view.dialogue) drawDialogue(ctx, view.dialogue, p);
  else drawLocationActions(ctx, view, p);
  drawSidebar(ctx, view, p);
}

function observationKindLabel(kind: ObservationKind): string {
  switch (kind) {
    case "dialogue": return "대화";
    case "inspect": return "조사";
    case "outcome": return "결과";
    case "system": return "상태";
    case "world": return "환경";
  }
}

function drawLedger(ctx: CanvasRenderingContext2D, view: AppViewModel, p: Palette): void {
  drawTopbar(ctx, view, p);
  label(ctx, "원문 관찰 장부", 42, 97, 22, p.ink, 850);
  label(ctx, "확인한 화면의 원문 기록 · 자동 해석되지 않음", 42, 120, 11, p.muted, 600);
  label(ctx, `FILTER  ${(view.ledger?.filter ?? "all").toUpperCase()}`, 1238, 108, 10, p.accent, 800, "right");

  panel(ctx, p, 24, 142, 500, 526, "#09191f", p.line, 14);
  panel(ctx, p, 544, 142, 712, 526, p.panel, p.line, 14);
  const selectedIndex = Math.max(0, Math.min(view.observations.length - 1, view.ledger?.cursor ?? 0));
  const selected = view.observations.find((item) => item.selected) ?? view.observations[selectedIndex];
  const start = Math.max(0, selectedIndex - 4);
  view.observations.slice(start, start + 9).forEach((observation, index) => {
    const y = 171 + index * 53;
    const active = observation.id === selected?.id;
    if (active) {
      roundedPath(ctx, 39, y - 21, 470, 44, 8);
      ctx.fillStyle = "rgba(114,224,188,0.12)";
      ctx.fill();
    }
    label(ctx, observation.bookmarked ? "◆" : "◇", 50, y + 2, 10, observation.bookmarked ? p.warning : p.muted, 800);
    label(ctx, observation.id, 72, y + 2, 10, active ? p.accent : p.muted, 850);
    clippedLabel(ctx, observation.text, 151, y + 2, 335, 11, p.ink, active ? 680 : 520);
    label(ctx, `${observationKindLabel(observation.kind)} · ${observation.area}`, 72, y + 19, 9, p.muted, 500);
  });

  if (selected) drawObservationDetail(ctx, selected, p);
  else label(ctx, "아직 기록된 관찰이 없습니다.", 900, 388, 15, p.muted, 600, "center");
  label(ctx, "OBS ID는 이후 위키 주장과 절차의 근거로 연결할 수 있습니다.", 900, 640, 10, p.muted, 550, "center");
}

function drawObservationDetail(ctx: CanvasRenderingContext2D, observation: ObservationView, p: Palette): void {
  panel(ctx, p, 576, 173, 648, 59, p.panelRaised, observation.bookmarked ? p.warning : p.line, 10);
  label(ctx, observation.id, 596, 207, 16, p.accent, 850);
  label(ctx, observationKindLabel(observation.kind), 1204, 207, 10, p.muted, 700, "right");
  label(ctx, "SOURCE", 580, 273, 9, p.muted, 850);
  label(ctx, observation.source, 580, 299, 15, p.ink, 700);
  label(ctx, "PLACE / TIME", 880, 273, 9, p.muted, 850);
  label(ctx, `${observation.area} · ${observation.worldTime}`, 880, 299, 13, p.ink, 600);
  ctx.fillStyle = p.line;
  ctx.fillRect(580, 326, 608, 1);
  label(ctx, "RAW RECORD", 580, 361, 9, p.muted, 850);
  wrapped(ctx, observation.text, 580, 399, 600, 30, 6, 17, p.ink, 520);
  if (observation.bookmarked) label(ctx, "◆ BOOKMARKED", 580, 590, 10, p.warning, 800);
}

function drawScoreBar(ctx: CanvasRenderingContext2D, p: Palette, labelText: string, value: number, max: number, x: number, y: number): void {
  label(ctx, labelText, x, y, 11, p.ink, 620);
  label(ctx, `${value} / ${max}`, x + 430, y, 10, p.muted, 650, "right");
  roundedPath(ctx, x, y + 12, 430, 8, 4);
  ctx.fillStyle = "#173038";
  ctx.fill();
  const fillWidth = 430 * Math.max(0, Math.min(1, max === 0 ? 0 : value / max));
  if (fillWidth > 0) {
    roundedPath(ctx, x, y + 12, fillWidth, 8, 4);
    ctx.fillStyle = p.accent;
    ctx.fill();
  }
}

function drawResult(ctx: CanvasRenderingContext2D, view: AppViewModel, p: Palette): void {
  drawTopbar(ctx, view, p);
  const result = view.result;
  label(ctx, result?.heading ?? "세션 기록 준비", 64, 119, 30, p.ink, 850);
  wrapped(ctx, result?.summary ?? "수집한 관찰과 세션 로그를 검토하고 결과물을 내보내세요.", 64, 153, 1120, 24, 2, 13, p.muted, 540);

  panel(ctx, p, 48, 209, 548, 397, p.panel, p.line, 15);
  label(ctx, "CONTENT MODEL", 76, 244, 10, p.muted, 850);
  if (result?.score !== undefined) {
    label(ctx, String(result.score), 76, 316, 58, p.accent, 900);
    label(ctx, "/ 100", 171, 315, 16, p.muted, 700);
  } else {
    label(ctx, "—", 76, 316, 58, p.accent, 900);
    label(ctx, "제출 전", 142, 311, 13, p.muted, 650);
  }
  result?.scoreLines?.slice(0, 5).forEach((line, index) => {
    drawScoreBar(ctx, p, line.label, line.value, line.max, 78, 365 + index * 45);
  });

  panel(ctx, p, 616, 209, 616, 397, "#0a1c22", p.line, 15);
  label(ctx, "EXPORT PACKAGE", 646, 244, 10, p.muted, 850);
  (result?.exports ?? []).slice(0, 4).forEach((entry, index) => {
    const y = 269 + index * 72;
    panel(ctx, p, 646, y, 556, 57, entry.ready ? p.panelRaised : p.panel, entry.ready ? p.accentSoft : p.line, 9);
    label(ctx, entry.ready ? "READY" : "WAIT", 667, y + 23, 9, entry.ready ? p.positive : p.muted, 850);
    clippedLabel(ctx, entry.label, 734, y + 23, 244, 13, p.ink, 720);
    clippedLabel(ctx, entry.filename, 734, y + 43, 360, 9, p.muted, 500);
    label(ctx, entry.ready ? "E" : "—", 1172, y + 35, 12, entry.ready ? p.accent : p.muted, 850, "center");
  });
  if (result?.replayStatus) {
    label(ctx, "REPLAY", 648, 574, 9, p.muted, 800);
    label(ctx, result.replayStatus, 710, 574, 10, p.ink, 600);
  }
  if (result?.transferStatus) {
    label(ctx, "TRANSFER", 930, 574, 9, p.muted, 800);
    label(ctx, result.transferStatus, 1003, 574, 10, p.ink, 600);
  }
  label(ctx, "E  결과물 내보내기", 48, 662, 12, p.accent, 800);
  label(ctx, "R  동일 시드 재현", 227, 662, 12, p.muted, 700);
  label(ctx, "N  전이 세션", 399, 662, 12, p.muted, 700);
}

function keyDisplay(value: string): string {
  const key = value.toUpperCase();
  if (key === "ARROWLEFT") return "←";
  if (key === "ARROWRIGHT") return "→";
  if (key === "ARROWUP") return "↑";
  if (key === "ARROWDOWN") return "↓";
  if (key.startsWith("KEY") && key.length === 4) return key.slice(3);
  if (key === " ") return "SPACE";
  return key.length > 7 ? key.slice(0, 7) : key;
}

function drawInputFeedback(ctx: CanvasRenderingContext2D, view: AppViewModel, p: Palette, now: number): void {
  const visible = (view.inputFeedback ?? []).filter((entry) => entry.active || now - entry.changedAt < 520).slice(-6);
  let x = 350;
  for (const input of visible) {
    const age = Math.max(0, now - input.changedAt);
    const alpha = input.active ? 1 : Math.max(0, 1 - age / 520);
    const key = keyDisplay(input.key);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `800 10px ${FONT}`;
    const width = Math.max(34, ctx.measureText(key).width + 18);
    roundedPath(ctx, x, 14, width, 28, 7);
    ctx.fillStyle = input.active ? p.accent : p.panelRaised;
    ctx.fill();
    ctx.strokeStyle = p.accent;
    ctx.stroke();
    label(ctx, key, x + width / 2, 33, 10, input.active ? p.bg : p.accent, 850, "center");
    ctx.restore();
    x += width + 7;
  }
}

function drawNotices(ctx: CanvasRenderingContext2D, view: AppViewModel, p: Palette, now: number): void {
  const colorFor = (tone: string | undefined): string => {
    if (tone === "positive") return p.positive;
    if (tone === "warning") return p.warning;
    if (tone === "negative") return p.negative;
    return p.accent;
  };
  const notices = (view.notices ?? []).filter((notice) => now - notice.createdAt < (notice.durationMs ?? 2600)).slice(-3);
  notices.forEach((notice, index) => {
    const duration = notice.durationMs ?? 2600;
    const age = now - notice.createdAt;
    const alpha = Math.min(1, (duration - age) / 350);
    const width = 430;
    const x = W / 2 - width / 2;
    const y = 74 + index * 46;
    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);
    panel(ctx, p, x, y, width, 36, "rgba(7,17,22,0.95)", colorFor(notice.tone), 9);
    label(ctx, notice.text, W / 2, y + 23, 11, p.ink, 680, "center");
    ctx.restore();
  });
}

function drawPause(ctx: CanvasRenderingContext2D, p: Palette): void {
  ctx.fillStyle = "rgba(3,8,11,0.76)";
  ctx.fillRect(0, 0, W, H);
  panel(ctx, p, 430, 286, 420, 146, "#0b1d23", p.warning, 16);
  label(ctx, "세션 일시 정지", 640, 338, 22, p.ink, 850, "center");
  label(ctx, "캔버스에 초점을 맞춘 뒤 ENTER", 640, 380, 13, p.warning, 700, "center");
}

/** Draws one complete 1280×720 raster frame from an engine-independent ViewModel. */
export function renderApp(ctx: CanvasRenderingContext2D, view: AppViewModel, now: number): void {
  ctx.save();
  ctx.setTransform(ctx.canvas.width / W, 0, 0, ctx.canvas.height / H, 0, 0);
  const p = palette(view);
  drawBackdrop(ctx, p, now);

  switch (view.phase) {
    case "title": drawTitle(ctx, view, p, now); break;
    case "briefing": drawBriefing(ctx, view, p); break;
    case "explore": drawExplore(ctx, view, p); break;
    case "ledger": drawLedger(ctx, view, p); break;
    case "result": drawResult(ctx, view, p); break;
  }

  drawNotices(ctx, view, p, now);
  drawInputFeedback(ctx, view, p, now);
  if (view.paused) drawPause(ctx, p);
  ctx.restore();
}
