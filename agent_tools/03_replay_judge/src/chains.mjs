import { canonicalize, sha256 } from "../../packages/atlas_protocol/src/index.mjs";
import { ARTIFACT, artifactDigest, issueArtifact } from "./attestation.mjs";
import { digestText, exactKeys, invariant, nonEmptyText } from "./errors.mjs";

const FRAME_KEYS = [
  "schemaVersion", "authorizationDigest", "internalRunId", "publicRunId", "frameId",
  "frameOrdinal", "gameBuildHandle", "capturePolicyDigest", "framePolicy",
  "rawHash", "overlayPolicyDigest", "overlayCompositorVersion", "overlayPrimitivesDigest",
  "servedHash", "previousFrameReceiptDigest",
];

const INPUT_KEYS = [
  "schemaVersion", "authorizationDigest", "internalRunId", "publicRunId", "requestId",
  "receiptOrdinal", "canonicalRequestDigest", "expectedFrameId", "action", "status",
  "actionOrdinal", "retry", "beforeFrameReceiptDigest", "afterFrameReceiptDigests",
  "previousInputReceiptDigest",
];

export function createFrameServedEvent({ authorization, internalRunId, frameId, frameOrdinal, capturePolicyDigest, framePolicy, rawBytes, servedBytes, overlayPolicyDigest, overlayCompositorVersion, overlayPrimitives, previousEvent = null, signer }) {
  const authorizationDigest = artifactDigest(authorization);
  const previousFrameReceiptDigest = previousEvent === null ? null : artifactDigest(previousEvent);
  const payload = {
    schemaVersion: "atlas/frame-served-event/1",
    authorizationDigest,
    internalRunId,
    publicRunId: authorization.header.targetRunId,
    frameId,
    frameOrdinal,
    gameBuildHandle: authorization.payload.gameBuildHandle,
    capturePolicyDigest,
    framePolicy,
    rawHash: sha256(rawBytes),
    overlayPolicyDigest,
    overlayCompositorVersion,
    overlayPrimitivesDigest: sha256(overlayPrimitives),
    servedHash: sha256(servedBytes),
    previousFrameReceiptDigest,
  };
  const envelope = issueArtifact({
    artifactType: ARTIFACT.FRAME_SERVED_EVENT,
    schemaVersion: "atlas/frame-served-event/1",
    campaignId: authorization.header.campaignId,
    track: authorization.header.track,
    arm: authorization.header.arm,
    targetRunId: authorization.header.targetRunId,
    issuer: signer.issuer,
    keyId: signer.keyId,
    parentDigests: previousFrameReceiptDigest === null
      ? [authorizationDigest]
      : [authorizationDigest, previousFrameReceiptDigest],
    contractDigest: authorization.header.contractDigest,
    payload,
    privateKey: signer.privateKey,
  });
  const material = Object.freeze({
    frameReceiptDigest: artifactDigest(envelope),
    rawBase64: Buffer.from(rawBytes).toString("base64"),
    servedBase64: Buffer.from(servedBytes).toString("base64"),
    overlayPrimitives,
  });
  return Object.freeze({ envelope, material });
}

