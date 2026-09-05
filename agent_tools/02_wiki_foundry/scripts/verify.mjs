import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  canonicalize as canonicalJson,
  coordinatorRandomId,
  createSignedEnvelope,
  publicHandoffPayloadDigest,
  sha256,
  validateNormalizedDocument,
  validateSignedEnvelopeShape,
  verifySignedEnvelope,
} from "../../packages/atlas_protocol/src/index.mjs";
import {
  ContentAddressedEvidenceStore,
  WikiWorkspace,
  attestTranscript,
  buildWikiBundle,
  lintSafeMarkdown,
  signEvidenceComparisonPlan,
  sealWikiBundle,
  validateProcedure,
  validatePublicPlayHandoff,
  validateReinspectionRequest,
  validateSealedWikiBundle,
  verifyEvidenceComparisonPlan,
} from "../src/index.mjs";

const comparisonKeys = generateKeyPairSync("ed25519");
const transcriptKeys = generateKeyPairSync("ed25519");
const runnerKeys = generateKeyPairSync("ed25519");
const contractDigest = "9".repeat(64);
const stableIds = {
  artifactA: "AAAAAAAAAAAAAAAAAAAAAA",
  runA: "BBBBBBBBBBBBBBBBBBBBBB",
  artifactB: "CCCCCCCCCCCCCCCCCCCCCC",
  runB: "DDDDDDDDDDDDDDDDDDDDDD",
};

function commonHandoff({ artifactId, runId, beforeText, afterText }) {
  const beforeBytes = Buffer.from(beforeText, "utf8");
  const afterBytes = Buffer.from(afterText, "utf8");
  const frames = [
    {
      frameId: "F000001",
      ordinal: 1,
      mediaRef: "frames/F000001.png",
      sha256: sha256(beforeBytes),
      evidenceRole: "CITEABLE",
      sourceActionRefs: [],
    },
    {
      frameId: "F000002",
      ordinal: 2,
      mediaRef: "frames/F000002.png",
      sha256: sha256(afterBytes),
      evidenceRole: "CITEABLE",
      sourceActionRefs: ["A000001"],
    },
  ];
  const observations = [
    {
      observationId: "O000001",
      ordinal: 1,
      frameRefs: ["F000001"],
      precedingActionRefs: [],
    },
    {
      observationId: "O000002",
      ordinal: 2,
      frameRefs: ["F000002"],
      precedingActionRefs: ["A000001"],
    },
  ];
  const actions = [{
    actionId: "A000001",
    ordinal: 1,
    input: { kind: "opaqueActivate" },
    delivery: "DELIVERED",
    beforeFrameRef: "F000001",
    afterFrameRefs: ["F000002"],
    changeClass: "UNCHANGED",
  }];
  const observationsBytes = Buffer.from(
    observations.map((entry) => canonicalJson(entry)).join("\n") + "\n",
    "utf8",
  );
  const actionsBytes = Buffer.from(
    actions.map((entry) => canonicalJson(entry)).join("\n") + "\n",
    "utf8",
  );
  const files = new Map([
    ["frames/F000001.png", beforeBytes],
    ["frames/F000002.png", afterBytes],
    ["observations.ndjson", observationsBytes],
    ["actions.ndjson", actionsBytes],
  ]);
  const payload = {
    manifest: {
      schemaVersion: "atlas/public-play-handoff/1",
      artifactId,
      runId,
      status: "COMPLETE",
      validity: "OFFICIAL",
      framePolicyVersion: "canvas-served/v1",
      inputPolicyVersion: "keyboard-restricted/v1",
      capture: {
        width: 640,
        height: 360,
        format: "png",
        colorSpace: "srgb",
      },
      counts: {
        frames: frames.length,
        observations: observations.length,
        actions: actions.length,
        interventions: 0,
      },
      files: [
        {
          role: "frames",
          relativeName: "frames/F000001.png",
          bytes: beforeBytes.byteLength,
          sha256: sha256(beforeBytes),
        },
        {
          role: "frames",
          relativeName: "frames/F000002.png",
          bytes: afterBytes.byteLength,
          sha256: sha256(afterBytes),
        },
        {
          role: "observations",
          relativeName: "observations.ndjson",
          bytes: observationsBytes.byteLength,
          sha256: sha256(observationsBytes),
        },
        {
          role: "actions",
          relativeName: "actions.ndjson",
          bytes: actionsBytes.byteLength,
          sha256: sha256(actionsBytes),
        },
      ],
      payloadDigest: "0".repeat(64),
    },
    frames,
    observations,
    actions,
  };
  payload.manifest.payloadDigest = publicHandoffPayloadDigest(payload);
  const expectedBinding = {
    artifactId,
    campaignId: "campaign-test",
    track: "knowledge-capture",
    arm: "baseline",
    targetRunId: runId,
    contractDigest,
  };
  const envelope = createSignedEnvelope({
    artifactType: "PublicPlayHandoff",
    schemaVersion: "atlas/public-play-handoff/1",
    ...expectedBinding,
    issuer: "runner",
    keyId: "runner-test-key",
    nonce: artifactId,
    parentDigests: [],
  }, payload, runnerKeys.privateKey);
  return {
    envelope,
    runnerPublicKey: runnerKeys.publicKey,
    files,
    expectedBinding,
  };
}

