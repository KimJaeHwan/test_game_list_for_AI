import { sha256 } from "../../packages/atlas_protocol/src/index.mjs";
import { ARTIFACT, artifactDigest, issueArtifact } from "./attestation.mjs";
import { digestText, exactKeys, invariant, nonEmptyText } from "./errors.mjs";

export const ARMS = Object.freeze(["BASELINE", "CANDIDATE", "ORACLE"]);
export const TRACKS = Object.freeze(["REPRODUCTION", "TRANSFER"]);
export const EVALUATION_CLASSES = Object.freeze(["STRICT", "ASSISTED"]);

const PLAN_KEYS = [
  "schemaVersion", "evaluationClass", "sourceRunId", "arms", "documents", "targets",
  "probeSetCapability", "probeSetDigest", "gameBuildHandle", "agentProfileDigest",
  "promptDigest", "budgetProfileDigest", "capturePolicyDigest", "framePolicy",
  "overlayPolicyDigest", "overlayCompositorVersion", "randomizedOrderCommitment",
];

export function createSignedCohortPlan({ campaignId, plan, signer }) {
  validateCohortPlanPayload(plan);
  return issueArtifact({
    artifactType: ARTIFACT.COHORT_PLAN,
    schemaVersion: "atlas/cohort-plan/1",
    campaignId,
    track: "PLAN",
    arm: "PLAN",
    targetRunId: "MULTI",
    issuer: signer.issuer,
    keyId: signer.keyId,
    parentDigests: [],
    contractDigest: signer.contractDigest,
    payload: plan,
    privateKey: signer.privateKey,
    nonce: signer.nonce,
  });
}

export function validateSignedCohortPlan(planEnvelope, verifier) {
  const verified = verifier.verify(planEnvelope, {
    artifactType: ARTIFACT.COHORT_PLAN,
    track: "PLAN",
    arm: "PLAN",
    targetRunId: "MULTI",
    parentDigests: [],
  });
  validateCohortPlanPayload(planEnvelope.payload);
  return verified;
}

export function validateCohortPlanPayload(plan) {
  exactKeys(plan, PLAN_KEYS, "COHORT_PLAN_INVALID", "plan");
  invariant(plan.schemaVersion === "atlas/cohort-plan/1", "COHORT_PLAN_INVALID", "unsupported cohort plan schema");
  invariant(EVALUATION_CLASSES.includes(plan.evaluationClass), "COHORT_PLAN_INVALID", "invalid evaluationClass");
  nonEmptyText(plan.sourceRunId, "COHORT_PLAN_INVALID", "plan.sourceRunId");
  invariant(equalArray(plan.arms, ARMS), "COHORT_PLAN_INVALID", "arms must be the fixed baseline/candidate/oracle set");
  exactKeys(plan.documents, ARMS, "COHORT_PLAN_INVALID", "plan.documents");
  invariant(plan.documents.BASELINE === null, "COHORT_PLAN_INVALID", "baseline document must be null");
  invariant(digestText(plan.documents.CANDIDATE), "COHORT_PLAN_INVALID", "candidate document digest is invalid");
  invariant(digestText(plan.documents.ORACLE), "COHORT_PLAN_INVALID", "oracle document digest is invalid");
  invariant(Array.isArray(plan.targets) && plan.targets.length > 0, "COHORT_PLAN_INVALID", "targets are required");

  const targetIds = new Set();
  const tracks = new Set();
  for (const [index, target] of plan.targets.entries()) {
    exactKeys(target, ["targetRunId", "track", "targetConfigCapability", "repetitions"], "COHORT_PLAN_INVALID", `plan.targets[${index}]`);
    nonEmptyText(target.targetRunId, "COHORT_PLAN_INVALID", `plan.targets[${index}].targetRunId`);
    invariant(!targetIds.has(target.targetRunId), "COHORT_PLAN_INVALID", "targetRunId must be unique");
    targetIds.add(target.targetRunId);
    invariant(TRACKS.includes(target.track), "COHORT_PLAN_INVALID", "invalid target track");
    tracks.add(target.track);
    nonEmptyText(target.targetConfigCapability, "COHORT_PLAN_INVALID", "targetConfigCapability");
    invariant(Number.isInteger(target.repetitions) && target.repetitions > 0 && target.repetitions <= 20, "COHORT_PLAN_INVALID", "invalid repetition count");
  }
  invariant(TRACKS.every((track) => tracks.has(track)), "COHORT_PLAN_INVALID", "plan must contain reproduction and transfer targets");
  nonEmptyText(plan.probeSetCapability, "COHORT_PLAN_INVALID", "plan.probeSetCapability");
  invariant(digestText(plan.probeSetDigest), "COHORT_PLAN_INVALID", "probeSetDigest is invalid");
  nonEmptyText(plan.gameBuildHandle, "COHORT_PLAN_INVALID", "plan.gameBuildHandle");
  for (const field of ["agentProfileDigest", "promptDigest", "budgetProfileDigest", "capturePolicyDigest", "overlayPolicyDigest", "randomizedOrderCommitment"]) {
    invariant(digestText(plan[field]), "COHORT_PLAN_INVALID", `${field} must be a SHA-256 digest`);
  }
  invariant(["KEYBOARD", "OBJECT_OVERLAY"].includes(plan.framePolicy), "COHORT_PLAN_INVALID", "framePolicy is invalid");
  nonEmptyText(plan.overlayCompositorVersion, "COHORT_PLAN_INVALID", "plan.overlayCompositorVersion");
  return true;
}

