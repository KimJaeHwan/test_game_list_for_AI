import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const LEGACY_ASSISTED_WIKI_SCHEMA_VERSION = "atlas/assisted-wiki-snapshot/1";
export const PROVENANCE_ASSISTED_WIKI_SCHEMA_VERSION = "atlas/assisted-wiki-snapshot/2";
export const ASSISTED_WIKI_SCHEMA_VERSION = "atlas/assisted-wiki-snapshot/3";
export const PLAYER_KNOWLEDGE_CONTEXT_VERSION = "atlas/player-knowledge-context/1";

const LIMITS = Object.freeze({
  proposalBytes: 512 * 1024,
  snapshotBytes: 2 * 1024 * 1024,
  sources: 256,
  pages: 64,
  facts: 128,
  procedures: 64,
  steps: 32,
  cases: 256,
  questions: 128,
  sourceFrames: 120,
  modelDeltas: 10,
  deltaFrames: 12,
  evidence: 64,
  evidenceSets: 32768,
  summary: 4000,
  kind: 40,
  title: 200,
  text: 4000,
  step: 4000,
  cue: 2000,
});
const SOURCE_STATUSES = new Set(["COMPLETE", "PARTIAL", "ABORT"]);
const SOURCE_TRACKS = new Set(["EXPLORATION", "ASSISTED_EXPLORATION"]);
const KNOWLEDGE_ATTESTATIONS = new Set(["HOST_RECEIPT", "LEGACY_OPERATOR_CONFIRMED"]);
const TERMINATION_KINDS = new Set([
  "NORMAL",
  "MODEL_DECISION_FAILED_NO_ACTION",
  "LEGACY_UNRECORDED",
]);
const ACCEPTANCE_BASES = new Set([
  "STANDARD",
  "EXPLICIT_OPERATOR_RECOVERY",
  "HOST_POLICY",
  "MIGRATED_LEGACY",
]);
const HOST_FINAL_STATES = new Set(["SEALED", "QUARANTINED"]);
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u;
const PRIVATE_USE = /[\ue000-\uf8ff\u{f0000}-\u{ffffd}\u{100000}-\u{10fffd}]/u;
const URL = /(?:\b[a-z][a-z0-9+.-]{1,31}:\/\/|\b(?:data|file|mailto|javascript):|\bwww\.)/iu;
const ENTROPY = /(?:\b[0-9a-f]{48,}\b|\b[A-Za-z0-9+\/_-]{80,}={0,2}\b)/u;
const INJECTION = /(?:<\|[^>]{1,80}\|>|<\/?(?:system|developer|assistant|tool|instructions?)\b|(?:^|\s)(?:system|developer|assistant|tool|user)\s*:|\b(?:ignore|override|disregard)\b.{0,80}\b(?:instruction|prompt|system|developer)\b)/iu;
const CONTEXT_PATH = /(?:\b[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|(?:^|\s)(?:\.{1,2}|~)[\\/]|(?:^|\s)\/[A-Za-z0-9._-]+(?:[\\/]|\b)|(?:^|\s)[A-Za-z0-9._-]+[\\/][A-Za-z0-9._-]+)/u;
const CONTEXT_COORDINATE = /(?:\b[xy]\s*[:=]\s*-?\d+|[([]\s*-?\d{1,7}\s*,\s*-?\d{1,7}\s*[)\]]|\bcoordinates?\b[^.]{0,24}-?\d)/iu;
const CONTEXT_KEY = /(?:\b(?:press|tap|hit|hold|release)\s+(?:the\s+)?(?:enter|return|space|spacebar|escape|esc|tab|shift|ctrl|control|alt|arrow(?:up|down|left|right)|up|down|left|right|[a-z0-9])\b|\b(?:ctrl|control|alt|shift|cmd|command|meta)\s*\+\s*\w+|\b(?:Arrow(?:Up|Down|Left|Right)|Numpad\w+|Key[A-Z]|Digit\d|F(?:[1-9]|1\d|2[0-4])|press_key|tapKey|allowedKeys?)\b)/iu;
const CONTEXT_INTERNAL = /(?:\bF\d{4,}\b|\b(?:frameId|actionId|runId|digest|sha256)\b|\bartifact\s*digest\b|\bevidence\s*frame\b|\b(?:action|run)[-_:#][a-z0-9][a-z0-9._:-]{2,}\b)/iu;
const FRAME_ID = /^F\d{6}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const SEMANTIC_NORMALIZER_VERSION = "ko-semantic-v1";

function fail(message) {
  throw new TypeError(message);
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value) {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function byteLength(value) {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

function exactRecord(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`);
  const actualKeys = Reflect.ownKeys(value);
  if (actualKeys.some((key) => typeof key !== "string")) fail(`${label} cannot contain symbol keys`);
  const actual = actualKeys.sort(compare);
  const expected = [...keys].sort(compare);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} must contain exactly: ${expected.join(", ")}`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(descriptors[key], "value")) fail(`${label} must contain data properties only`);
  }
  return Object.fromEntries(expected.map((key) => [key, descriptors[key].value]));
}

function boundedArray(value, maximum, label) {
  if (!Array.isArray(value) || value.length > maximum) fail(`${label} must be an array of at most ${maximum}`);
  return value;
}

function safeString(value, maximum, label, allowEmpty = false) {
  if (
    typeof value !== "string" || Array.from(value).length > maximum || (!allowEmpty && value.length === 0) ||
    value.normalize("NFC") !== value || value.trim() !== value
  ) {
    fail(`${label} has invalid text or length`);
  }
  if (CONTROL.test(value) || PRIVATE_USE.test(value) || URL.test(value) || ENTROPY.test(value) || INJECTION.test(value)) {
    fail(`${label} contains unsafe text`);
  }
  return value;
}

function stableId(prefix, ...parts) {
  const hash = createHash("sha256").update(parts.map(canonical).join("\u001f")).digest("hex").slice(0, 20);
  return `${prefix}_${hash}`;
}

function validateEvidence(value, available, label, maximum = LIMITS.evidence) {
  boundedArray(value, maximum, label);
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const frameId = value[index];
    if (typeof frameId !== "string" || !FRAME_ID.test(frameId) || seen.has(frameId)) {
      fail(`${label}[${index}] is invalid or duplicate`);
    }
    if (available && !available.has(frameId)) fail(`${label}[${index}] does not exist in source.availableFrameIds`);
    seen.add(frameId);
  }
  return [...value];
}

function evidenceRefKey(reference) {
  return `${reference.sourceDigest}\u001f${reference.frameId}`;
}

function sourceEvidence(frameIds, sourceDigest) {
  return frameIds
    .map((frameId) => ({ sourceDigest, frameId }))
    .sort((left, right) => compare(evidenceRefKey(left), evidenceRefKey(right)));
}

function unionEvidenceRefs(left, right) {
  const merged = new Map([...left, ...right].map((reference) => [evidenceRefKey(reference), {
    sourceDigest: reference.sourceDigest,
    frameId: reference.frameId,
  }]));
  return [...merged.values()].sort((a, b) => compare(evidenceRefKey(a), evidenceRefKey(b)));
}

function validateEvidenceRefs(value, sourceFrames, label) {
  boundedArray(value, LIMITS.evidence, label);
  let previous;
  const seen = new Set();
  value.forEach((reference, index) => {
    const fields = exactRecord(reference, ["sourceDigest", "frameId"], `${label}[${index}]`);
    if (typeof fields.sourceDigest !== "string" || !DIGEST.test(fields.sourceDigest) || !sourceFrames.has(fields.sourceDigest)) {
      fail(`${label}[${index}].sourceDigest is invalid`);
    }
    if (typeof fields.frameId !== "string" || !FRAME_ID.test(fields.frameId) || !sourceFrames.get(fields.sourceDigest).has(fields.frameId)) {
      fail(`${label}[${index}].frameId is invalid for its source`);
    }
    const key = `${fields.sourceDigest}\u001f${fields.frameId}`;
    if (seen.has(key)) fail(`${label} contains a duplicate`);
    if (previous !== undefined && compare(previous, key) > 0) fail(`${label} is not deterministically sorted`);
    seen.add(key);
    previous = key;
  });
}

export function validateSource(source) {
  const fields = exactRecord(
    source,
    ["artifactDigest", "status", "explorationTrack", "knowledgeAttestation", "provenance", "availableFrameIds"],
    "source",
  );
  if (typeof fields.artifactDigest !== "string" || !DIGEST.test(fields.artifactDigest)) fail("source.artifactDigest is invalid");
  if (!SOURCE_STATUSES.has(fields.status)) fail("source.status is invalid");
  if (!SOURCE_TRACKS.has(fields.explorationTrack)) fail("source.explorationTrack is invalid");
  if (!KNOWLEDGE_ATTESTATIONS.has(fields.knowledgeAttestation)) fail("source.knowledgeAttestation is invalid");
  validateSourceProvenance(fields.provenance, fields.status, "source.provenance");
  validateEvidence(fields.availableFrameIds, null, "source.availableFrameIds", LIMITS.sourceFrames);
  return source;
}

function validateSourceProvenance(provenance, contentStatus, label) {
  const fields = exactRecord(
    provenance,
    [
      "finalState",
      "terminationKind",
      "acceptanceBasis",
      "journalSha256",
      "endReason",
      "stopCode",
      "failedTurn",
      "endReceiptVerified",
      "sealReceiptVerified",
    ],
    label,
  );
  if (!TERMINATION_KINDS.has(fields.terminationKind) ||
    !ACCEPTANCE_BASES.has(fields.acceptanceBasis)) fail(`${label}.acceptance is invalid`);
  if (fields.acceptanceBasis === "MIGRATED_LEGACY") {
    if (
      fields.finalState !== null ||
      fields.terminationKind !== "LEGACY_UNRECORDED" ||
      fields.journalSha256 !== null ||
      fields.endReason !== null ||
      fields.stopCode !== null ||
      fields.failedTurn !== null ||
      fields.endReceiptVerified !== false ||
      fields.sealReceiptVerified !== false
    ) fail(`${label} legacy migration is invalid`);
    return;
  }
  if (!HOST_FINAL_STATES.has(fields.finalState) || !SOURCE_STATUSES.has(fields.endReason) ||
    typeof fields.journalSha256 !== "string" || !DIGEST.test(fields.journalSha256)) {
    fail(`${label} termination is invalid`);
  }
  if (fields.endReason !== contentStatus ||
    fields.endReceiptVerified !== true || fields.sealReceiptVerified !== true) {
    fail(`${label} receipt provenance is invalid`);
  }
  if (fields.acceptanceBasis === "STANDARD") {
    if (
      fields.finalState !== "SEALED" ||
      fields.terminationKind !== "NORMAL" ||
      fields.stopCode !== null ||
      fields.failedTurn !== null
    ) fail(`${label} standard acceptance is invalid`);
    return;
  }
  if (
    fields.terminationKind !== "MODEL_DECISION_FAILED_NO_ACTION" ||
    !new Set(["EXPLICIT_OPERATOR_RECOVERY", "HOST_POLICY"]).has(fields.acceptanceBasis) ||
    (fields.acceptanceBasis === "EXPLICIT_OPERATOR_RECOVERY" && fields.finalState !== "QUARANTINED") ||
    (fields.acceptanceBasis === "HOST_POLICY" && fields.finalState !== "SEALED") ||
    contentStatus !== "PARTIAL" ||
    fields.endReason !== "PARTIAL" ||
    fields.stopCode !== "MODEL_TURN_FAILED" ||
    !Number.isSafeInteger(fields.failedTurn) ||
    fields.failedTurn < 1
  ) fail(`${label} recovered model failure is invalid`);
}

function validateStep(step, label) {
  const fields = exactRecord(step, ["instruction", "expectedCue"], label);
  safeString(fields.instruction, LIMITS.step, `${label}.instruction`);
  safeString(fields.expectedCue, LIMITS.cue, `${label}.expectedCue`);
}

function validateProposalStep(step, available, label) {
  const fields = exactRecord(step, ["instruction", "expectedCue", "evidenceFrameIds"], label);
  safeString(fields.instruction, LIMITS.step, `${label}.instruction`);
  safeString(fields.expectedCue, LIMITS.cue, `${label}.expectedCue`);
  validateEvidence(fields.evidenceFrameIds, available, `${label}.evidenceFrameIds`);
}

export function validateKnowledgeProposal(proposal, source) {
  const root = exactRecord(proposal, ["summary", "pages", "cases", "openQuestions"], "proposal");
  validateSource(source);
  const available = new Set(source.availableFrameIds);
  safeString(root.summary, LIMITS.summary, "proposal.summary", true);
  boundedArray(root.pages, LIMITS.pages, "proposal.pages").forEach((page, pageIndex) => {
    const label = `proposal.pages[${pageIndex}]`;
    const fields = exactRecord(page, ["kind", "title", "facts", "procedures"], label);
    safeString(fields.kind, LIMITS.kind, `${label}.kind`);
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(fields.kind)) fail(`${label}.kind is invalid`);
    safeString(fields.title, LIMITS.title, `${label}.title`);
    boundedArray(fields.facts, LIMITS.facts, `${label}.facts`).forEach((fact, factIndex) => {
      const factLabel = `${label}.facts[${factIndex}]`;
      const factFields = exactRecord(fact, ["text", "confidence", "evidenceFrameIds"], factLabel);
      safeString(factFields.text, LIMITS.text, `${factLabel}.text`);
      if (!["OBSERVED", "TENTATIVE"].includes(factFields.confidence)) {
        fail(`${factLabel}.confidence is invalid`);
      }
      validateEvidence(factFields.evidenceFrameIds, available, `${factLabel}.evidenceFrameIds`);
    });
    boundedArray(fields.procedures, LIMITS.procedures, `${label}.procedures`).forEach((procedure, procedureIndex) => {
      const procedureLabel = `${label}.procedures[${procedureIndex}]`;
      const procedureFields = exactRecord(procedure, ["title", "steps", "evidenceFrameIds"], procedureLabel);
      safeString(procedureFields.title, LIMITS.title, `${procedureLabel}.title`);
      const steps = boundedArray(procedureFields.steps, LIMITS.steps, `${procedureLabel}.steps`);
      if (steps.length === 0) fail(`${procedureLabel}.steps cannot be empty`);
      steps.forEach((step, stepIndex) => validateProposalStep(step, available, `${procedureLabel}.steps[${stepIndex}]`));
      validateEvidence(procedureFields.evidenceFrameIds, available, `${procedureLabel}.evidenceFrameIds`);
    });
  });
  boundedArray(root.cases, LIMITS.cases, "proposal.cases").forEach((entry, index) => {
    const label = `proposal.cases[${index}]`;
    const fields = exactRecord(entry, ["title", "condition", "outcome", "evidenceFrameIds"], label);
    safeString(fields.title, LIMITS.title, `${label}.title`);
    safeString(fields.condition, LIMITS.text, `${label}.condition`);
    safeString(fields.outcome, LIMITS.text, `${label}.outcome`);
    validateEvidence(fields.evidenceFrameIds, available, `${label}.evidenceFrameIds`);
  });
  boundedArray(root.openQuestions, LIMITS.questions, "proposal.openQuestions").forEach((entry, index) => {
    const label = `proposal.openQuestions[${index}]`;
    const fields = exactRecord(entry, ["question", "evidenceFrameIds"], label);
    safeString(fields.question, LIMITS.text, `${label}.question`);
    validateEvidence(fields.evidenceFrameIds, available, `${label}.evidenceFrameIds`);
  });
  if (byteLength(proposal) > LIMITS.proposalBytes) fail("proposal exceeds its byte limit");
  return proposal;
}

function procedureKey(procedure) {
  return [procedure.title, ...procedure.steps.flatMap((step) => [step.instruction, step.expectedCue])]
    .map(canonical)
    .join("\u001f");
}

function semanticSentence(value) {
  return canonical(value).replace(/[.?!？]+$/u, "").trim();
}

function coordinatedParts(value, { sort = true } = {}) {
  const separated = semanticSentence(value)
    .replace(/,\s*/gu, "\u001f")
    .replace(/\s+및\s+/gu, "\u001f")
    .replace(/([가-힣0-9]+)(?:와|과)\s+(?=[가-힣0-9])/gu, "$1\u001f");
  const parts = separated.split("\u001f").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0 || new Set(parts).size !== parts.length) return null;
  return sort ? parts.sort(compare) : parts;
}

