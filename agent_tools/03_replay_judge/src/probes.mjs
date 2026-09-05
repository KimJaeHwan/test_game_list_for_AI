import { ARTIFACT, artifactDigest, issueArtifact } from "./attestation.mjs";
import { exactKeys, invariant, nonEmptyText } from "./errors.mjs";

const PROBE_KEYS = ["schemaVersion", "goals", "denominator"];

export function createSignedProbeSet({ campaignId, goals, signer }) {
  const payload = {
    schemaVersion: "atlas/probe-set/1",
    goals: goals.map(({ id, weight }) => ({ id, weight })),
    denominator: goals.reduce((sum, goal) => sum + goal.weight, 0),
  };
  validateProbeSetPayload(payload);
  return issueArtifact({
    artifactType: ARTIFACT.PROBE_SET,
    schemaVersion: "atlas/probe-set/1",
    campaignId,
    track: "PLAN",
    arm: "PLAN",
    targetRunId: "MULTI",
    issuer: signer.issuer,
    keyId: signer.keyId,
    parentDigests: [],
    contractDigest: signer.contractDigest,
    payload,
    privateKey: signer.privateKey,
  });
}

export function validateSignedProbeSet(envelope, verifier, campaignId = envelope?.header?.campaignId) {
  const verified = verifier.verify(envelope, {
    artifactType: ARTIFACT.PROBE_SET,
    campaignId,
    track: "PLAN",
    arm: "PLAN",
    targetRunId: "MULTI",
    parentDigests: [],
  });
  validateProbeSetPayload(envelope.payload);
  return verified;
}

export function validateProbeSetPayload(payload) {
  exactKeys(payload, PROBE_KEYS, "PROBE_SET_INVALID", "probeSet");
  invariant(payload.schemaVersion === "atlas/probe-set/1", "PROBE_SET_INVALID", "unsupported probe set schema");
  invariant(Array.isArray(payload.goals) && payload.goals.length > 0, "PROBE_SET_INVALID", "at least one probe is required");
  const ids = new Set();
  let denominator = 0;
  for (const [index, goal] of payload.goals.entries()) {
    exactKeys(goal, ["id", "weight"], "PROBE_SET_INVALID", `probeSet.goals[${index}]`);
    nonEmptyText(goal.id, "PROBE_SET_INVALID", `probeSet.goals[${index}].id`, 64);
    invariant(!ids.has(goal.id), "PROBE_SET_INVALID", "probe IDs must be unique");
    ids.add(goal.id);
    invariant(Number.isFinite(goal.weight) && goal.weight > 0, "PROBE_SET_INVALID", "probe weight must be positive");
    denominator += goal.weight;
  }
  invariant(payload.denominator === denominator, "PROBE_SET_INVALID", "probe denominator mismatch");
  return true;
}

export function makeProbeRecord({ envelope, evaluators, verifier }) {
  const verified = validateSignedProbeSet(envelope, verifier);
  invariant(evaluators && typeof evaluators === "object" && !Array.isArray(evaluators), "PROBE_EVALUATOR_INVALID", "probe evaluators are required");
  const expected = envelope.payload.goals.map((goal) => goal.id).sort();
  const actual = Object.keys(evaluators).sort();
  invariant(equalArray(actual, expected), "PROBE_EVALUATOR_INVALID", "evaluator IDs must exactly match fixed ProbeSet");
  for (const evaluator of Object.values(evaluators)) invariant(typeof evaluator === "function", "PROBE_EVALUATOR_INVALID", "probe evaluator must be a function");
  return Object.freeze({ envelope, digest: verified.digest, evaluators: Object.freeze({ ...evaluators }) });
}

export function evaluateProbeRecord(record, state) {
  return record.envelope.payload.goals.map((goal) => ({
    id: goal.id,
    passed: Boolean(record.evaluators[goal.id](state)),
  }));
}

export function validateProbeResults(probeSetEnvelope, results) {
  validateProbeSetPayload(probeSetEnvelope.payload);
  invariant(Array.isArray(results), "PROBE_RESULT_SET_MISMATCH", "probe results must be an array");
  const resultMap = new Map();
  for (const result of results) {
    exactKeys(result, ["id", "passed"], "PROBE_RESULT_SET_MISMATCH", "probeResult");
    invariant(typeof result.passed === "boolean", "PROBE_RESULT_SET_MISMATCH", "probe passed must be boolean");
    invariant(!resultMap.has(result.id), "PROBE_RESULT_SET_MISMATCH", "duplicate probe result");
    resultMap.set(result.id, result.passed);
  }
  const expectedIds = probeSetEnvelope.payload.goals.map((goal) => goal.id);
  invariant(resultMap.size === expectedIds.length && expectedIds.every((id) => resultMap.has(id)), "PROBE_RESULT_SET_MISMATCH", "probe results do not exactly match fixed ProbeSet");

  let earned = 0;
  for (const goal of probeSetEnvelope.payload.goals) if (resultMap.get(goal.id)) earned += goal.weight;
  return Object.freeze({
    earned,
    denominator: probeSetEnvelope.payload.denominator,
    completion: earned / probeSetEnvelope.payload.denominator,
  });
}

export function probeSetDigest(envelope) {
  return artifactDigest(envelope);
}

function equalArray(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
