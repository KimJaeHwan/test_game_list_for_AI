import {
  coordinatorRandomId,
  createSignedEnvelope,
  sha256,
  validateSignedEnvelopeShape,
  verifySignedEnvelope,
} from "../../packages/atlas_protocol/src/index.mjs";
import { JudgeError, digestText, invariant } from "./errors.mjs";

export const ARTIFACT = Object.freeze({
  NORMALIZED_DOCUMENT: "atlas/normalized-document",
  PROBE_SET: "atlas/probe-set",
  COHORT_PLAN: "atlas/cohort-plan",
  REPLAY_AUTHORIZATION: "atlas/replay-authorization",
  INPUT_RECEIPT: "atlas/input-receipt",
  FRAME_SERVED_EVENT: "atlas/frame-served-event",
  ACTION_TRANSCRIPT: "atlas/action-transcript",
  ENGINE_OUTCOME: "atlas/engine-outcome",
  VERIFIED_REPLAY: "atlas/verified-replay",
  SCORE_REPORT: "atlas/score-report",
});

export function artifactDigest(envelope) {
  return sha256(envelope);
}

export class NonceLedger {
  #seen = new Map();

  accept(keyId, nonce, digest) {
    const key = `${keyId}\u0000${nonce}`;
    const prior = this.#seen.get(key);
    if (prior === undefined) {
      this.#seen.set(key, digest);
      return;
    }
    invariant(prior === digest, "DUPLICATE_NONCE", "nonce was reused for a different artifact");
  }
}

export class ArtifactVerifier {
  #keys = new Map();
  #nonces;

  constructor({ nonceLedger = new NonceLedger() } = {}) {
    this.#nonces = nonceLedger;
  }

  registerKey({ keyId, issuer, publicKey, artifactTypes }) {
    invariant(!this.#keys.has(keyId), "KEY_POLICY_INVALID", "keyId is already registered");
    invariant(Array.isArray(artifactTypes) && artifactTypes.length > 0, "KEY_POLICY_INVALID", "artifactTypes are required");
    this.#keys.set(keyId, Object.freeze({ issuer, publicKey, artifactTypes: new Set(artifactTypes) }));
    return this;
  }

  verify(envelope, expected = {}) {
    const shape = validateSignedEnvelopeShape(envelope);
    invariant(shape.valid, "ARTIFACT_SHAPE_INVALID", "signed envelope shape is invalid", shape.errors);
    const policy = this.#keys.get(envelope.header.keyId);
    invariant(policy, "SIGNING_KEY_UNKNOWN", "signing key is not registered");
    invariant(policy.issuer === envelope.header.issuer, "ISSUER_KEY_MISMATCH", "issuer is not authorized by key policy");
    invariant(policy.artifactTypes.has(envelope.header.artifactType), "ISSUER_TYPE_DENIED", "key cannot sign this artifact type");
    invariant(verifySignedEnvelope(envelope, policy.publicKey), "SIGNATURE_INVALID", "artifact signature is invalid");

    const fields = ["artifactType", "schemaVersion", "campaignId", "track", "arm", "targetRunId", "contractDigest"];
    for (const field of fields) {
      if (expected[field] !== undefined) {
        invariant(envelope.header[field] === expected[field], "ARTIFACT_BINDING_MISMATCH", `${field} binding mismatch`);
      }
    }
    if (expected.parentDigests !== undefined) {
      invariant(
        equalArray(envelope.header.parentDigests, expected.parentDigests),
        "PARENT_DIGEST_MISMATCH",
        "artifact parent digest binding mismatch",
      );
    }
    const digest = artifactDigest(envelope);
    this.#nonces.accept(envelope.header.keyId, envelope.header.nonce, digest);
    return Object.freeze({ envelope, digest, policy });
  }
}

export function issueArtifact({
  artifactType,
  schemaVersion,
  campaignId,
  track,
  arm,
  targetRunId,
  issuer,
  keyId,
  parentDigests = [],
  contractDigest,
  payload,
  privateKey,
  nonce = coordinatorRandomId(),
  artifactId = coordinatorRandomId(),
}) {
  invariant(parentDigests.every(digestText), "ARTIFACT_ISSUE_INVALID", "parentDigests must contain SHA-256 digests");
  invariant(digestText(contractDigest), "ARTIFACT_ISSUE_INVALID", "contractDigest must be SHA-256");
  return createSignedEnvelope({
    artifactType,
    schemaVersion,
    artifactId,
    campaignId,
    track,
    arm,
    targetRunId,
    issuer,
    keyId,
    nonce,
    parentDigests,
    contractDigest,
  }, payload, privateKey);
}

export function resignArtifact(envelope, privateKey, patch = {}) {
  const { payloadDigest: _discard, ...header } = envelope.header;
  return createSignedEnvelope({ ...header, ...patch }, envelope.payload, privateKey);
}

function equalArray(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function expectJudgeError(fn, code) {
  try {
    fn();
  } catch (error) {
    if (error instanceof JudgeError && error.code === code) return error;
    throw error;
  }
  throw new JudgeError("EXPECTED_FAILURE_MISSING", `expected ${code}`);
}
