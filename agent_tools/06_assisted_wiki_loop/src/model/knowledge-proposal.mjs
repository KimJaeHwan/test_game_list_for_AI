import { isDeepStrictEqual } from "node:util";

export const KNOWLEDGE_PAGE_KINDS = Object.freeze([
  "region", "npc", "item", "quest", "encounter", "system", "unknown",
]);
export const KNOWLEDGE_CONFIDENCES = Object.freeze(["OBSERVED", "TENTATIVE"]);
export const KNOWLEDGE_PROPOSAL_LIMITS = Object.freeze({
  summaryLength: 4_000, pages: 32, factsPerPage: 64, proceduresPerPage: 32,
  stepsPerProcedure: 32, cases: 64, openQuestions: 64, titleLength: 200,
  textLength: 4_000, cueLength: 2_000, evidenceFrameIds: 12,
});

const FRAME_ID_PATTERN = /^F\d{6}$/;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function boundedString(value, maximum) {
  return typeof value === "string" && Array.from(value).length >= 1 &&
    Array.from(value).length <= maximum && !value.includes("\0");
}
function requireAllowedFrameIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12 ||
    value.some((id) => typeof id !== "string" || !FRAME_ID_PATTERN.test(id)) ||
    new Set(value).size !== value.length) {
    throw new TypeError("allowedFrameIds must contain 1 to 12 unique canonical frame IDs");
  }
  return [...value];
}
function evidenceSchema(allowedFrameIds) {
  return {
    type: "array", minItems: 1,
    maxItems: Math.min(KNOWLEDGE_PROPOSAL_LIMITS.evidenceFrameIds, allowedFrameIds.length),
    items: { type: "string", pattern: "^F\\d{6}$", enum: [...allowedFrameIds] },
  };
}
function strictObject(properties) {
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
}
function stringSchema(maxLength) {
  return { type: "string", minLength: 1, maxLength };
}

export function createKnowledgeProposalSchema(rawAllowedFrameIds) {
  const allowedFrameIds = requireAllowedFrameIds(rawAllowedFrameIds);
  const evidence = () => evidenceSchema(allowedFrameIds);
  const step = strictObject({
    instruction: stringSchema(KNOWLEDGE_PROPOSAL_LIMITS.textLength),
    expectedCue: stringSchema(KNOWLEDGE_PROPOSAL_LIMITS.cueLength),
    evidenceFrameIds: evidence(),
  });
  const fact = strictObject({
    text: stringSchema(KNOWLEDGE_PROPOSAL_LIMITS.textLength),
    confidence: { type: "string", enum: [...KNOWLEDGE_CONFIDENCES] },
    evidenceFrameIds: evidence(),
  });
  const procedure = strictObject({
    title: stringSchema(KNOWLEDGE_PROPOSAL_LIMITS.titleLength),
    steps: {
      type: "array", minItems: 1,
      maxItems: KNOWLEDGE_PROPOSAL_LIMITS.stepsPerProcedure, items: step,
    },
    evidenceFrameIds: evidence(),
  });
  const page = strictObject({
    kind: { type: "string", enum: [...KNOWLEDGE_PAGE_KINDS] },
    title: stringSchema(KNOWLEDGE_PROPOSAL_LIMITS.titleLength),
    facts: {
      type: "array", minItems: 0,
      maxItems: KNOWLEDGE_PROPOSAL_LIMITS.factsPerPage, items: fact,
    },
    procedures: {
      type: "array", minItems: 0,
      maxItems: KNOWLEDGE_PROPOSAL_LIMITS.proceduresPerPage, items: procedure,
    },
  });
  const knowledgeCase = strictObject({
    title: stringSchema(KNOWLEDGE_PROPOSAL_LIMITS.titleLength),
    condition: stringSchema(KNOWLEDGE_PROPOSAL_LIMITS.textLength),
    outcome: stringSchema(KNOWLEDGE_PROPOSAL_LIMITS.textLength),
    evidenceFrameIds: evidence(),
  });
  const openQuestion = strictObject({
    question: stringSchema(KNOWLEDGE_PROPOSAL_LIMITS.textLength),
    evidenceFrameIds: evidence(),
  });
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "KnowledgeProposal",
    ...strictObject({
      summary: stringSchema(KNOWLEDGE_PROPOSAL_LIMITS.summaryLength),
      pages: {
        type: "array", minItems: 0,
        maxItems: KNOWLEDGE_PROPOSAL_LIMITS.pages, items: page,
      },
      cases: {
        type: "array", minItems: 0,
        maxItems: KNOWLEDGE_PROPOSAL_LIMITS.cases, items: knowledgeCase,
      },
      openQuestions: {
        type: "array", minItems: 0,
        maxItems: KNOWLEDGE_PROPOSAL_LIMITS.openQuestions, items: openQuestion,
      },
    }),
  };
}

export function validateKnowledgeProposalSchema(schema, allowedFrameIds) {
  return isDeepStrictEqual(schema, createKnowledgeProposalSchema(allowedFrameIds));
}

