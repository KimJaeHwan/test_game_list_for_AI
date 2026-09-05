import {
  ENTITY_TYPES, EVIDENCE_NEEDED, FAILURE_ACTIONS, HEX_64, HIGH_ENTROPY, KEY_MACRO,
  PREDICATES, PRIORITIES, PROCEDURE_VERBS, QUESTION_CODES, REINSPECTION_CONTRASTS,
  REINSPECTION_OPERATIONS, SAFE_ID, SCOPE_KINDS, URL_LIKE,
  assertArray, assertEnum, assertExact, assertInteger, assertObject,
  assertSafeSemanticText, assertString, assertUnique, canonicalJson, deepFreeze, fail, jsonCopy,
} from "./core.mjs";

export function validateTranscriptBase(transcript, { allowAttestation = true } = {}) {
  assertExact(transcript, ["schemaVersion", "transcriptId", "artifactDigest", "segments"], allowAttestation ? ["attestation"] : [], "transcript");
  if (transcript.schemaVersion !== "1.0") fail("transcript.schemaVersion: unsupported version");
  assertString(transcript.transcriptId, "transcript.transcriptId", { max: 96, pattern: SAFE_ID });
  assertString(transcript.artifactDigest, "transcript.artifactDigest", { min: 64, max: 64, pattern: HEX_64 });
  assertArray(transcript.segments, "transcript.segments", { min: 1, max: 1000 });
  transcript.segments.forEach((segment, index) => {
    assertExact(segment, ["observationId", "text"], [], `transcript.segments[${index}]`);
    assertString(segment.observationId, `transcript.segments[${index}].observationId`, { max: 96, pattern: SAFE_ID });
    assertSafeSemanticText(segment.text, `transcript.segments[${index}].text`, 2000);
  });
}

export function validateScope(scope) {
  assertObject(scope, "claim.scope");
  assertEnum(scope.kind, SCOPE_KINDS, "claim.scope.kind");
  if (scope.kind === "rule") {
    assertExact(scope, ["kind", "groupRef", "supportingArtifactDigests"], [], "claim.scope");
    assertString(scope.groupRef, "claim.scope.groupRef", { max: 96, pattern: SAFE_ID });
    assertArray(scope.supportingArtifactDigests, "claim.scope.supportingArtifactDigests", { min: 2, max: 100 });
    scope.supportingArtifactDigests.forEach((digest, index) => {
      assertString(digest, `claim.scope.supportingArtifactDigests[${index}]`, { min: 64, max: 64, pattern: HEX_64 });
    });
    assertUnique(scope.supportingArtifactDigests, "claim.scope.supportingArtifactDigests");
  } else {
    assertExact(scope, ["kind", "artifactDigests"], [], "claim.scope");
    assertArray(scope.artifactDigests, "claim.scope.artifactDigests", { min: 1, max: 100 });
    scope.artifactDigests.forEach((digest, index) => {
      assertString(digest, `claim.scope.artifactDigests[${index}]`, { min: 64, max: 64, pattern: HEX_64 });
    });
    assertUnique(scope.artifactDigests, "claim.scope.artifactDigests");
  }
}

export function validateEntity(entity) {
  assertExact(entity, ["entityId", "type", "name", "nameEvidenceId", "status"], ["aliases", "submitterId", "submissionOrder"], "entity");
  assertString(entity.entityId, "entity.entityId", { max: 96, pattern: SAFE_ID });
  assertEnum(entity.type, ENTITY_TYPES, "entity.type");
  entity.name = assertSafeSemanticText(entity.name, "entity.name", 120);
  assertString(entity.nameEvidenceId, "entity.nameEvidenceId", { max: 96, pattern: SAFE_ID });
  if (entity.status !== "draft" && entity.status !== "approved") fail("entity.status: invalid status");
  if (entity.aliases !== undefined) {
    assertArray(entity.aliases, "entity.aliases", { max: 20 });
    entity.aliases = entity.aliases.map((alias, index) => assertSafeSemanticText(alias, `entity.aliases[${index}]`, 120));
  }
}