function stablePair() {
  const one = commonHandoff({
    artifactId: stableIds.artifactA,
    runId: stableIds.runA,
    beforeText: "Room A",
    afterText: "Room A contains Token B",
  });
  const two = commonHandoff({
    artifactId: stableIds.artifactB,
    runId: stableIds.runB,
    beforeText: "Token B",
    afterText: "Room A contains Token B again",
  });
  const plan = signEvidenceComparisonPlan({
    schemaVersion: "atlas/evidence-comparison-plan/1",
    planId: "EEEEEEEEEEEEEEEEEEEEEE",
    groups: [{
      groupRef: "G01",
      handoffDigests: [
        sha256(one.envelope),
        sha256(two.envelope),
      ],
    }],
  }, comparisonKeys.privateKey);
  return { one, two, plan };
}

function importPair() {
  const { one, two, plan } = stablePair();
  const store = new ContentAddressedEvidenceStore();
  const comparisonMembership = {
    plan,
    publicKey: comparisonKeys.publicKey,
  };
  const artifactA = store.importHandoff({ ...one, comparisonMembership });
  const artifactB = store.importHandoff({ ...two, comparisonMembership });
  return { store, artifactA, artifactB };
}

function verifiedTranscript(id, artifactDigest) {
  return attestTranscript({
    schemaVersion: "1.0",
    transcriptId: id,
    artifactDigest,
    segments: [{
      observationId: "O000002",
      text: "Room A contains Token B",
    }],
  }, transcriptKeys.privateKey);
}

