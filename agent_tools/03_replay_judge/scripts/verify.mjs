import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  coordinatorRandomId,
  sha256,
} from "../../packages/atlas_protocol/src/index.mjs";
import {
  ARTIFACT,
  ARMS,
  ArtifactVerifier,
  CohortCollector,
  FreshStateEngineReplayPort,
  JudgeError,
  OpaqueCapabilityRegistry,
  ReplayAuthorizationIssuer,
  SyntheticRoomTokenEngine,
  artifactDigest,
  buildAggregateReport,
  createActionTranscript,
  createFrameServedEvent,
  createSignedCohortPlan,
  createSignedInputReceipt,
  createSignedProbeSet,
  evaluateProbeRecord,
  expectedCohortCells,
  issueArtifact,
  makeProbeRecord,
  sanitizeNormalizedDocument,
  validateReplayAuthorization,
  verifyNormalizedDocumentArtifact,
} from "../src/index.mjs";

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof JudgeError && error.code === code, `expected ${code}`);
}

function signer(issuer, keyId, artifactTypes, contractDigest) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { issuer, keyId, artifactTypes, contractDigest, privateKey, publicKey };
}

function createContext({ evaluationClass = "STRICT", engineFactory, probeExecutor } = {}) {
  const contractDigest = sha256("atlas-protocol-public-contract-v1");
  const signers = {
    coordinator: signer("TrustedCoordinator", "coordinator-test-key", [ARTIFACT.PROBE_SET, ARTIFACT.COHORT_PLAN, ARTIFACT.REPLAY_AUTHORIZATION], contractDigest),
    foundry: signer("WikiFoundry", "foundry-test-key", [ARTIFACT.NORMALIZED_DOCUMENT], contractDigest),
    gateway: signer("InputGateway", "gateway-test-key", [ARTIFACT.FRAME_SERVED_EVENT, ARTIFACT.INPUT_RECEIPT, ARTIFACT.ACTION_TRANSCRIPT], contractDigest),
    engine: signer("EngineRunner", "engine-test-key", [ARTIFACT.ENGINE_OUTCOME], contractDigest),
    judge: signer("ReplayJudge", "judge-test-key", [ARTIFACT.VERIFIED_REPLAY, ARTIFACT.SCORE_REPORT], contractDigest),
  };
  const verifier = new ArtifactVerifier();
  for (const entry of Object.values(signers)) {
    verifier.registerKey({ keyId: entry.keyId, issuer: entry.issuer, publicKey: entry.publicKey, artifactTypes: entry.artifactTypes });
  }
  const campaignId = coordinatorRandomId();
  const registry = new OpaqueCapabilityRegistry();
  const probeEnvelope = createSignedProbeSet({
    campaignId,
    goals: [
      { id: "ROOM_B", weight: 1 },
      { id: "TOKEN_B", weight: 1 },
      { id: "COMPLETE", weight: 2 },
    ],
    signer: signers.coordinator,
  });
  const probeRecord = makeProbeRecord({
    envelope: probeEnvelope,
    verifier,
    evaluators: {
      ROOM_B: (state) => state.room === "Room B",
      TOKEN_B: (state) => state.inventory.includes("Token B"),
      COMPLETE: (state) => state.complete === true,
    },
  });
  const probeSetCapability = registry.issue({ kind: "probe-set", campaignId, audience: "ENGINE", value: probeRecord });

  const candidate = sanitizeNormalizedDocument({
    schemaVersion: "atlas/normalized-document/1",
    pages: [{
      title: "Room B",
      nodes: [
        { type: "heading", level: 1, text: "Room B" },
        { type: "paragraph", text: "Token B를 얻은 뒤 출구 장치를 확인한다." },
      ],
    }],
  });
  const oracle = sanitizeNormalizedDocument({
    schemaVersion: "atlas/normalized-document/1",
    pages: [{
      title: "Token B",
      nodes: [
        { type: "heading", level: 1, text: "Token B" },
        { type: "paragraph", text: "Room B에서 Token B를 얻고 출구 장치를 확인한다." },
      ],
    }],
  });

  const reproductionRunId = coordinatorRandomId();
  const transferRunId = coordinatorRandomId();
  const reproductionCapability = registry.issue({ kind: "target-config", campaignId, audience: "ENGINE", value: { initialRoom: "Room A", layout: "source" } });
  const transferCapability = registry.issue({ kind: "target-config", campaignId, audience: "ENGINE", value: { initialRoom: "Room A", layout: "changed" } });
  const planPayload = {
    schemaVersion: "atlas/cohort-plan/1",
    evaluationClass,
    sourceRunId: coordinatorRandomId(),
    arms: [...ARMS],
    documents: { BASELINE: null, CANDIDATE: candidate.digest, ORACLE: oracle.digest },
    targets: [
      { targetRunId: reproductionRunId, track: "REPRODUCTION", targetConfigCapability: reproductionCapability, repetitions: 2 },
      { targetRunId: transferRunId, track: "TRANSFER", targetConfigCapability: transferCapability, repetitions: 2 },
    ],
    probeSetCapability,
    probeSetDigest: probeRecord.digest,
    gameBuildHandle: `build_${coordinatorRandomId()}`,
    agentProfileDigest: sha256("agent-profile"),
    promptDigest: sha256("reproduction-prompt"),
    budgetProfileDigest: sha256("budget-profile"),
    capturePolicyDigest: sha256("capture-policy-v1"),
    framePolicy: "KEYBOARD",
    overlayPolicyDigest: sha256("no-overlay"),
    overlayCompositorVersion: "none/v1",
    randomizedOrderCommitment: sha256("blind-order"),
  };
  const planEnvelope = createSignedCohortPlan({ campaignId, plan: planPayload, signer: signers.coordinator });
  const authorizationIssuer = new ReplayAuthorizationIssuer({ planEnvelope, verifier, signer: signers.coordinator });
  const port = new FreshStateEngineReplayPort({
    verifier,
    registry,
    engineFactory,
    probeExecutor,
    engineSigner: signers.engine,
    judgeSigner: signers.judge,
  });
  port.registerPlan(planEnvelope);
  return { contractDigest, signers, verifier, campaignId, registry, probeEnvelope, probeRecord, candidate, oracle, planPayload, planEnvelope, authorizationIssuer, port };
}

