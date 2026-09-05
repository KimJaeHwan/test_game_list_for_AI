import assert from "node:assert/strict";
import { QuestAtlasBrowserAdapter } from "./browser-adapter.mjs";

const pngBytes = Buffer.from("synthetic-canvas-png", "utf8");
const calls = [];
const transport = {
  async command(method, params = {}) {
    calls.push({ method, params });
    if (method !== "Runtime.evaluate") return {};
    const expression = params.expression;
    if (expression.includes("toDataURL")) {
      return { result: { value: `data:image/png;base64,${pngBytes.toString("base64")}` } };
    }
    if (expression.includes("getBoundingClientRect")) {
      return { result: { value: { x: 10, y: 20, width: 640, height: 360 } } };
    }
    if (expression.includes("document.activeElement")) return { result: { value: true } };
    return { result: { value: { width: 1280, height: 720 } } };
  },
};
let redemptions = 0;
const broker = {
  async redeem(ticket) {
    assert.equal(ticket, "opaque-launch-ticket");
    redemptions += 1;
    return {
      debugBaseUrl: "http://127.0.0.1:9222",
      expectedTargetUrl: "http://127.0.0.1:3001/?scenario=private",
      sessionHandle: "session-handle",
      configHandle: "config-handle",
      gameBuildHandle: "build-handle",
      capturePolicyDigest: "a".repeat(64),
    };
  },
};
const adapter = new QuestAtlasBrowserAdapter({
  ticketBroker: broker,
  transportFactory: async ({ debugBaseUrl, expectedTargetUrl }) => {
    assert.equal(debugBaseUrl, "http://127.0.0.1:9222");
    assert.match(expectedTargetUrl, /^http:\/\/127\.0\.0\.1:3001\//u);
    return transport;
  },
});
const launch = await adapter.launch({
  launchTicket: "opaque-launch-ticket",
  internalRunId: "internal-run",
  publicRunId: "public-run",
});
assert.equal(redemptions, 1);
assert.deepEqual(Object.keys(launch).sort(), [
  "capturePolicyDigest", "configHandle", "framePolicyVersion", "gameBuildHandle",
  "height", "inputPolicyVersion", "overlayCompositorVersion", "replayAdapterVersion",
  "sessionHandle", "width",
].sort());
assert.equal(JSON.stringify(launch).includes("scenario"), false);

const captured = await adapter.capture({ sessionHandle: launch.sessionHandle });
assert.deepEqual(captured.rawBytes, pngBytes);
assert.deepEqual(captured.interactionTargets, []);
assert.equal((await adapter.dispatch(
  { kind: "keyTap", code: "Enter" },
  { sessionHandle: launch.sessionHandle },
)).status, "DELIVERED");
assert.equal((await adapter.dispatch(
  { kind: "safePointActivate", safePoint: { x: 640, y: 360 }, dispatchHandle: "private" },
  { sessionHandle: launch.sessionHandle },
)).status, "DELIVERED");

const keyEvents = calls.filter((entry) => entry.method === "Input.dispatchKeyEvent");
assert.deepEqual(keyEvents.map((entry) => entry.params.type), ["keyDown", "keyUp"]);
const pointerEvents = calls.filter((entry) => entry.method === "Input.dispatchMouseEvent");
assert.deepEqual(pointerEvents.map((entry) => entry.params.type), ["mousePressed", "mouseReleased"]);
assert.equal(pointerEvents[0].params.x, 330);
assert.equal(pointerEvents[0].params.y, 200);

const rejected = new QuestAtlasBrowserAdapter({
  ticketBroker: { redeem: async () => ({ expectedTargetUrl: "https://example.com", sessionHandle: "bad" }) },
  transportFactory: async () => { throw new Error("must not connect"); },
});
await assert.rejects(
  rejected.launch({ launchTicket: "opaque", internalRunId: "internal", publicRunId: "public" }),
  /outside the approved/u,
);

console.log(JSON.stringify({
  adapter: "Quest Atlas loopback CDP",
  canvasCapture: "fixed 1280x720 PNG",
  keyboard: "allowlisted keyDown/keyUp",
  coordinateOwner: "trusted adapter only",
  publicCoordinateArguments: 0,
}, null, 2));
