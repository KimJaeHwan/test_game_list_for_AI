import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  coordinatorRandomId,
  sha256,
  validatePublicPlayHandoff,
  validateSignedEnvelopeShape,
  verifySignedEnvelope,
} from "../../packages/atlas_protocol/src/index.mjs";
import {
  CapabilityIssuer,
  CoordinatorIdentityPool,
  FileWalStore,
  FrameProvenance,
  HandoffSealer,
  InputGateway,
  OpaqueOptionResolver,
  RunStateMachine,
  RunnerError,
  SignedReceiptChain,
} from "../src/index.mjs";
import { SyntheticCanvas, SyntheticInputSink } from "../fixtures/synthetic.mjs";

const temporaryRoot = mkdtempSync(join(tmpdir(), "atlas-runner-verify-"));
let harnessOrdinal = 0;

function expectRunnerError(error, code) {
  return error instanceof RunnerError && error.code === code;
}

function createCoordinatorIdentityPool(size = 128) {
  return new CoordinatorIdentityPool({
    campaignId: coordinatorRandomId(),
    publicRunId: coordinatorRandomId(),
    targetRunId: coordinatorRandomId(),
    artifactIds: Array.from({ length: size }, () => coordinatorRandomId()),
    nonces: Array.from({ length: size }, () => coordinatorRandomId()),
  });
}

function assertSigned(envelope, publicKey) {
  const validation = validateSignedEnvelopeShape(envelope);
  assert.equal(validation.valid, true, validation.errors?.join("; "));
  assert.equal(envelope.header.track, "EXPLORATION");
  assert.equal(envelope.header.arm, "NONE");
  assert.equal(verifySignedEnvelope(envelope, publicKey), true);
}

function createHarness({ sinkBehaviors = [], clock = () => Date.now(), objectOptions } = {}) {
  harnessOrdinal += 1;
  const runId = coordinatorRandomId();
  const identityPool = createCoordinatorIdentityPool();
  const clientBinding = `synthetic-client-${harnessOrdinal}`;
  const gameBuildHandle = `private-build-handle-${harnessOrdinal}`;
  const capturePolicyDigest = sha256("synthetic-capture-policy/v1");
  const overlayCompositorVersion = "synthetic-overlay-compositor/v1";
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const receiptChain = new SignedReceiptChain({
    privateKey,
    keyId: `fixture-key-${harnessOrdinal}`,
    identityPool,
  });
  const stateMachine = new RunStateMachine({ runId, initialState: "READY", clock });
  const capabilityIssuer = new CapabilityIssuer({ clock });
  const frames = new FrameProvenance({
    campaignId: identityPool.campaignId,
    internalRunId: runId,
    publicRunId: identityPool.publicRunId,
    gameBuildHandle,
    capturePolicyDigest,
    overlayCompositorVersion,
    clientBindingDigest: sha256(clientBinding),
    receiptChain,
  });
  const optionResolver = new OpaqueOptionResolver({ clock, defaultTtlMs: 50 });
  const canvas = new SyntheticCanvas(`run-${harnessOrdinal}`);
  const captureId = frames.capture(canvas.frame("before"));
  const frameId = frames.allocateFrameId();
  const optionSet = objectOptions
    ? optionResolver.bindFrame({ frameId, safePoints: objectOptions, ttlMs: 50 })
    : { optionSetDigest: sha256({ options: [] }), overlays: [] };
  const overlayPrimitivesDigest = sha256({ compositor: overlayCompositorVersion, overlays: optionSet.overlays });
  frames.serve({
    captureId,
    frameId,
    servedBytes: canvas.frame(objectOptions ? "before-overlay" : "before"),
    framePolicyVersion: objectOptions ? "opaque-overlay/v1" : "canvas-served/v1",
    responseRequestDigest: sha256(`observe-${harnessOrdinal}`),
    optionSetDigest: optionSet.optionSetDigest,
    overlayPrimitivesDigest,
  });
  const walPath = join(temporaryRoot, `run-${harnessOrdinal}`, "input.wal");
  const wal = new FileWalStore(walPath);
  const sink = new SyntheticInputSink(sinkBehaviors);
  const gateway = new InputGateway({
    campaignId: identityPool.campaignId,
    runId,
    publicRunId: identityPool.publicRunId,
    clientBinding,
    capabilityIssuer,
    wal,
    sink,
    frames,
    optionResolver,
    receiptChain,
    stateMachine,
  });
  const expiresAt = clock() + 10_000;
  const keyboardCap = capabilityIssuer.issue({ runId, clientBinding, scopes: ["keyboard"], expiresAt, budget: 20 });
  const objectCap = capabilityIssuer.issue({ runId, clientBinding, scopes: ["object"], expiresAt, budget: 20 });
  return {
    runId,
    identityPool,
    clientBinding,
    gameBuildHandle,
    capturePolicyDigest,
    overlayCompositorVersion,
    overlayPrimitivesDigest,
    privateKey,
    publicKey,
    receiptChain,
    stateMachine,
    capabilityIssuer,
    frames,
    optionResolver,
    optionSet,
    canvas,
    wal,
    walPath,
    sink,
    gateway,
    frameId,
    keyboardCap,
    objectCap,
  };
}