export function validateClaim(claim) {
  assertExact(claim, ["claimId", "subjectEntityId", "predicate", "object", "scope", "evidenceIds", "status"], ["submitterId", "submissionOrder"], "claim");
  assertString(claim.claimId, "claim.claimId", { max: 96, pattern: SAFE_ID });
  assertString(claim.subjectEntityId, "claim.subjectEntityId", { max: 96, pattern: SAFE_ID });
  assertEnum(claim.predicate, PREDICATES, "claim.predicate");
  assertObject(claim.object, "claim.object");
  if (claim.object.kind === "entity") {
    assertExact(claim.object, ["kind", "entityId"], [], "claim.object");
    assertString(claim.object.entityId, "claim.object.entityId", { max: 96, pattern: SAFE_ID });
  } else if (claim.object.kind === "literal") {
    assertExact(claim.object, ["kind", "value"], [], "claim.object");
    claim.object.value = assertSafeSemanticText(claim.object.value, "claim.object.value", 160);
  } else {
    fail("claim.object.kind: invalid kind");
  }
  validateScope(claim.scope);
  assertArray(claim.evidenceIds, "claim.evidenceIds", { min: 1, max: 100 });
  claim.evidenceIds.forEach((id, index) => assertString(id, `claim.evidenceIds[${index}]`, { max: 96, pattern: SAFE_ID }));
  assertUnique(claim.evidenceIds, "claim.evidenceIds");
  if (claim.status !== "draft" && claim.status !== "approved") fail("claim.status: invalid status");
}

export function validateProcedure(procedure) {
  assertExact(procedure, ["procedureId", "status", "steps", "evidenceIds"], ["submitterId", "submissionOrder"], "procedure");
  assertString(procedure.procedureId, "procedure.procedureId", { max: 96, pattern: SAFE_ID });
  if (procedure.status !== "draft" && procedure.status !== "approved") fail("procedure.status: invalid status");
  assertArray(procedure.steps, "procedure.steps", { min: 1, max: 50 });
  procedure.steps.forEach((step, index) => {
    assertExact(step,
      ["order", "verb", "preconditionClaimIds", "expectedClaimIds", "consumesEntityIds", "producesEntityIds", "onFailure"],
      ["targetEntityId"], `procedure.steps[${index}]`);
    assertInteger(step.order, `procedure.steps[${index}].order`, 1, 50);
    assertEnum(step.verb, PROCEDURE_VERBS, `procedure.steps[${index}].verb`);
    if (step.targetEntityId !== undefined) {
      assertString(step.targetEntityId, `procedure.steps[${index}].targetEntityId`, { max: 96, pattern: SAFE_ID });
    }
    for (const field of ["preconditionClaimIds", "expectedClaimIds", "consumesEntityIds", "producesEntityIds"]) {
      assertArray(step[field], `procedure.steps[${index}].${field}`, { max: 50 });
      step[field].forEach((id, idIndex) => {
        assertString(id, `procedure.steps[${index}].${field}[${idIndex}]`, { max: 96, pattern: SAFE_ID });
      });
      assertUnique(step[field], `procedure.steps[${index}].${field}`);
    }
    assertEnum(step.onFailure, FAILURE_ACTIONS, `procedure.steps[${index}].onFailure`);
  });
  assertUnique(procedure.steps.map((step) => step.order), "procedure.steps.order");
  assertArray(procedure.evidenceIds, "procedure.evidenceIds", { min: 1, max: 100 });
  procedure.evidenceIds.forEach((id, index) => {
    assertString(id, `procedure.evidenceIds[${index}]`, { max: 96, pattern: SAFE_ID });
  });
  assertUnique(procedure.evidenceIds, "procedure.evidenceIds");
  const withoutDigests = canonicalJson(procedure).replace(/[a-f0-9]{64}/g, "");
  if (KEY_MACRO.test(withoutDigests) || URL_LIKE.test(withoutDigests) || HIGH_ENTROPY.test(withoutDigests)) {
    fail("procedure: macro, URL, or opaque payload forbidden");
  }
  return true;
}

