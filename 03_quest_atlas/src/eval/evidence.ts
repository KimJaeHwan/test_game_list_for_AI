import type { CanonicalFact, EvidenceScore, KnowledgeSubmission, ObservedEvidence } from "./types.ts";

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function scoreEvidence(
  submission: KnowledgeSubmission,
  observations: readonly ObservedEvidence[],
  matchedClaims: ReadonlyMap<string, CanonicalFact>,
  expectedRunId: string,
  maximumSpanTicks = 300,
  maximumObservationsPerCitation = 3,
): EvidenceScore {
  const observationsById = new Map<string, ObservedEvidence[]>();
  for (const observation of observations) {
    observationsById.set(observation.id, [...(observationsById.get(observation.id) ?? []), observation]);
  }
  const citationById = new Map(submission.evidence.map((citation) => [citation.id, citation]));
  const overlyBroad = new Set(
    observations
      .filter((observation) => observation.endTick - observation.startTick > maximumSpanTicks)
      .map((observation) => observation.id),
  );
  let validLinks = 0;
  let totalLinks = 0;
  let validEvidenceWeight = 0;
  let matchedWeight = 0;
  let brierSum = 0;
  const claimsWithValidEvidence: string[] = [];
  const invalidEvidenceIds = new Set<string>();
  const oversizedEvidenceIds = new Set<string>();
  const crossRunEvidenceIds = new Set<string>();

  for (const claim of submission.claims) {
    const fact = matchedClaims.get(claim.id);
    const label = fact ? 1 : 0;
    brierSum += (claim.confidence - label) ** 2;
    if (fact) matchedWeight += fact.weight;
    let claimHasValidEvidence = false;
    for (const evidenceId of claim.evidenceIds) {
      totalLinks += 1;
      const citation = citationById.get(evidenceId);
      if (citation && citation.observationIds.length > maximumObservationsPerCitation) oversizedEvidenceIds.add(evidenceId);
      const resolved = citation?.observationIds.map((observationId) => observationsById.get(observationId) ?? []) ?? [];
      const crossesRun = resolved.some((candidates) =>
        candidates.length !== 1 || candidates[0]?.runId !== expectedRunId
      );
      if (crossesRun) crossRunEvidenceIds.add(evidenceId);
      const valid = Boolean(
        fact
        && citation
        && citation.observationIds.length > 0
        && citation.observationIds.length <= maximumObservationsPerCitation
        && !crossesRun
        && resolved.every((candidates) => {
          const observation = candidates[0];
          if (!observation || overlyBroad.has(observation.id)) return false;
          return observation.cueIds.some((cueId) => fact.evidenceCueIds.includes(cueId));
        }),
      );
      if (valid) {
        validLinks += 1;
        claimHasValidEvidence = true;
      } else {
        invalidEvidenceIds.add(evidenceId);
      }
    }
    if (fact && claimHasValidEvidence) {
      validEvidenceWeight += fact.weight;
      claimsWithValidEvidence.push(claim.id);
    }
  }

  const precision = totalLinks > 0 ? validLinks / totalLinks : 0;
  const coverage = matchedWeight > 0 ? validEvidenceWeight / matchedWeight : 0;
  const calibration = submission.claims.length > 0 ? 1 - brierSum / submission.claims.length : 0;
  return {
    precision,
    coverage,
    calibration,
    composite: clamp01(0.4 * precision + 0.3 * coverage + 0.3 * calibration),
    validLinks,
    totalLinks,
    claimsWithValidEvidence,
    invalidEvidenceIds: [...invalidEvidenceIds].sort(),
    overlyBroadObservationIds: [...overlyBroad].sort(),
    oversizedEvidenceIds: [...oversizedEvidenceIds].sort(),
    crossRunEvidenceIds: [...crossRunEvidenceIds].sort(),
  };
}
