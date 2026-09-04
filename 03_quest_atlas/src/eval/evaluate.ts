import { scoreEvidence } from "./evidence.ts";
import { scoreDiscoverableRecall, scoreFacts } from "./facts.ts";
import { validateKnowledgeSubmission } from "./schema.ts";
import type { EvaluationInput, EvaluationReport, KnowledgeSubmission } from "./types.ts";
import { scoreRunSet } from "../replay/score-runs.ts";

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function scoreWikiReadiness(submission: KnowledgeSubmission, valid: boolean): number {
  let readiness = valid ? 0.4 : 0;
  if (submission.entities.length > 0) readiness += 0.1;
  if (submission.claims.length > 0) readiness += 0.15;
  if (submission.procedures.length > 0 && submission.procedures.every((procedure) => procedure.steps.length > 0)) readiness += 0.2;
  if (submission.evidence.length > 0) readiness += 0.1;
  if (Array.isArray(submission.unknowns) && Array.isArray(submission.contradictions)) readiness += 0.05;
  return clamp(readiness, 0, 1);
}

export function evaluateSubmission(input: EvaluationInput): EvaluationReport {
  const falsePositiveMultiplier = input.options?.falsePositiveMultiplier ?? 1.5;
  const maximumPenalty = input.options?.maximumHallucinationPenalty ?? 25;
  const maximumSpan = input.options?.maximumEvidenceSpanTicks ?? 300;
  const maximumObservations = input.options?.maximumObservationsPerCitation ?? 3;
  const validation = validateKnowledgeSubmission(input.submission);
  const factResult = scoreFacts(input.truth, input.submission.claims, falsePositiveMultiplier);
  const matchedFactIds = new Set(factResult.score.matches.map((match) => match.factId));
  const discoverableRecall = scoreDiscoverableRecall(input.truth, matchedFactIds, input.options?.discoverableFactIds);
  const evidence = scoreEvidence(
    input.submission,
    input.observations,
    factResult.matchedClaims,
    input.runId,
    maximumSpan,
    maximumObservations,
  );
  const procedureIds = new Set(input.submission.procedures.map((procedure) => procedure.id));
  const reproduction = scoreRunSet(input.reproduction, 0.7, "reproduction", procedureIds);
  const transfer = scoreRunSet(input.transfer, 0.8, "transfer", procedureIds);
  const wikiReadiness = scoreWikiReadiness(input.submission, validation.valid);
  const components = {
    factAccuracy: 35 * factResult.score.f1,
    discoverableCompleteness: 15 * discoverableRecall,
    reproduction: 15 * reproduction.composite,
    transfer: 20 * transfer.composite,
    evidenceAndCalibration: 10 * evidence.composite,
    wikiReadiness: 5 * wikiReadiness,
  };
  const beforePenalty = Object.values(components).reduce((sum, value) => sum + value, 0);
  const risk = factResult.score.falsePositives.reduce((sum, item) => {
    const highConfidenceFactor = item.confidence >= 0.8 ? 1.5 : 1;
    return sum + item.weight * falsePositiveMultiplier * highConfidenceFactor;
  }, 0);
  const denominator = Math.max(1, factResult.score.totalTruthWeight);
  const hallucinationPenalty = clamp(maximumPenalty * risk / denominator, 0, maximumPenalty);
  const notes: string[] = [];
  if (input.reproduction.length === 0) notes.push("동일 시드 재현 결과가 제출되지 않았습니다.");
  if (input.transfer.length === 0) notes.push("다른 배치 전이 결과가 제출되지 않았습니다.");
  if (factResult.score.conditionMismatches.length > 0) notes.push("같은 관계를 찾았지만 조건이 틀린 주장이 있습니다.");
  if (evidence.invalidEvidenceIds.length > 0) notes.push("주장을 뒷받침하지 못하는 근거 인용이 있습니다.");
  if (evidence.oversizedEvidenceIds.length > 0) notes.push("한 근거 묶음에 허용 수보다 많은 관찰을 넣었습니다.");
  if (evidence.crossRunEvidenceIds.length > 0) notes.push("현재 탐색 run에 속하지 않는 관찰 근거가 있습니다.");
  if (reproduction.rejectedOutcomes > 0 || transfer.rejectedOutcomes > 0) notes.push("엔진이 검증하지 않은 실행 결과는 점수에서 제외되었습니다.");
  if (!validation.valid) notes.push("knowledge.json 스키마 검증에 실패했습니다.");
  return {
    schemaVersion: "1.0",
    score: {
      total: clamp(beforePenalty - hallucinationPenalty, 0, 100),
      beforePenalty,
      hallucinationPenalty,
      components,
    },
    facts: factResult.score,
    evidence,
    reproduction,
    transfer,
    validationErrors: validation.errors,
    notes,
  };
}