export class ReplayAuthorizationIssuer {
  #plan;
  #planDigest;
  #campaignId;
  #signer;
  #issuedCells = new Set();

  constructor({ planEnvelope, verifier, signer }) {
    const verified = validateSignedCohortPlan(planEnvelope, verifier);
    this.#plan = planEnvelope.payload;
    this.#planDigest = verified.digest;
    this.#campaignId = planEnvelope.header.campaignId;
    this.#signer = signer;
  }

  issue({ track, arm, targetRunId, repetitionOrdinal }) {
    const target = this.#plan.targets.find((entry) => entry.targetRunId === targetRunId);
    invariant(target && target.track === track, "AUTHORIZATION_OUTSIDE_PLAN", "target run or track is not in cohort plan");
    invariant(ARMS.includes(arm), "AUTHORIZATION_OUTSIDE_PLAN", "arm is not in cohort plan");
    invariant(Number.isInteger(repetitionOrdinal) && repetitionOrdinal >= 1 && repetitionOrdinal <= target.repetitions, "AUTHORIZATION_OUTSIDE_PLAN", "repetition is not in cohort plan");
    const cell = cohortCellKey(track, arm, targetRunId, repetitionOrdinal);
    invariant(!this.#issuedCells.has(cell), "AUTHORIZATION_ALREADY_ISSUED", "cohort cell already has an authorization");
    this.#issuedCells.add(cell);

    const documentDigest = this.#plan.documents[arm];
    const payload = Object.freeze({
      schemaVersion: "atlas/replay-authorization/1",
      cohortPlanDigest: this.#planDigest,
      evaluationClass: this.#plan.evaluationClass,
      sourceRunId: this.#plan.sourceRunId,
      track,
      arm,
      targetRunId,
      targetConfigCapability: target.targetConfigCapability,
      gameBuildHandle: this.#plan.gameBuildHandle,
      probeSetCapability: this.#plan.probeSetCapability,
      probeSetDigest: this.#plan.probeSetDigest,
      documentDigest,
      agentProfileDigest: this.#plan.agentProfileDigest,
      promptDigest: this.#plan.promptDigest,
      budgetProfileDigest: this.#plan.budgetProfileDigest,
      capturePolicyDigest: this.#plan.capturePolicyDigest,
      framePolicy: this.#plan.framePolicy,
      overlayPolicyDigest: this.#plan.overlayPolicyDigest,
      overlayCompositorVersion: this.#plan.overlayCompositorVersion,
      repetitionOrdinal,
    });
    return issueArtifact({
      artifactType: ARTIFACT.REPLAY_AUTHORIZATION,
      schemaVersion: "atlas/replay-authorization/1",
      campaignId: this.#campaignId,
      track,
      arm,
      targetRunId,
      issuer: this.#signer.issuer,
      keyId: this.#signer.keyId,
      parentDigests: documentDigest === null ? [this.#planDigest] : [this.#planDigest, documentDigest],
      contractDigest: this.#signer.contractDigest,
      payload,
      privateKey: this.#signer.privateKey,
    });
  }
}

const AUTH_KEYS = [
  "schemaVersion", "cohortPlanDigest", "evaluationClass", "sourceRunId", "track", "arm",
  "targetRunId", "targetConfigCapability", "gameBuildHandle", "probeSetCapability",
  "probeSetDigest", "documentDigest", "agentProfileDigest", "promptDigest",
  "budgetProfileDigest", "capturePolicyDigest", "framePolicy", "overlayPolicyDigest",
  "overlayCompositorVersion", "repetitionOrdinal",
];

export function validateReplayAuthorization({ authorization, planEnvelope, verifier }) {
  const planVerified = validateSignedCohortPlan(planEnvelope, verifier);
  exactKeys(authorization.payload, AUTH_KEYS, "AUTHORIZATION_INVALID", "authorization.payload");
  const auth = authorization.payload;
  const target = planEnvelope.payload.targets.find((entry) => entry.targetRunId === auth.targetRunId);
  invariant(target, "AUTHORIZATION_OUTSIDE_PLAN", "authorization target is not planned");
  invariant(target.track === auth.track, "AUTHORIZATION_OUTSIDE_PLAN", "authorization track is not planned");
  invariant(ARMS.includes(auth.arm), "AUTHORIZATION_OUTSIDE_PLAN", "authorization arm is not planned");
  invariant(Number.isInteger(auth.repetitionOrdinal) && auth.repetitionOrdinal >= 1 && auth.repetitionOrdinal <= target.repetitions, "AUTHORIZATION_OUTSIDE_PLAN", "authorization repetition is not planned");

  const expectedDocument = planEnvelope.payload.documents[auth.arm];
  const expectedParents = expectedDocument === null ? [planVerified.digest] : [planVerified.digest, expectedDocument];
  const verified = verifier.verify(authorization, {
    artifactType: ARTIFACT.REPLAY_AUTHORIZATION,
    campaignId: planEnvelope.header.campaignId,
    track: auth.track,
    arm: auth.arm,
    targetRunId: auth.targetRunId,
    contractDigest: planEnvelope.header.contractDigest,
    parentDigests: expectedParents,
  });

  invariant(auth.schemaVersion === "atlas/replay-authorization/1", "AUTHORIZATION_INVALID", "unsupported authorization schema");
  invariant(auth.cohortPlanDigest === planVerified.digest, "AUTHORIZATION_PLAN_MISMATCH", "authorization plan digest mismatch");
  invariant(auth.evaluationClass === planEnvelope.payload.evaluationClass, "AUTHORIZATION_PLAN_MISMATCH", "evaluation class mismatch");
  invariant(auth.sourceRunId === planEnvelope.payload.sourceRunId, "AUTHORIZATION_PLAN_MISMATCH", "source run mismatch");
  invariant(auth.targetConfigCapability === target.targetConfigCapability, "AUTHORIZATION_PLAN_MISMATCH", "target config mismatch");
  invariant(auth.gameBuildHandle === planEnvelope.payload.gameBuildHandle, "AUTHORIZATION_PLAN_MISMATCH", "game build mismatch");
  invariant(auth.probeSetCapability === planEnvelope.payload.probeSetCapability, "AUTHORIZATION_PLAN_MISMATCH", "probe capability mismatch");
  invariant(auth.probeSetDigest === planEnvelope.payload.probeSetDigest, "AUTHORIZATION_PLAN_MISMATCH", "probe digest mismatch");
  invariant(auth.documentDigest === expectedDocument, "AUTHORIZATION_DOCUMENT_MISMATCH", "document digest mismatch");
  for (const field of ["agentProfileDigest", "promptDigest", "budgetProfileDigest", "capturePolicyDigest", "framePolicy", "overlayPolicyDigest", "overlayCompositorVersion"]) {
    invariant(auth[field] === planEnvelope.payload[field], "AUTHORIZATION_PLAN_MISMATCH", `${field} mismatch`);
  }
  return verified;
}

export function cohortCellKey(track, arm, targetRunId, repetitionOrdinal) {
  return `${track}\u0000${arm}\u0000${targetRunId}\u0000${repetitionOrdinal}`;
}

export function expectedCohortCells(plan) {
  validateCohortPlanPayload(plan);
  const cells = [];
  for (const target of plan.targets) {
    for (const arm of ARMS) {
      for (let repetitionOrdinal = 1; repetitionOrdinal <= target.repetitions; repetitionOrdinal += 1) {
        cells.push({
          key: cohortCellKey(target.track, arm, target.targetRunId, repetitionOrdinal),
          track: target.track,
          arm,
          targetRunId: target.targetRunId,
          repetitionOrdinal,
        });
      }
    }
  }
  return cells;
}

export function documentDigest(document) {
  return sha256(document);
}

function equalArray(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((item, index) => item === right[index]);
}
