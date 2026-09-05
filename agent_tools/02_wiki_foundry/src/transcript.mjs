import {
  signDetached,
  verifyDetached,
} from "../../packages/atlas_protocol/src/index.mjs";
import {
  assertExact, assertString, deepFreeze, digestCanonical, jsonCopy,
} from "./core.mjs";
import { validateTranscriptBase } from "./knowledge-schema.mjs";

export function unsignedTranscript(transcript) {
  const copy = jsonCopy(transcript);
  delete copy.attestation;
  return copy;
}

export function attestTranscript(transcript, privateKey) {
  validateTranscriptBase(transcript, { allowAttestation: false });
  const payload = unsignedTranscript(transcript);
  const transcriptDigest = digestCanonical(payload);
  return deepFreeze({
    ...jsonCopy(payload),
    attestation: {
      schemaVersion: "1.0",
      kind: "TranscriptVerifierAttestation",
      transcriptDigest,
      signature: signDetached(payload, privateKey),
    },
  });
}

export function verifyTranscriptAttestation(transcript, publicKey) {
  validateTranscriptBase(transcript);
  if (!transcript.attestation) return false;
  assertExact(transcript.attestation, ["schemaVersion", "kind", "transcriptDigest", "signature"], [], "transcript.attestation");
  if (transcript.attestation.schemaVersion !== "1.0") return false;
  if (transcript.attestation.kind !== "TranscriptVerifierAttestation") return false;
  assertString(transcript.attestation.transcriptDigest, "transcript.attestation.transcriptDigest", { min: 64, max: 64 });
  assertString(transcript.attestation.signature, "transcript.attestation.signature", { min: 32, max: 512 });
  const payload = unsignedTranscript(transcript);
  if (transcript.attestation.transcriptDigest !== digestCanonical(payload)) return false;
  return verifyDetached(payload, transcript.attestation.signature, publicKey);
}