function buildTranscript(context, authorization, codes, options = {}) {
  const internalRunId = `internal_${coordinatorRandomId()}`;
  const frameEvents = [];
  const frameMaterials = [];
  let previousEvent = null;
  for (let index = 0; index <= codes.length; index += 1) {
    const raw = Buffer.from(`canvas:${authorization.header.targetRunId}:${authorization.payload.arm}:${authorization.payload.repetitionOrdinal}:${index}`, "utf8");
    const served = options.badServedAt === index ? Buffer.concat([raw, Buffer.from(":tampered")]) : raw;
    const created = createFrameServedEvent({
      authorization,
      internalRunId,
      frameId: `F${String(index + 1).padStart(6, "0")}`,
      frameOrdinal: index + 1,
      capturePolicyDigest: authorization.payload.capturePolicyDigest,
      framePolicy: authorization.payload.framePolicy,
      rawBytes: raw,
      servedBytes: served,
      overlayPolicyDigest: authorization.payload.overlayPolicyDigest,
      overlayCompositorVersion: authorization.payload.overlayCompositorVersion,
      overlayPrimitives: {},
      previousEvent,
      signer: context.signers.gateway,
    });
    frameEvents.push(created.envelope);
    frameMaterials.push(created.material);
    previousEvent = created.envelope;
  }

  const inputReceipts = [];
  let previousReceipt = null;
  for (const [index, code] of codes.entries()) {
    const receiptOrdinal = options.gapAt === index ? index + 2 : index + 1;
    const receipt = createSignedInputReceipt({
      authorization,
      internalRunId,
      requestId: `Q${String(index + 1).padStart(6, "0")}`,
      receiptOrdinal,
      expectedFrameId: frameEvents[index].payload.frameId,
      action: { kind: "keyTap", code },
      status: "DELIVERED",
      actionOrdinal: index + 1,
      retry: "DO_NOT_RETRY",
      beforeFrameReceiptDigest: artifactDigest(frameEvents[index]),
      afterFrameReceiptDigests: [artifactDigest(frameEvents[index + 1])],
      previousReceipt,
      signer: context.signers.gateway,
    });
    inputReceipts.push(receipt);
    previousReceipt = receipt;
  }
  return createActionTranscript({
    authorization,
    internalRunId,
    frameEvents,
    frameMaterials,
    inputReceipts,
    signer: context.signers.gateway,
  });
}

