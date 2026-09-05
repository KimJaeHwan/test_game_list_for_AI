import { coordinatorRandomId, sha256 } from "../../packages/atlas_protocol/src/index.mjs";
import { RunnerError } from "./errors.mjs";

function publicFrameId(ordinal) {
  return `F${String(ordinal).padStart(6, "0")}`;
}

const FRAME_RECEIPT_GENESIS = sha256("PRIVATE_FRAME_RECEIPT_GENESIS");
const FRAME_SERVED_GENESIS = sha256("SIGNED_FRAME_SERVED_EVENT_GENESIS");

export class FrameProvenance {
  constructor({
    campaignId,
    internalRunId,
    publicRunId,
    gameBuildHandle,
    capturePolicyDigest,
    overlayCompositorVersion,
    clientBindingDigest,
    receiptChain,
    width = 1280,
    height = 720,
  }) {
    const required = { campaignId, internalRunId, publicRunId, gameBuildHandle, capturePolicyDigest, overlayCompositorVersion, clientBindingDigest, receiptChain };
    if (Object.values(required).some((value) => !value)) throw new TypeError("FrameProvenance requires all run, build, policy, binding, and receipt-chain fields.");
    this.campaignId = campaignId;
    this.internalRunId = internalRunId;
    this.publicRunId = publicRunId;
    this.gameBuildHandle = gameBuildHandle;
    this.capturePolicyDigest = capturePolicyDigest;
    this.overlayCompositorVersion = overlayCompositorVersion;
    this.clientBindingDigest = clientBindingDigest;
    this.receiptChain = receiptChain;
    this.width = width;
    this.height = height;
    this.captures = new Map();
    this.frames = new Map();
    this.latestFrameId = undefined;
    this.previousFrameReceiptDigest = FRAME_RECEIPT_GENESIS;
    this.previousFrameServedEventDigest = FRAME_SERVED_GENESIS;
  }

  capture(rawBytes) {
    if (!(rawBytes instanceof Uint8Array)) throw new RunnerError("CAPTURE_INVALID", "Capture must be byte data.");
    const captureId = `capture-${coordinatorRandomId()}`;
    this.captures.set(captureId, Object.freeze({
      captureId,
      rawBytes: Buffer.from(rawBytes),
      rawHash: sha256(rawBytes),
      served: false,
    }));
    return captureId;
  }

  allocateFrameId() {
    return publicFrameId(this.frames.size + 1);
  }

  serve({
    captureId,
    frameId,
    servedBytes,
    framePolicyVersion,
    responseRequestDigest,
    optionSetDigest = sha256({ options: [] }),
    overlayPrimitivesDigest = sha256({ primitives: [] }),
  }) {
    const capture = this.captures.get(captureId);
    if (!capture || capture.served) throw new RunnerError("CAPTURE_NOT_SERVABLE", "Capture is missing or already served.");
    const ordinal = this.frames.size + 1;
    const expectedFrameId = publicFrameId(ordinal);
    if (frameId !== expectedFrameId) throw new RunnerError("FRAME_ID_INVALID", `Expected ${expectedFrameId}.`);
    if (!(servedBytes instanceof Uint8Array)) throw new RunnerError("CAPTURE_INVALID", "Served frame must be byte data.");

    const servedHash = sha256(servedBytes);
    const common = {
      campaignId: this.campaignId,
      internalRunId: this.internalRunId,
      publicRunId: this.publicRunId,
      gameBuildHandle: this.gameBuildHandle,
      frameId,
      frameOrdinal: ordinal,
      capturePolicyDigest: this.capturePolicyDigest,
      overlayCompositorVersion: this.overlayCompositorVersion,
      overlayPrimitivesDigest,
      optionSetDigest,
    };
    const privateFrameReceipt = this.receiptChain.append("PrivateFrameReceipt", Object.freeze({
      eventType: "PRIVATE_FRAME_RECEIPT",
      ...common,
      rawHash: capture.rawHash,
      servedHash,
      previousFrameReceiptDigest: this.previousFrameReceiptDigest,
    }));
    const privateFrameReceiptDigest = sha256(privateFrameReceipt);

    const signedServedEvent = this.receiptChain.append("SignedFrameServedEvent", Object.freeze({
      eventType: "FRAME_SERVED",
      ...common,
      clientBindingDigest: this.clientBindingDigest,
      servedHash,
      framePolicyVersion,
      responseRequestDigest,
      privateFrameReceiptDigest,
      previousFrameServedEventDigest: this.previousFrameServedEventDigest,
    }));
    const signedServedEventDigest = sha256(signedServedEvent);
    const record = {
      frameId,
      ordinal,
      mediaRef: `frames/${frameId}.png`,
      sha256: servedHash,
      evidenceRole: "CITEABLE",
      sourceActionRefs: [],
      bytes: Buffer.from(servedBytes),
      captureId,
      optionSetDigest,
      privateFrameReceipt,
      privateFrameReceiptDigest,
      signedServedEvent,
      signedServedEventDigest,
    };
    this.frames.set(frameId, record);
    this.captures.set(captureId, Object.freeze({ ...capture, served: true }));
    this.latestFrameId = frameId;
    this.previousFrameReceiptDigest = privateFrameReceiptDigest;
    this.previousFrameServedEventDigest = signedServedEventDigest;
    return Object.freeze({
      frameId,
      image: Buffer.from(servedBytes),
      sha256: servedHash,
      optionSetDigest,
      privateFrameReceipt: structuredClone(privateFrameReceipt),
      signedServedEvent: structuredClone(signedServedEvent),
    });
  }

