import {
  SAFE_ID, assertExact, assertString, assertUnique, deepFreeze, digestCanonical,
  fail, jsonCopy, normalizeText,
} from "./core.mjs";
import { ContentAddressedEvidenceStore } from "./handoff.mjs";
import {
  validateClaim, validateContradiction, validateEntity, validateProcedure,
  validateReinspectionRequest, validateTranscriptBase, validateUnknown,
} from "./knowledge-schema.mjs";
import { unsignedTranscript, verifyTranscriptAttestation } from "./transcript.mjs";
import { normalizeWorkspace } from "./normalizer.mjs";

export class WikiWorkspace {
  #store;
  #transcriptPublicKey;
  #closures = new Map();
  #entities = [];
  #claims = [];
  #procedures = [];
  #contradictions = [];
  #unknowns = [];
  #reinspection = [];
  #scratchNotes = new Map();

  constructor({ store, transcriptPublicKey }) {
    if (!(store instanceof ContentAddressedEvidenceStore)) {
      fail("workspace.store: ContentAddressedEvidenceStore required");
    }
    this.#store = store;
    this.#transcriptPublicKey = transcriptPublicKey;
  }

  addTranscript(transcript) {
    validateTranscriptBase(transcript);
    if (!this.#store.has(transcript.artifactDigest)) fail("transcript: unknown artifactDigest");
    const observationIds = transcript.segments.map((segment) => segment.observationId);
    assertUnique(observationIds, "transcript.segments.observationId");
    const frameRefs = [];
    const actionRefs = [];
    for (const observationId of observationIds) {
      const observation = this.#store.observation(transcript.artifactDigest, observationId);
      if (!observation) fail(`transcript: unknown observation '${observationId}'`);
      for (const actionRef of observation.precedingActionRefs) {
        if (!this.#store.action(transcript.artifactDigest, actionRef)) {
          fail(`transcript: unsealed action '${actionRef}'`);
        }
        actionRefs.push(actionRef);
      }
      for (const frameRef of observation.frameRefs) {
        const frame = this.#store.frame(transcript.artifactDigest, frameRef);
        if (!frame) {
          fail(`transcript: unsealed frame '${frameRef}'`);
        }
        frameRefs.push(frameRef);
        for (const actionRef of frame.sourceActionRefs) {
          if (!this.#store.action(transcript.artifactDigest, actionRef)) {
            fail(`transcript: frame has unsealed action '${actionRef}'`);
          }
          actionRefs.push(actionRef);
        }
      }
    }
    const verified = transcript.attestation !== undefined
      && this.#transcriptPublicKey
      && verifyTranscriptAttestation(transcript, this.#transcriptPublicKey);
    const closure = deepFreeze({
      evidenceId: transcript.transcriptId,
      artifactDigest: transcript.artifactDigest,
      observationIds: [...observationIds].sort(),
      frameRefs: [...new Set(frameRefs)].sort(),
      actionRefs: [...new Set(actionRefs)].sort(),
      transcriptDigest: digestCanonical(unsignedTranscript(transcript)),
      status: verified ? "verified" : "draft",
      transcriptText: transcript.segments.map((segment) => normalizeText(segment.text)).join("\n"),
    });
    if (this.#closures.has(closure.evidenceId)) fail("transcript: duplicate transcriptId");
    this.#closures.set(closure.evidenceId, closure);
    return deepFreeze(jsonCopy(closure));
  }

  addEntity(entity) {
    const copy = jsonCopy(entity);
    validateEntity(copy);
    if (this.#entities.some((entry) => entry.entityId === copy.entityId)) {
      fail("entity: duplicate entityId");
    }
    if (this.#entities.some((entry) =>
      entry.type === copy.type
      && normalizeText(entry.name).toLocaleLowerCase("en") === normalizeText(copy.name).toLocaleLowerCase("en"))) {
      fail("entity: duplicate type/name");
    }
    const closure = this.#closures.get(copy.nameEvidenceId);
    if (!closure) fail("entity: missing name evidence");
    if (copy.status === "approved") {
      if (closure.status !== "verified") {
        fail("entity: approved name requires TranscriptVerifier attestation");
      }
      if (!closure.transcriptText.includes(copy.name)) {
        fail("entity: approved name must appear in verified transcript");
      }
    }
    this.#entities.push(copy);
    return this;
  }

  addClaim(claim) {
    const copy = jsonCopy(claim);
    validateClaim(copy);
    if (this.#claims.some((entry) => entry.claimId === copy.claimId)) {
      fail("claim: duplicate claimId");
    }
    this.#claims.push(copy);
    return this;
  }

  addProcedure(procedure) {
    const copy = jsonCopy(procedure);
    validateProcedure(copy);
    if (this.#procedures.some((entry) => entry.procedureId === copy.procedureId)) {
      fail("procedure: duplicate procedureId");
    }
    this.#procedures.push(copy);
    return this;
  }

  addContradiction(contradiction) {
    const copy = jsonCopy(contradiction);
    validateContradiction(copy);
    if (this.#contradictions.some((entry) => entry.contradictionId === copy.contradictionId)) {
      fail("contradiction: duplicate contradictionId");
    }
    this.#contradictions.push(copy);
    return this;
  }

  addUnknown(unknown) {
    const copy = jsonCopy(unknown);
    validateUnknown(copy);
    if (this.#unknowns.some((entry) => entry.unknownId === copy.unknownId)) {
      fail("unknown: duplicate unknownId");
    }
    this.#unknowns.push(copy);
    return this;
  }

  addReinspectionRequest(request) {
    const copy = validateReinspectionRequest(request);
    if (this.#reinspection.some((entry) => entry.requestId === copy.requestId)) {
      fail("reinspectionRequest: duplicate requestId");
    }
    this.#reinspection.push(copy);
    return this;
  }

  addScratchNote(note) {
    assertExact(note, ["noteId", "body", "exportPolicy"], [], "scratchNote");
    assertString(note.noteId, "scratchNote.noteId", { max: 96, pattern: SAFE_ID });
    assertString(note.body, "scratchNote.body", { min: 0, max: 20_000 });
    if (note.exportPolicy !== "never") fail("scratchNote.exportPolicy: must be never");
    this.#scratchNotes.set(note.noteId, String(note.body));
    return this;
  }

  scratchNoteCount() {
    return this.#scratchNotes.size;
  }

  #assertReferencesAndPromotion() {
    const entities = new Map(this.#entities.map((entry) => [entry.entityId, entry]));
    const claims = new Map(this.#claims.map((entry) => [entry.claimId, entry]));
    const closures = this.#closures;
    for (const entity of this.#entities) {
      if (entity.status === "approved" && closures.get(entity.nameEvidenceId)?.status !== "verified") {
        fail(`entity '${entity.entityId}': unverified evidence`);
      }
    }
    for (const claim of this.#claims) {
      if (!entities.has(claim.subjectEntityId)) fail(`claim '${claim.claimId}': unknown subject`);
      if (claim.object.kind === "entity" && !entities.has(claim.object.entityId)) {
        fail(`claim '${claim.claimId}': unknown object entity`);
      }
      const evidence = claim.evidenceIds.map((id) => {
        const closure = closures.get(id);
        if (!closure) fail(`claim '${claim.claimId}': missing evidence '${id}'`);
        return closure;
      });
      if (claim.status === "approved") {
        if (entities.get(claim.subjectEntityId).status !== "approved") {
          fail(`claim '${claim.claimId}': subject is draft`);
        }
        if (claim.object.kind === "entity" && entities.get(claim.object.entityId).status !== "approved") {
          fail(`claim '${claim.claimId}': object is draft`);
        }
        if (evidence.some((entry) => entry.status !== "verified")) {
          fail(`claim '${claim.claimId}': approved claim has draft evidence`);
        }
        const evidenceArtifacts = new Set(evidence.map((entry) => entry.artifactDigest));
        if (claim.scope.kind === "rule") {
          if (claim.scope.supportingArtifactDigests.length < 2) {
            fail(`claim '${claim.claimId}': rule scope requires two independent runs`);
          }
          for (const digest of claim.scope.supportingArtifactDigests) {
            if (!evidenceArtifacts.has(digest)) {
              fail(`claim '${claim.claimId}': rule scope lacks evidence for artifact`);
            }
            if (!this.#store.isComparisonMember(digest, claim.scope.groupRef)) {
              fail(`claim '${claim.claimId}': unsigned comparison membership`);
            }
          }
        } else {
          for (const digest of claim.scope.artifactDigests) {
            if (!evidenceArtifacts.has(digest)) {
              fail(`claim '${claim.claimId}': scoped artifact lacks evidence`);
            }
          }
        }
      }
    }
    for (const procedure of this.#procedures) {
      const evidence = procedure.evidenceIds.map((id) => {
        const closure = closures.get(id);
        if (!closure) fail(`procedure '${procedure.procedureId}': missing evidence '${id}'`);
        return closure;
      });
      for (const step of procedure.steps) {
        if (step.targetEntityId && !entities.has(step.targetEntityId)) {
          fail(`procedure '${procedure.procedureId}': unknown target entity`);
        }
        for (const id of [...step.consumesEntityIds, ...step.producesEntityIds]) {
          if (!entities.has(id)) fail(`procedure '${procedure.procedureId}': unknown entity reference`);
        }
        for (const id of [...step.preconditionClaimIds, ...step.expectedClaimIds]) {
          if (!claims.has(id)) fail(`procedure '${procedure.procedureId}': unknown claim reference`);
        }
      }
      if (procedure.status === "approved") {
        if (evidence.some((entry) => entry.status !== "verified")) {
          fail(`procedure '${procedure.procedureId}': approved procedure has draft evidence`);
        }
        for (const step of procedure.steps) {
          if (step.targetEntityId && entities.get(step.targetEntityId).status !== "approved") {
            fail(`procedure '${procedure.procedureId}': draft target`);
          }
          for (const id of [...step.preconditionClaimIds, ...step.expectedClaimIds]) {
            if (claims.get(id).status !== "approved") {
              fail(`procedure '${procedure.procedureId}': draft claim reference`);
            }
          }
        }
      }
    }
    for (const item of this.#contradictions) {
      for (const id of item.claimIds) {
        if (!claims.has(id)) fail(`contradiction '${item.contradictionId}': unknown claim`);
      }
      if (item.resolutionClaimId && claims.get(item.resolutionClaimId)?.status !== "approved") {
        fail(`contradiction '${item.contradictionId}': invalid resolution`);
      }
    }
    for (const item of this.#unknowns) {
      if (item.subjectEntityId && !entities.has(item.subjectEntityId)) {
        fail(`unknown '${item.unknownId}': unknown subject`);
      }
      for (const id of item.relatedClaimIds) {
        if (!claims.has(id)) fail(`unknown '${item.unknownId}': unknown claim`);
      }
      if (item.resolvedByClaimId && claims.get(item.resolvedByClaimId)?.status !== "approved") {
        fail(`unknown '${item.unknownId}': invalid resolution`);
      }
    }
    for (const request of this.#reinspection) {
      if (request.subjectEntityId && !entities.has(request.subjectEntityId)) {
        fail(`reinspection '${request.requestId}': unknown subject`);
      }
      for (const id of request.blockedKnowledgeRefs) {
        if (!claims.has(id) && !entities.has(id)) {
          fail(`reinspection '${request.requestId}': unknown blocked ref`);
        }
      }
    }
  }

  normalizedGraph() {
    this.#assertReferencesAndPromotion();
    return normalizeWorkspace({
      closures: [...this.#closures.values()],
      entities: this.#entities,
      claims: this.#claims,
      procedures: this.#procedures,
      contradictions: this.#contradictions,
      unknowns: this.#unknowns,
      reinspection: this.#reinspection,
    });
  }
}