function successfulCodes(arm) {
  return arm === "BASELINE" ? ["ArrowRight", "Enter"] : ["ArrowRight", "Space", "Enter"];
}

function signedAuthorizationAttack(context, original, { payloadPatch = {}, headerPatch = {}, parents } = {}) {
  const payload = { ...original.payload, ...payloadPatch };
  return issueArtifact({
    artifactType: ARTIFACT.REPLAY_AUTHORIZATION,
    schemaVersion: "atlas/replay-authorization/1",
    campaignId: context.campaignId,
    track: headerPatch.track ?? payload.track,
    arm: headerPatch.arm ?? payload.arm,
    targetRunId: headerPatch.targetRunId ?? payload.targetRunId,
    issuer: context.signers.coordinator.issuer,
    keyId: context.signers.coordinator.keyId,
    parentDigests: parents ?? original.header.parentDigests,
    contractDigest: context.contractDigest,
    payload,
    privateKey: context.signers.coordinator.privateKey,
  });
}

test("complete strict cohort replays fresh engine twice and reports separated aggregates", () => {
  const context = createContext();
  const collector = new CohortCollector({ planEnvelope: context.planEnvelope, verifier: context.verifier });
  const executed = [];
  for (const cell of expectedCohortCells(context.planPayload)) {
    const authorization = context.authorizationIssuer.issue(cell);
    const transcript = buildTranscript(context, authorization, successfulCodes(cell.arm));
    const result = context.port.execute({ authorization, transcript });
    assert.deepEqual(result.first.payload, result.second.payload);
    collector.add(result.verifiedReplay);
    executed.push({ authorization, transcript, result });
  }
  const completed = collector.finalize();
  const report = buildAggregateReport({
    completedCohorts: [completed],
    campaignId: context.campaignId,
    signer: context.signers.judge,
    verifier: context.verifier,
  });
  assert.equal(report.status, "VALID");
  assert.deepEqual(report.scoreReport.payload.classes.map((entry) => entry.evaluationClass), ["STRICT"]);
  for (const track of report.scoreReport.payload.classes[0].tracks) {
    assert.equal(track.arms.find((arm) => arm.arm === "BASELINE").meanCompletion, 0.25);
    assert.equal(track.arms.find((arm) => arm.arm === "CANDIDATE").meanCompletion, 1);
    assert.equal(track.arms.find((arm) => arm.arm === "ORACLE").meanCompletion, 1);
    assert.equal(track.utility, 1);
  }
  expectCode(() => context.port.execute(executed[0]), "AUTHORIZATION_CONSUMED");
});

test("assisted cohort is reported only in its own evaluation class", () => {
  const context = createContext({ evaluationClass: "ASSISTED" });
  const collector = new CohortCollector({ planEnvelope: context.planEnvelope, verifier: context.verifier });
  for (const cell of expectedCohortCells(context.planPayload)) {
    const authorization = context.authorizationIssuer.issue(cell);
    const transcript = buildTranscript(context, authorization, successfulCodes(cell.arm));
    collector.add(context.port.execute({ authorization, transcript }).verifiedReplay);
  }
  const report = buildAggregateReport({
    completedCohorts: [collector.finalize()],
    campaignId: context.campaignId,
    signer: context.signers.judge,
    verifier: context.verifier,
  });
  assert.equal(report.status, "VALID");
  assert.deepEqual(report.scoreReport.payload.classes.map((entry) => entry.evaluationClass), ["ASSISTED"]);
});