  linkAction(frameId, actionId) {
    const frame = this.frames.get(frameId);
    if (!frame) throw new RunnerError("FRAME_NOT_SERVED", "Cannot link an action to an unserved frame.");
    if (!frame.sourceActionRefs.includes(actionId)) frame.sourceActionRefs.push(actionId);
  }

  isServed(frameId) {
    return this.frames.has(frameId);
  }

  get latestServedFrameId() {
    return this.latestFrameId;
  }

  getPublicFrame(frameId) {
    const frame = this.frames.get(frameId);
    if (!frame) throw new RunnerError("FRAME_NOT_SERVED", "Frame was not served to the agent.");
    return Object.freeze({
      frameId: frame.frameId,
      ordinal: frame.ordinal,
      mediaRef: frame.mediaRef,
      sha256: frame.sha256,
      evidenceRole: frame.evidenceRole,
      sourceActionRefs: [...frame.sourceActionRefs],
    });
  }

  getMedia(frameId) {
    const frame = this.frames.get(frameId);
    if (!frame) throw new RunnerError("FRAME_NOT_SERVED", "Frame was not served to the agent.");
    return Buffer.from(frame.bytes);
  }

  getSignedFrameEvent(frameId) {
    const frame = this.frames.get(frameId);
    if (!frame) throw new RunnerError("FRAME_NOT_SERVED", "Frame was not served to the agent.");
    return structuredClone(frame.signedServedEvent);
  }

  getPrivateFrameReceipt(frameId) {
    const frame = this.frames.get(frameId);
    if (!frame) throw new RunnerError("FRAME_NOT_SERVED", "Frame was not served to the agent.");
    return structuredClone(frame.privateFrameReceipt);
  }

  getFrameReceiptDigest(frameId) {
    const frame = this.frames.get(frameId);
    if (!frame) throw new RunnerError("FRAME_NOT_SERVED", "Frame was not served to the agent.");
    return frame.privateFrameReceiptDigest;
  }

  getFrameProof(frameId) {
    const frame = this.frames.get(frameId);
    if (!frame) throw new RunnerError("FRAME_NOT_SERVED", "Frame was not served to the agent.");
    return Object.freeze({
      privateFrameReceipt: structuredClone(frame.privateFrameReceipt),
      privateFrameReceiptDigest: frame.privateFrameReceiptDigest,
      signedServedEvent: structuredClone(frame.signedServedEvent),
      signedServedEventDigest: frame.signedServedEventDigest,
    });
  }

  servedFrameIds() {
    return [...this.frames.keys()];
  }
}
