import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { coordinatorRandomId } from "../../packages/atlas_protocol/src/index.mjs";
import {
  CoordinatorIdentityPool,
  FileWalStore,
  PlayerRunnerService,
} from "../../01_player_runner/src/index.mjs";
import {
  DesktopWindowAdapter,
  SafeInputBroker,
  TargetBindingBroker,
} from "../src/index.mjs";
import { CaptureBroker } from "../src/capture/index.mjs";
import { createLegacyBridgeInputProvider } from "../src/input/index.mjs";
import {
  createLegacyBridgeCaptureProvider,
  createProviderLifecycle,
} from "../src/provider-contract.mjs";
import {
  ROLLOVER_ENDURANCE_RUNNER_PROFILE,
  runnerOptionsForProfile,
} from "../integration/local-runner-bootstrap.mjs";

assert.deepEqual(runnerOptionsForProfile({}), {});
assert.deepEqual(runnerOptionsForProfile({
  ATLAS_RUNNER_PROFILE: ROLLOVER_ENDURANCE_RUNNER_PROFILE,
}), {
  budgets: {
    observe: 180,
    keyboard: 60,
    bookmark: 180,
    object: 50,
    handoff: 2,
  },
  capabilityTtlMs: 3_000_000,
});
assert.throws(
  () => runnerOptionsForProfile({ ATLAS_RUNNER_PROFILE: "UNTRUSTED_PROFILE" }),
  { code: "RUNNER_PROFILE_INVALID" },
);

const identity = Object.freeze({
  hwnd: "9001",
  pid: 501,
  processStartTimeUtc: "2026-09-05T00:00:00.000Z",
  executableSha256: "b".repeat(64),
  clientWidth: 1280,
  clientHeight: 720,
});
let visualState = 0;
const dispatches = [];
function syntheticPng(marker) {
  const bytes = Buffer.alloc(57);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(1280, 16);
  bytes.writeUInt32BE(720, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  bytes[28] = marker;
  bytes.write("IDAT", 37, "ascii");
  bytes.write("IEND", 49, "ascii");
  return bytes;
}
const bridge = {
  async listWindows() { return [{ title: "private", executablePath: "C:\\private.exe", identity }]; },
  async inspect() { return identity; },
  async capture({ region }) {
    return {
      rawBytes: syntheticPng(visualState),
      width: region.width,
      height: region.height,
      captureBackend: "synthetic/v1",
    };
  },
  async tapKey({ code }) {
    dispatches.push(code);
    visualState += 1;
    return { delivered: true, sinkReceipt: "win-sendinput" };
  },
  async safeClick() { throw new Error("No object detector is attached."); },
  async close() {},
};

const targetBroker = new TargetBindingBroker({ bridge, idFactory: coordinatorRandomId });
const { bindingRef } = await targetBroker.bind({ hwnd: identity.hwnd });
const { launchTicket } = await targetBroker.issueLaunchTicket({ bindingRef });
const captureProvider = createLegacyBridgeCaptureProvider({
  bridge,
  providerId: "synthetic/v1",
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
const publicRunId = coordinatorRandomId();
const identityPool = new CoordinatorIdentityPool({
  campaignId: coordinatorRandomId(),
  publicRunId,
  targetRunId: publicRunId,
  artifactIds: Array.from({ length: 256 }, () => coordinatorRandomId()),
  nonces: Array.from({ length: 256 }, () => coordinatorRandomId()),
});
const keys = generateKeyPairSync("ed25519");
const temporaryRoot = resolve(mkdtempSync(join(tmpdir(), "atlas-desktop-runner-")));

try {
  const service = new PlayerRunnerService({
    adapter,
    internalRunId: coordinatorRandomId(),
    identityPool,
    signingPrivateKey: keys.privateKey,
    runnerKeyId: "desktop-integration-key",
    clientBinding: "desktop-integration-client",
    wal: new FileWalStore(join(temporaryRoot, "input.wal")),
    allowedKeys: ["Enter"],
  });
  const attached = await service.callTool("attach_run", { launchTicket });
  const before = await service.callTool("observe", { observeCap: attached.observeCap });
  const receipt = await service.callTool("tap_key", {
    keyboardCap: attached.keyboardCap,
    requestId: "desktop-request-1",
    expectedFrameId: before.frameId,
    code: "Enter",
  });
  assert.equal(receipt.status, "DELIVERED");
  const after = await service.callTool("wait_frame", {
    observeCap: attached.observeCap,
    afterFrameId: before.frameId,
    maxFrames: 2,
  });
  assert.equal(after.changeClass, "PERSISTENT_CHANGE");
  await service.callTool("bookmark_observation", {
    bookmarkCap: attached.bookmarkCap,
    frameIds: [before.frameId, after.frameId],
    precedingActionIds: ["A000001"],
  });
  await service.callTool("request_end", { handoffCap: attached.handoffCap, reason: "COMPLETE" });
  await service.callTool("seal_handoff", { handoffCap: attached.handoffCap });
  const artifacts = service.getSealedArtifacts();
  assert.equal(artifacts.publicHandoff.payload.manifest.framePolicyVersion, "desktop-composited-window/v1");
  assert.equal(artifacts.publicHandoff.payload.manifest.inputPolicyVersion, "desktop-bounded-input/v1");
  assert.deepEqual(dispatches, ["Enter"]);
  const publicText = JSON.stringify(artifacts.publicHandoff).toLowerCase();
  for (const forbidden of ["hwnd", "pid", "executable", "region", "coordinate", "private.exe"]) {
    assert.equal(publicText.includes(forbidden), false, `public handoff leaked ${forbidden}`);
  }
  console.log(JSON.stringify({
    playerRunner: "desktop adapter lifecycle passed",
    publicFrames: artifacts.publicHandoff.payload.frames.length,
    publicActions: artifacts.publicHandoff.payload.actions.length,
    targetMetadataLeakage: 0,
    urlDependency: false,
  }, null, 2));
} finally {
  const safePrefix = resolve(tmpdir()).toLowerCase();
  if (!temporaryRoot.toLowerCase().startsWith(safePrefix)) throw new Error("Refusing unsafe temporary cleanup.");
  rmSync(temporaryRoot, { recursive: true, force: true });
}