function serveOutcome(harness, state = "after") {
  const captureId = harness.frames.capture(harness.canvas.frame(state));
  const frameId = harness.frames.allocateFrameId();
  harness.frames.serve({
    captureId,
    frameId,
    servedBytes: harness.canvas.frame(state),
    framePolicyVersion: "canvas-served/v1",
    responseRequestDigest: sha256(`observe-${frameId}`),
    overlayPrimitivesDigest: sha256({ primitives: [] }),
  });
  return frameId;
}

function assertAllPrivateReceipts(harness) {
  for (const envelope of harness.receiptChain.snapshot()) {
    assertSigned(envelope, harness.publicKey);
    assert.equal(envelope.header.campaignId, harness.identityPool.campaignId);
    assert.equal(envelope.header.targetRunId, harness.identityPool.targetRunId);
  }
}

async function verifyDuplicateAndPayloadMismatch() {
  const harness = createHarness();
  const request = {
    runId: harness.runId,
    requestId: "request-duplicate",
    expectedFrameId: harness.frameId,
    capability: harness.keyboardCap,
    action: { kind: "keyTap", code: "Enter" },
  };
  const first = await harness.gateway.submit(request);
  const duplicate = await harness.gateway.submit(structuredClone(request));
  assert.deepEqual(duplicate, first);
  assert.equal(harness.sink.calls.length, 1, "duplicate request must not dispatch twice");
  await assert.rejects(
    harness.gateway.submit({ ...request, action: { kind: "keyTap", code: "Tab" } }),
    (error) => expectRunnerError(error, "REQUEST_PAYLOAD_MISMATCH"),
  );
  assert.equal(harness.sink.calls.length, 1, "payload mismatch must not reach sink");
  const outcomeFrame = serveOutcome(harness);
  harness.gateway.settleDelivered({ requestId: request.requestId, afterFrameIds: [outcomeFrame], changeClass: "PERSISTENT_CHANGE" });

  const input = harness.receiptChain.snapshot().find((entry) => entry.header.artifactType === "SignedInputReceipt");
  assert.equal(input.payload.campaignId, harness.identityPool.campaignId);
  assert.equal(input.payload.internalRunId, harness.runId);
  assert.equal(input.payload.publicRunId, harness.identityPool.publicRunId);
  assert.equal(input.payload.canonicalRequestDigest, first.canonicalRequestDigest);
  assert.equal(input.payload.beforeFrameReceiptDigest, harness.frames.getFrameReceiptDigest(harness.frameId));
  assert.match(input.payload.previousInputReceiptDigest, /^[a-f0-9]{64}$/u);
  const outcome = harness.receiptChain.snapshot().find((entry) => entry.header.artifactType === "SignedInputOutcomeSettledEvent");
  assert.deepEqual(outcome.payload.afterFrameReceiptDigests, [harness.frames.getFrameReceiptDigest(outcomeFrame)]);
  assertAllPrivateReceipts(harness);
}

