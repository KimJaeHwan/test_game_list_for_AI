import { stableJson } from "./normalize.ts";
import type { EvaluationReport, KnowledgeSubmission } from "./types.ts";

const codeMark = String.fromCharCode(96);

function code(value: string): string {
  return codeMark + value + codeMark;
}

function list(values: readonly string[], empty = "없음"): string {
  return values.length > 0 ? values.map((value) => "- " + value).join("\n") : "- " + empty;
}

function evidenceSuffix(ids: readonly string[]): string {
  return ids.length > 0 ? " (근거: " + ids.map(code).join(", ") + ")" : "";
}

export function exportKnowledgeMarkdown(submission: KnowledgeSubmission): string {
  const entities = submission.entities.length > 0
    ? submission.entities.map((entity) => [
      "### " + entity.name,
      "",
      "- ID/유형: " + code(entity.localId) + " / " + code(entity.type),
      "- 신뢰도: " + entity.confidence.toFixed(2),
      "- 속성: " + code(stableJson(entity.attributes)) + evidenceSuffix(entity.evidenceIds),
    ].join("\n")).join("\n\n")
    : "발견한 개체 없음";
  const claims = submission.claims.length > 0
    ? submission.claims.map((claim) =>
      "- **" + claim.subject + "** — " + claim.predicate + " → " + code(stableJson(claim.object))
      + "; 조건 " + code(stableJson(claim.conditions)) + "; 신뢰도 " + claim.confidence.toFixed(2)
      + evidenceSuffix(claim.evidenceIds),
    ).join("\n")
    : "발견한 규칙 없음";
  const procedures = submission.procedures.length > 0
    ? submission.procedures.map((procedure) => {
      const steps = [...procedure.steps].sort((a, b) => a.order - b.order).map((step) =>
        String(step.order) + ". " + step.action + (step.target ? " — " + step.target : "")
        + "; 요구 " + code(stableJson(step.requirements))
        + "; 기대 변화 " + code(stableJson(step.expectedChange))
        + evidenceSuffix(step.evidenceIds),
      ).join("\n");
      return [
        "### " + procedure.name,
        "",
        "- 목표: " + procedure.goal,
        "- 선행조건: " + code(stableJson(procedure.preconditions)),
        "- 성공조건: " + code(stableJson(procedure.successConditions)),
        "- 신뢰도: " + procedure.confidence.toFixed(2),
        "",
        steps,
        "",
        "실패: " + (procedure.failureModes.join("; ") || "없음"),
        "",
        "복구: " + (procedure.recovery.join("; ") || "없음"),
      ].join("\n");
    }).join("\n\n")
    : "작성한 절차 없음";
  const evidence = submission.evidence.length > 0
    ? submission.evidence.map((item) =>
      "- " + code(item.id) + ": " + item.observationIds.join(", ") + " — " + item.note,
    ).join("\n")
    : "- 없음";
  return [
    "# " + submission.title,
    "",
    "- 스키마: " + submission.schemaVersion,
    "- 시나리오: " + submission.scenarioId,
    "",
    "## 개체", "", entities, "",
    "## 규칙과 관계", "", claims, "",
    "## 절차", "", procedures, "",
    "## 미확인 사항", "", list(submission.unknowns), "",
    "## 충돌하는 관찰", "", list(submission.contradictions), "",
    "## 근거 색인", "", evidence, "",
  ].join("\n");
}

export function exportScoreMarkdown(report: EvaluationReport): string {
  const components = report.score.components;
  return [
    "# QUEST ATLAS 평가 결과",
    "",
    "## 총점 " + report.score.total.toFixed(2) + " / 100",
    "",
    "- 콘텐츠 그래프 정확성: " + components.factAccuracy.toFixed(2) + " / 35",
    "- 발견 가능 사실 완전성: " + components.discoverableCompleteness.toFixed(2) + " / 15",
    "- 동일 시드 재현: " + components.reproduction.toFixed(2) + " / 15",
    "- 다른 배치 전이: " + components.transfer.toFixed(2) + " / 20",
    "- 근거 및 신뢰도 보정: " + components.evidenceAndCalibration.toFixed(2) + " / 10",
    "- 위키 준비도: " + components.wikiReadiness.toFixed(2) + " / 5",
    "- 환각 페널티: -" + report.score.hallucinationPenalty.toFixed(2),
    "",
    "## 사실 감사",
    "",
    "- 정밀도: " + (report.facts.precision * 100).toFixed(1) + "%",
    "- 재현율: " + (report.facts.recall * 100).toFixed(1) + "%",
    "- 누락: " + (report.facts.missingFactIds.join(", ") || "없음"),
    "- 환각/오류: " + (report.facts.falsePositives.map((item) => item.claimId).join(", ") || "없음"),
    "- 무효 근거: " + (report.evidence.invalidEvidenceIds.join(", ") || "없음"),
    "- 과대 근거 묶음: " + (report.evidence.oversizedEvidenceIds.join(", ") || "없음"),
    "- 다른 run 근거: " + (report.evidence.crossRunEvidenceIds.join(", ") || "없음"),
    "- 거부된 재현/전이 결과: " + report.reproduction.rejectedOutcomes + " / " + report.transfer.rejectedOutcomes,
    "",
    "## 검증 메모",
    "",
    list(report.notes),
    "",
  ].join("\n");
}