function semanticKey(kind, atom, fallback) {
  return atom === null
    ? `exact:${kind}:${fallback}`
    : `semantic:${SEMANTIC_NORMALIZER_VERSION}:${kind}:${JSON.stringify(atom)}`;
}

function parseFactAtom(value) {
  const text = semanticSentence(value);
  let match = /^(.+?)(?:은|는) (.+?) (?:말합니다|설명합니다)$/u.exec(text);
  if (match) {
    return {
      subject: match[1],
      relation: "reports",
      object: match[2],
      polarity: "POSITIVE",
      qualifiers: [],
    };
  }
  match = /^(.+?)(?:에서는|은|는) (.+?) 상태로 표시됩니다$/u.exec(text);
  if (match) {
    const states = coordinatedParts(match[2]);
    if (states) {
      return {
        subject: match[1],
        relation: "visible-state",
        object: states,
        polarity: "POSITIVE",
        qualifiers: [],
      };
    }
  }
  match = /^(.+?)에서 (.+?)(?:으로|로) (?:가는|향하는) 경로는 (관찰 시점에 )?잠겨 있습니다$/u.exec(text);
  if (match) {
    const destinations = coordinatedParts(match[2]);
    if (destinations) {
      return {
        subject: match[1],
        relation: "route-locked",
        object: destinations,
        polarity: "POSITIVE",
        qualifiers: match[3] ? ["OBSERVED_AT_CURRENT_TIME"] : [],
      };
    }
  }
  match = /^(탐색|구조화|재현|전이)(?: 단계에서는|은|는) (.+?)(?:하는 단계입니다|합니다)$/u.exec(text);
  if (match) {
    return {
      subject: match[1],
      relation: "phase-purpose",
      object: match[2],
      polarity: "POSITIVE",
      qualifiers: [],
    };
  }
  match = /^세션(?: 흐름)?(?:은|는) (.+?)의 네 단계로 (?:제시됩니다|안내됩니다)$/u.exec(text);
  if (match) {
    const stages = coordinatedParts(match[1], { sort: false });
    if (stages?.length === 4) {
      return {
        subject: "세션",
        relation: "ordered-phases",
        object: stages,
        polarity: "POSITIVE",
        qualifiers: [{ count: 4 }],
      };
    }
  }
  if (
    text === "이끼숲은 수지와 약초, 밤의 월광나방이 사는 숲입니다" ||
    text === "이끼숲은 수지와 약초가 있으며 밤의 월광나방이 사는 숲입니다"
  ) {
    return {
      subject: "이끼숲",
      relation: "contains-and-habitat",
      object: ["수지", "약초", "밤의 월광나방"],
      polarity: "POSITIVE",
      qualifiers: [],
    };
  }
  return null;
}