test("forged signature and self-reported completion are rejected", () => {
  const context = createContext();
  const cell = expectedCohortCells(context.planPayload)[0];
  const authorization = context.authorizationIssuer.issue(cell);
  const forged = structuredClone(authorization);
  forged.signature = `${forged.signature.startsWith("A") ? "B" : "A"}${forged.signature.slice(1)}`;
  expectCode(() => validateReplayAuthorization({ authorization: forged, planEnvelope: context.planEnvelope, verifier: context.verifier }), "SIGNATURE_INVALID");

  const transcript = buildTranscript(context, authorization, successfulCodes(cell.arm));
  const result = context.port.execute({ authorization, transcript });
  const fakeReplay = structuredClone(result.verifiedReplay);
  fakeReplay.payload.completion = 1;
  const collector = new CohortCollector({ planEnvelope: context.planEnvelope, verifier: context.verifier });
  expectCode(() => collector.add(fakeReplay), "ARTIFACT_SHAPE_INVALID");
});

test("duplicate nonce for different signed artifacts is rejected", () => {
  const context = createContext();
  const fixedNonce = "fixed-test-nonce";
  const first = createSignedCohortPlan({ campaignId: context.campaignId, plan: { ...context.planPayload, sourceRunId: coordinatorRandomId() }, signer: { ...context.signers.coordinator, nonce: fixedNonce } });
  const second = createSignedCohortPlan({ campaignId: context.campaignId, plan: { ...context.planPayload, sourceRunId: coordinatorRandomId() }, signer: { ...context.signers.coordinator, nonce: fixedNonce } });
  context.verifier.verify(first, { artifactType: ARTIFACT.COHORT_PLAN });
  expectCode(() => context.verifier.verify(second, { artifactType: ARTIFACT.COHORT_PLAN }), "DUPLICATE_NONCE");
});

test("wrong document, arm, and target run authorizations are rejected even when signed", () => {
  const context = createContext();
  const candidateCell = expectedCohortCells(context.planPayload).find((cell) => cell.arm === "CANDIDATE");
  const authorization = context.authorizationIssuer.issue(candidateCell);
  const wrongDocument = signedAuthorizationAttack(context, authorization, { payloadPatch: { documentDigest: sha256("wrong-document") } });
  expectCode(() => validateReplayAuthorization({ authorization: wrongDocument, planEnvelope: context.planEnvelope, verifier: context.verifier }), "AUTHORIZATION_DOCUMENT_MISMATCH");

  const wrongArm = signedAuthorizationAttack(context, authorization, { payloadPatch: { arm: "UNPLANNED" }, headerPatch: { arm: "UNPLANNED" } });
  expectCode(() => validateReplayAuthorization({ authorization: wrongArm, planEnvelope: context.planEnvelope, verifier: context.verifier }), "AUTHORIZATION_OUTSIDE_PLAN");

  const unknownRun = coordinatorRandomId();
  const wrongRun = signedAuthorizationAttack(context, authorization, { payloadPatch: { targetRunId: unknownRun }, headerPatch: { targetRunId: unknownRun } });
  expectCode(() => validateReplayAuthorization({ authorization: wrongRun, planEnvelope: context.planEnvelope, verifier: context.verifier }), "AUTHORIZATION_OUTSIDE_PLAN");
});

test("gap in input receipts and invalid keyboard served frame fail closed", () => {
  const gapContext = createContext();
  const gapCell = expectedCohortCells(gapContext.planPayload)[0];
  const gapAuthorization = gapContext.authorizationIssuer.issue(gapCell);
  const gapTranscript = buildTranscript(gapContext, gapAuthorization, ["ArrowRight", "Enter"], { gapAt: 1 });
  expectCode(() => gapContext.port.execute({ authorization: gapAuthorization, transcript: gapTranscript }), "INPUT_CHAIN_INVALID");

  const frameContext = createContext();
  const frameCell = expectedCohortCells(frameContext.planPayload)[0];
  const frameAuthorization = frameContext.authorizationIssuer.issue(frameCell);
  const frameTranscript = buildTranscript(frameContext, frameAuthorization, ["ArrowRight", "Enter"], { badServedAt: 0 });
  expectCode(() => frameContext.port.execute({ authorization: frameAuthorization, transcript: frameTranscript }), "FRAME_TRANSFORM_INVALID");
});

