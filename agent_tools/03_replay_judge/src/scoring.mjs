import { ARTIFACT, artifactDigest, issueArtifact } from "./attestation.mjs";
import { scanCanaries } from "./document.mjs";
import { digestText, exactKeys, invariant } from "./errors.mjs";
import { ARMS, TRACKS, cohortCellKey, expectedCohortCells, validateSignedCohortPlan } from "./plans.mjs";

const VERIFIED_REPLAY_KEYS = [
  "schemaVersion", "cohortPlanDigest", "authorizationDigest", "transcriptDigest",
  "evaluationClass", "track", "arm", "targetRunId", "repetitionOrdinal",
  "outcomePayloadDigest", "completion",
];

export class CohortCollector {
  #verifier;
  #planEnvelope;
  #planDigest;
  #expected;
  #results = new Map();

  constructor({ planEnvelope, verifier }) {
    const verified = validateSignedCohortPlan(planEnvelope, verifier);
    this.#verifier = verifier;
    this.#planEnvelope = planEnvelope;
    this.#planDigest = verified.digest;
    this.#expected = new Map(expectedCohortCells(planEnvelope.payload).map((cell) => [cell.key, cell]));
  }

  add(verifiedReplay) {
    exactKeys(verifiedReplay.payload, VERIFIED_REPLAY_KEYS, "VERIFIED_REPLAY_INVALID", "verifiedReplay.payload");
    const payload = verifiedReplay.payload;
    const key = cohortCellKey(payload.track, payload.arm, payload.targetRunId, payload.repetitionOrdinal);
    invariant(this.#expected.has(key), "COHORT_CELL_UNPLANNED", "verified replay is outside the cohort plan");
    invariant(!this.#results.has(key), "COHORT_CELL_DUPLICATE", "cohort cell was submitted twice");
    invariant(Array.isArray(verifiedReplay.header.parentDigests) && verifiedReplay.header.parentDigests.length === 4, "VERIFIED_REPLAY_INVALID", "verified replay must bind authorization, transcript, and two outcomes");
    invariant(verifiedReplay.header.parentDigests[0] === payload.authorizationDigest && verifiedReplay.header.parentDigests[1] === payload.transcriptDigest, "VERIFIED_REPLAY_INVALID", "verified replay parent order mismatch");
    invariant(verifiedReplay.header.parentDigests[2] !== verifiedReplay.header.parentDigests[3], "VERIFIED_REPLAY_INVALID", "two distinct signed engine outcomes are required");
    invariant(payload.cohortPlanDigest === this.#planDigest, "VERIFIED_REPLAY_INVALID", "verified replay plan mismatch");
    invariant(payload.evaluationClass === this.#planEnvelope.payload.evaluationClass, "VERIFIED_REPLAY_INVALID", "verified replay evaluation class mismatch");
    invariant(payload.schemaVersion === "atlas/verified-replay/1", "VERIFIED_REPLAY_INVALID", "unsupported verified replay schema");
    invariant(digestText(payload.outcomePayloadDigest), "VERIFIED_REPLAY_INVALID", "outcome payload digest is invalid");
    invariant(Number.isFinite(payload.completion) && payload.completion >= 0 && payload.completion <= 1, "VERIFIED_REPLAY_INVALID", "completion must be in range");
    const verified = this.#verifier.verify(verifiedReplay, {
      artifactType: ARTIFACT.VERIFIED_REPLAY,
      campaignId: this.#planEnvelope.header.campaignId,
      track: payload.track,
      arm: payload.arm,
      targetRunId: payload.targetRunId,
      contractDigest: this.#planEnvelope.header.contractDigest,
      parentDigests: verifiedReplay.header.parentDigests,
    });
    this.#results.set(key, Object.freeze({ envelope: verifiedReplay, digest: verified.digest, payload }));
    return this;
  }

  finalize() {
    const missing = [...this.#expected.keys()].filter((key) => !this.#results.has(key));
    invariant(missing.length === 0, "COHORT_INCOMPLETE", "cohort is missing planned target × arm × repetition cells", { missingCount: missing.length });
    const results = [...this.#expected.keys()].map((key) => this.#results.get(key));
    return Object.freeze({
      campaignId: this.#planEnvelope.header.campaignId,
      evaluationClass: this.#planEnvelope.payload.evaluationClass,
      planDigest: this.#planDigest,
      planEnvelope: this.#planEnvelope,
      results: Object.freeze(results),
    });
  }
}

export function buildAggregateReport({ completedCohorts, campaignId, signer, verifier, canaries = [], leakageInputs = [] }) {
  invariant(Array.isArray(completedCohorts) && completedCohorts.length > 0, "REPORT_INVALID", "completed cohorts are required");
  const leakageHits = scanCanaries(leakageInputs, canaries);
  if (leakageHits.length > 0) {
    return Object.freeze({ status: "LEAKAGE_QUARANTINED", scoreReport: null, hitCount: leakageHits.length });
  }

  const groups = new Map();
  const parentDigests = [];
  for (const supplied of completedCohorts) {
    invariant(supplied?.planEnvelope && Array.isArray(supplied.results) && supplied.results.length > 0, "REPORT_INVALID", "cohort must include its signed plan and verified results");
    invariant(supplied.campaignId === campaignId, "REPORT_INVALID", "cross-campaign cohort cannot enter report");
    const revalidator = new CohortCollector({ planEnvelope: supplied.planEnvelope, verifier });
    for (const result of supplied.results) revalidator.add(result.envelope);
    const cohort = revalidator.finalize();
    invariant(cohort.planDigest === supplied.planDigest, "REPORT_INVALID", "cohort plan digest mismatch");
    parentDigests.push(cohort.planDigest, ...cohort.results.map((result) => result.digest));
    const byClass = groups.get(cohort.evaluationClass) ?? [];
    byClass.push(...cohort.results.map((result) => result.payload));
    groups.set(cohort.evaluationClass, byClass);
  }

  const classes = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([evaluationClass, results]) => ({
      evaluationClass,
      tracks: TRACKS.map((track) => aggregateTrack(track, results.filter((result) => result.track === track))),
    }));
  const payload = Object.freeze({
    schemaVersion: "atlas/score-report/1",
    status: "VALID",
    classes,
  });
  const postHits = scanCanaries(payload, canaries);
  if (postHits.length > 0) return Object.freeze({ status: "LEAKAGE_QUARANTINED", scoreReport: null, hitCount: postHits.length });

  const uniqueParents = [...new Set(parentDigests)];
  const scoreReport = issueArtifact({
    artifactType: ARTIFACT.SCORE_REPORT,
    schemaVersion: "atlas/score-report/1",
    campaignId,
    track: "AGGREGATE",
    arm: "AGGREGATE",
    targetRunId: "MULTI",
    issuer: signer.issuer,
    keyId: signer.keyId,
    parentDigests: uniqueParents,
    contractDigest: signer.contractDigest,
    payload,
    privateKey: signer.privateKey,
  });
  verifier.verify(scoreReport, {
    artifactType: ARTIFACT.SCORE_REPORT,
    campaignId,
    track: "AGGREGATE",
    arm: "AGGREGATE",
    targetRunId: "MULTI",
    contractDigest: signer.contractDigest,
    parentDigests: uniqueParents,
  });
  return Object.freeze({ status: "VALID", scoreReport, hitCount: 0 });
}

function aggregateTrack(track, results) {
  const arms = ARMS.map((arm) => {
    const values = results.filter((result) => result.arm === arm).map((result) => result.completion);
    invariant(values.length > 0, "REPORT_INVALID", `${track}/${arm} has no results`);
    return {
      arm,
      samples: values.length,
      meanCompletion: average(values),
    };
  });
  const lookup = Object.fromEntries(arms.map((entry) => [entry.arm, entry.meanCompletion]));
  const denominator = lookup.ORACLE - lookup.BASELINE;
  const utility = denominator <= 0 ? null : clip((lookup.CANDIDATE - lookup.BASELINE) / denominator, 0, 1);
  return { track, arms, utility };
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clip(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
