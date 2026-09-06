import {
  canonicalize,
  createSignedEnvelope,
  publicHandoffPayloadDigest,
  scanForForbiddenData,
  sha256,
  validatePublicPlayHandoff,
  validateSignedEnvelopeShape,
} from "../../packages/atlas_protocol/src/index.mjs";
import { RunnerError } from "./errors.mjs";
import { validateExplorationTrack, validityForExplorationTrack } from "./exploration-track.mjs";

const OBSERVATION_KEYS = new Set(["frameRefs", "precedingActionRefs"]);

function assertExactKeys(value, allowed, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RunnerError(code, "Expected an object.");
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new RunnerError(code, `Unexpected public fields: ${unexpected.join(", ")}.`);
}

function ndjson(records) {
  return Buffer.from(records.map((record) => canonicalize(record)).join("\n") + (records.length ? "\n" : ""), "utf8");
}

function assertSignedShape(envelope, label) {
  const validation = validateSignedEnvelopeShape(envelope);
  if (!validation.valid) {
    throw new RunnerError("SIGNED_ENVELOPE_INVALID", `${label} does not match the common signed-envelope contract.`, {
      details: validation.errors,
    });
  }
}

export class HandoffSealer {
  constructor({
    internalRunId,
    configHandle,
    gameBuildHandle,
    replayAdapterVersion,
    runnerKeyId,
    signingPrivateKey,
    identityPool,
    receiptChain,
    frames,
    inputGateway,
    explorationTrack = "EXPLORATION",
  }) {
    if (!identityPool) throw new RunnerError("COORDINATOR_IDENTITY_REQUIRED", "HandoffSealer requires a Coordinator-issued identity pool.");
    this.internalRunId = internalRunId;
    this.configHandle = configHandle;
    this.gameBuildHandle = gameBuildHandle;
    this.replayAdapterVersion = replayAdapterVersion;
    this.runnerKeyId = runnerKeyId;
    this.signingPrivateKey = signingPrivateKey;
    this.identityPool = identityPool;
    this.receiptChain = receiptChain;
    this.frames = frames;
    this.inputGateway = inputGateway;
    this.explorationTrack = validateExplorationTrack(explorationTrack);
    this.publicRunId = identityPool.publicRunId;
    this.campaignId = identityPool.campaignId;
    this.targetRunId = identityPool.targetRunId;
    this.sealed = false;
  }

