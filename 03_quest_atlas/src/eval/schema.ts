import type { JsonValue, KnowledgeSubmission } from "./types.ts";

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export const KNOWLEDGE_SUBMISSION_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://quest-atlas.local/schema/knowledge-submission-1.0.json",
  title: "QUEST ATLAS Knowledge Submission",
  $defs: {
    jsonValue: {
      anyOf: [
        { type: ["string", "number", "boolean", "null"] },
        { type: "array", items: { $ref: "#/$defs/jsonValue" } },
        { type: "object", additionalProperties: { $ref: "#/$defs/jsonValue" } },
      ],
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    stringArray: { type: "array", items: { type: "string" } },
    entity: {
      type: "object",
      required: ["localId", "type", "name", "attributes", "confidence", "evidenceIds"],
      properties: {
        localId: { type: "string", minLength: 1 },
        type: { type: "string", minLength: 1 },
        name: { type: "string", minLength: 1 },
        attributes: { type: "object", additionalProperties: { $ref: "#/$defs/jsonValue" } },
        confidence: { $ref: "#/$defs/confidence" },
        evidenceIds: { $ref: "#/$defs/stringArray" },
      },
    },
    claim: {
      type: "object",
      required: ["id", "subject", "predicate", "object", "conditions", "confidence", "evidenceIds"],
      properties: {
        id: { type: "string", minLength: 1 },
        subject: { type: "string", minLength: 1 },
        predicate: { type: "string", minLength: 1 },
        object: { $ref: "#/$defs/jsonValue" },
        conditions: { type: "array", items: { $ref: "#/$defs/jsonValue" } },
        confidence: { $ref: "#/$defs/confidence" },
        evidenceIds: { $ref: "#/$defs/stringArray" },
      },
    },
    procedureStep: {
      type: "object",
      required: ["order", "action", "requirements", "expectedChange", "evidenceIds"],
      properties: {
        order: { type: "integer", minimum: 1 },
        action: { type: "string", minLength: 1 },
        target: { type: "string" },
        requirements: { type: "array", items: { $ref: "#/$defs/jsonValue" } },
        expectedChange: { type: "array", items: { $ref: "#/$defs/jsonValue" } },
        evidenceIds: { $ref: "#/$defs/stringArray" },
      },
    },
    procedure: {
      type: "object",
      required: ["id", "name", "goal", "preconditions", "steps", "successConditions", "alternatives", "failureModes", "recovery", "confidence", "evidenceIds"],
      properties: {
        id: { type: "string", minLength: 1 },
        name: { type: "string", minLength: 1 },
        goal: { type: "string", minLength: 1 },
        preconditions: { type: "array", items: { $ref: "#/$defs/jsonValue" } },
        steps: { type: "array", items: { $ref: "#/$defs/procedureStep" } },
        successConditions: { type: "array", items: { $ref: "#/$defs/jsonValue" } },
        alternatives: { $ref: "#/$defs/stringArray" },
        failureModes: { $ref: "#/$defs/stringArray" },
        recovery: { $ref: "#/$defs/stringArray" },
        confidence: { $ref: "#/$defs/confidence" },
        evidenceIds: { $ref: "#/$defs/stringArray" },
      },
    },
    evidence: {
      type: "object",
      required: ["id", "observationIds", "note"],
      properties: {
        id: { type: "string", minLength: 1 },
        observationIds: { $ref: "#/$defs/stringArray" },
        note: { type: "string" },
      },
    },
  },
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "title", "scenarioId", "entities", "claims", "procedures", "evidence", "unknowns", "contradictions"],
  properties: {
    schemaVersion: { const: "1.0" },
    title: { type: "string", minLength: 1 },
    scenarioId: { type: "string", minLength: 1 },
    entities: { type: "array", items: { $ref: "#/$defs/entity" } },
    claims: { type: "array", items: { $ref: "#/$defs/claim" } },
    procedures: { type: "array", items: { $ref: "#/$defs/procedure" } },
    evidence: { type: "array", items: { $ref: "#/$defs/evidence" } },
    unknowns: { type: "array", items: { type: "string" } },
    contradictions: { type: "array", items: { type: "string" } },
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function stringArray(record: Record<string, unknown>, key: string, path: string, errors: string[]): void {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    errors.push(path + "." + key + " must be an array of strings");
  }
}

function uniqueIds(values: readonly unknown[], path: string, errors: string[]): Set<string> {
  const ids = new Set<string>();
  values.forEach((value, index) => {
    if (!isRecord(value) || !isText(value.id)) {
      errors.push(path + "[" + index + "].id must be a non-empty string");
      return;
    }
    if (ids.has(value.id)) errors.push(path + "[" + index + "].id is duplicated");
    ids.add(value.id);
  });
  return ids;
}

function jsonArray(record: Record<string, unknown>, key: string, path: string, errors: string[]): void {
  const value = record[key];
  if (!Array.isArray(value) || !value.every(isJsonValue)) errors.push(path + "." + key + " must contain JSON values");
}

