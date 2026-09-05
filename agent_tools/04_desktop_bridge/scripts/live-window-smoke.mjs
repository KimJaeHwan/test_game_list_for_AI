import assert from "node:assert/strict";
import { coordinatorRandomId, sha256 } from "../../packages/atlas_protocol/src/index.mjs";
import {
  CaptureBroker,
  DESKTOP_ALLOWED_KEYS,
  DesktopWindowAdapter,
  NativeDesktopBridgeClient,
  SafeInputBroker,
  TargetBindingBroker,
  createLegacyBridgeCaptureProvider,
  createLegacyBridgeInputProvider,
  createProviderLifecycle,
} from "../src/index.mjs";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parseRegion(value) {
  if (!value) return undefined;
  const parts = value.split(",").map((entry) => Number(entry.trim()));
  if (parts.length !== 4 || parts.some((entry) => !Number.isSafeInteger(entry))) {
    throw new Error("ATLAS_CAPTURE_REGION must be x,y,width,height using integers.");
  }
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
}

const hwnd = requiredEnvironment("ATLAS_TARGET_HWND");
const region = parseRegion(process.env.ATLAS_CAPTURE_REGION);
const keyCode = process.env.ATLAS_SMOKE_KEY ?? "Enter";
if (!DESKTOP_ALLOWED_KEYS.includes(keyCode)) throw new Error("ATLAS_SMOKE_KEY is not allowlisted.");
const armDelayMs = Number(process.env.ATLAS_ARM_DELAY_MS ?? "5000");
if (!Number.isSafeInteger(armDelayMs) || armDelayMs < 1000 || armDelayMs > 30_000) {
  throw new Error("ATLAS_ARM_DELAY_MS must be an integer from 1000 to 30000.");
}

const bridge = new NativeDesktopBridgeClient().start();
try {
  const targetBroker = new TargetBindingBroker({ bridge, idFactory: coordinatorRandomId });
  const { bindingRef } = await targetBroker.bind(region ? { hwnd, region } : { hwnd });
  const { launchTicket } = await targetBroker.issueLaunchTicket({ bindingRef });
  const captureProvider = createLegacyBridgeCaptureProvider({
    bridge,
    providerId: "gdi-composited-screen/v1",
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
  });
  const launch = await adapter.launch({
    launchTicket,
    internalRunId: coordinatorRandomId(),
    publicRunId: coordinatorRandomId(),
  });

  process.stderr.write(`Focus the selected target window now. Test starts in ${armDelayMs / 1000} seconds.\n`);
  await new Promise((resolve) => setTimeout(resolve, armDelayMs));

  const before = await adapter.capture({ sessionHandle: launch.sessionHandle, purpose: "observe" });
  const delivery = await adapter.dispatch(
    { kind: "keyTap", code: keyCode },
    { sessionHandle: launch.sessionHandle },
  );
  assert.equal(delivery.status, "DELIVERED", "The selected window did not accept the bounded key tap.");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const after = await adapter.capture({
    sessionHandle: launch.sessionHandle,
    purpose: "wait",
    afterFrameId: "F000001",
  });
  const frameChanged = sha256(before.rawBytes) !== sha256(after.rawBytes);
  assert.equal(frameChanged, true, "The visible target pixels did not change after the key tap.");
  await adapter.end({ sessionHandle: launch.sessionHandle, reason: "COMPLETE" });

  console.log(JSON.stringify({
    liveWindow: "passed",
    frame: `${launch.width}x${launch.height} PNG from composited GUI pixels`,
    keyTap: `${keyCode} delivered through bounded SendInput`,
    visibleFrameChanged: frameChanged,
    browserProtocolUsed: false,
    targetMetadataExposedToCaller: false,
    absoluteCoordinatesExposedToCaller: false,
  }, null, 2));
} finally {
  // Idempotent if adapter.end() already closed the shared provider lifecycle.
  await bridge.close();
}
