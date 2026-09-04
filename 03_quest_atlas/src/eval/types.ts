export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Minimal interface the content module must expose to the evaluator. */
export interface CanonicalFact {
  readonly id: string;
  readonly subject: string;
  readonly predicate: string;
  readonly object: JsonValue;
  readonly conditions: readonly JsonValue[];
  readonly weight: number;
  readonly evidenceCueIds: readonly string[];
}

export interface KnowledgeEntity {
  readonly localId: string;
  readonly type: string;
  readonly name: string;
  readonly attributes: Readonly<Record<string, JsonValue>>;
  readonly confidence: number;
  readonly evidenceIds: readonly string[];
}

export interface KnowledgeClaim {
  readonly id: string;
  readonly subject: string;
  readonly predicate: string;
  readonly object: JsonValue;
  readonly conditions: readonly JsonValue[];
  readonly confidence: number;
  readonly evidenceIds: readonly string[];
}

export interface ProcedureStep {
  readonly order: number;
  readonly action: string;
  readonly target?: string;
  readonly requirements: readonly JsonValue[];
  readonly expectedChange: readonly JsonValue[];
  readonly evidenceIds: readonly string[];
}

export interface KnowledgeProcedure {
  readonly id: string;
  readonly name: string;
  readonly goal: string;
  readonly preconditions: readonly JsonValue[];
  readonly steps: readonly ProcedureStep[];
  readonly successConditions: readonly JsonValue[];
  readonly alternatives: readonly string[];
  readonly failureModes: readonly string[];
  readonly recovery: readonly string[];
  readonly confidence: number;
  readonly evidenceIds: readonly string[];
}

/** Agent-authored evidence bundle. It can only point at observations issued by the evaluator. */
export interface EvidenceCitation {
  readonly id: string;
  readonly observationIds: readonly string[];
  readonly note: string;
}

export interface KnowledgeSubmission {
  readonly schemaVersion: "1.0";
  readonly title: string;
  readonly scenarioId: string;
  readonly entities: readonly KnowledgeEntity[];
  readonly claims: readonly KnowledgeClaim[];
  readonly procedures: readonly KnowledgeProcedure[];
  readonly evidence: readonly EvidenceCitation[];
  readonly unknowns: readonly string[];
  readonly contradictions: readonly string[];
}

/** Evaluator-owned observation metadata. cueIds are never returned to the playing agent. */
export interface ObservedEvidence {
  readonly id: string;
  readonly cueIds: readonly string[];
  readonly runId: string;
  readonly startTick: number;
  readonly endTick: number;
  readonly frameHashes?: readonly string[];
}

export interface RunOutcome {
  readonly track: "reproduction" | "transfer";
  readonly runId: string;
  readonly goalId: string;
  readonly procedureId: string;
  readonly success: boolean;
  readonly goalCompletion?: number;
  readonly actionCount: number;
  readonly referenceActionCount?: number;
  readonly invalidActions?: number;
  readonly finalStateHash?: string;
  readonly sourceScenarioHash: string;
  readonly targetScenarioHash: string;
}

export interface EvaluationOptions {
  readonly falsePositiveMultiplier?: number;
  readonly maximumHallucinationPenalty?: number;
  readonly maximumEvidenceSpanTicks?: number;
  readonly maximumObservationsPerCitation?: number;
  readonly discoverableFactIds?: readonly string[];
}

export interface EvaluationInput {
  readonly runId: string;
  readonly truth: readonly CanonicalFact[];
  readonly submission: KnowledgeSubmission;
  readonly observations: readonly ObservedEvidence[];
  readonly reproduction: readonly RunOutcome[];
  readonly transfer: readonly RunOutcome[];
  readonly options?: EvaluationOptions;
}

export interface FactMatch {
  readonly factId: string;
  readonly claimId: string;
  readonly weight: number;
}

export interface FalsePositive {
  readonly claimId: string;
  readonly weight: number;
  readonly confidence: number;
  readonly reason: "unsupported" | "condition-mismatch";
  readonly nearFactId?: string;
}

export interface FactScore {
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly truePositiveWeight: number;
  readonly falsePositiveWeight: number;
  readonly totalTruthWeight: number;
  readonly matches: readonly FactMatch[];
  readonly falsePositives: readonly FalsePositive[];
  readonly missingFactIds: readonly string[];
  readonly duplicateClaimIds: readonly string[];
  readonly conditionMismatches: readonly { claimId: string; factId: string }[];
}

export interface EvidenceScore {
  readonly precision: number;
  readonly coverage: number;
  readonly calibration: number;
  readonly composite: number;
  readonly validLinks: number;
  readonly totalLinks: number;
  readonly claimsWithValidEvidence: readonly string[];
  readonly invalidEvidenceIds: readonly string[];
  readonly overlyBroadObservationIds: readonly string[];
  readonly oversizedEvidenceIds: readonly string[];
  readonly crossRunEvidenceIds: readonly string[];
}

export interface RunSetScore {
  readonly completion: number;
  readonly efficiency: number;
  readonly composite: number;
  readonly completedGoals: number;
  readonly totalGoals: number;
  readonly rejectedOutcomes: number;
}

export interface EvaluationReport {
  readonly schemaVersion: "1.0";
  readonly score: {
    readonly total: number;
    readonly beforePenalty: number;
    readonly hallucinationPenalty: number;
    readonly components: {
      readonly factAccuracy: number;
      readonly discoverableCompleteness: number;
      readonly reproduction: number;
      readonly transfer: number;
      readonly evidenceAndCalibration: number;
      readonly wikiReadiness: number;
    };
  };
  readonly facts: FactScore;
  readonly evidence: EvidenceScore;
  readonly reproduction: RunSetScore;
  readonly transfer: RunSetScore;
  readonly validationErrors: readonly string[];
  readonly notes: readonly string[];
}
