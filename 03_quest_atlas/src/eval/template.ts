import type { KnowledgeSubmission } from "./types.ts";

export function createSubmissionTemplate(scenarioId = "scenario-unknown"): KnowledgeSubmission {
  return {
    schemaVersion: "1.0",
    title: "QUEST ATLAS 조사 보고서",
    scenarioId,
    entities: [{
      localId: "entity-example",
      type: "npc",
      name: "관찰한 이름",
      attributes: {},
      confidence: 0.5,
      evidenceIds: ["evidence-example"],
    }],
    claims: [{
      id: "claim-example",
      subject: "관찰한 대상",
      predicate: "관계 또는 규칙",
      object: "관찰한 값",
      conditions: [],
      confidence: 0.5,
      evidenceIds: ["evidence-example"],
    }],
    procedures: [{
      id: "procedure-example",
      name: "목표 달성 절차",
      goal: "달성할 게임 상태",
      preconditions: [],
      steps: [{
        order: 1,
        action: "상호작용",
        target: "대상",
        requirements: [],
        expectedChange: [],
        evidenceIds: ["evidence-example"],
      }],
      successConditions: [],
      alternatives: [],
      failureModes: [],
      recovery: [],
      confidence: 0.5,
      evidenceIds: ["evidence-example"],
    }],
    evidence: [{
      id: "evidence-example",
      observationIds: ["observation-id-from-evaluator"],
      note: "이 관찰이 주장을 뒷받침하는 이유",
    }],
    unknowns: ["확인하지 못한 내용은 추측 대신 여기에 기록"],
    contradictions: [],
  };
}