export function validateFrameReceiptChain({ authorization, events, materials, verifier, composeOverlay }) {
  invariant(Array.isArray(events) && events.length > 0, "FRAME_CHAIN_INVALID", "frame events are required");
  invariant(Array.isArray(materials) && materials.length === events.length, "FRAME_CHAIN_INVALID", "one frame material is required per event");
  const authorizationDigest = artifactDigest(authorization);
  const materialMap = new Map(materials.map((material) => [material.frameReceiptDigest, material]));
  invariant(materialMap.size === materials.length, "FRAME_CHAIN_INVALID", "duplicate frame material digest");
  const byDigest = new Map();
  let previousDigest = null;
  let internalRunId = null;

  for (const [index, event] of events.entries()) {
    exactKeys(event.payload, FRAME_KEYS, "FRAME_CHAIN_INVALID", `frameEvents[${index}].payload`);
    const payload = event.payload;
    const expectedParents = previousDigest === null
      ? [authorizationDigest]
      : [authorizationDigest, previousDigest];
    const verified = verifier.verify(event, {
      artifactType: ARTIFACT.FRAME_SERVED_EVENT,
      campaignId: authorization.header.campaignId,
      track: authorization.header.track,
      arm: authorization.header.arm,
      targetRunId: authorization.header.targetRunId,
      contractDigest: authorization.header.contractDigest,
      parentDigests: expectedParents,
    });
    invariant(payload.schemaVersion === "atlas/frame-served-event/1", "FRAME_CHAIN_INVALID", "unsupported frame event schema");
    invariant(payload.authorizationDigest === authorizationDigest, "FRAME_CHAIN_INVALID", "frame authorization mismatch");
    invariant(payload.publicRunId === authorization.header.targetRunId, "FRAME_CHAIN_INVALID", "frame public run mismatch");
    invariant(payload.frameOrdinal === index + 1, "FRAME_CHAIN_INVALID", "frame ordinals must be gap-free");
    invariant(payload.frameId === `F${String(index + 1).padStart(6, "0")}`, "FRAME_CHAIN_INVALID", "frameId must be canonical ordinal");
    invariant(payload.gameBuildHandle === authorization.payload.gameBuildHandle, "FRAME_CHAIN_INVALID", "frame game build mismatch");
    invariant(payload.capturePolicyDigest === authorization.payload.capturePolicyDigest, "FRAME_CHAIN_INVALID", "capture policy is not authorized");
    invariant(payload.framePolicy === authorization.payload.framePolicy, "FRAME_CHAIN_INVALID", "frame policy is not authorized");
    invariant([payload.rawHash, payload.overlayPolicyDigest, payload.overlayPrimitivesDigest, payload.servedHash].every(digestText), "FRAME_CHAIN_INVALID", "frame digest is invalid");
    invariant(payload.overlayPolicyDigest === authorization.payload.overlayPolicyDigest, "FRAME_CHAIN_INVALID", "overlay policy is not authorized");
    invariant(payload.overlayCompositorVersion === authorization.payload.overlayCompositorVersion, "FRAME_CHAIN_INVALID", "overlay compositor is not authorized");
    invariant(payload.previousFrameReceiptDigest === previousDigest, "FRAME_CHAIN_INVALID", "previous frame receipt mismatch");
    internalRunId ??= payload.internalRunId;
    invariant(payload.internalRunId === internalRunId, "FRAME_CHAIN_INVALID", "cross-run frame receipt detected");

    const material = materialMap.get(verified.digest);
    invariant(material, "FRAME_CHAIN_INVALID", "frame material is missing or bound to another receipt");
    exactKeys(material, ["frameReceiptDigest", "rawBase64", "servedBase64", "overlayPrimitives"], "FRAME_CHAIN_INVALID", "frameMaterial");
    const raw = decodeBase64(material.rawBase64, "rawBase64");
    const served = decodeBase64(material.servedBase64, "servedBase64");
    invariant(sha256(raw) === payload.rawHash && sha256(served) === payload.servedHash, "FRAME_BYTES_MISMATCH", "frame bytes do not match signed hashes");
    invariant(sha256(material.overlayPrimitives) === payload.overlayPrimitivesDigest, "FRAME_BYTES_MISMATCH", "overlay primitives digest mismatch");
    if (payload.framePolicy === "KEYBOARD") {
      invariant(raw.equals(served), "FRAME_TRANSFORM_INVALID", "keyboard raw and served frames must be byte-identical");
      invariant(isEmptyOverlay(material.overlayPrimitives), "FRAME_TRANSFORM_INVALID", "keyboard frame cannot contain overlay primitives");
    } else {
      invariant(typeof composeOverlay === "function", "FRAME_TRANSFORM_INVALID", "object overlay requires a pinned compositor");
      const recomposed = Buffer.from(composeOverlay({ raw, primitives: material.overlayPrimitives, policyDigest: payload.overlayPolicyDigest, compositorVersion: payload.overlayCompositorVersion }));
      invariant(recomposed.equals(served), "FRAME_TRANSFORM_INVALID", "served frame is not the deterministic raw overlay transform");
    }
    byDigest.set(verified.digest, Object.freeze({ event, payload, raw, served }));
    previousDigest = verified.digest;
  }
  return Object.freeze({ authorizationDigest, internalRunId, byDigest, terminalDigest: previousDigest });
}