function parseInstructionAtom(value) {
  const text = semanticSentence(value);
  let match = /^(.+?)에서 (.+?)(?:을|를) 선택해 조사한다$/u.exec(text);
  if (match) {
    return {
      action: "inspect",
      location: match[1],
      target: match[2],
      qualifiers: [],
    };
  }
  match = /^(.+?)에서 (.+?)(?:으로|로) 향하는 이동 선택지를 고른다$/u.exec(text);
  if (match) {
    return {
      action: "travel",
      location: match[1],
      target: match[2],
      qualifiers: [],
    };
  }
  return null;
}

function parseCueAtom(value) {
  const text = semanticSentence(value);
  let match = /^(.+?) 도착 알림이 나타나고 현재 장소가 (.+?)(?:으로|로) 바뀝니다$/u.exec(text);
  if (!match) {
    match = /^(.+?)에 도착했다는 알림과 함께 현재 장소가 (.+?)(?:으로|로) 바뀝니다$/u.exec(text);
  }
  if (match && canonical(match[1]) === canonical(match[2])) {
    return {
      observation: "arrival-and-current-location",
      target: match[1],
      polarity: "POSITIVE",
      qualifiers: [],
    };
  }
  return null;
}

function procedureTitleAtom(value) {
  const text = semanticSentence(value);
  const match = /^(.+?)에서 (.+?)(?:으로|로) 이동$/u.exec(text);
  if (match) {
    return {
      mode: "SEMANTIC",
      action: "travel",
      location: match[1],
      target: match[2],
    };
  }
  return {
    mode: "EXACT",
    text,
  };
}

function factMergeKey(fact) {
  return semanticKey("fact", parseFactAtom(fact.text), canonical(fact.text));
}

function procedureMergeKey(procedure) {
  const steps = [];
  for (const step of procedure.steps) {
    const action = parseInstructionAtom(step.instruction);
    const cue = parseCueAtom(step.expectedCue);
    if (action === null || cue === null) {
      return semanticKey("procedure", null, procedureKey(procedure));
    }
    steps.push({ action, cue });
  }
  return semanticKey(
    "procedure",
    { title: procedureTitleAtom(procedure.title), steps },
    procedureKey(procedure),
  );
}

function parseCaseCondition(value) {
  const text = semanticSentence(value);
  const match = /^(.+?)에서 (.+?)(?:을|를) (아직 조사하지 않은|조사하지 않은|조사한) 상태입니다$/u.exec(text);
  if (!match) return null;
  return {
    location: match[1],
    target: match[2],
    relation: "inspection-state",
    state: match[3] === "조사한" ? "INSPECTED" : "UNINSPECTED",
  };
}

function parseCaseOutcome(value) {
  const text = semanticSentence(value);
  if (/(?:^|\s|로)만(?:\s|$)/u.test(text)) return null;
  let match = /^(.+?)(?:은|는) 발견 가능한 퀘스트로 표시되며 진행도는 나타나지 않습니다$/u.exec(text);
  if (match) {
    return {
      subject: match[1],
      state: ["DISCOVERABLE_QUEST", "PROGRESS_NOT_VISIBLE"],
    };
  }
  match = /^(.+?)(?:은|이) 새 조사로 시작되고 첫 단계 진행도가 표시됩니다$/u.exec(text);
  if (match) {
    return {
      subject: match[1],
      state: ["INVESTIGATION_STARTED", "PROGRESS_STAGE_1_VISIBLE"],
    };
  }
  return null;
}

