import assert from "node:assert/strict";
import {
  CaptureBroker,
  DesktopWindowAdapter,
  SafeInputBroker,
  TargetBindingBroker,
  createLegacyBridgeCaptureProvider,
  createLegacyBridgeInputProvider,
  createProviderLifecycle,
} from "../src/index.mjs";

const identity = Object.freeze({
  hwnd: "4242",
  pid: 700,
  processStartTimeUtc: "2026-09-05T01:02:03.000Z",
  executableSha256: "a".repeat(64),
  clientWidth: 800,
  clientHeight: 600,
});

let currentIdentity = identity;
let visualState = 0;
const calls = [];
function syntheticPng(marker) {
  const bytes = Buffer.alloc(57);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(640, 16);
  bytes.writeUInt32BE(480, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  bytes[28] = marker;
  bytes.write("IDAT", 37, "ascii");
  bytes.write("IEND", 49, "ascii");
  return bytes;
}
const bridge = {
  async listWindows() {
    return [{ title: "Local visual target", executablePath: "C:\\private\\target.exe", identity: currentIdentity }];
  },
  async inspect(hwnd) {
    assert.equal(hwnd, "4242");
    return currentIdentity;
  },
  async capture({ binding, region }) {
    calls.push({ op: "capture", binding, region });
    return {
      rawBytes: syntheticPng(visualState),
      width: region.width,
      height: region.height,
      captureBackend: "test-composited/v1",
    };
  },
  async tapKey({ binding, code }) {
    calls.push({ op: "tapKey", binding, code });
    visualState += 1;
    return { delivered: true, sinkReceipt: "win-sendinput" };
  },
  async safeClick(value) {
    calls.push({ op: "safeClick", ...value });
    return { delivered: true, sinkReceipt: "win-sendinput" };
  },
  async close() {},
};

const ids = ["binding-ref", "internal-ticket", "session-ref", "config-ref", "build-ref"];
const targetBroker = new TargetBindingBroker({ bridge, idFactory: () => ids.shift() });
const { bindingRef } = await targetBroker.bind({
  hwnd: "4242",
  region: { x: 100, y: 80, width: 640, height: 480 },
});
const { launchTicket } = await targetBroker.issueLaunchTicket({ bindingRef });
const captureProvider = createLegacyBridgeCaptureProvider({
  bridge,
  providerId: "test-composited/v1",
});
const inputProvider = createLegacyBridgeInputProvider(bridge);
const captureBroker = new CaptureBroker({ targetBroker, captureProvider });
const inputBroker = new SafeInputBroker({ inputProvider, targetBroker });
const providerLifecycle = createProviderLifecycle([bridge]);
const adapter = new DesktopWindowAdapter({
  targetBroker,
  captureBroker,
  inputBroker,
  providerLifecycle,
  idFactory: () => ids.shift(),
});

const launch = await adapter.launch({ launchTicket, internalRunId: "private-run", publicRunId: "public-run" });
assert.equal(launch.width, 640);
assert.equal(launch.height, 480);
assert.equal(launch.framePolicyVersion, "desktop-composited-window/v1");
assert.equal(launch.inputPolicyVersion, "desktop-bounded-input/v1");
for (const forbidden of ["hwnd", "pid", "title", "path", "region", "url", "coordinate", "sha256"]) {
  assert.equal(JSON.stringify(launch).toLowerCase().includes(forbidden), false, `launch leaked ${forbidden}`);
}

const before = await adapter.capture({ sessionHandle: launch.sessionHandle, purpose: "observe" });
assert.equal(before.changeClass, "UNCERTAIN");
const delivered = await adapter.dispatch(
  { kind: "keyTap", code: "Enter" },
  { sessionHandle: launch.sessionHandle },
);
assert.deepEqual(delivered, { status: "DELIVERED", sinkReceipt: "win-sendinput" });
const after = await adapter.capture({
  sessionHandle: launch.sessionHandle,
  purpose: "wait",
  afterFrameId: "F000001",
});
assert.equal(after.changeClass, "PERSISTENT_CHANGE");

const inputCalls = calls.filter((entry) => entry.op === "tapKey");
assert.equal(inputCalls.length, 1);
assert.equal(Object.hasOwn(inputCalls[0], "targetRef"), false);

currentIdentity = Object.freeze({ ...identity, clientWidth: 799 });
const callsBeforeStaleCapture = calls.length;
await assert.rejects(
  adapter.capture({ sessionHandle: launch.sessionHandle, purpose: "observe" }),
  /changed|invalid|malformed|unavailable|inspect|revalidated/iu,
);
assert.equal(calls.length, callsBeforeStaleCapture);

console.log(JSON.stringify({
  adapter: "generic Windows desktop window",
  selection: "operator-bound opaque target",
  visualSource: "composited pixels only",
  input: "bounded allowlist",
  browserProtocolUsed: false,
  publicTargetMetadataFields: 0,
}, null, 2));
