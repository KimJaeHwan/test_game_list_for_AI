import { Buffer } from "node:buffer";

const CANVAS_SELECTOR = ".game-canvas";
const WIDTH = 1280;
const HEIGHT = 720;
const KEY_DATA = Object.freeze({
  ArrowLeft: { key: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowUp: { key: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowRight: { key: "ArrowRight", windowsVirtualKeyCode: 39 },
  ArrowDown: { key: "ArrowDown", windowsVirtualKeyCode: 40 },
  Enter: { key: "Enter", windowsVirtualKeyCode: 13 },
  Tab: { key: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", windowsVirtualKeyCode: 27 },
  KeyB: { key: "b", windowsVirtualKeyCode: 66 },
  KeyC: { key: "c", windowsVirtualKeyCode: 67 },
  KeyE: { key: "e", windowsVirtualKeyCode: 69 },
  KeyF: { key: "f", windowsVirtualKeyCode: 70 },
  KeyN: { key: "n", windowsVirtualKeyCode: 78 },
  KeyR: { key: "r", windowsVirtualKeyCode: 82 },
});

function assertLoopbackUrl(value, protocols) {
  const url = new URL(value);
  if (!protocols.includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Only an approved loopback browser endpoint is allowed.");
  }
  return url;
}

function resultValue(response, context) {
  if (response?.exceptionDetails) throw new Error(`${context} failed inside the target page.`);
  if (!response?.result || !("value" in response.result)) throw new Error(`${context} returned no value.`);
  return response.result.value;
}

export class CdpSession {
  #socket;
  #nextId = 1;
  #pending = new Map();

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (!message.id) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(`CDP ${pending.method} failed: ${message.error.message}`));
      else pending.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) pending.reject(new Error("CDP session closed."));
      this.#pending.clear();
    });
  }

  static async connect(webSocketUrl) {
    assertLoopbackUrl(webSocketUrl, ["ws:", "wss:"]);
    const socket = new WebSocket(webSocketUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("Unable to open the CDP WebSocket.")), { once: true });
    });
    return new CdpSession(socket);
  }

  command(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP ${method} timed out.`));
      }, 5_000);
      this.#pending.set(id, {
        method,
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.#socket.close();
  }
}

export async function connectCdpPage({ debugBaseUrl, expectedTargetUrl }) {
  const endpoint = assertLoopbackUrl(debugBaseUrl, ["http:", "https:"]);
  const expected = assertLoopbackUrl(expectedTargetUrl, ["http:", "https:"]);
  const response = await fetch(new URL("/json/list", endpoint));
  if (!response.ok) throw new Error("CDP target discovery failed.");
  const targets = await response.json();
  const page = targets.find((target) => target.type === "page" && target.url === expected.href);
  if (!page?.webSocketDebuggerUrl) throw new Error("Approved Quest Atlas target is not open.");
  return CdpSession.connect(page.webSocketDebuggerUrl);
}

/**
 * Game-specific trusted adapter. Launch-ticket contents, URL, DOM selector and
 * computed coordinates never cross the PlayerRunnerService tool boundary.
 */
export class QuestAtlasBrowserAdapter {
  #ticketBroker;
  #transportFactory;
  #allowedOrigin;
  #sessions = new Map();

  constructor({ ticketBroker, transportFactory = connectCdpPage, allowedOrigin = "http://127.0.0.1:3001" }) {
    if (typeof ticketBroker?.redeem !== "function" || typeof transportFactory !== "function") {
      throw new TypeError("A one-time ticket broker and CDP transport factory are required.");
    }
    this.#ticketBroker = ticketBroker;
    this.#transportFactory = transportFactory;
    this.#allowedOrigin = new URL(allowedOrigin).origin;
  }

  async launch({ launchTicket, internalRunId, publicRunId }) {
    const record = await this.#ticketBroker.redeem(launchTicket, { internalRunId, publicRunId });
    if (!record || new URL(record.expectedTargetUrl).origin !== this.#allowedOrigin) {
      throw new Error("Launch ticket target is outside the approved Quest Atlas origin.");
    }
    const transport = await this.#transportFactory({
      debugBaseUrl: record.debugBaseUrl,
      expectedTargetUrl: record.expectedTargetUrl,
    });
    await transport.command("Runtime.enable");
    const dimensions = resultValue(await transport.command("Runtime.evaluate", {
      expression: `(() => { const c = document.querySelector(${JSON.stringify(CANVAS_SELECTOR)}); return c ? { width: c.width, height: c.height } : null; })()`,
      returnByValue: true,
    }), "canvas calibration");
    if (dimensions?.width !== WIDTH || dimensions?.height !== HEIGHT) {
      throw new Error("Quest Atlas canvas calibration failed.");
    }
    this.#sessions.set(record.sessionHandle, { transport, record });
    return Object.freeze({
      sessionHandle: record.sessionHandle,
      configHandle: record.configHandle,
      gameBuildHandle: record.gameBuildHandle,
      replayAdapterVersion: "quest-atlas-cdp/v1",
      capturePolicyDigest: record.capturePolicyDigest,
      overlayCompositorVersion: "none/v1",
      framePolicyVersion: "canvas-served/v1",
      inputPolicyVersion: "keyboard-restricted/v1",
      width: WIDTH,
      height: HEIGHT,
    });
  }

  async capture({ sessionHandle }) {
    const session = this.#requireSession(sessionHandle);
    const dataUrl = resultValue(await session.transport.command("Runtime.evaluate", {
      expression: `(() => { const c = document.querySelector(${JSON.stringify(CANVAS_SELECTOR)}); if (!c || c.width !== ${WIDTH} || c.height !== ${HEIGHT}) return null; return c.toDataURL("image/png"); })()`,
      returnByValue: true,
    }), "canvas capture");
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) {
      throw new Error("Quest Atlas returned no canonical Canvas PNG.");
    }
    return Object.freeze({
      rawBytes: Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64"),
      interactionTargets: [],
      framePolicyVersion: "canvas-served/v1",
      changeClass: "UNCERTAIN",
    });
  }

  async dispatch(action, { sessionHandle }) {
    const session = this.#requireSession(sessionHandle);
    try {
      if (action?.kind === "keyTap") await this.#tapKey(session.transport, action.code);
      else if (action?.kind === "safePointActivate") await this.#activateSafePoint(session.transport, action.safePoint);
      else throw new Error("Unsupported trusted dispatch kind.");
      return Object.freeze({ status: "DELIVERED", sinkReceipt: "cdp-ack" });
    } catch (error) {
      return Object.freeze({ status: "DELIVERY_UNKNOWN", sinkReceipt: error?.name ?? "cdp-error" });
    }
  }

  async end({ sessionHandle }) {
    this.#requireSession(sessionHandle);
  }

  #requireSession(sessionHandle) {
    const session = this.#sessions.get(sessionHandle);
    if (!session) throw new Error("Unknown trusted browser session.");
    return session;
  }

  async #focusCanvas(transport) {
    const focused = resultValue(await transport.command("Runtime.evaluate", {
      expression: `(() => { const c = document.querySelector(${JSON.stringify(CANVAS_SELECTOR)}); if (!c) return false; c.focus({ preventScroll: true }); return document.activeElement === c; })()`,
      returnByValue: true,
    }), "canvas focus");
    if (focused !== true) throw new Error("Canvas focus could not be established.");
  }

  async #tapKey(transport, code) {
    const keyData = KEY_DATA[code];
    if (!keyData) throw new Error("Key is not in the Quest Atlas adapter profile.");
    await this.#focusCanvas(transport);
    const common = { code, key: keyData.key, windowsVirtualKeyCode: keyData.windowsVirtualKeyCode, nativeVirtualKeyCode: keyData.windowsVirtualKeyCode };
    await transport.command("Input.dispatchKeyEvent", { type: "keyDown", ...common });
    await transport.command("Input.dispatchKeyEvent", { type: "keyUp", ...common });
  }

  async #activateSafePoint(transport, safePoint) {
    if (!safePoint || !Number.isFinite(safePoint.x) || !Number.isFinite(safePoint.y)
      || safePoint.x < 0 || safePoint.x >= WIDTH || safePoint.y < 0 || safePoint.y >= HEIGHT) {
      throw new Error("Trusted safe point is outside the Canvas.");
    }
    const rect = resultValue(await transport.command("Runtime.evaluate", {
      expression: `(() => { const c = document.querySelector(${JSON.stringify(CANVAS_SELECTOR)}); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
      returnByValue: true,
    }), "canvas geometry");
    if (!rect || rect.width <= 0 || rect.height <= 0) throw new Error("Canvas geometry is unavailable.");
    const x = rect.x + (safePoint.x / WIDTH) * rect.width;
    const y = rect.y + (safePoint.y / HEIGHT) * rect.height;
    await transport.command("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await transport.command("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }
}