function caseMergeKey(entry) {
  const condition = parseCaseCondition(entry.condition);
  const outcome = parseCaseOutcome(entry.outcome);
  return semanticKey(
    "case",
    condition === null || outcome === null ? null : { condition, outcome },
    `${canonical(entry.condition)}\u001f${canonical(entry.outcome)}`,
  );
}

function parseQuestionAtom(value) {
  const text = semanticSentence(value);
  if (/(?:^|\s|로)만(?:\s|$)/u.test(text)) return null;
  let match = /^(.+?)의 (.+?)(?:은|는) 무엇입니까$/u.exec(text);
  if (match) {
    const topics = coordinatedParts(match[1]);
    const requestedSlots = coordinatedParts(match[2]);
    if (topics && requestedSlots) {
      return { topics, requestedSlots, relation: "what" };
    }
  }
  match = /^(.+?)(?:으로|로) 향하는 잠긴 경로는 어떻게 해제합니까$/u.exec(text);
  if (match) {
    const topics = coordinatedParts(match[1]);
    if (topics) {
      return { topics, requestedSlots: ["잠긴 경로 해제 방법"], relation: "how" };
    }
  }
  return null;
}

function questionMergeKey(entry) {
  return semanticKey("question", parseQuestionAtom(entry.question), canonical(entry.question));
}

function evidenceSetOrderKey(entry) {
  return `${entry.ownerId}\u001f${entry.sourceDigest}`;
}

function createEvidenceStore(snapshot) {
  const byOwner = new Map();
  for (const entry of snapshot.evidenceSets ?? []) {
    const entries = byOwner.get(entry.ownerId) ?? [];
    entries.push(entry);
    byOwner.set(entry.ownerId, entries);
  }

  const read = (item) => [
    ...item.evidenceRefs,
    ...(byOwner.get(item.id) ?? []).flatMap((entry) =>
      entry.frameIds.map((frameId) => ({ sourceDigest: entry.sourceDigest, frameId }))),
  ];

  const write = (item, evidenceRefs) => {
    const ordered = unionEvidenceRefs([], evidenceRefs);
    item.evidenceRefs = ordered.slice(0, LIMITS.evidence);
    const overflowBySource = new Map();
    for (const reference of ordered.slice(LIMITS.evidence)) {
      const frameIds = overflowBySource.get(reference.sourceDigest) ?? [];
      frameIds.push(reference.frameId);
      overflowBySource.set(reference.sourceDigest, frameIds);
    }
    byOwner.set(
      item.id,
      [...overflowBySource.entries()].map(([sourceDigest, frameIds]) => ({
        id: stableId("evidence-set", item.id, sourceDigest),
        ownerId: item.id,
        sourceDigest,
        frameIds,
      })),
    );
  };

  return {
    read,
    write,
    remove(ownerId) {
      byOwner.delete(ownerId);
    },
    flush() {
      snapshot.evidenceSets = [...byOwner.values()]
        .flat()
        .filter((entry) => entry.frameIds.length > 0)
        .sort((left, right) => compare(evidenceSetOrderKey(left), evidenceSetOrderKey(right)));
    },
  };
}

function mergeEvidence(survivor, duplicate, { fact = false, evidenceStore } = {}) {
  const duplicateEvidence = duplicate.id === undefined
    ? duplicate.evidenceRefs
    : evidenceStore.read(duplicate);
  evidenceStore.write(
    survivor,
    unionEvidenceRefs(evidenceStore.read(survivor), duplicateEvidence),
  );
  if (duplicate.id !== undefined && duplicate.id !== survivor.id) evidenceStore.remove(duplicate.id);
  if (fact) survivor.confidence = Math.max(survivor.confidence, duplicate.confidence);
  return true;
}

function consolidateItems(items, keyFor, mergeInto) {
  const byMeaning = new Map();
  const survivors = [];
  for (const item of items) {
    const key = keyFor(item);
    const candidates = byMeaning.get(key) ?? [];
    let merged = false;
    for (const survivor of candidates) {
      if (mergeInto(survivor, item)) {
        merged = true;
        break;
      }
    }
    if (!merged) {
      candidates.push(item);
      byMeaning.set(key, candidates);
      survivors.push(item);
    }
  }
  return survivors;
}

function consolidateExistingKnowledge(snapshot) {
  const evidenceStore = createEvidenceStore(snapshot);
  for (const page of snapshot.pages) {
    page.facts = consolidateItems(
      page.facts,
      factMergeKey,
      (survivor, duplicate) => mergeEvidence(survivor, duplicate, { fact: true, evidenceStore }),
    );
    page.procedures = consolidateItems(
      page.procedures,
      procedureMergeKey,
      (survivor, duplicate) => mergeEvidence(survivor, duplicate, { evidenceStore }),
    );
  }
  snapshot.cases = consolidateItems(
    snapshot.cases,
    caseMergeKey,
    (survivor, duplicate) => mergeEvidence(survivor, duplicate, { evidenceStore }),
  );
  snapshot.openQuestions = consolidateItems(
    snapshot.openQuestions,
    questionMergeKey,
    (survivor, duplicate) => mergeEvidence(survivor, duplicate, { evidenceStore }),
  );
  evidenceStore.flush();
  return snapshot;
}

function indexByMeaning(items, keyFor) {
  const indexed = new Map();
  for (const item of items) {
    const key = keyFor(item);
    const candidates = indexed.get(key) ?? [];
    candidates.push(item);
    indexed.set(key, candidates);
  }
  return indexed;
}

function mergeIntoMeaningBucket(indexed, key, duplicate, options) {
  for (const survivor of indexed.get(key) ?? []) {
    if (mergeEvidence(survivor, duplicate, options)) return true;
  }
  return false;
}

function addToMeaningBucket(indexed, key, item) {
  const candidates = indexed.get(key) ?? [];
  candidates.push(item);
  indexed.set(key, candidates);
}

function requireSortedUnique(items, keyFor, label) {
  let previous;
  const seen = new Set();
  for (const item of items) {
    const key = keyFor(item);
    if (seen.has(key)) fail(`${label} contains a canonical duplicate`);
    if (previous !== undefined && compare(previous, key) > 0) fail(`${label} is not deterministically sorted`);
    seen.add(key);
    previous = key;
  }
}