async function verifyNotDeliveredNeedsNewRequest() {
  const harness = createHarness({ sinkBehaviors: ["NOT_DELIVERED"] });
  const request = {
    runId: harness.runId,
    requestId: "request-not-delivered",
    expectedFrameId: harness.frameId,
    capability: harness.keyboardCap,
    action: { kind: "keyTap", code: "Enter" },
  };
  const receipt = await harness.gateway.submit(request);
  assert.equal(receipt.status, "NOT_DELIVERED");
  assert.equal(receipt.retry, "NEW_REQUEST_REQUIRED");
  assert.deepEqual(await harness.gateway.submit(request), receipt);
  assert.equal(harness.sink.calls.length, 1);
  const outcome = harness.receiptChain.snapshot().find((entry) => entry.header.artifactType === "SignedInputOutcomeSettledEvent");
  assert.deepEqual(outcome.payload.afterFrameReceiptDigests, []);
}

async function verifyCrashAfterDispatch() {
  const harness = createHarness({ sinkBehaviors: ["CRASH_AFTER_DISPATCH"] });
  const request = {
    runId: harness.runId,
    requestId: "request-crash-window",
    expectedFrameId: harness.frameId,
    capability: harness.keyboardCap,
    action: { kind: "keyTap", code: "Enter" },
  };
  await assert.rejects(harness.gateway.submit(request), (error) => error?.simulatedProcessCrash === true);
  assert.equal(harness.sink.calls.length, 1, "sink received the pre-crash input once");

  const recoveredWal = new FileWalStore(harness.walPath);
  const recoveredMachine = new RunStateMachine({ runId: harness.runId, initialState: "READY" });
  const recoveredGateway = new InputGateway({
    campaignId: harness.identityPool.campaignId,
    runId: harness.runId,
    publicRunId: harness.identityPool.publicRunId,
    clientBinding: harness.clientBinding,
    capabilityIssuer: harness.capabilityIssuer,
    wal: recoveredWal,
    sink: harness.sink,
    frames: harness.frames,
    optionResolver: harness.optionResolver,
    receiptChain: harness.receiptChain,
    stateMachine: recoveredMachine,
  });
  const recovered = recoveredGateway.recoverInDoubt();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].status, "DELIVERY_UNKNOWN");
  assert.equal(recovered[0].retry, "DO_NOT_RETRY");
  assert.deepEqual(await recoveredGateway.submit(request), recovered[0]);
  assert.equal(harness.sink.calls.length, 1, "in-doubt input must never be dispatched again");
  assert.equal(recoveredMachine.state, "BLOCKED");
}

async function verifyExpiredOption() {
  let now = 1_000;
  const harness = createHarness({
    clock: () => now,
    objectOptions: [{ safePoint: { x: 320, y: 180 }, dispatchHandle: "private-dispatch-only" }],
  });
  now += 100;
  const optionRef = harness.optionSet.overlays[0].optionRef;
  await assert.rejects(
    harness.gateway.submit({
      runId: harness.runId,
      requestId: "request-expired-option",
      expectedFrameId: harness.frameId,
      capability: harness.objectCap,
      action: { kind: "activate", optionRef },
    }),
    (error) => expectRunnerError(error, "OPTION_EXPIRED"),
  );
  assert.equal(harness.sink.calls.length, 0);
}