export function createSignedInputReceipt({ authorization, internalRunId, requestId, receiptOrdinal, expectedFrameId, action, status, actionOrdinal, retry, beforeFrameReceiptDigest, afterFrameReceiptDigests, previousReceipt = null, signer }) {
  validateAction(action);
  const authorizationDigest = artifactDigest(authorization);
  const previousInputReceiptDigest = previousReceipt === null ? null : artifactDigest(previousReceipt);
  const canonicalRequestDigest = sha256({ requestId, expectedFrameId, action });
  const payload = {
    schemaVersion: "atlas/input-receipt/1",
    authorizationDigest,
    internalRunId,
    publicRunId: authorization.header.targetRunId,
    requestId,
    receiptOrdinal,
    canonicalRequestDigest,
    expectedFrameId,
    action,
    status,
    actionOrdinal,
    retry,
    beforeFrameReceiptDigest,
    afterFrameReceiptDigests,
    previousInputReceiptDigest,
  };
  const dependencyDigests = [authorizationDigest];
  if (previousInputReceiptDigest !== null) dependencyDigests.push(previousInputReceiptDigest);
  dependencyDigests.push(beforeFrameReceiptDigest, ...afterFrameReceiptDigests);
  return issueArtifact({
    artifactType: ARTIFACT.INPUT_RECEIPT,
    schemaVersion: "atlas/input-receipt/1",
    campaignId: authorization.header.campaignId,
    track: authorization.header.track,
    arm: authorization.header.arm,
    targetRunId: authorization.header.targetRunId,
    issuer: signer.issuer,
    keyId: signer.keyId,
    parentDigests: dependencyDigests,
    contractDigest: authorization.header.contractDigest,
    payload,
    privateKey: signer.privateKey,
  });
}