  #assertFrameProofs(publicFrames) {
    const transcript = this.receiptChain.snapshot();
    let previousPrivateDigest;
    let previousServedDigest;
    for (const [index, frame] of publicFrames.entries()) {
      if (frame.ordinal !== index + 1) {
        throw new RunnerError("UNSERVED_FRAME_PUBLIC", "Public frames must be the complete served ordinal series.");
      }
      const proof = this.frames.getFrameProof(frame.frameId);
      assertSignedShape(proof.privateFrameReceipt, "PrivateFrameReceipt");
      assertSignedShape(proof.signedServedEvent, "SignedFrameServedEvent");
      const privatePayload = proof.privateFrameReceipt.payload;
      const servedPayload = proof.signedServedEvent.payload;
      const privateMatches = transcript.filter((entry) => entry.header.artifactType === "PrivateFrameReceipt" && entry.payload.frameId === frame.frameId);
      const servedMatches = transcript.filter((entry) => entry.header.artifactType === "SignedFrameServedEvent" && entry.payload.frameId === frame.frameId);
      if (privateMatches.length !== 1 || servedMatches.length !== 1) {
        throw new RunnerError("FRAME_PROOF_CARDINALITY_INVALID", "Every public frame requires exactly one private frame receipt and one served event.");
      }
      if (
        proof.privateFrameReceipt.header.campaignId !== this.campaignId
        || proof.privateFrameReceipt.header.targetRunId !== this.targetRunId
        || proof.signedServedEvent.header.campaignId !== this.campaignId
        || proof.signedServedEvent.header.targetRunId !== this.targetRunId
        || proof.privateFrameReceipt.header.track !== this.explorationTrack
        || proof.signedServedEvent.header.track !== this.explorationTrack
        || privatePayload.campaignId !== this.campaignId
        || servedPayload.campaignId !== this.campaignId
        || privatePayload.internalRunId !== this.internalRunId
        || servedPayload.internalRunId !== this.internalRunId
        || privatePayload.publicRunId !== this.publicRunId
        || servedPayload.publicRunId !== this.publicRunId
        || privatePayload.gameBuildHandle !== this.gameBuildHandle
        || servedPayload.gameBuildHandle !== this.gameBuildHandle
        || privatePayload.frameOrdinal !== frame.ordinal
        || servedPayload.frameOrdinal !== frame.ordinal
        || privatePayload.capturePolicyDigest !== servedPayload.capturePolicyDigest
        || privatePayload.overlayCompositorVersion !== servedPayload.overlayCompositorVersion
        || privatePayload.overlayPrimitivesDigest !== servedPayload.overlayPrimitivesDigest
        || privatePayload.optionSetDigest !== servedPayload.optionSetDigest
        || privatePayload.servedHash !== frame.sha256
        || servedPayload.servedHash !== frame.sha256
        || servedPayload.privateFrameReceiptDigest !== proof.privateFrameReceiptDigest
        || sha256(proof.privateFrameReceipt) !== proof.privateFrameReceiptDigest
        || sha256(proof.signedServedEvent) !== proof.signedServedEventDigest
        || sha256(privateMatches[0]) !== proof.privateFrameReceiptDigest
        || sha256(servedMatches[0]) !== proof.signedServedEventDigest
        || (index > 0 && privatePayload.previousFrameReceiptDigest !== previousPrivateDigest)
        || (index > 0 && servedPayload.previousFrameServedEventDigest !== previousServedDigest)
      ) {
        throw new RunnerError("FRAME_PROOF_BINDING_INVALID", "Frame receipt, served event, build, run, and public media hashes must agree.");
      }
      previousPrivateDigest = proof.privateFrameReceiptDigest;
      previousServedDigest = proof.signedServedEventDigest;
    }
  }

  seal({
    frameIds = this.frames.servedFrameIds(),
    observations = [],
    status = "COMPLETE",
    validity,
    interventions = 0,
    framePolicyVersion = "canvas-served/v1",
    inputPolicyVersion = "keyboard-restricted/v1",
  } = {}) {
    if (this.sealed) throw new RunnerError("HANDOFF_ALREADY_SEALED", "A HandoffSealer instance can seal only once.");
    const requiredValidity = validityForExplorationTrack(this.explorationTrack);
    if (validity === undefined) validity = requiredValidity;
    if (validity !== requiredValidity) {
      throw new RunnerError("TRACK_VALIDITY_MISMATCH", "Handoff validity must match the signed exploration track.");
    }
    const publicFrames = frameIds.map((frameId) => this.frames.getPublicFrame(frameId));
    this.#assertFrameProofs(publicFrames);
    const publicActions = this.inputGateway.publicActions();
    const frameSet = new Set(publicFrames.map((frame) => frame.frameId));
    const actionSet = new Set(publicActions.map((action) => action.actionId));
    const publicObservations = observations.map((observation, index) => {
      assertExactKeys(observation, OBSERVATION_KEYS, "PUBLIC_FIELD_FORBIDDEN");
      if (!Array.isArray(observation.frameRefs) || observation.frameRefs.length === 0 || observation.frameRefs.some((id) => !frameSet.has(id))) {
        throw new RunnerError("PUBLIC_REFERENCE_INVALID", "Observation references an unavailable served frame.");
      }
      if (!Array.isArray(observation.precedingActionRefs) || observation.precedingActionRefs.some((id) => !actionSet.has(id))) {
        throw new RunnerError("PUBLIC_REFERENCE_INVALID", "Observation references an unavailable public action.");
      }
      return Object.freeze({
        observationId: `O${String(index + 1).padStart(6, "0")}`,
        ordinal: index + 1,
        frameRefs: [...observation.frameRefs],
        precedingActionRefs: [...observation.precedingActionRefs],
      });
    });

    const publicIdentity = this.identityPool.takeEnvelopeIdentity("public-play-handoff");
    const actionBytes = ndjson(publicActions);
    const observationBytes = ndjson(publicObservations);
    const media = new Map(publicFrames.map((frame) => [frame.mediaRef, this.frames.getMedia(frame.frameId)]));
    const publicFiles = new Map([
      ...media.entries(),
      ["observations.ndjson", observationBytes],
      ["actions.ndjson", actionBytes],
    ]);
    const files = [
      ...publicFrames.map((frame) => ({
        role: "frames",
        relativeName: frame.mediaRef,
        bytes: media.get(frame.mediaRef).byteLength,
        sha256: frame.sha256,
      })),
      { role: "observations", relativeName: "observations.ndjson", bytes: observationBytes.byteLength, sha256: sha256(observationBytes) },
      { role: "actions", relativeName: "actions.ndjson", bytes: actionBytes.byteLength, sha256: sha256(actionBytes) },
    ];
    if (publicFiles.size !== files.length || files.some((file) => {
      const bytes = publicFiles.get(file.relativeName);
      return !(bytes instanceof Uint8Array) || bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256;
    })) {
      throw new RunnerError("PUBLIC_FILE_MANIFEST_MISMATCH", "Every declared public file must have exactly one byte-identical publicFiles entry.");
    }
    const handoffPayload = {
      manifest: {
        schemaVersion: "atlas/public-play-handoff/1",
        artifactId: publicIdentity.artifactId,
        runId: this.publicRunId,
        status,
        validity,
        framePolicyVersion,
        inputPolicyVersion,
        capture: { width: this.frames.width, height: this.frames.height, format: "png", colorSpace: "srgb" },
        counts: {
          frames: publicFrames.length,
          observations: publicObservations.length,
          actions: publicActions.length,
          interventions,
        },
        files,
        payloadDigest: "",
      },
      frames: publicFrames,
      observations: publicObservations,
      actions: publicActions,
    };
    handoffPayload.manifest.payloadDigest = publicHandoffPayloadDigest(handoffPayload);
    const validation = validatePublicPlayHandoff(handoffPayload);
    const forbidden = scanForForbiddenData(handoffPayload);
    if (!validation.valid || forbidden.length) {
      throw new RunnerError("PUBLIC_SANITIZATION_FAILED", "Public handoff failed its allowlist contract.", {
        details: { validationErrors: validation.errors, forbidden },
      });
    }

    const publicHandoff = createSignedEnvelope({
      artifactType: "PublicPlayHandoff",
      schemaVersion: "atlas/public-play-handoff/1",
      artifactId: publicIdentity.artifactId,
      campaignId: this.campaignId,
      track: this.explorationTrack,
      arm: "NONE",
      targetRunId: this.publicRunId,
      issuer: "atlas-player-runner",
      keyId: this.runnerKeyId,
      nonce: publicIdentity.nonce,
      parentDigests: [],
      contractDigest: sha256("atlas/public-play-handoff/1"),
    }, handoffPayload, this.signingPrivateKey);
    assertSignedShape(publicHandoff, "PublicPlayHandoff");

    const publicHandoffDigest = sha256(publicHandoff);
    const privatePayload = Object.freeze({
      schemaVersion: "atlas/private-judge-envelope/1",
      campaignId: this.campaignId,
      internalRunId: this.internalRunId,
      publicRunId: this.publicRunId,
      publicHandoffDigest,
      configHandle: this.configHandle,
      gameBuildHandle: this.gameBuildHandle,
      runnerKeyId: this.runnerKeyId,
      transcriptRoot: this.receiptChain.rootDigest,
      signedTranscript: this.receiptChain.snapshot(),
      replayAdapterVersion: this.replayAdapterVersion,
    });
    const privateIdentity = this.identityPool.takeEnvelopeIdentity("private-judge-envelope");
    const privateJudgeEnvelope = createSignedEnvelope({
      artifactType: "PrivateJudgeEnvelope",
      schemaVersion: "atlas/private-judge-envelope/1",
      artifactId: privateIdentity.artifactId,
      campaignId: this.campaignId,
      track: this.explorationTrack,
      arm: "NONE",
      targetRunId: this.targetRunId,
      issuer: "atlas-player-runner",
      keyId: this.runnerKeyId,
      nonce: privateIdentity.nonce,
      parentDigests: [publicHandoffDigest],
      contractDigest: sha256("atlas/private-judge-envelope/1"),
    }, privatePayload, this.signingPrivateKey);
    assertSignedShape(privateJudgeEnvelope, "PrivateJudgeEnvelope");
    this.sealed = true;

    return Object.freeze({
      publicHandoff,
      publicHandoffPayload: structuredClone(handoffPayload),
      publicFiles: new Map([...publicFiles.entries()].map(([name, bytes]) => [name, Buffer.from(bytes)])),
      publicMedia: new Map([...media.entries()].map(([name, bytes]) => [name, Buffer.from(bytes)])),
      privateJudgeEnvelope,
    });
  }
}
