import {
  canonicalJson, deepFreeze, normalizeText, remapList, sortByCanonical,
} from "./core.mjs";

function localId(kind, index) {
  return `${kind}-${String(index + 1).padStart(3, "0")}`;
}

function closureKey(closure) {
  return canonicalJson({
    artifactDigest: closure.artifactDigest,
    observationIds: [...closure.observationIds].sort(),
    frameRefs: [...closure.frameRefs].sort(),
    actionRefs: [...closure.actionRefs].sort(),
    transcriptDigest: closure.transcriptDigest,
    status: closure.status,
  });
}

export function normalizeWorkspace(source) {
  const sortedClosures = [...source.closures].sort((a, b) => {
    const aa = closureKey(a);
    const bb = closureKey(b);
    return aa < bb ? -1 : aa > bb ? 1 : 0;
  });
  const evidenceMap = new Map(sortedClosures.map((entry, index) => [entry.evidenceId, localId("evidence", index)]));
  const evidence = sortedClosures.map((entry, index) => ({
    evidenceId: localId("evidence", index),
    artifactDigest: entry.artifactDigest,
    observationIds: [...entry.observationIds].sort(),
    frameRefs: [...entry.frameRefs].sort(),
    actionRefs: [...entry.actionRefs].sort(),
    transcriptDigest: entry.transcriptDigest,
    status: entry.status,
  }));

  const entityStubs = source.entities.map((entry) => ({
    originalId: entry.entityId,
    type: entry.type,
    name: normalizeText(entry.name),
    aliases: [...(entry.aliases ?? [])].map(normalizeText).sort(),
    nameEvidenceId: evidenceMap.get(entry.nameEvidenceId),
    status: entry.status,
  })).sort((a, b) => {
    const aa = canonicalJson({
      type: a.type, name: a.name, aliases: a.aliases,
      nameEvidenceId: a.nameEvidenceId, status: a.status,
    });
    const bb = canonicalJson({
      type: b.type, name: b.name, aliases: b.aliases,
      nameEvidenceId: b.nameEvidenceId, status: b.status,
    });
    return aa < bb ? -1 : aa > bb ? 1 : 0;
  });
  const entityMap = new Map(entityStubs.map((entry, index) => [entry.originalId, localId("entity", index)]));
  const entities = entityStubs.map((entry, index) => ({
    entityId: localId("entity", index),
    type: entry.type,
    name: entry.name,
    aliases: entry.aliases,
    nameEvidenceId: entry.nameEvidenceId,
    status: entry.status,
  }));

  const claimStubs = source.claims.map((entry) => ({
    originalId: entry.claimId,
    subjectEntityId: entityMap.get(entry.subjectEntityId),
    predicate: entry.predicate,
    object: entry.object.kind === "entity"
      ? { kind: "entity", entityId: entityMap.get(entry.object.entityId) }
      : { kind: "literal", value: normalizeText(entry.object.value) },
    scope: entry.scope.kind === "rule"
      ? {
          kind: "rule",
          groupRef: entry.scope.groupRef,
          supportingArtifactDigests: [...entry.scope.supportingArtifactDigests].sort(),
        }
      : { kind: entry.scope.kind, artifactDigests: [...entry.scope.artifactDigests].sort() },
    evidenceIds: remapList(entry.evidenceIds, evidenceMap, "claim.evidenceIds"),
    status: entry.status,
  })).sort((a, b) => {
    const aa = canonicalJson({
      subjectEntityId: a.subjectEntityId, predicate: a.predicate, object: a.object,
      scope: a.scope, evidenceIds: a.evidenceIds, status: a.status,
    });
    const bb = canonicalJson({
      subjectEntityId: b.subjectEntityId, predicate: b.predicate, object: b.object,
      scope: b.scope, evidenceIds: b.evidenceIds, status: b.status,
    });
    return aa < bb ? -1 : aa > bb ? 1 : 0;
  });
  const claimMap = new Map(claimStubs.map((entry, index) => [entry.originalId, localId("claim", index)]));
  const claims = claimStubs.map((entry, index) => ({
    claimId: localId("claim", index),
    subjectEntityId: entry.subjectEntityId,
    predicate: entry.predicate,
    object: entry.object,
    scope: entry.scope,
    evidenceIds: entry.evidenceIds,
    status: entry.status,
  }));

  const procedures = source.procedures.map((entry) => ({
    status: entry.status,
    steps: [...entry.steps].sort((a, b) => a.order - b.order).map((step, index) => ({
      order: index + 1,
      verb: step.verb,
      ...(step.targetEntityId ? { targetEntityId: entityMap.get(step.targetEntityId) } : {}),
      preconditionClaimIds: remapList(step.preconditionClaimIds, claimMap, "procedure.preconditionClaimIds"),
      expectedClaimIds: remapList(step.expectedClaimIds, claimMap, "procedure.expectedClaimIds"),
      consumesEntityIds: remapList(step.consumesEntityIds, entityMap, "procedure.consumesEntityIds"),
      producesEntityIds: remapList(step.producesEntityIds, entityMap, "procedure.producesEntityIds"),
      onFailure: step.onFailure,
    })),
    evidenceIds: remapList(entry.evidenceIds, evidenceMap, "procedure.evidenceIds"),
  }));
  const normalizedProcedures = sortByCanonical(procedures)
    .map((entry, index) => ({ procedureId: localId("procedure", index), ...entry }));

  const contradictions = sortByCanonical(source.contradictions.map((entry) => ({
    claimIds: remapList(entry.claimIds, claimMap, "contradiction.claimIds"),
    status: entry.status,
    ...(entry.resolutionClaimId ? { resolutionClaimId: claimMap.get(entry.resolutionClaimId) } : {}),
  }))).map((entry, index) => ({ contradictionId: localId("contradiction", index), ...entry }));

  const unknowns = sortByCanonical(source.unknowns.map((entry) => ({
    questionCode: entry.questionCode,
    status: entry.status,
    relatedClaimIds: remapList(entry.relatedClaimIds, claimMap, "unknown.relatedClaimIds"),
    ...(entry.subjectEntityId ? { subjectEntityId: entityMap.get(entry.subjectEntityId) } : {}),
    ...(entry.resolvedByClaimId ? { resolvedByClaimId: claimMap.get(entry.resolvedByClaimId) } : {}),
  }))).map((entry, index) => ({ unknownId: localId("unknown", index), ...entry }));

  const reinspectionQueue = sortByCanonical(source.reinspection.map((entry) => ({
    schemaVersion: entry.schemaVersion,
    operation: entry.operation,
    contrast: entry.contrast,
    evidenceNeeded: entry.evidenceNeeded,
    maxAttempts: entry.maxAttempts,
    priority: entry.priority,
    blockedKnowledgeRefs: entry.blockedKnowledgeRefs
      .map((id) => claimMap.get(id) ?? entityMap.get(id))
      .sort(),
    ...(entry.subjectEntityId ? { subjectEntityId: entityMap.get(entry.subjectEntityId) } : {}),
  }))).map((entry, index) => ({ requestId: localId("request", index), ...entry }));

  return deepFreeze({
    schemaVersion: "1.0",
    evidence,
    entities,
    claims,
    procedures: normalizedProcedures,
    contradictions,
    unknowns,
    reinspectionQueue,
  });
}