test("missing fixed probe is rejected", () => {
  const context = createContext({ probeExecutor: (record, state) => evaluateProbeRecord(record, state).slice(1) });
  const cell = expectedCohortCells(context.planPayload)[0];
  const authorization = context.authorizationIssuer.issue(cell);
  const transcript = buildTranscript(context, authorization, successfulCodes(cell.arm));
  expectCode(() => context.port.execute({ authorization, transcript }), "PROBE_RESULT_SET_MISMATCH");
});

test("nondeterministic fresh engine replay is rejected on full payload mismatch", () => {
  let instance = 0;
  const context = createContext({
    engineFactory: (config) => {
      const engine = new SyntheticRoomTokenEngine(config);
      const salt = ++instance;
      return {
        apply: (action) => engine.apply(action),
        snapshot: () => ({ ...engine.snapshot(), nondeterministicSalt: salt }),
      };
    },
  });
  const cell = expectedCohortCells(context.planPayload)[0];
  const authorization = context.authorizationIssuer.issue(cell);
  const transcript = buildTranscript(context, authorization, successfulCodes(cell.arm));
  expectCode(() => context.port.execute({ authorization, transcript }), "INVALID_ENGINE_RUN");
});

test("incomplete cohort cannot produce an aggregate", () => {
  const context = createContext();
  const cell = expectedCohortCells(context.planPayload)[0];
  const authorization = context.authorizationIssuer.issue(cell);
  const transcript = buildTranscript(context, authorization, successfulCodes(cell.arm));
  const result = context.port.execute({ authorization, transcript });
  const collector = new CohortCollector({ planEnvelope: context.planEnvelope, verifier: context.verifier });
  collector.add(result.verifiedReplay);
  expectCode(() => collector.finalize(), "COHORT_INCOMPLETE");
});

test("document sanitizer rejects hidden channels and report quarantines canaries", () => {
  const canary = "GT_CANARY_ROOM_TOKEN_7Z";
  const encoded = Buffer.from(canary).toString("base64");
  expectCode(() => sanitizeNormalizedDocument({
    schemaVersion: "atlas/normalized-document/1",
    pages: [{ title: "Room A", nodes: [{ type: "paragraph", text: encoded }] }],
  }, { canaries: [canary] }), "LEAKAGE_QUARANTINED");
  expectCode(() => sanitizeNormalizedDocument({
    schemaVersion: "atlas/normalized-document/1",
    pages: [{ title: "Room A", nodes: [{ type: "paragraph", text: "ArrowRight, Space, Enter" }] }],
  }), "DOCUMENT_REJECTED");
  for (const rawKey of ["Enter", "ArrowRight", "KeyC", "A r r o w R i g h t", "Ｅｎｔｅｒ"]) {
    expectCode(() => sanitizeNormalizedDocument({
      schemaVersion: "atlas/normalized-document/1",
      pages: [{ title: "Room A", nodes: [{ type: "paragraph", text: rawKey }] }],
    }), "DOCUMENT_REJECTED");
  }
  expectCode(() => sanitizeNormalizedDocument({
    schemaVersion: "atlas/normalized-document/1",
    pages: [{ title: "Room A", nodes: [{ type: "html", text: "<!-- hidden -->" }] }],
  }), "DOCUMENT_REJECTED");

  const context = createContext();
  const quarantined = buildAggregateReport({
    completedCohorts: [{ campaignId: context.campaignId, evaluationClass: "STRICT", planDigest: artifactDigest(context.planEnvelope), results: [{ digest: sha256("dummy"), payload: {} }] }],
    campaignId: context.campaignId,
    signer: context.signers.judge,
    verifier: context.verifier,
    canaries: [canary],
    leakageInputs: [{ fragment: canary.slice(0, 12) }, { fragment: canary.slice(12) }],
  });
  assert.deepEqual(quarantined, { status: "LEAKAGE_QUARANTINED", scoreReport: null, hitCount: 1 });
});