function validWorkspace(note = "") {
  const { store, artifactA, artifactB } = importPair();
  const workspace = new WikiWorkspace({
    store,
    transcriptPublicKey: transcriptKeys.publicKey,
  });
  workspace.addTranscript(verifiedTranscript("transcript-a", artifactA.artifactDigest));
  workspace.addTranscript(verifiedTranscript("transcript-b", artifactB.artifactDigest));
  workspace.addEntity({
    entityId: "room-source",
    type: "region",
    name: "Room A",
    nameEvidenceId: "transcript-a",
    status: "approved",
    submitterId: "writer-z",
    submissionOrder: 99,
  });
  workspace.addEntity({
    entityId: "token-source",
    type: "item",
    name: "Token B",
    nameEvidenceId: "transcript-a",
    status: "approved",
    submitterId: "writer-a",
    submissionOrder: 1,
  });
  workspace.addClaim({
    claimId: "claim-source",
    subjectEntityId: "room-source",
    predicate: "contains",
    object: { kind: "entity", entityId: "token-source" },
    scope: {
      kind: "rule",
      groupRef: "G01",
      supportingArtifactDigests: [
        artifactB.artifactDigest,
        artifactA.artifactDigest,
      ],
    },
    evidenceIds: ["transcript-b", "transcript-a"],
    status: "approved",
    submitterId: "writer-z",
    submissionOrder: 77,
  });
  workspace.addProcedure({
    procedureId: "procedure-source",
    status: "approved",
    evidenceIds: ["transcript-a", "transcript-b"],
    submitterId: "writer-a",
    submissionOrder: 12,
    steps: [{
      order: 1,
      verb: "inspect",
      targetEntityId: "room-source",
      preconditionClaimIds: [],
      expectedClaimIds: ["claim-source"],
      consumesEntityIds: [],
      producesEntityIds: [],
      onFailure: "reinspect",
    }],
  });
  workspace.addUnknown({
    unknownId: "unknown-source",
    subjectEntityId: "token-source",
    questionCode: "source",
    status: "queued",
    relatedClaimIds: ["claim-source"],
  });
  workspace.addReinspectionRequest({
    schemaVersion: "1.0",
    requestId: "request-source",
    subjectEntityId: "token-source",
    operation: "compare",
    contrast: "repeat-observation",
    evidenceNeeded: "repeat-confirmation",
    maxAttempts: 2,
    priority: "normal",
    blockedKnowledgeRefs: ["claim-source"],
  });
  workspace.addScratchNote({
    noteId: "scratch",
    body: note,
    exportPolicy: "never",
  });
  return workspace;
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test("common F/A/O handoff imports immutably", () => {
  const input = commonHandoff({
    artifactId: coordinatorRandomId(),
    runId: coordinatorRandomId(),
    beforeText: "before",
    afterText: "after",
  });
  assert.equal(validatePublicPlayHandoff(input.envelope.payload), true);
  const store = new ContentAddressedEvidenceStore();
  const imported = store.importHandoff(input);
  assert.equal(imported.artifactDigest, sha256(input.envelope));
  assert.notEqual(
    imported.artifactDigest,
    input.envelope.payload.manifest.payloadDigest,
  );
  assert(Object.isFrozen(imported));
  const bytes = store.getFile(imported.artifactDigest, "frames/F000001.png");
  bytes[0] = 0;
  assert.equal(
    store.getFile(imported.artifactDigest, "frames/F000001.png").toString(),
    "before",
  );
});

test("archive accepts an exact plain-object files map", () => {
  const input = commonHandoff({
    artifactId: coordinatorRandomId(),
    runId: coordinatorRandomId(),
    beforeText: "before",
    afterText: "after",
  });
  const imported = new ContentAddressedEvidenceStore().importHandoff({
    ...input,
    files: Object.fromEntries(input.files),
  });
  assert.equal(imported.artifactDigest, sha256(input.envelope));
});

test("tampered frame file is rejected", () => {
  const input = commonHandoff({
    artifactId: coordinatorRandomId(),
    runId: coordinatorRandomId(),
    beforeText: "before",
    afterText: "after",
  });
  input.files.set("frames/F000002.png", Buffer.from("tampered"));
  assert.throws(
    () => new ContentAddressedEvidenceStore().importHandoff(input),
    /byte length mismatch|sha256 mismatch/,
  );
});

test("archive rejects missing, extra, and tampered non-frame files", () => {
  const missing = commonHandoff({
    artifactId: coordinatorRandomId(),
    runId: coordinatorRandomId(),
    beforeText: "before",
    afterText: "after",
  });
  missing.files.delete("observations.ndjson");
  assert.throws(
    () => new ContentAddressedEvidenceStore().importHandoff(missing),
    /exact manifest file set|required|missing/,
  );

  const extra = commonHandoff({
    artifactId: coordinatorRandomId(),
    runId: coordinatorRandomId(),
    beforeText: "before",
    afterText: "after",
  });
  extra.files.set("extra.bin", Buffer.from("x"));
  assert.throws(
    () => new ContentAddressedEvidenceStore().importHandoff(extra),
    /exact manifest file set|extra file/,
  );

  const tampered = commonHandoff({
    artifactId: coordinatorRandomId(),
    runId: coordinatorRandomId(),
    beforeText: "before",
    afterText: "after",
  });
  const actionBytes = Buffer.from(tampered.files.get("actions.ndjson"));
  actionBytes[0] ^= 1;
  tampered.files.set("actions.ndjson", actionBytes);
  assert.throws(
    () => new ContentAddressedEvidenceStore().importHandoff(tampered),
    /sha256 mismatch/,
  );
});

test("archive rejects non-canonical NDJSON despite matching manifest hash", () => {
  const input = commonHandoff({
    artifactId: coordinatorRandomId(),
    runId: coordinatorRandomId(),
    beforeText: "before",
    afterText: "after",
  });
  const payload = structuredClone(input.envelope.payload);
  const nonCanonical = Buffer.from(
    payload.actions.map((entry) => JSON.stringify(entry)).join("\r\n") + "\r\n",
    "utf8",
  );
  const file = payload.manifest.files.find(
    (entry) => entry.relativeName === "actions.ndjson",
  );
  file.bytes = nonCanonical.byteLength;
  file.sha256 = sha256(nonCanonical);
  payload.manifest.payloadDigest = publicHandoffPayloadDigest(payload);
  const envelope = createSignedEnvelope(
    input.envelope.header,
    payload,
    runnerKeys.privateKey,
  );
  const files = new Map(input.files);
  files.set("actions.ndjson", nonCanonical);
  assert.throws(
    () => new ContentAddressedEvidenceStore().importHandoff({
      ...input,
      envelope,
      files,
    }),
    /actions.ndjson: canonical payload mismatch/,
  );
});

test("archive enforces frame mediaRef and frame role one-to-one", () => {
  const input = commonHandoff({
    artifactId: coordinatorRandomId(),
    runId: coordinatorRandomId(),
    beforeText: "before",
    afterText: "after",
  });
  const payload = structuredClone(input.envelope.payload);
  payload.manifest.files[0].role = "actions";
  payload.manifest.payloadDigest = publicHandoffPayloadDigest(payload);
  const envelope = createSignedEnvelope(
    input.envelope.header,
    payload,
    runnerKeys.privateKey,
  );
  assert.throws(
    () => new ContentAddressedEvidenceStore().importHandoff({
      ...input,
      envelope,
    }),
    /frame role|actions.ndjson|PublicPlayHandoff/,
  );
});

test("legacy frameFiles-only input is rejected", () => {
  const input = commonHandoff({
    artifactId: coordinatorRandomId(),
    runId: coordinatorRandomId(),
    beforeText: "before",
    afterText: "after",
  });
  const { files, ...withoutFiles } = input;
  assert.throws(
    () => new ContentAddressedEvidenceStore().importHandoff({
      ...withoutFiles,
      frameFiles: files,
    }),
    /unsupported property 'frameFiles'/,
  );
});

test("tampered public payload and extra field fail closed", () => {
  const input = commonHandoff({
    artifactId: coordinatorRandomId(),
    runId: coordinatorRandomId(),
    beforeText: "before",
    afterText: "after",
  });
  const tamperedEnvelope = structuredClone(input.envelope);
  tamperedEnvelope.payload.observations[1].frameRefs = ["F000001"];
  assert.throws(
    () => new ContentAddressedEvidenceStore().importHandoff({
      ...input,
      envelope: tamperedEnvelope,
    }),
    /signature|payloadDigest|SignedEnvelope/,
  );
  const extra = commonHandoff({
    artifactId: coordinatorRandomId(),
    runId: coordinatorRandomId(),
    beforeText: "before",
    afterText: "after",
  });
  const extraPayload = structuredClone(extra.envelope.payload);
  extraPayload.frames[0].targetHandle = "forbidden";
  const extraEnvelope = createSignedEnvelope(
    extra.envelope.header,
    extraPayload,
    runnerKeys.privateKey,
  );
  assert.throws(
    () => new ContentAddressedEvidenceStore().importHandoff({
      ...extra,
      envelope: extraEnvelope,
    }),
    /additional|PublicPlayHandoff/,
  );
});

test("tampered signature and unsigned plan are rejected", () => {
  const signed = commonHandoff({
    artifactId: coordinatorRandomId(),
    runId: coordinatorRandomId(),
    beforeText: "before",
    afterText: "after",
  });
  const badEnvelope = structuredClone(signed.envelope);
  badEnvelope.signature = (badEnvelope.signature[0] === "A" ? "B" : "A")
    + badEnvelope.signature.slice(1);
  assert.throws(
    () => new ContentAddressedEvidenceStore().importHandoff({
      ...signed,
      envelope: badEnvelope,
    }),
    /Runner signature/,
  );
  const { plan } = stablePair();
  const tampered = structuredClone(plan);
  tampered.signature = (tampered.signature[0] === "A" ? "B" : "A")
    + tampered.signature.slice(1);
  assert.throws(
    () => verifyEvidenceComparisonPlan(tampered, comparisonKeys.publicKey),
    /signature/,
  );
  const unsigned = structuredClone(plan);
  unsigned.signature = "";
  assert.throws(
    () => verifyEvidenceComparisonPlan(unsigned, comparisonKeys.publicKey),
    /EvidenceComparisonPlan/,
  );
});

test("raw unsigned payload import is rejected", () => {
  const signed = commonHandoff({
    artifactId: coordinatorRandomId(),
    runId: coordinatorRandomId(),
    beforeText: "before",
    afterText: "after",
  });
  assert.throws(
    () => new ContentAddressedEvidenceStore().importHandoff({
      ...signed,
      envelope: signed.envelope.payload,
    }),
    /SignedEnvelope/,
  );
});

test("trusted header binding and payload identity are enforced", () => {
  const signed = commonHandoff({
    artifactId: coordinatorRandomId(),
    runId: coordinatorRandomId(),
    beforeText: "before",
    afterText: "after",
  });
  assert.throws(
    () => new ContentAddressedEvidenceStore().importHandoff({
      ...signed,
      expectedBinding: {
        ...signed.expectedBinding,
        track: "wrong-track",
      },
    }),
    /track binding mismatch/,
  );

  const otherArtifactId = coordinatorRandomId();
  const mismatchedEnvelope = createSignedEnvelope({
    ...signed.envelope.header,
    artifactId: otherArtifactId,
  }, signed.envelope.payload, runnerKeys.privateKey);
  assert.throws(
    () => new ContentAddressedEvidenceStore().importHandoff({
      ...signed,
      envelope: mismatchedEnvelope,
      expectedBinding: {
        ...signed.expectedBinding,
        artifactId: otherArtifactId,
      },
    }),
    /payload artifactId binding mismatch/,
  );

  const wrongSchemaEnvelope = createSignedEnvelope({
    ...signed.envelope.header,
    schemaVersion: "atlas/signed-envelope/1",
  }, signed.envelope.payload, runnerKeys.privateKey);
  assert.throws(
    () => new ContentAddressedEvidenceStore().importHandoff({
      ...signed,
      envelope: wrongSchemaEnvelope,
    }),
    /header schemaVersion mismatch/,
  );
});

test("plan membership uses groups handoffDigests", () => {
  const { one, plan } = stablePair();
  const nonmember = commonHandoff({
    artifactId: coordinatorRandomId(),
    runId: coordinatorRandomId(),
    beforeText: "other",
    afterText: "other after",
  });
  assert.throws(
    () => new ContentAddressedEvidenceStore().importHandoff({
      ...nonmember,
      comparisonMembership: {
        plan,
        publicKey: comparisonKeys.publicKey,
      },
    }),
    /not a group member/,
  );
  assert.notEqual(sha256(one.envelope), sha256(nonmember.envelope));
  assert.notEqual(
    sha256(one.envelope),
    one.envelope.payload.manifest.payloadDigest,
  );
});

test("unsigned transcript is draft-only", () => {
  const { store, artifactA } = importPair();
  const workspace = new WikiWorkspace({
    store,
    transcriptPublicKey: transcriptKeys.publicKey,
  });
  const closure = workspace.addTranscript({
    schemaVersion: "1.0",
    transcriptId: "draft-transcript",
    artifactDigest: artifactA.artifactDigest,
    segments: [{ observationId: "O000002", text: "Room A" }],
  });
  assert.equal(closure.status, "draft");
  assert.deepEqual(closure.actionRefs, ["A000001"]);
  assert.throws(() => workspace.addEntity({
    entityId: "room",
    type: "region",
    name: "Room A",
    nameEvidenceId: "draft-transcript",
    status: "approved",
  }), /TranscriptVerifier/);
});

test("missing evidence is rejected", () => {
  const workspace = validWorkspace();
  workspace.addClaim({
    claimId: "bad",
    subjectEntityId: "room-source",
    predicate: "contains",
    object: { kind: "literal", value: "Token B" },
    scope: {
      kind: "session",
      artifactDigests: ["1".repeat(64)],
    },
    evidenceIds: ["missing"],
    status: "approved",
  });
  assert.throws(() => buildWikiBundle(workspace), /missing evidence/);
});

test("single-run rule is rejected", () => {
  const { artifactA } = importPair();
  const workspace = validWorkspace();
  assert.throws(() => workspace.addClaim({
    claimId: "single",
    subjectEntityId: "room-source",
    predicate: "contains",
    object: { kind: "literal", value: "Token B" },
    scope: {
      kind: "rule",
      groupRef: "G01",
      supportingArtifactDigests: [artifactA.artifactDigest],
    },
    evidenceIds: ["transcript-a"],
    status: "approved",
  }), /array length must be 2/);
});

test("procedure blocks macros and additional properties", () => {
  const macro = {
    procedureId: "procedure",
    status: "draft",
    evidenceIds: ["evidence-a"],
    steps: [{
      order: 1,
      verb: "inspect",
      targetEntityId: "ArrowUp",
      preconditionClaimIds: [],
      expectedClaimIds: [],
      consumesEntityIds: [],
      producesEntityIds: [],
      onFailure: "stop",
    }],
  };
  assert.throws(() => validateProcedure(macro), /macro/);
  macro.steps[0].targetEntityId = "room";
  macro.steps[0].coordinates = [1, 2];
  assert.throws(() => validateProcedure(macro), /additional property/);
});

test("contradiction and unknown references are checked", () => {
  const workspace = validWorkspace();
  workspace.addContradiction({
    contradictionId: "broken",
    claimIds: ["claim-source", "not-a-claim"],
    status: "open",
  });
  assert.throws(() => buildWikiBundle(workspace), /unknown claim/);
});

test("reinspection DSL rejects prose", () => {
  assert.throws(() => validateReinspectionRequest({
    schemaVersion: "1.0",
    requestId: "request",
    operation: "observe",
    contrast: "unknown",
    evidenceNeeded: "visible-outcome",
    maxAttempts: 1,
    priority: "normal",
    blockedKnowledgeRefs: [],
    prompt: "click here",
  }), /additional property/);
});

test("scratch notes are export and digest inert", () => {
  const a = buildWikiBundle(validWorkspace("private one"));
  const b = buildWikiBundle(validWorkspace("different private ArrowUp"));
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert(!canonicalJson(a).includes("private one"));
  assert(!canonicalJson(b).includes("different private"));
});

test("normalizer removes submitter and submission order", () => {
  const graph = canonicalJson(validWorkspace().normalizedGraph());
  assert(!graph.includes("writer-"));
  assert(!graph.includes("submitter"));
  assert(!graph.includes("submissionOrder"));
});

test("Markdown lint blocks hidden channels", () => {
  const samples = [
    "# x\n\n<!-- secret -->\n",
    "# x\n\nhttps://example.com\n",
    "# x\n\n\x60code\x60\n",
    "# x\n\nArrowUp ArrowUp Space\n",
    "# x\n\nsecret\u200bchannel\n",
    "# x\n\n" + "a".repeat(48) + "\n",
  ];
  for (const sample of samples) {
    assert.throws(() => lintSafeMarkdown(sample));
  }
});

test("normalized document passes the common validator", () => {
  const bundle = buildWikiBundle(validWorkspace());
  const result = validateNormalizedDocument(bundle.normalizedDocument);
  assert.deepEqual(result, { valid: true, errors: [] });
  assert.equal(
    bundle.knowledgeReceipt.normalizedDocumentDigest,
    sha256(bundle.normalizedDocument),
  );
  const allowed = new Set(["heading", "paragraph", "list", "table", "link"]);
  for (const page of bundle.normalizedDocument.pages) {
    for (const node of page.nodes) assert(allowed.has(node.type));
  }
});

test("Wiki stages are sealed with allocated IDs and chained parents", () => {
  const bundle = buildWikiBundle(validWorkspace());
  const input = {
    bundle,
    signer: {
      issuer: "wiki-foundry",
      keyId: "wiki-test-key",
      privateKey: transcriptKeys.privateKey,
    },
    campaignId: "campaign-test",
    track: "knowledge-capture",
    arm: "baseline",
    targetRunId: stableIds.runA,
    contractDigest,
    allocations: [
      {
        artifactId: "KKKKKKKKKKKKKKKKKKKKKK",
        nonce: "LLLLLLLLLLLLLLLLLLLLLL",
      },
      {
        artifactId: "MMMMMMMMMMMMMMMMMMMMMM",
        nonce: "NNNNNNNNNNNNNNNNNNNNNN",
      },
    ],
    parentHandoffEnvelopeDigests:
      bundle.knowledgeReceipt.inputEnvelopeDigests,
  };
  const sealed = sealWikiBundle(input);
  assert.equal(validateSealedWikiBundle(
    sealed,
    transcriptKeys.publicKey,
  ), true);
  assert.deepEqual(
    validateSignedEnvelopeShape(sealed.knowledgeReceiptEnvelope),
    { valid: true, errors: [] },
  );
  assert.deepEqual(
    validateSignedEnvelopeShape(sealed.normalizedDocumentEnvelope),
    { valid: true, errors: [] },
  );
  assert(verifySignedEnvelope(
    sealed.knowledgeReceiptEnvelope,
    transcriptKeys.publicKey,
  ));
  assert(verifySignedEnvelope(
    sealed.normalizedDocumentEnvelope,
    transcriptKeys.publicKey,
  ));
  assert.equal(
    sealed.knowledgeReceiptEnvelope.header.artifactType,
    "atlas/knowledge-receipt",
  );
  assert.equal(
    sealed.knowledgeReceiptEnvelope.header.schemaVersion,
    "atlas/knowledge-receipt/1",
  );
  assert.equal(
    sealed.normalizedDocumentEnvelope.header.artifactType,
    "atlas/normalized-document",
  );
  assert.equal(
    sealed.normalizedDocumentEnvelope.header.schemaVersion,
    "atlas/normalized-document/1",
  );
  assert.deepEqual(
    sealed.knowledgeReceiptEnvelope.header.parentDigests,
    [...bundle.knowledgeReceipt.inputEnvelopeDigests].sort(),
  );
  assert.deepEqual(
    sealed.normalizedDocumentEnvelope.header.parentDigests,
    [sha256(sealed.knowledgeReceiptEnvelope)],
  );
  assert.equal(
    sealed.knowledgeReceiptEnvelope.header.payloadDigest,
    sha256(bundle.knowledgeReceipt),
  );
  assert.equal(
    sealed.normalizedDocumentEnvelope.header.payloadDigest,
    sha256(bundle.normalizedDocument),
  );

  const tampered = structuredClone(sealed.normalizedDocumentEnvelope);
  tampered.payload.pages[0].title = "tampered";
  assert.equal(
    verifySignedEnvelope(tampered, transcriptKeys.publicKey),
    false,
  );
  assert.throws(
    () => sealWikiBundle(input),
    /coordinator value reuse/,
  );
});

test("re-signed generic Wiki stage schemas are rejected", () => {
  const bundle = buildWikiBundle(validWorkspace());
  const sealed = sealWikiBundle({
    bundle,
    signer: {
      issuer: "wiki-foundry",
      keyId: "wiki-test-key",
      privateKey: transcriptKeys.privateKey,
    },
    campaignId: "campaign-test",
    track: "knowledge-capture",
    arm: "baseline",
    targetRunId: stableIds.runA,
    contractDigest,
    allocations: [
      {
        artifactId: "TTTTTTTTTTTTTTTTTTTTTT",
        nonce: "UUUUUUUUUUUUUUUUUUUUUU",
      },
      {
        artifactId: "VVVVVVVVVVVVVVVVVVVVVV",
        nonce: "WWWWWWWWWWWWWWWWWWWWWW",
      },
    ],
    parentHandoffEnvelopeDigests:
      bundle.knowledgeReceipt.inputEnvelopeDigests,
  });

  const badReceipt = createSignedEnvelope({
    ...sealed.knowledgeReceiptEnvelope.header,
    schemaVersion: "atlas/signed-envelope/1",
  }, sealed.knowledgeReceiptEnvelope.payload, transcriptKeys.privateKey);
  assert.throws(
    () => validateSealedWikiBundle({
      knowledgeReceiptEnvelope: badReceipt,
      normalizedDocumentEnvelope: sealed.normalizedDocumentEnvelope,
    }, transcriptKeys.publicKey),
    /KnowledgeReceipt SignedEnvelope: schemaVersion mismatch/,
  );

  const badDocument = createSignedEnvelope({
    ...sealed.normalizedDocumentEnvelope.header,
    schemaVersion: "atlas/signed-envelope/1",
  }, sealed.normalizedDocumentEnvelope.payload, transcriptKeys.privateKey);
  assert.throws(
    () => validateSealedWikiBundle({
      knowledgeReceiptEnvelope: sealed.knowledgeReceiptEnvelope,
      normalizedDocumentEnvelope: badDocument,
    }, transcriptKeys.publicKey),
    /NormalizedDocument SignedEnvelope: schemaVersion mismatch/,
  );
});

test("Wiki sealing rejects wrong parents and document digest", () => {
  const bundle = buildWikiBundle(validWorkspace());
  const base = {
    bundle,
    signer: {
      issuer: "wiki-foundry",
      keyId: "wiki-test-key",
      privateKey: transcriptKeys.privateKey,
    },
    campaignId: "campaign-test",
    track: "knowledge-capture",
    arm: "baseline",
    targetRunId: stableIds.runA,
    contractDigest,
    allocations: [
      {
        artifactId: "PPPPPPPPPPPPPPPPPPPPPP",
        nonce: "QQQQQQQQQQQQQQQQQQQQQQ",
      },
      {
        artifactId: "RRRRRRRRRRRRRRRRRRRRRR",
        nonce: "SSSSSSSSSSSSSSSSSSSSSS",
      },
    ],
    parentHandoffEnvelopeDigests: ["8".repeat(64)],
  };
  assert.throws(
    () => sealWikiBundle(base),
    /parent handoff digests/,
  );

  const badBundle = structuredClone(bundle);
  badBundle.knowledgeReceipt.normalizedDocumentDigest = "7".repeat(64);
  assert.throws(
    () => sealWikiBundle({
      ...base,
      bundle: badBundle,
      parentHandoffEnvelopeDigests:
        bundle.knowledgeReceipt.inputEnvelopeDigests,
    }),
    /normalizedDocumentDigest mismatch/,
  );
});

test("three builds are byte-identical and delivery is clean", () => {
  const workspace = validWorkspace("never export");
  const builds = [
    buildWikiBundle(workspace),
    buildWikiBundle(workspace),
    buildWikiBundle(workspace),
  ];
  assert.equal(canonicalJson(builds[0]), canonicalJson(builds[1]));
  assert.equal(canonicalJson(builds[1]), canonicalJson(builds[2]));
  const delivery = canonicalJson(builds[0].delivery);
  const normalized = canonicalJson(builds[0].normalizedDocument);
  const provenance = stablePair();
  for (const forbidden of [
    "F000001", "A000001", "O000001", "G01",
    "entity-", "claim-", "procedure-", "evidence-",
    "never export", "writer-", "transcript-a",
    stableIds.artifactA,
    stableIds.runA,
    sha256(provenance.one.envelope),
    provenance.one.envelope.payload.manifest.payloadDigest,
  ]) {
    assert(!delivery.includes(forbidden), `delivery leaked ${forbidden}`);
    assert(
      !normalized.includes(forbidden),
      `normalized document leaked ${forbidden}`,
    );
  }
  assert(delivery.includes("Room A"));
  assert(delivery.includes("Token B"));
  assert(normalized.includes("Room A"));
  assert(normalized.includes("Token B"));
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`ok ${passed} - ${name}\n`);
  } catch (error) {
    process.stderr.write(`not ok - ${name}\n${error.stack}\n`);
    process.exitCode = 1;
    break;
  }
}
if (!process.exitCode) {
  process.stdout.write(`verified ${passed}/${tests.length} tests\n`);
}