export function validateKnowledgeSubmission(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(input)) return { valid: false, errors: ["submission must be an object"] };
  if (input.schemaVersion !== "1.0") errors.push("schemaVersion must be '1.0'");
  if (!isText(input.title)) errors.push("title must be a non-empty string");
  if (!isText(input.scenarioId)) errors.push("scenarioId must be a non-empty string");

  const requiredArrays = ["entities", "claims", "procedures", "evidence", "unknowns", "contradictions"] as const;
  for (const key of requiredArrays) if (!Array.isArray(input[key])) errors.push(key + " must be an array");
  if (errors.length > 0) return { valid: false, errors };

  const entities = input.entities as readonly unknown[];
  const claims = input.claims as readonly unknown[];
  const procedures = input.procedures as readonly unknown[];
  const evidence = input.evidence as readonly unknown[];
  const evidenceIds = uniqueIds(evidence, "evidence", errors);
  uniqueIds(claims, "claims", errors);
  uniqueIds(procedures, "procedures", errors);

  entities.forEach((value, index) => {
    const path = "entities[" + index + "]";
    if (!isRecord(value)) { errors.push(path + " must be an object"); return; }
    for (const key of ["localId", "type", "name"] as const) if (!isText(value[key])) errors.push(path + "." + key + " must be a non-empty string");
    if (!isRecord(value.attributes) || !Object.values(value.attributes).every(isJsonValue)) errors.push(path + ".attributes must contain JSON values");
    if (!isConfidence(value.confidence)) errors.push(path + ".confidence must be between 0 and 1");
    stringArray(value, "evidenceIds", path, errors);
  });

  claims.forEach((value, index) => {
    const path = "claims[" + index + "]";
    if (!isRecord(value)) { errors.push(path + " must be an object"); return; }
    for (const key of ["subject", "predicate"] as const) if (!isText(value[key])) errors.push(path + "." + key + " must be a non-empty string");
    if (!isJsonValue(value.object)) errors.push(path + ".object must be a JSON value");
    jsonArray(value, "conditions", path, errors);
    if (!isConfidence(value.confidence)) errors.push(path + ".confidence must be between 0 and 1");
    stringArray(value, "evidenceIds", path, errors);
  });

  evidence.forEach((value, index) => {
    const path = "evidence[" + index + "]";
    if (!isRecord(value)) { errors.push(path + " must be an object"); return; }
    stringArray(value, "observationIds", path, errors);
    if (typeof value.note !== "string") errors.push(path + ".note must be a string");
  });

  procedures.forEach((value, index) => {
    const path = "procedures[" + index + "]";
    if (!isRecord(value)) { errors.push(path + " must be an object"); return; }
    for (const key of ["name", "goal"] as const) if (!isText(value[key])) errors.push(path + "." + key + " must be a non-empty string");
    for (const key of ["preconditions", "successConditions"] as const) jsonArray(value, key, path, errors);
    for (const key of ["alternatives", "failureModes", "recovery", "evidenceIds"] as const) stringArray(value, key, path, errors);
    if (!isConfidence(value.confidence)) errors.push(path + ".confidence must be between 0 and 1");
    if (!Array.isArray(value.steps)) {
      errors.push(path + ".steps must be an array");
    } else {
      value.steps.forEach((step, stepIndex) => {
        const stepPath = path + ".steps[" + stepIndex + "]";
        if (!isRecord(step)) { errors.push(stepPath + " must be an object"); return; }
        if (!Number.isInteger(step.order) || (step.order as number) < 1) errors.push(stepPath + ".order must be a positive integer");
        if (!isText(step.action)) errors.push(stepPath + ".action must be a non-empty string");
        if (step.target !== undefined && typeof step.target !== "string") errors.push(stepPath + ".target must be a string");
        for (const key of ["requirements", "expectedChange"] as const) jsonArray(step, key, stepPath, errors);
        stringArray(step, "evidenceIds", stepPath, errors);
      });
    }
  });

  const referenced: string[] = [];
  for (const value of [...entities, ...claims, ...procedures]) {
    if (isRecord(value) && Array.isArray(value.evidenceIds)) referenced.push(...value.evidenceIds.filter((entry): entry is string => typeof entry === "string"));
  }
  for (const value of procedures) {
    if (!isRecord(value) || !Array.isArray(value.steps)) continue;
    for (const step of value.steps) {
      if (isRecord(step) && Array.isArray(step.evidenceIds)) referenced.push(...step.evidenceIds.filter((entry): entry is string => typeof entry === "string"));
    }
  }
  for (const id of referenced) if (!evidenceIds.has(id)) errors.push("evidence reference '" + id + "' does not exist");
  if (!(input.unknowns as unknown[]).every((entry) => typeof entry === "string")) errors.push("unknowns must contain strings");
  if (!(input.contradictions as unknown[]).every((entry) => typeof entry === "string")) errors.push("contradictions must contain strings");
  return { valid: errors.length === 0, errors };
}

export function assertKnowledgeSubmission(input: unknown): asserts input is KnowledgeSubmission {
  const result = validateKnowledgeSubmission(input);
  if (!result.valid) throw new Error("Invalid knowledge submission:\n" + result.errors.join("\n"));
}
