import {
  createSignedEnvelope,
  sha256,
  validateSignedEnvelopeShape,
} from "../../packages/atlas_protocol/src/index.mjs";
import { RunnerError } from "./errors.mjs";
import { validateExplorationTrack } from "./exploration-track.mjs";

export class SignedReceiptChain {
  constructor({
    privateKey,
    keyId,
    identityPool,
    issuer = "atlas-player-runner",
    contractVersion = "runner-private/v1",
    explorationTrack = "EXPLORATION",
  }) {
    if (!privateKey || !keyId || !identityPool) throw new TypeError("privateKey, keyId, and Coordinator identityPool are required.");
    this.privateKey = privateKey;
    this.keyId = keyId;
    this.identityPool = identityPool;
    this.issuer = issuer;
    this.explorationTrack = validateExplorationTrack(explorationTrack);
    this.contractDigest = sha256(contractVersion);
    this.envelopes = [];
  }

  append(artifactType, payload) {
    const previous = this.envelopes.at(-1);
    const identity = this.identityPool.takeEnvelopeIdentity(`receipt-${this.envelopes.length + 1}-${artifactType}`);
    const envelope = createSignedEnvelope({
      artifactType,
      schemaVersion: "atlas/runner-private-event/1",
      artifactId: identity.artifactId,
      campaignId: this.identityPool.campaignId,
      track: this.explorationTrack,
      arm: "NONE",
      targetRunId: this.identityPool.targetRunId,
      issuer: this.issuer,
      keyId: this.keyId,
      nonce: identity.nonce,
      parentDigests: previous ? [sha256(previous)] : [],
      contractDigest: this.contractDigest,
    }, payload, this.privateKey);
    const validation = validateSignedEnvelopeShape(envelope);
    if (!validation.valid) {
      throw new RunnerError("SIGNED_ENVELOPE_INVALID", "Private receipt does not match the common signed-envelope contract.", {
        details: validation.errors,
      });
    }
    this.envelopes.push(envelope);
    return envelope;
  }

  snapshot() {
    return this.envelopes.map((envelope) => structuredClone(envelope));
  }

  get rootDigest() {
    return this.envelopes.length ? sha256(this.envelopes.at(-1)) : sha256("EMPTY_PRIVATE_TRANSCRIPT");
  }
}