test("signed NormalizedDocument binds signature, payload, parents, and safe AST", () => {
  const context = createContext();
  const parentDigest = sha256("knowledge-receipt");
  const canonical = sanitizeNormalizedDocument({
    schemaVersion: "atlas/normalized-document/1",
    pages: [{ title: "Room A", nodes: [{ type: "paragraph", text: "Token B의 위치를 확인한다." }] }],
  }).document;
  const envelope = issueArtifact({
    artifactType: ARTIFACT.NORMALIZED_DOCUMENT,
    schemaVersion: "atlas/normalized-document/1",
    campaignId: context.campaignId,
    track: "STRICT",
    arm: "CANDIDATE",
    targetRunId: context.planPayload.sourceRunId,
    issuer: context.signers.foundry.issuer,
    keyId: context.signers.foundry.keyId,
    parentDigests: [parentDigest],
    contractDigest: context.contractDigest,
    payload: canonical,
    privateKey: context.signers.foundry.privateKey,
  });
  const expected = {
    campaignId: context.campaignId,
    track: "STRICT",
    arm: "CANDIDATE",
    targetRunId: context.planPayload.sourceRunId,
    contractDigest: context.contractDigest,
    parentDigests: [parentDigest],
  };
  const accepted = verifyNormalizedDocumentArtifact({ envelope, verifier: context.verifier, expected });
  assert.equal(accepted.rawDocumentDigest, envelope.header.payloadDigest);
  assert.equal(accepted.signedArtifactDigest, artifactDigest(envelope));
  assert.equal(Object.isFrozen(accepted.document), true);
  assert.equal(Object.isFrozen(accepted.document.pages), true);

  const tamperedPayload = structuredClone(envelope);
  tamperedPayload.payload.pages[0].nodes[0].text = "변조된 문장";
  expectCode(() => verifyNormalizedDocumentArtifact({ envelope: tamperedPayload, verifier: context.verifier, expected }), "ARTIFACT_SHAPE_INVALID");

  const tamperedSignature = structuredClone(envelope);
  tamperedSignature.signature = `${tamperedSignature.signature.startsWith("A") ? "B" : "A"}${tamperedSignature.signature.slice(1)}`;
  expectCode(() => verifyNormalizedDocumentArtifact({ envelope: tamperedSignature, verifier: context.verifier, expected }), "SIGNATURE_INVALID");

  expectCode(() => verifyNormalizedDocumentArtifact({
    envelope,
    verifier: context.verifier,
    expected: { ...expected, parentDigests: [sha256("wrong-parent")] },
  }), "PARENT_DIGEST_MISMATCH");

  const wrongSchemaEnvelope = issueArtifact({
    artifactType: ARTIFACT.NORMALIZED_DOCUMENT,
    schemaVersion: "atlas/normalized-document/999",
    campaignId: context.campaignId,
    track: "STRICT",
    arm: "CANDIDATE",
    targetRunId: context.planPayload.sourceRunId,
    issuer: context.signers.foundry.issuer,
    keyId: context.signers.foundry.keyId,
    parentDigests: [parentDigest],
    contractDigest: context.contractDigest,
    payload: canonical,
    privateKey: context.signers.foundry.privateKey,
  });
  expectCode(() => verifyNormalizedDocumentArtifact({
    envelope: wrongSchemaEnvelope,
    verifier: context.verifier,
    expected,
  }), "ARTIFACT_BINDING_MISMATCH");

  const forbiddenEnvelope = issueArtifact({
    artifactType: ARTIFACT.NORMALIZED_DOCUMENT,
    schemaVersion: "atlas/normalized-document/1",
    campaignId: context.campaignId,
    track: "STRICT",
    arm: "CANDIDATE",
    targetRunId: context.planPayload.sourceRunId,
    issuer: context.signers.foundry.issuer,
    keyId: context.signers.foundry.keyId,
    parentDigests: [parentDigest],
    contractDigest: context.contractDigest,
    payload: {
      schemaVersion: "atlas/normalized-document/1",
      pages: [{ title: "Room A", nodes: [{ type: "html", text: "hidden" }] }],
    },
    privateKey: context.signers.foundry.privateKey,
  });
  expectCode(() => verifyNormalizedDocumentArtifact({ envelope: forbiddenEnvelope, verifier: context.verifier, expected }), "DOCUMENT_REJECTED");
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
  } catch (error) {
    console.error(`not ok ${passed + 1} - ${name}`);
    console.error(error);
    process.exitCode = 1;
    break;
  }
}

if (process.exitCode !== 1) console.log(`# ${passed}/${tests.length} verification cases passed`);