export function validateAssistedWikiSnapshot(snapshot) {
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) fail("snapshot must be a plain object");
  const schemaVersion = Object.getOwnPropertyDescriptor(snapshot, "schemaVersion")?.value;
  const isLegacy = schemaVersion === LEGACY_ASSISTED_WIKI_SCHEMA_VERSION;
  const isProvenance = schemaVersion === PROVENANCE_ASSISTED_WIKI_SCHEMA_VERSION;
  const isCurrent = schemaVersion === ASSISTED_WIKI_SCHEMA_VERSION;
  if (!isLegacy && !isProvenance && !isCurrent) fail("snapshot envelope is invalid");
  const root = exactRecord(
    snapshot,
    isCurrent
      ? ["schemaVersion", "track", "revision", "sources", "pages", "cases", "openQuestions", "evidenceSets"]
      : ["schemaVersion", "track", "revision", "sources", "pages", "cases", "openQuestions"],
    "snapshot",
  );
  if (
    root.track !== "ASSISTED" ||
    !Number.isSafeInteger(root.revision) || root.revision < 1
  ) fail("snapshot envelope is invalid");
  boundedArray(root.sources, LIMITS.sources, "snapshot.sources").forEach((source, index) => {
    const label = `snapshot.sources[${index}]`;
    const fields = exactRecord(
      source,
      isLegacy
        ? ["artifactDigest", "status", "explorationTrack", "knowledgeAttestation", "availableFrameIds"]
        : ["artifactDigest", "status", "explorationTrack", "knowledgeAttestation", "provenance", "availableFrameIds"],
      label,
    );
    if (typeof fields.artifactDigest !== "string" || !DIGEST.test(fields.artifactDigest)) fail(`${label}.artifactDigest is invalid`);
    if (!SOURCE_STATUSES.has(fields.status)) fail(`${label}.status is invalid`);
    if (!SOURCE_TRACKS.has(fields.explorationTrack)) fail(`${label}.explorationTrack is invalid`);
    if (!KNOWLEDGE_ATTESTATIONS.has(fields.knowledgeAttestation)) fail(`${label}.knowledgeAttestation is invalid`);
    if (!isLegacy) validateSourceProvenance(fields.provenance, fields.status, `${label}.provenance`);
    validateEvidence(fields.availableFrameIds, null, `${label}.availableFrameIds`, LIMITS.sourceFrames);
    requireSortedUnique(fields.availableFrameIds, (frameId) => frameId, `${label}.availableFrameIds`);
  });
  const sourceFrames = new Map(root.sources.map((source) => [source.artifactDigest, new Set(source.availableFrameIds)]));
  const evidenceOwners = new Map();
  const registerEvidenceOwner = (id, kind, item, label) => {
    if (evidenceOwners.has(id)) fail(`${label}.id collides with another evidence owner`);
    evidenceOwners.set(id, { kind, item });
  };
  boundedArray(root.pages, LIMITS.pages, "snapshot.pages").forEach((page, pageIndex) => {
    const label = `snapshot.pages[${pageIndex}]`;
    const fields = exactRecord(page, ["id", "kind", "title", "facts", "procedures"], label);
    safeString(fields.kind, LIMITS.kind, `${label}.kind`);
    safeString(fields.title, LIMITS.title, `${label}.title`);
    if (fields.id !== stableId("page", fields.kind, fields.title)) fail(`${label}.id is not locally derived`);
    boundedArray(fields.facts, LIMITS.facts, `${label}.facts`).forEach((fact, factIndex) => {
      const factLabel = `${label}.facts[${factIndex}]`;
      const factFields = exactRecord(fact, ["id", "text", "confidence", "evidenceRefs"], factLabel);
      safeString(factFields.text, LIMITS.text, `${factLabel}.text`);
      if (
        factFields.id !== stableId("fact", fields.id, factFields.text) || !Number.isFinite(factFields.confidence) ||
        factFields.confidence < 0 || factFields.confidence > 1
      ) fail(`${factLabel} is invalid`);
      validateEvidenceRefs(factFields.evidenceRefs, sourceFrames, `${factLabel}.evidenceRefs`);
      registerEvidenceOwner(factFields.id, "FACT", fact, factLabel);
    });
    boundedArray(fields.procedures, LIMITS.procedures, `${label}.procedures`).forEach((procedure, procedureIndex) => {
      const procedureLabel = `${label}.procedures[${procedureIndex}]`;
      const procedureFields = exactRecord(procedure, ["id", "title", "steps", "evidenceRefs"], procedureLabel);
      safeString(procedureFields.title, LIMITS.title, `${procedureLabel}.title`);
      const steps = boundedArray(procedureFields.steps, LIMITS.steps, `${procedureLabel}.steps`);
      if (steps.length === 0) fail(`${procedureLabel}.steps cannot be empty`);
      steps.forEach((step, stepIndex) => validateStep(step, `${procedureLabel}.steps[${stepIndex}]`));
      const expectedId = stableId("procedure", fields.id, procedureFields.title, ...steps.flatMap((step) => [step.instruction, step.expectedCue]));
      if (procedureFields.id !== expectedId) fail(`${procedureLabel}.id is not locally derived`);
      validateEvidenceRefs(procedureFields.evidenceRefs, sourceFrames, `${procedureLabel}.evidenceRefs`);
      registerEvidenceOwner(procedureFields.id, "PROCEDURE", procedure, procedureLabel);
    });
  });
  boundedArray(root.cases, LIMITS.cases, "snapshot.cases").forEach((entry, index) => {
    const label = `snapshot.cases[${index}]`;
    const fields = exactRecord(entry, ["id", "title", "condition", "outcome", "evidenceRefs"], label);
    safeString(fields.title, LIMITS.title, `${label}.title`);
    safeString(fields.condition, LIMITS.text, `${label}.condition`);
    safeString(fields.outcome, LIMITS.text, `${label}.outcome`);
    if (fields.id !== stableId("case", fields.condition, fields.outcome)) fail(`${label}.id is not locally derived`);
    validateEvidenceRefs(fields.evidenceRefs, sourceFrames, `${label}.evidenceRefs`);
    registerEvidenceOwner(fields.id, "CASE", entry, label);
  });
  boundedArray(root.openQuestions, LIMITS.questions, "snapshot.openQuestions").forEach((entry, index) => {
    const label = `snapshot.openQuestions[${index}]`;
    const fields = exactRecord(entry, ["id", "question", "evidenceRefs"], label);
    safeString(fields.question, LIMITS.text, `${label}.question`);
    if (fields.id !== stableId("question", fields.question)) fail(`${label}.id is not locally derived`);
    validateEvidenceRefs(fields.evidenceRefs, sourceFrames, `${label}.evidenceRefs`);
    registerEvidenceOwner(fields.id, "OPEN_QUESTION", entry, label);
  });
  const evidenceSetOwners = new Set();
  const extendedByOwner = new Map();
  boundedArray(root.evidenceSets ?? [], LIMITS.evidenceSets, "snapshot.evidenceSets").forEach((entry, index) => {
    const label = `snapshot.evidenceSets[${index}]`;
    const fields = exactRecord(entry, ["id", "ownerId", "sourceDigest", "frameIds"], label);
    if (typeof fields.ownerId !== "string" || !evidenceOwners.has(fields.ownerId)) fail(`${label}.ownerId is orphaned`);
    if (typeof fields.sourceDigest !== "string" || !DIGEST.test(fields.sourceDigest) || !sourceFrames.has(fields.sourceDigest)) {
      fail(`${label}.sourceDigest is invalid`);
    }
    if (fields.id !== stableId("evidence-set", fields.ownerId, fields.sourceDigest)) fail(`${label}.id is not locally derived`);
    const ownerSourceKey = `${fields.ownerId}\u001f${fields.sourceDigest}`;
    if (evidenceSetOwners.has(ownerSourceKey)) fail("snapshot.evidenceSets contains a duplicate owner/source pair");
    evidenceSetOwners.add(ownerSourceKey);
    const frameIds = validateEvidence(
      fields.frameIds,
      sourceFrames.get(fields.sourceDigest),
      `${label}.frameIds`,
      LIMITS.sourceFrames,
    );
    if (frameIds.length === 0) fail(`${label}.frameIds cannot be empty`);
    requireSortedUnique(frameIds, (frameId) => frameId, `${label}.frameIds`);
    const references = extendedByOwner.get(fields.ownerId) ?? [];
    references.push(...frameIds.map((frameId) => ({ sourceDigest: fields.sourceDigest, frameId })));
    extendedByOwner.set(fields.ownerId, references);
  });
  for (const [ownerId, references] of extendedByOwner) {
    const owner = evidenceOwners.get(ownerId);
    if (owner.item.evidenceRefs.length !== LIMITS.evidence) {
      fail(`evidence owner ${ownerId} must retain exactly ${LIMITS.evidence} direct references before using evidenceSets`);
    }
    const allReferences = unionEvidenceRefs(owner.item.evidenceRefs, references);
    if (allReferences.length !== owner.item.evidenceRefs.length + references.length) {
      fail(`evidence owner ${ownerId} contains duplicate direct or extended evidence`);
    }
    const expectedDirect = allReferences.slice(0, LIMITS.evidence);
    if (expectedDirect.some((reference, index) =>
      evidenceRefKey(reference) !== evidenceRefKey(owner.item.evidenceRefs[index]))) {
      fail(`evidence owner ${ownerId} is not canonically partitioned`);
    }
  }
  requireSortedUnique(root.sources, (entry) => entry.artifactDigest, "snapshot.sources");
  requireSortedUnique(root.evidenceSets ?? [], evidenceSetOrderKey, "snapshot.evidenceSets");
  requireSortedUnique(root.pages, (page) => `${canonical(page.kind)}\u001f${canonical(page.title)}`, "snapshot.pages");
  for (const page of root.pages) {
    requireSortedUnique(page.facts, (fact) => canonical(fact.text), `snapshot page ${page.id} facts`);
    requireSortedUnique(page.procedures, procedureKey, `snapshot page ${page.id} procedures`);
  }
  requireSortedUnique(root.cases, (entry) => `${canonical(entry.condition)}\u001f${canonical(entry.outcome)}`, "snapshot.cases");
  requireSortedUnique(root.openQuestions, (entry) => canonical(entry.question), "snapshot.openQuestions");
  if (byteLength(snapshot) > LIMITS.snapshotBytes) fail("snapshot exceeds its byte limit");
  return snapshot;
}