export function validateInputReceiptChain({ authorization, receipts, frameChain, verifier }) {
  invariant(Array.isArray(receipts), "INPUT_CHAIN_INVALID", "input receipts must be an array");
  const authorizationDigest = artifactDigest(authorization);
  const requestIds = new Set();
  let previousDigest = null;
  let deliveredOrdinal = 0;
  let terminalUnknown = false;
  let previousAfterDigest = null;

  for (const [index, receipt] of receipts.entries()) {
    invariant(!terminalUnknown, "INPUT_CHAIN_INVALID", "no receipt may follow DELIVERY_UNKNOWN");
    exactKeys(receipt.payload, INPUT_KEYS, "INPUT_CHAIN_INVALID", `inputReceipts[${index}].payload`);
    const payload = receipt.payload;
    const expectedParents = [authorizationDigest];
    if (previousDigest !== null) expectedParents.push(previousDigest);
    expectedParents.push(payload.beforeFrameReceiptDigest, ...payload.afterFrameReceiptDigests);
    const verified = verifier.verify(receipt, {
      artifactType: ARTIFACT.INPUT_RECEIPT,
      campaignId: authorization.header.campaignId,
      track: authorization.header.track,
      arm: authorization.header.arm,
      targetRunId: authorization.header.targetRunId,
      contractDigest: authorization.header.contractDigest,
      parentDigests: expectedParents,
    });
    invariant(payload.schemaVersion === "atlas/input-receipt/1", "INPUT_CHAIN_INVALID", "unsupported input receipt schema");
    invariant(payload.authorizationDigest === authorizationDigest, "INPUT_CHAIN_INVALID", "input authorization mismatch");
    invariant(payload.internalRunId === frameChain.internalRunId, "INPUT_CHAIN_INVALID", "input/frame internal run mismatch");
    invariant(payload.publicRunId === authorization.header.targetRunId, "INPUT_CHAIN_INVALID", "input public run mismatch");
    invariant(payload.receiptOrdinal === index + 1, "INPUT_CHAIN_INVALID", "receipt ordinals must be gap-free");
    invariant(payload.previousInputReceiptDigest === previousDigest, "INPUT_CHAIN_INVALID", "previous input receipt mismatch");
    nonEmptyText(payload.requestId, "INPUT_CHAIN_INVALID", "requestId");
    invariant(!requestIds.has(payload.requestId), "INPUT_CHAIN_INVALID", "duplicate requestId in transcript");
    requestIds.add(payload.requestId);
    validateAction(payload.action);
    invariant(payload.canonicalRequestDigest === sha256({ requestId: payload.requestId, expectedFrameId: payload.expectedFrameId, action: payload.action }), "REQUEST_DIGEST_MISMATCH", "canonical request digest mismatch");
    invariant(frameChain.byDigest.has(payload.beforeFrameReceiptDigest), "INPUT_CHAIN_INVALID", "before frame receipt is not in this run");
    invariant(Array.isArray(payload.afterFrameReceiptDigests) && payload.afterFrameReceiptDigests.length > 0, "INPUT_CHAIN_INVALID", "after frame receipts are required");
    invariant(payload.afterFrameReceiptDigests.every((digest) => frameChain.byDigest.has(digest)), "INPUT_CHAIN_INVALID", "after frame receipt is not in this run");
    invariant(frameChain.byDigest.get(payload.beforeFrameReceiptDigest).payload.frameId === payload.expectedFrameId, "INPUT_CHAIN_INVALID", "expectedFrameId does not match before frame receipt");
    if (previousAfterDigest !== null) invariant(payload.beforeFrameReceiptDigest === previousAfterDigest, "INPUT_CHAIN_INVALID", "next input must use the prior stabilized after-frame");
    const beforeOrdinal = frameChain.byDigest.get(payload.beforeFrameReceiptDigest).payload.frameOrdinal;
    let afterOrdinal = beforeOrdinal;
    for (const digest of payload.afterFrameReceiptDigests) {
      const currentOrdinal = frameChain.byDigest.get(digest).payload.frameOrdinal;
      invariant(currentOrdinal > afterOrdinal, "INPUT_CHAIN_INVALID", "after frames must be strictly ordered after the before frame");
      afterOrdinal = currentOrdinal;
    }
    invariant(["DELIVERED", "NOT_DELIVERED", "DELIVERY_UNKNOWN"].includes(payload.status), "INPUT_CHAIN_INVALID", "invalid delivery status");
    if (payload.status === "DELIVERED") {
      deliveredOrdinal += 1;
      invariant(payload.actionOrdinal === deliveredOrdinal, "INPUT_CHAIN_INVALID", "delivered action ordinals must be gap-free");
      invariant(payload.retry === "DO_NOT_RETRY", "INPUT_CHAIN_INVALID", "delivered input cannot be retried");
    } else {
      invariant(payload.actionOrdinal === null, "INPUT_CHAIN_INVALID", "undelivered input cannot have actionOrdinal");
      if (payload.status === "DELIVERY_UNKNOWN") {
        invariant(payload.retry === "DO_NOT_RETRY", "INPUT_CHAIN_INVALID", "unknown delivery must not retry");
        terminalUnknown = true;
      } else {
        invariant(["SAME_REQUEST_SAFE", "DO_NOT_RETRY"].includes(payload.retry), "INPUT_CHAIN_INVALID", "invalid retry policy");
      }
    }
    previousAfterDigest = payload.afterFrameReceiptDigests.at(-1);
    previousDigest = verified.digest;
  }
  return Object.freeze({
    deliveredActions: receipts.filter((receipt) => receipt.payload.status === "DELIVERED").map((receipt) => receipt.payload.action),
    deliveredCount: deliveredOrdinal,
    terminalDigest: previousDigest,
  });
}

