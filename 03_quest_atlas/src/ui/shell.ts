export const CANVAS_WIDTH = 1280;
export const CANVAS_HEIGHT = 720;

export interface AppShell {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  status: HTMLElement;
  focus(): void;
  setStatus(message: string): void;
}

/**
 * Builds the stable DOM frame. All game/content information is rendered into the
 * canvas so an evaluator can give an agent pixels without exposing semantic DOM.
 */
export function createShell(host?: HTMLElement): AppShell {
  const root = host ?? document.querySelector<HTMLElement>("#app");
  if (!root) {
    throw new Error("QUEST ATLAS requires an #app host element.");
  }

  root.replaceChildren();
  root.className = "quest-atlas-root";

  const shell = document.createElement("main");
  shell.className = "quest-atlas-shell";

  const masthead = document.createElement("header");
  masthead.className = "app-masthead";
  masthead.innerHTML = `
    <div class="brand-mark" aria-hidden="true">QA</div>
    <div>
      <p class="eyebrow">CONTENT UNDERSTANDING BENCHMARK</p>
      <h1>QUEST ATLAS <span>안개항 조사록</span></h1>
    </div>
    <div class="local-badge">LOCAL · PIXEL INPUT</div>
  `;

  const frame = document.createElement("section");
  frame.className = "canvas-frame";

  const canvas = document.createElement("canvas");
  canvas.className = "game-canvas";
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", "QUEST ATLAS 게임 화면. 게임 입력을 시작하려면 초점을 맞추세요.");
  canvas.setAttribute("role", "application");

  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    throw new Error("Canvas 2D context is unavailable.");
  }

  const focusRing = document.createElement("span");
  focusRing.className = "focus-ring-label";
  focusRing.textContent = "GAME INPUT";
  focusRing.setAttribute("aria-hidden", "true");

  frame.append(canvas, focusRing);

  const footer = document.createElement("footer");
  footer.className = "app-footer";

  const status = document.createElement("p");
  status.className = "shell-status";
  status.setAttribute("aria-live", "polite");
  status.textContent = "캔버스를 선택하면 키보드 입력이 활성화됩니다.";

  const privacy = document.createElement("p");
  privacy.className = "capture-note";
  privacy.textContent = "공식 관찰 범위 · 1280 × 720 CANVAS ONLY";

  footer.append(status, privacy);
  shell.append(masthead, frame, footer);
  root.append(shell);

  const focus = (): void => canvas.focus({ preventScroll: true });
  canvas.addEventListener("pointerdown", focus);
  canvas.addEventListener("focus", () => shell.classList.add("has-game-focus"));
  canvas.addEventListener("blur", () => shell.classList.remove("has-game-focus"));

  return {
    root,
    canvas,
    context,
    status,
    focus,
    setStatus(message: string): void {
      status.textContent = message;
    },
  };
}