export function migrateAssistedWikiSnapshot(snapshot) {
  validateAssistedWikiSnapshot(snapshot);
  const migrated = structuredClone(snapshot);
  if (migrated.schemaVersion === LEGACY_ASSISTED_WIKI_SCHEMA_VERSION) {
    migrated.schemaVersion = PROVENANCE_ASSISTED_WIKI_SCHEMA_VERSION;
    migrated.sources = migrated.sources.map((source) => ({
      ...source,
      provenance: {
        finalState: null,
        terminationKind: "LEGACY_UNRECORDED",
        acceptanceBasis: "MIGRATED_LEGACY",
        journalSha256: null,
        endReason: null,
        stopCode: null,
        failedTurn: null,
        endReceiptVerified: false,
        sealReceiptVerified: false,
      },
    }));
  }
  if (migrated.schemaVersion === PROVENANCE_ASSISTED_WIKI_SCHEMA_VERSION) {
    migrated.schemaVersion = ASSISTED_WIKI_SCHEMA_VERSION;
    migrated.evidenceSets = [];
  }
  validateAssistedWikiSnapshot(migrated);
  return migrated;
}

function representationPart(value) {
  return `${canonical(value)}\u001e${value}`;
}

function factProposalOrderKey(fact) {
  return representationPart(fact.text);
}

function procedureProposalOrderKey(procedure) {
  return [
    representationPart(procedure.title),
    ...procedure.steps.flatMap((step) => [
      representationPart(step.instruction),
      representationPart(step.expectedCue),
    ]),
  ].join("\u001f");
}

function caseProposalOrderKey(entry) {
  return [
    representationPart(entry.condition),
    representationPart(entry.outcome),
    representationPart(entry.title),
  ].join("\u001f");
}

function questionProposalOrderKey(entry) {
  return representationPart(entry.question);
}

function orderedProposalPages(proposalPages) {
  const grouped = new Map();
  for (const proposedPage of proposalPages) {
    const pageKey = `${canonical(proposedPage.kind)}\u001f${canonical(proposedPage.title)}`;
    const representationKey = `${representationPart(proposedPage.kind)}\u001f${representationPart(proposedPage.title)}`;
    let group = grouped.get(pageKey);
    if (!group) {
      group = {
        pageKey,
        representationKey,
        kind: proposedPage.kind,
        title: proposedPage.title,
        facts: [],
        procedures: [],
      };
      grouped.set(pageKey, group);
    } else if (compare(representationKey, group.representationKey) < 0) {
      group.representationKey = representationKey;
      group.kind = proposedPage.kind;
      group.title = proposedPage.title;
    }
    group.facts.push(...proposedPage.facts);
    group.procedures.push(...proposedPage.procedures);
  }
  return [...grouped.values()]
    .sort((left, right) => compare(left.pageKey, right.pageKey))
    .map((group) => ({
      kind: group.kind,
      title: group.title,
      facts: [...group.facts].sort((left, right) =>
        compare(factProposalOrderKey(left), factProposalOrderKey(right))),
      procedures: [...group.procedures].sort((left, right) =>
        compare(procedureProposalOrderKey(left), procedureProposalOrderKey(right))),
    }));
}

function stableSort(snapshot) {
  snapshot.sources.sort((left, right) => compare(left.artifactDigest, right.artifactDigest));
  (snapshot.evidenceSets ?? []).sort((left, right) => compare(evidenceSetOrderKey(left), evidenceSetOrderKey(right)));
  snapshot.pages.sort((left, right) => compare(`${canonical(left.kind)}\u001f${canonical(left.title)}`, `${canonical(right.kind)}\u001f${canonical(right.title)}`));
  for (const page of snapshot.pages) {
    page.facts.sort((left, right) => compare(canonical(left.text), canonical(right.text)));
    page.procedures.sort((left, right) => compare(procedureKey(left), procedureKey(right)));
  }
  snapshot.cases.sort((left, right) => compare(`${canonical(left.condition)}\u001f${canonical(left.outcome)}`, `${canonical(right.condition)}\u001f${canonical(right.outcome)}`));
  snapshot.openQuestions.sort((left, right) => compare(canonical(left.question), canonical(right.question)));
  return snapshot;
}