async function verifyObjectActionAndSealing() {
  let now = 5_000;
  const harness = createHarness({
    clock: () => now,
    objectOptions: [{ safePoint: { x: 111, y: 222 }, dispatchHandle: "private-target-handle" }],
  });
  const optionRef = harness.optionSet.overlays[0].optionRef;
  const receipt = await harness.gateway.submit({
    runId: harness.runId,
    requestId: "request-object",
    expectedFrameId: harness.frameId,
    capability: harness.objectCap,
    action: { kind: "activate", optionRef },
  });
  assert.equal(receipt.status, "DELIVERED");
  assert.deepEqual(harness.sink.calls[0].action.safePoint, { x: 111, y: 222 });

  const firstProof = harness.frames.getFrameProof(harness.frameId);
  assert.notDeepEqual(firstProof.privateFrameReceipt, firstProof.signedServedEvent);
  assert.equal(firstProof.privateFrameReceipt.payload.capturePolicyDigest, harness.capturePolicyDigest);
  assert.equal(firstProof.privateFrameReceipt.payload.overlayCompositorVersion, harness.overlayCompositorVersion);
  assert.equal(firstProof.privateFrameReceipt.payload.overlayPrimitivesDigest, harness.overlayPrimitivesDigest);
  assert.equal(firstProof.signedServedEvent.payload.privateFrameReceiptDigest, firstProof.privateFrameReceiptDigest);
  assert.equal(firstProof.signedServedEvent.payload.optionSetDigest, harness.optionSet.optionSetDigest);
  const inputEvent = harness.receiptChain.snapshot().find((entry) => entry.payload.eventType === "INPUT_TERMINAL");
  assert.equal(inputEvent.payload.optionSetDigest, harness.optionSet.optionSetDigest);
  assert.equal(typeof inputEvent.payload.selectedOptionDigest, "string");

  const outcomeFrame = serveOutcome(harness, "object-after");
  harness.gateway.settleDelivered({ requestId: "request-object", afterFrameIds: [outcomeFrame], changeClass: "PERSISTENT_CHANGE" });
  const secondProof = harness.frames.getFrameProof(outcomeFrame);
  assert.equal(secondProof.privateFrameReceipt.payload.previousFrameReceiptDigest, firstProof.privateFrameReceiptDigest);
  assert.equal(
    secondProof.signedServedEvent.payload.previousFrameServedEventDigest,
    firstProof.signedServedEventDigest,
  );
  await assert.rejects(
    harness.gateway.submit({
      runId: harness.runId,
      requestId: "request-reuse-option",
      expectedFrameId: outcomeFrame,
      capability: harness.objectCap,
      action: { kind: "activate", optionRef },
    }),
    (error) => expectRunnerError(error, "OPTION_EXPIRED"),
  );
  assert.equal(harness.sink.calls.length, 1, "one-shot option must never dispatch twice");

  const privateValues = {
    configHandle: "private-config-handle-do-not-publish",
    gameBuildHandle: harness.gameBuildHandle,
  };
  assert.throws(
    () => new HandoffSealer({}),
    (error) => expectRunnerError(error, "COORDINATOR_IDENTITY_REQUIRED"),
  );
  const sealer = new HandoffSealer({
    internalRunId: harness.runId,
    ...privateValues,
    replayAdapterVersion: "synthetic-replay/v1",
    runnerKeyId: `fixture-key-${harnessOrdinal}`,
    signingPrivateKey: harness.privateKey,
    identityPool: harness.identityPool,
    receiptChain: harness.receiptChain,
    frames: harness.frames,
    inputGateway: harness.gateway,
  });
  const unservedCapture = harness.frames.capture(harness.canvas.frame("never-served"));
  assert.throws(
    () => sealer.seal({ frameIds: [harness.frameId, outcomeFrame, unservedCapture] }),
    (error) => expectRunnerError(error, "FRAME_NOT_SERVED"),
  );
  assert.throws(
    () => sealer.seal({ observations: [{ frameRefs: [harness.frameId], precedingActionRefs: [], seed: 7301 }] }),
    (error) => expectRunnerError(error, "PUBLIC_FIELD_FORBIDDEN"),
  );

  const sealed = sealer.seal({
    observations: [{ frameRefs: [outcomeFrame], precedingActionRefs: ["A000001"] }],
    framePolicyVersion: "opaque-overlay/v1",
    inputPolicyVersion: "opaque-object/v1",
  });
  assert.equal(validatePublicPlayHandoff(sealed.publicHandoff.payload).valid, true);
  assertSigned(sealed.publicHandoff, harness.publicKey);
  assertSigned(sealed.privateJudgeEnvelope, harness.publicKey);
  assert.equal(sealed.publicHandoff.header.artifactType, "PublicPlayHandoff");
  assert.equal(sealed.publicHandoff.header.schemaVersion, "atlas/public-play-handoff/1");
  assert.equal(sealed.privateJudgeEnvelope.header.schemaVersion, "atlas/private-judge-envelope/1");
  assert.equal(sealed.publicHandoff.header.campaignId, harness.identityPool.campaignId);
  assert.equal(sealed.publicHandoff.header.targetRunId, sealed.publicHandoff.payload.manifest.runId);
  assert.equal(sealed.publicHandoff.header.artifactId, sealed.publicHandoff.payload.manifest.artifactId);
  const preissuedArtifacts = new Set(harness.identityPool.entries.map((entry) => entry.artifactId));
  const preissuedNonces = new Set(harness.identityPool.entries.map((entry) => entry.nonce));
  assert.equal(preissuedArtifacts.has(sealed.publicHandoff.header.artifactId), true);
  assert.equal(preissuedArtifacts.has(sealed.privateJudgeEnvelope.header.artifactId), true);
  assert.equal(preissuedNonces.has(sealed.publicHandoff.header.nonce), true);
  assert.equal(preissuedNonces.has(sealed.privateJudgeEnvelope.header.nonce), true);
  assert.deepEqual(sealed.publicHandoff.payload.actions[0].input, { kind: "opaqueActivate" });
  assert.equal(sealed.privateJudgeEnvelope.payload.publicHandoffDigest, sha256(sealed.publicHandoff));
  assert.deepEqual(sealed.privateJudgeEnvelope.header.parentDigests, [sha256(sealed.publicHandoff)]);
  assert.equal(sealed.privateJudgeEnvelope.payload.configHandle, privateValues.configHandle);
  assert.equal(sealed.publicFiles.size, sealed.publicHandoff.payload.manifest.files.length);
  for (const file of sealed.publicHandoff.payload.manifest.files) {
    const bytes = sealed.publicFiles.get(file.relativeName);
    assert.equal(bytes.byteLength, file.bytes);
    assert.equal(sha256(bytes), file.sha256);
  }

  const publicText = JSON.stringify(sealed.publicHandoff);
  assert.equal(publicText.includes(privateValues.configHandle), false);
  assert.equal(publicText.includes(privateValues.gameBuildHandle), false);
  assert.equal(publicText.includes("private-target-handle"), false);
  assert.equal(publicText.includes(optionRef), false);
  const transcript = sealed.privateJudgeEnvelope.payload.signedTranscript;
  for (const frameId of harness.frames.servedFrameIds()) {
    assert.equal(transcript.filter((entry) => entry.header.artifactType === "PrivateFrameReceipt" && entry.payload.frameId === frameId).length, 1);
    assert.equal(transcript.filter((entry) => entry.header.artifactType === "SignedFrameServedEvent" && entry.payload.frameId === frameId).length, 1);
  }
  assertAllPrivateReceipts(harness);
}

