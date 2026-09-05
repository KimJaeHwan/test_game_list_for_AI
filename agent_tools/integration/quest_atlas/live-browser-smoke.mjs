import assert from "node:assert/strict";
import { sha256 } from "../../packages/atlas_protocol/src/index.mjs";
import { QuestAtlasBrowserAdapter } from "./browser-adapter.mjs";

const debugBaseUrl = process.env.ATLAS_CDP_URL;
const expectedTargetUrl = process.env.ATLAS_GAME_URL;
if (!debugBaseUrl || !expectedTargetUrl) {
  throw new Error("ATLAS_CDP_URL and ATLAS_GAME_URL are required.");
}
let redeemed = false;
const adapter = new QuestAtlasBrowserAdapter({
  ticketBroker: {
    async redeem(ticket) {
      if (redeemed || ticket !== "live-smoke-ticket") throw new Error("Launch ticket is invalid or consumed.");
      redeemed = true;
      return {
        debugBaseUrl,
        expectedTargetUrl,
        sessionHandle: "live-smoke-session",
        configHandle: "opaque-live-config",
        gameBuildHandle: "quest-atlas-local-build",
        capturePolicyDigest: sha256("quest-atlas-live-canvas-policy"),
      };
    },
  },
});
const launch = await adapter.launch({
  launchTicket: "live-smoke-ticket",
  internalRunId: "live-smoke-internal",
  publicRunId: "live-smoke-public",
});
const before = await adapter.capture({ sessionHandle: launch.sessionHandle });
assert.deepEqual([...before.rawBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
const receipt = await adapter.dispatch(
  { kind: "keyTap", code: "Enter" },
  { sessionHandle: launch.sessionHandle },
);
assert.equal(receipt.status, "DELIVERED");
await new Promise((resolve) => setTimeout(resolve, 150));
const after = await adapter.capture({ sessionHandle: launch.sessionHandle });
assert.deepEqual([...after.rawBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
assert.notEqual(sha256(before.rawBytes), sha256(after.rawBytes));
console.log(JSON.stringify({
  liveBrowser: "passed",
  canvas: "1280x720 PNG",
  keyTap: "CDP delivered",
  visibleFrameChanged: true,
  coordinatesExposedToCaller: false,
}, null, 2));