export function validateContradiction(item) {
  assertExact(item, ["contradictionId", "claimIds", "status"], ["resolutionClaimId", "submitterId", "submissionOrder"], "contradiction");
  assertString(item.contradictionId, "contradiction.contradictionId", { max: 96, pattern: SAFE_ID });
  assertArray(item.claimIds, "contradiction.claimIds", { min: 2, max: 20 });
  item.claimIds.forEach((id, index) => assertString(id, `contradiction.claimIds[${index}]`, { max: 96, pattern: SAFE_ID }));
  assertUnique(item.claimIds, "contradiction.claimIds");
  if (item.status !== "open" && item.status !== "resolved") fail("contradiction.status: invalid status");
  if (item.status === "resolved" && !item.resolutionClaimId) fail("contradiction: resolved requires resolutionClaimId");
  if (item.status === "open" && item.resolutionClaimId !== undefined) fail("contradiction: open cannot have resolutionClaimId");
  if (item.resolutionClaimId !== undefined) {
    assertString(item.resolutionClaimId, "contradiction.resolutionClaimId", { max: 96, pattern: SAFE_ID });
  }
}

export function validateUnknown(item) {
  assertExact(item, ["unknownId", "questionCode", "status", "relatedClaimIds"], ["subjectEntityId", "resolvedByClaimId", "submitterId", "submissionOrder"], "unknown");
  assertString(item.unknownId, "unknown.unknownId", { max: 96, pattern: SAFE_ID });
  assertEnum(item.questionCode, QUESTION_CODES, "unknown.questionCode");
  if (item.subjectEntityId !== undefined) {
    assertString(item.subjectEntityId, "unknown.subjectEntityId", { max: 96, pattern: SAFE_ID });
  }
  if (!new Set(["open", "queued", "resolved"]).has(item.status)) fail("unknown.status: invalid status");
  assertArray(item.relatedClaimIds, "unknown.relatedClaimIds", { max: 50 });
  item.relatedClaimIds.forEach((id, index) => assertString(id, `unknown.relatedClaimIds[${index}]`, { max: 96, pattern: SAFE_ID }));
  assertUnique(item.relatedClaimIds, "unknown.relatedClaimIds");
  if (item.status === "resolved" && !item.resolvedByClaimId) fail("unknown: resolved requires resolvedByClaimId");
  if (item.status !== "resolved" && item.resolvedByClaimId !== undefined) fail("unknown: unresolved cannot have resolvedByClaimId");
  if (item.resolvedByClaimId !== undefined) {
    assertString(item.resolvedByClaimId, "unknown.resolvedByClaimId", { max: 96, pattern: SAFE_ID });
  }
}

export function validateReinspectionRequest(request) {
  assertExact(request,
    ["schemaVersion", "requestId", "operation", "contrast", "evidenceNeeded", "maxAttempts", "priority", "blockedKnowledgeRefs"],
    ["subjectEntityId"], "reinspectionRequest");
  if (request.schemaVersion !== "1.0") fail("reinspectionRequest.schemaVersion: unsupported version");
  assertString(request.requestId, "reinspectionRequest.requestId", { max: 96, pattern: SAFE_ID });
  if (request.subjectEntityId !== undefined) {
    assertString(request.subjectEntityId, "reinspectionRequest.subjectEntityId", { max: 96, pattern: SAFE_ID });
  }
  assertEnum(request.operation, REINSPECTION_OPERATIONS, "reinspectionRequest.operation");
  assertEnum(request.contrast, REINSPECTION_CONTRASTS, "reinspectionRequest.contrast");
  assertEnum(request.evidenceNeeded, EVIDENCE_NEEDED, "reinspectionRequest.evidenceNeeded");
  assertInteger(request.maxAttempts, "reinspectionRequest.maxAttempts", 1, 3);
  assertEnum(request.priority, PRIORITIES, "reinspectionRequest.priority");
  assertArray(request.blockedKnowledgeRefs, "reinspectionRequest.blockedKnowledgeRefs", { max: 20 });
  request.blockedKnowledgeRefs.forEach((id, index) => {
    assertString(id, `reinspectionRequest.blockedKnowledgeRefs[${index}]`, { max: 96, pattern: SAFE_ID });
  });
  assertUnique(request.blockedKnowledgeRefs, "reinspectionRequest.blockedKnowledgeRefs");
  return deepFreeze(jsonCopy(request));
}