async function verifyCapabilityExpiryAndBudget() {
  let now = 10;
  const issuer = new CapabilityIssuer({ clock: () => now });
  const token = issuer.issue({ runId: "run", clientBinding: "client", scopes: ["keyboard"], expiresAt: 20, budget: 1 });
  issuer.authorize({ token, runId: "run", clientBinding: "client", scope: "keyboard", consume: true });
  assert.throws(
    () => issuer.authorize({ token, runId: "run", clientBinding: "client", scope: "keyboard", consume: true }),
    (error) => expectRunnerError(error, "CAPABILITY_BUDGET_EXHAUSTED"),
  );
  assert.throws(
    () => issuer.authorize({ token, runId: "run", clientBinding: "client", scope: "object" }),
    (error) => expectRunnerError(error, "CAPABILITY_DENIED"),
  );
  now = 21;
  assert.throws(
    () => issuer.authorize({ token, runId: "run", clientBinding: "client", scope: "keyboard" }),
    (error) => expectRunnerError(error, "CAPABILITY_EXPIRED"),
  );
}

try {
  await verifyDuplicateAndPayloadMismatch();
  await verifyNotDeliveredNeedsNewRequest();
  await verifyCrashAfterDispatch();
  await verifyExpiredOption();
  await verifyObjectActionAndSealing();
  await verifyCapabilityExpiryAndBudget();
  console.log("Player Runner verification passed");
  console.log(JSON.stringify({
    commonEnvelopeShape: "valid",
    coordinatorIdentityPool: "required",
    frameReceiptAndServeEvent: "one-to-one",
    inputBeforeAfterBinding: "verified",
    publicHandoffSignature: "verified",
    duplicateRequest: "exactly-once",
    payloadMismatch: "rejected",
    crashAfterDispatch: "delivery-unknown-no-retry",
    expiredOption: "rejected",
    unservedFrame: "public-seal-rejected",
    privateLeak: "public-seal-rejected",
  }, null, 2));
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