function buildSnapshotFromValidatedProposals({ previousSnapshot, proposals, source }) {
  const migratedPrevious = previousSnapshot === null
    ? null
    : migrateAssistedWikiSnapshot(previousSnapshot);
  if (migratedPrevious?.sources.some((entry) => entry.artifactDigest === source.artifactDigest)) {
    fail("source artifact was already imported; a new play run is required for another revision");
  }
  if (migratedPrevious !== null) consolidateExistingKnowledge(migratedPrevious);
  const snapshot = migratedPrevious === null
    ? { schemaVersion: ASSISTED_WIKI_SCHEMA_VERSION, track: "ASSISTED", revision: 1, sources: [], pages: [], cases: [], openQuestions: [], evidenceSets: [] }
    : { ...migratedPrevious, revision: migratedPrevious.revision + 1 };

  if (snapshot.sources.length >= LIMITS.sources) fail("source limit reached");
  snapshot.sources.push({
    artifactDigest: source.artifactDigest,
    status: source.status,
    explorationTrack: source.explorationTrack,
    knowledgeAttestation: source.knowledgeAttestation,
    provenance: structuredClone(source.provenance),
    availableFrameIds: [...source.availableFrameIds].sort(compare),
  });
  const evidenceStore = createEvidenceStore(snapshot);

  const pages = new Map(snapshot.pages.map((page) => [`${canonical(page.kind)}\u001f${canonical(page.title)}`, page]));
  for (const proposedPage of orderedProposalPages(proposals.flatMap((proposal) => proposal.pages))) {
    const pageKey = `${canonical(proposedPage.kind)}\u001f${canonical(proposedPage.title)}`;
    let page = pages.get(pageKey);
    if (!page) {
      if (snapshot.pages.length >= LIMITS.pages) fail("page limit reached");
      page = { id: stableId("page", proposedPage.kind, proposedPage.title), kind: proposedPage.kind, title: proposedPage.title, facts: [], procedures: [] };
      snapshot.pages.push(page);
      pages.set(pageKey, page);
    }
    const facts = indexByMeaning(page.facts, factMergeKey);
    for (const proposedFact of proposedPage.facts) {
      const factKey = factMergeKey(proposedFact);
      const proposedEvidence = sourceEvidence(proposedFact.evidenceFrameIds, source.artifactDigest);
      const duplicate = {
        evidenceRefs: proposedEvidence,
        confidence: proposedFact.confidence === "OBSERVED" ? 1 : 0.5,
      };
      if (!mergeIntoMeaningBucket(facts, factKey, duplicate, { fact: true, evidenceStore })) {
        if (page.facts.length >= LIMITS.facts) fail("fact limit reached");
        const fact = {
          id: stableId("fact", page.id, proposedFact.text),
          text: proposedFact.text,
          confidence: duplicate.confidence,
          evidenceRefs: proposedEvidence,
        };
        page.facts.push(fact);
        addToMeaningBucket(facts, factKey, fact);
      }
    }
    const procedures = indexByMeaning(page.procedures, procedureMergeKey);
    for (const proposedProcedure of proposedPage.procedures) {
      const key = procedureMergeKey(proposedProcedure);
      const proposedEvidence = sourceEvidence(proposedProcedure.evidenceFrameIds, source.artifactDigest);
      if (!mergeIntoMeaningBucket(procedures, key, { evidenceRefs: proposedEvidence }, { evidenceStore })) {
        if (page.procedures.length >= LIMITS.procedures) fail("procedure limit reached");
        const steps = proposedProcedure.steps.map((step) => ({ instruction: step.instruction, expectedCue: step.expectedCue }));
        const procedure = {
          id: stableId("procedure", page.id, proposedProcedure.title, ...steps.flatMap((step) => [step.instruction, step.expectedCue])),
          title: proposedProcedure.title,
          steps,
          evidenceRefs: proposedEvidence,
        };
        page.procedures.push(procedure);
        addToMeaningBucket(procedures, key, procedure);
      }
    }
  }

  const cases = indexByMeaning(snapshot.cases, caseMergeKey);
  for (const proposedCase of proposals.flatMap((proposal) => proposal.cases).sort((left, right) =>
    compare(caseProposalOrderKey(left), caseProposalOrderKey(right)))) {
    const key = caseMergeKey(proposedCase);
    const proposedEvidence = sourceEvidence(proposedCase.evidenceFrameIds, source.artifactDigest);
    if (!mergeIntoMeaningBucket(cases, key, { evidenceRefs: proposedEvidence }, { evidenceStore })) {
      if (snapshot.cases.length >= LIMITS.cases) fail("case limit reached");
      const entry = { id: stableId("case", proposedCase.condition, proposedCase.outcome), title: proposedCase.title, condition: proposedCase.condition, outcome: proposedCase.outcome, evidenceRefs: proposedEvidence };
      snapshot.cases.push(entry);
      addToMeaningBucket(cases, key, entry);
    }
  }

  const questions = indexByMeaning(snapshot.openQuestions, questionMergeKey);
  for (const proposedQuestion of proposals.flatMap((proposal) => proposal.openQuestions).sort((left, right) =>
    compare(questionProposalOrderKey(left), questionProposalOrderKey(right)))) {
    const key = questionMergeKey(proposedQuestion);
    const proposedEvidence = sourceEvidence(proposedQuestion.evidenceFrameIds, source.artifactDigest);
    if (!mergeIntoMeaningBucket(questions, key, { evidenceRefs: proposedEvidence }, { evidenceStore })) {
      if (snapshot.openQuestions.length >= LIMITS.questions) fail("open-question limit reached");
      const entry = { id: stableId("question", proposedQuestion.question), question: proposedQuestion.question, evidenceRefs: proposedEvidence };
      snapshot.openQuestions.push(entry);
      addToMeaningBucket(questions, key, entry);
    }
  }
  evidenceStore.flush();
  stableSort(snapshot);
  validateAssistedWikiSnapshot(snapshot);
  return snapshot;
}

export function buildAssistedWikiSnapshot({ previousSnapshot = null, proposal, source }) {
  validateKnowledgeProposal(proposal, source);
  return buildSnapshotFromValidatedProposals({ previousSnapshot, proposals: [proposal], source });
}

export function buildAssistedWikiSnapshotFromDeltas({ previousSnapshot = null, source, deltas }) {
  validateSource(source);
  const sourceFrameIds = new Set(source.availableFrameIds);
  const orderedDeltas = boundedArray(deltas, LIMITS.modelDeltas, "deltas")
    .map((delta, index) => {
      const fields = exactRecord(delta, ["batchOrdinal", "frameIds", "proposal"], `deltas[${index}]`);
      if (!Number.isSafeInteger(fields.batchOrdinal) || fields.batchOrdinal < 1) {
        fail(`deltas[${index}].batchOrdinal is invalid`);
      }
      const frameIds = validateEvidence(
        fields.frameIds,
        sourceFrameIds,
        `deltas[${index}].frameIds`,
        LIMITS.deltaFrames,
      );
      if (frameIds.length === 0) fail(`deltas[${index}].frameIds cannot be empty`);
      const batchSource = {
        ...source,
        provenance: structuredClone(source.provenance),
        availableFrameIds: frameIds,
      };
      validateKnowledgeProposal(fields.proposal, batchSource);
      return { batchOrdinal: fields.batchOrdinal, frameIds, proposal: fields.proposal };
    })
    .sort((left, right) => left.batchOrdinal - right.batchOrdinal);
  if (orderedDeltas.length === 0) fail("deltas cannot be empty");

  const coveredFrames = new Set();
  orderedDeltas.forEach((delta, index) => {
    if (delta.batchOrdinal !== index + 1) fail("delta batch ordinals must be contiguous from 1");
    for (const frameId of delta.frameIds) {
      if (coveredFrames.has(frameId)) fail("delta batches contain a duplicate frame");
      coveredFrames.add(frameId);
    }
  });
  if (
    coveredFrames.size !== source.availableFrameIds.length ||
    source.availableFrameIds.some((frameId) => !coveredFrames.has(frameId))
  ) fail("delta batches must cover every source frame exactly once");

  return buildSnapshotFromValidatedProposals({
    previousSnapshot,
    proposals: orderedDeltas.map((delta) => delta.proposal),
    source,
  });
}