export function createActionTranscript({ authorization, internalRunId, frameEvents, frameMaterials, inputReceipts, signer }) {
  const authorizationDigest = artifactDigest(authorization);
  const frameDigests = frameEvents.map(artifactDigest);
  const inputDigests = inputReceipts.map(artifactDigest);
  const payload = {
    schemaVersion: "atlas/action-transcript/1",
    authorizationDigest,
    documentDigest: authorization.payload.documentDigest,
    internalRunId,
    publicRunId: authorization.header.targetRunId,
    frameEvents,
    frameMaterials,
    inputReceipts,
    deliveredActionCount: inputReceipts.filter((receipt) => receipt.payload.status === "DELIVERED").length,
  };
  return issueArtifact({
    artifactType: ARTIFACT.ACTION_TRANSCRIPT,
    schemaVersion: "atlas/action-transcript/1",
    campaignId: authorization.header.campaignId,
    track: authorization.header.track,
    arm: authorization.header.arm,
    targetRunId: authorization.header.targetRunId,
    issuer: signer.issuer,
    keyId: signer.keyId,
    parentDigests: [authorizationDigest, ...frameDigests, ...inputDigests],
    contractDigest: authorization.header.contractDigest,
    payload,
    privateKey: signer.privateKey,
  });
}

export function validateActionTranscript({ authorization, transcript, verifier, composeOverlay }) {
  const authorizationDigest = artifactDigest(authorization);
  exactKeys(transcript.payload, ["schemaVersion", "authorizationDigest", "documentDigest", "internalRunId", "publicRunId", "frameEvents", "frameMaterials", "inputReceipts", "deliveredActionCount"], "TRANSCRIPT_INVALID", "transcript.payload");
  const frameDigests = transcript.payload.frameEvents.map(artifactDigest);
  const inputDigests = transcript.payload.inputReceipts.map(artifactDigest);
  const verified = verifier.verify(transcript, {
    artifactType: ARTIFACT.ACTION_TRANSCRIPT,
    campaignId: authorization.header.campaignId,
    track: authorization.header.track,
    arm: authorization.header.arm,
    targetRunId: authorization.header.targetRunId,
    contractDigest: authorization.header.contractDigest,
    parentDigests: [authorizationDigest, ...frameDigests, ...inputDigests],
  });
  invariant(transcript.payload.schemaVersion === "atlas/action-transcript/1", "TRANSCRIPT_INVALID", "unsupported transcript schema");
  invariant(transcript.payload.authorizationDigest === authorizationDigest, "TRANSCRIPT_INVALID", "transcript authorization mismatch");
  invariant(transcript.payload.documentDigest === authorization.payload.documentDigest, "TRANSCRIPT_WRONG_DOCUMENT", "transcript document mismatch");
  invariant(transcript.payload.publicRunId === authorization.header.targetRunId, "TRANSCRIPT_INVALID", "transcript public run mismatch");
  const frameChain = validateFrameReceiptChain({ authorization, events: transcript.payload.frameEvents, materials: transcript.payload.frameMaterials, verifier, composeOverlay });
  invariant(frameChain.internalRunId === transcript.payload.internalRunId, "TRANSCRIPT_INVALID", "transcript/frame internal run mismatch");
  const inputChain = validateInputReceiptChain({ authorization, receipts: transcript.payload.inputReceipts, frameChain, verifier });
  invariant(inputChain.deliveredCount === transcript.payload.deliveredActionCount, "TRANSCRIPT_INVALID", "delivered action count mismatch");
  return Object.freeze({ verified, frameChain, inputChain });
}

export function canonicalRequestDigest({ requestId, expectedFrameId, action }) {
  validateAction(action);
  return sha256({ requestId, expectedFrameId, action });
}

function validateAction(action) {
  exactKeys(action, ["kind", "code"], "ACTION_INVALID", "action");
  invariant(action.kind === "keyTap", "ACTION_INVALID", "MVP supports keyTap only");
  nonEmptyText(action.code, "ACTION_INVALID", "action.code", 32);
}

function decodeBase64(value, field) {
  invariant(typeof value === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value), "FRAME_BYTES_MISMATCH", `${field} must be canonical base64`);
  return Buffer.from(value, "base64");
}

function isEmptyOverlay(value) {
  return value === null
    || (Array.isArray(value) && value.length === 0)
    || (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0)
    || canonicalize(value) === "{}";
}