function projectEvidenceFrameIds(value, allowedFrameIds) {
  if (!Array.isArray(value) || value.length < 1 ||
    value.length > Math.min(KNOWLEDGE_PROPOSAL_LIMITS.evidenceFrameIds, allowedFrameIds.size) ||
    value.some((id) => typeof id !== "string" || !FRAME_ID_PATTERN.test(id) || !allowedFrameIds.has(id)) ||
    new Set(value).size !== value.length) {
    throw new TypeError("invalid evidenceFrameIds");
  }
  return [...value];
}
function projectStep(value, allowedFrameIds) {
  if (!exactKeys(value, ["instruction", "expectedCue", "evidenceFrameIds"]) ||
    !boundedString(value.instruction, KNOWLEDGE_PROPOSAL_LIMITS.textLength) ||
    !boundedString(value.expectedCue, KNOWLEDGE_PROPOSAL_LIMITS.cueLength)) {
    throw new TypeError("invalid step");
  }
  return {
    instruction: value.instruction,
    expectedCue: value.expectedCue,
    evidenceFrameIds: projectEvidenceFrameIds(value.evidenceFrameIds, allowedFrameIds),
  };
}
function projectFact(value, allowedFrameIds) {
  if (!exactKeys(value, ["text", "confidence", "evidenceFrameIds"]) ||
    !boundedString(value.text, KNOWLEDGE_PROPOSAL_LIMITS.textLength) ||
    !KNOWLEDGE_CONFIDENCES.includes(value.confidence)) throw new TypeError("invalid fact");
  return {
    text: value.text, confidence: value.confidence,
    evidenceFrameIds: projectEvidenceFrameIds(value.evidenceFrameIds, allowedFrameIds),
  };
}
function projectProcedure(value, allowedFrameIds) {
  if (!exactKeys(value, ["title", "steps", "evidenceFrameIds"]) ||
    !boundedString(value.title, KNOWLEDGE_PROPOSAL_LIMITS.titleLength) ||
    !Array.isArray(value.steps) || value.steps.length < 1 ||
    value.steps.length > KNOWLEDGE_PROPOSAL_LIMITS.stepsPerProcedure) {
    throw new TypeError("invalid procedure");
  }
  return {
    title: value.title,
    steps: value.steps.map((step) => projectStep(step, allowedFrameIds)),
    evidenceFrameIds: projectEvidenceFrameIds(value.evidenceFrameIds, allowedFrameIds),
  };
}
function projectPage(value, allowedFrameIds) {
  if (!exactKeys(value, ["kind", "title", "facts", "procedures"]) ||
    !KNOWLEDGE_PAGE_KINDS.includes(value.kind) ||
    !boundedString(value.title, KNOWLEDGE_PROPOSAL_LIMITS.titleLength) ||
    !Array.isArray(value.facts) || value.facts.length > KNOWLEDGE_PROPOSAL_LIMITS.factsPerPage ||
    !Array.isArray(value.procedures) ||
    value.procedures.length > KNOWLEDGE_PROPOSAL_LIMITS.proceduresPerPage) {
    throw new TypeError("invalid page");
  }
  return {
    kind: value.kind, title: value.title,
    facts: value.facts.map((fact) => projectFact(fact, allowedFrameIds)),
    procedures: value.procedures.map((item) => projectProcedure(item, allowedFrameIds)),
  };
}
function projectCase(value, allowedFrameIds) {
  if (!exactKeys(value, ["title", "condition", "outcome", "evidenceFrameIds"]) ||
    !boundedString(value.title, KNOWLEDGE_PROPOSAL_LIMITS.titleLength) ||
    !boundedString(value.condition, KNOWLEDGE_PROPOSAL_LIMITS.textLength) ||
    !boundedString(value.outcome, KNOWLEDGE_PROPOSAL_LIMITS.textLength)) {
    throw new TypeError("invalid case");
  }
  return {
    title: value.title, condition: value.condition, outcome: value.outcome,
    evidenceFrameIds: projectEvidenceFrameIds(value.evidenceFrameIds, allowedFrameIds),
  };
}
function projectOpenQuestion(value, allowedFrameIds) {
  if (!exactKeys(value, ["question", "evidenceFrameIds"]) ||
    !boundedString(value.question, KNOWLEDGE_PROPOSAL_LIMITS.textLength)) {
    throw new TypeError("invalid question");
  }
  return {
    question: value.question,
    evidenceFrameIds: projectEvidenceFrameIds(value.evidenceFrameIds, allowedFrameIds),
  };
}

export function projectKnowledgeProposal(value, rawAllowedFrameIds) {
  const allowedFrameIds = new Set(requireAllowedFrameIds(rawAllowedFrameIds));
  if (!exactKeys(value, ["summary", "pages", "cases", "openQuestions"]) ||
    !boundedString(value.summary, KNOWLEDGE_PROPOSAL_LIMITS.summaryLength) ||
    !Array.isArray(value.pages) || value.pages.length > KNOWLEDGE_PROPOSAL_LIMITS.pages ||
    !Array.isArray(value.cases) || value.cases.length > KNOWLEDGE_PROPOSAL_LIMITS.cases ||
    !Array.isArray(value.openQuestions) ||
    value.openQuestions.length > KNOWLEDGE_PROPOSAL_LIMITS.openQuestions) {
    throw new TypeError("invalid KnowledgeProposal");
  }
  return {
    summary: value.summary,
    pages: value.pages.map((page) => projectPage(page, allowedFrameIds)),
    cases: value.cases.map((item) => projectCase(item, allowedFrameIds)),
    openQuestions: value.openQuestions.map((item) => projectOpenQuestion(item, allowedFrameIds)),
  };
}