function markdown(value) {
  return value.replace(/[\\`*_{}[\]<>#|]/gu, (character) => `\\${character}`);
}

function evidenceLabel(reference) {
  return `${reference.sourceDigest.slice(0, 12)}/${reference.frameId}`;
}

function evidenceSetsFor(snapshot, ownerId) {
  return snapshot.evidenceSets.filter((entry) => entry.ownerId === ownerId);
}

function allItemEvidence(snapshot, item) {
  return unionEvidenceRefs(
    item.evidenceRefs,
    evidenceSetsFor(snapshot, item.id).flatMap((entry) =>
      entry.frameIds.map((frameId) => ({ sourceDigest: entry.sourceDigest, frameId }))),
  );
}

function renderedEvidence(snapshot, item, relativeEvidenceRoot) {
  const extendedCount = evidenceSetsFor(snapshot, item.id)
    .reduce((total, entry) => total + entry.frameIds.length, 0);
  if (extendedCount === 0) {
    return item.evidenceRefs.length > 0
      ? item.evidenceRefs.map(evidenceLabel).map(markdown).join(", ")
      : "none";
  }
  const total = item.evidenceRefs.length + extendedCount;
  return `${total} total (${item.evidenceRefs.length} direct, ${extendedCount} extended; [full evidence](${relativeEvidenceRoot}/${item.id}.md))`;
}

function allKnowledgeItems(snapshot) {
  return [
    ...snapshot.pages.flatMap((page) => [...page.facts, ...page.procedures]),
    ...snapshot.cases,
    ...snapshot.openQuestions,
  ];
}

export function renderAssistedWiki(inputSnapshot) {
  const snapshot = migrateAssistedWikiSnapshot(inputSnapshot);
  const index = [
    "# Assisted Wiki",
    "",
    "> This is cumulative assisted knowledge, not STRICT evaluation ground truth.",
    "",
    `Revision: ${snapshot.revision}`,
    "",
    "## Pages",
    "",
    ...(snapshot.pages.length > 0 ? snapshot.pages.map((page) => `- [${markdown(page.title)}](pages/${page.id}.md) — ${markdown(page.kind)}`) : ["- None"]),
    "",
    "## Cases",
    "",
  ];
  if (snapshot.cases.length === 0) index.push("- None", "");
  for (const entry of snapshot.cases) {
    index.push(
      `### ${markdown(entry.title)}`,
      "",
      `- Condition: ${markdown(entry.condition)}`,
      `- Outcome: ${markdown(entry.outcome)}`,
      `- Evidence: ${renderedEvidence(snapshot, entry, "evidence")}`,
      "",
    );
  }
  index.push(
    "## Open questions",
    "",
    ...(snapshot.openQuestions.length > 0
      ? snapshot.openQuestions.map((entry) => `- ${markdown(entry.question)}${entry.evidenceRefs.length > 0 ? ` (${renderedEvidence(snapshot, entry, "evidence")})` : ""}`)
      : ["- None"]),
    "",
  );
  const files = [{ path: "index.md", content: index.join("\n") }];
  for (const page of snapshot.pages) {
    const lines = [
      `# ${markdown(page.title)}`,
      "",
      `Kind: ${markdown(page.kind)}`,
      "",
      "## Facts",
      "",
      ...(page.facts.length > 0
        ? page.facts.map((fact) => `- ${markdown(fact.text)} (confidence ${fact.confidence}; evidence ${renderedEvidence(snapshot, fact, "../evidence")})`)
        : ["- None"]),
      "",
      "## Procedures",
      "",
    ];
    if (page.procedures.length === 0) lines.push("- None", "");
    for (const procedure of page.procedures) {
      lines.push(`### ${markdown(procedure.title)}`, "");
      procedure.steps.forEach((step, index) => lines.push(`${index + 1}. ${markdown(step.instruction)} — Expected: ${markdown(step.expectedCue)}`));
      lines.push("", `Evidence: ${renderedEvidence(snapshot, procedure, "../evidence")}`, "");
    }
    files.push({ path: `pages/${page.id}.md`, content: `${lines.join("\n")}\n` });
  }
  const items = new Map(allKnowledgeItems(snapshot).map((item) => [item.id, item]));
  const sourceByDigest = new Map(snapshot.sources.map((source) => [source.artifactDigest, source]));
  const ownersWithExtendedEvidence = [...new Set(snapshot.evidenceSets.map((entry) => entry.ownerId))].sort(compare);
  for (const ownerId of ownersWithExtendedEvidence) {
    const item = items.get(ownerId);
    const grouped = new Map();
    for (const reference of allItemEvidence(snapshot, item)) {
      const frameIds = grouped.get(reference.sourceDigest) ?? [];
      frameIds.push(reference.frameId);
      grouped.set(reference.sourceDigest, frameIds);
    }
    const lines = [
      `# Evidence for ${markdown(ownerId)}`,
      "",
      `Total references: ${allItemEvidence(snapshot, item).length}`,
      "",
    ];
    for (const [sourceDigest, frameIds] of [...grouped.entries()].sort((left, right) => compare(left[0], right[0]))) {
      const source = sourceByDigest.get(sourceDigest);
      lines.push(
        `## ${markdown(sourceDigest)}`,
        "",
        `Source status: ${source.status}; track: ${source.explorationTrack}; attestation: ${source.knowledgeAttestation}`,
        "",
        ...frameIds.map((frameId) => `- ${frameId}`),
        "",
      );
    }
    files.push({ path: `evidence/${ownerId}.md`, content: `${lines.join("\n")}\n` });
  }
  return { files };
}

function safeForPlayer(value) {
  return !URL.test(value) && !ENTROPY.test(value) && !CONTEXT_PATH.test(value) && !CONTEXT_COORDINATE.test(value) &&
    !CONTEXT_KEY.test(value) && !CONTEXT_INTERNAL.test(value);
}

function appendGuidance(context, item, maximumBytes) {
  if (context.guidance.length >= 32 || !safeForPlayer(item.title) || !safeForPlayer(item.body)) return false;
  context.guidance.push(item);
  if (byteLength(context) <= maximumBytes) return true;
  context.guidance.pop();
  return false;
}

export function createPlayerKnowledgeContext(snapshot, { maxBytes = 8192 } = {}) {
  validateAssistedWikiSnapshot(snapshot);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 128 || maxBytes > 8192) fail("maxBytes must be an integer from 128 to 8192");
  const contextSnapshot = stableSort(consolidateExistingKnowledge(migrateAssistedWikiSnapshot(snapshot)));
  validateAssistedWikiSnapshot(contextSnapshot);
  const context = {
    schemaVersion: PLAYER_KNOWLEDGE_CONTEXT_VERSION,
    track: "ASSISTED",
    revision: contextSnapshot.revision,
    guidance: [],
  };
  if (byteLength(context) > maxBytes) fail("knowledge context envelope exceeds maxBytes");
  if (contextSnapshot.sources.some((source) => source.status === "PARTIAL")) {
    appendGuidance(context, {
      kind: "OPEN_QUESTION",
      title: "Coverage",
      body: "Prior observations were incomplete; unseen content remains unknown.",
    }, maxBytes);
  }
  for (const entry of contextSnapshot.openQuestions) {
    appendGuidance(context, { kind: "OPEN_QUESTION", title: "Open question", body: entry.question }, maxBytes);
  }
  for (const entry of contextSnapshot.cases) {
    appendGuidance(context, { kind: "CASE", title: entry.title, body: `When ${entry.condition} Observed outcome: ${entry.outcome}` }, maxBytes);
  }
  for (const page of contextSnapshot.pages) {
    for (const procedure of page.procedures) {
      const body = procedure.steps.map((step, index) => `${index + 1}. ${step.instruction} Expected visible cue: ${step.expectedCue}`).join(" ");
      appendGuidance(context, { kind: "PROCEDURE", title: procedure.title, body }, maxBytes);
    }
  }
  for (const page of contextSnapshot.pages) {
    for (const fact of page.facts) {
      if (fact.confidence === 1) appendGuidance(context, { kind: "FACT", title: page.title, body: fact.text }, maxBytes);
    }
  }
  return JSON.stringify(context);
}

export async function persistAssistedWikiSnapshot(directory, snapshot) {
  validateAssistedWikiSnapshot(snapshot);
  if (typeof directory !== "string" || !path.isAbsolute(directory)) fail("directory must be absolute");
  await mkdir(directory, { recursive: true });
  const output = path.join(directory, `assisted-wiki-r${String(snapshot.revision).padStart(6, "0")}.json`);
  await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600, flush: true });
  return output;
}

export const assistedWikiLimits = LIMITS;
