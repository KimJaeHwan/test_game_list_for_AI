import { factBaseKey, factKey } from "./normalize.ts";
import type { CanonicalFact, FactScore, FalsePositive, KnowledgeClaim } from "./types.ts";

export interface FactScoringResult {
  readonly score: FactScore;
  readonly matchedClaims: ReadonlyMap<string, CanonicalFact>;
}

export function scoreFacts(
  truth: readonly CanonicalFact[],
  claims: readonly KnowledgeClaim[],
  falsePositiveMultiplier = 1.5,
): FactScoringResult {
  const exact = new Map<string, CanonicalFact>();
  const byBase = new Map<string, CanonicalFact[]>();
  for (const fact of truth) {
    exact.set(factKey(fact), fact);
    const base = factBaseKey(fact);
    byBase.set(base, [...(byBase.get(base) ?? []), fact]);
  }

  const matchedFactIds = new Set<string>();
  const matchedClaims = new Map<string, CanonicalFact>();
  const matches: { factId: string; claimId: string; weight: number }[] = [];
  const falsePositives: FalsePositive[] = [];
  const duplicateClaimIds: string[] = [];
  const conditionMismatches: { claimId: string; factId: string }[] = [];

  for (const claim of claims) {
    const found = exact.get(factKey(claim));
    if (found) {
      if (matchedFactIds.has(found.id)) {
        duplicateClaimIds.push(claim.id);
      } else {
        matchedFactIds.add(found.id);
        matchedClaims.set(claim.id, found);
        matches.push({ factId: found.id, claimId: claim.id, weight: found.weight });
      }
      continue;
    }
    const near = byBase.get(factBaseKey(claim))?.[0];
    const falsePositive: FalsePositive = {
      claimId: claim.id,
      weight: near?.weight ?? 1,
      confidence: claim.confidence,
      reason: near ? "condition-mismatch" : "unsupported",
      ...(near ? { nearFactId: near.id } : {}),
    };
    falsePositives.push(falsePositive);
    if (near) conditionMismatches.push({ claimId: claim.id, factId: near.id });
  }

  const truePositiveWeight = matches.reduce((sum, match) => sum + match.weight, 0);
  const falsePositiveWeight = falsePositives.reduce((sum, item) => sum + item.weight, 0);
  const totalTruthWeight = truth.reduce((sum, fact) => sum + fact.weight, 0);
  const precisionDenominator = truePositiveWeight + falsePositiveMultiplier * falsePositiveWeight;
  const precision = precisionDenominator > 0 ? truePositiveWeight / precisionDenominator : 0;
  const recall = totalTruthWeight > 0 ? truePositiveWeight / totalTruthWeight : 1;
  const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;

  return {
    score: {
      precision,
      recall,
      f1,
      truePositiveWeight,
      falsePositiveWeight,
      totalTruthWeight,
      matches,
      falsePositives,
      missingFactIds: truth.filter((fact) => !matchedFactIds.has(fact.id)).map((fact) => fact.id),
      duplicateClaimIds,
      conditionMismatches,
    },
    matchedClaims,
  };
}

export function scoreDiscoverableRecall(
  truth: readonly CanonicalFact[],
  matchedFactIds: ReadonlySet<string>,
  discoverableFactIds?: readonly string[],
): number {
  const allowed = discoverableFactIds ? new Set(discoverableFactIds) : undefined;
  const discoverable = allowed ? truth.filter((fact) => allowed.has(fact.id)) : [...truth];
  const totalWeight = discoverable.reduce((sum, fact) => sum + fact.weight, 0);
  if (totalWeight === 0) return 1;
  return discoverable.filter((fact) => matchedFactIds.has(fact.id)).reduce((sum, fact) => sum + fact.weight, 0) / totalWeight;
}
