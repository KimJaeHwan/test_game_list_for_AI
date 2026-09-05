import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Buffer } from "node:buffer";
import { generateWorld } from "../../../03_quest_atlas/src/content/generator.ts";
import { coordinatorRandomId, sha256 } from "../../packages/atlas_protocol/src/index.mjs";
import {
  ARTIFACT,
  ARMS,
  ArtifactVerifier,
  FreshStateEngineReplayPort,
  OpaqueCapabilityRegistry,
  ReplayAuthorizationIssuer,
  artifactDigest,
  createActionTranscript,
  createFrameServedEvent,
  createSignedCohortPlan,
  createSignedInputReceipt,
  createSignedProbeSet,
  makeProbeRecord,
  sanitizeNormalizedDocument,
} from "../../03_replay_judge/src/index.mjs";
import { QuestAtlasReplayEngine } from "./engine-adapter.mjs";

function signer(issuer, keyId, artifactTypes, contractDigest) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { issuer, keyId, artifactTypes, contractDigest, privateKey, publicKey };
}

function buildTranscript(context, authorization, codes) {
  const internalRunId = `internal_${coordinatorRandomId()}`;
  const frameEvents = [];
  const frameMaterials = [];
  let previousEvent = null;
  for (let index = 0; index <= codes.length; index += 1) {
    const raw = Buffer.from(`quest-atlas-canvas:${authorization.header.targetRunId}:${index}`, "utf8");
    const created = createFrameServedEvent({
      authorization,
      internalRunId,
      frameId: `F${String(index + 1).padStart(6, "0")}`,
      frameOrdinal: index + 1,
      capturePolicyDigest: authorization.payload.capturePolicyDigest,
      framePolicy: authorization.payload.framePolicy,
      rawBytes: raw,
      servedBytes: raw,
      overlayPolicyDigest: authorization.payload.overlayPolicyDigest,
      overlayCompositorVersion: authorization.payload.overlayCompositorVersion,
      overlayPrimitives: {},
      previousEvent,
      signer: context.gateway,
    });
    frameEvents.push(created.envelope);
    frameMaterials.push(created.material);
    previousEvent = created.envelope;
  }

  const inputReceipts = [];
  let previousReceipt = null;
  for (const [index, code] of codes.entries()) {
    const receipt = createSignedInputReceipt({
      authorization,
      internalRunId,
      requestId: `Q${String(index + 1).padStart(6, "0")}`,
      receiptOrdinal: index + 1,
      expectedFrameId: frameEvents[index].payload.frameId,
      action: { kind: "keyTap", code },
      status: "DELIVERED",
      actionOrdinal: index + 1,
      retry: "DO_NOT_RETRY",
      beforeFrameReceiptDigest: artifactDigest(frameEvents[index]),
      afterFrameReceiptDigests: [artifactDigest(frameEvents[index + 1])],
      previousReceipt,
      signer: context.gateway,
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
    signer: context.gateway,
  });
}

const contractDigest = sha256("atlas-protocol-public-contract-v1");
const coordinator = signer(
  "TrustedCoordinator",
  "coordinator-integration-key",
  [ARTIFACT.PROBE_SET, ARTIFACT.COHORT_PLAN, ARTIFACT.REPLAY_AUTHORIZATION],
  contractDigest,
);
const gateway = signer(
  "InputGateway",
  "gateway-integration-key",
  [ARTIFACT.FRAME_SERVED_EVENT, ARTIFACT.INPUT_RECEIPT, ARTIFACT.ACTION_TRANSCRIPT],
  contractDigest,
);
const engineSigner = signer("EngineRunner", "engine-integration-key", [ARTIFACT.ENGINE_OUTCOME], contractDigest);
const judgeSigner = signer("ReplayJudge", "judge-integration-key", [ARTIFACT.VERIFIED_REPLAY], contractDigest);
const verifier = new ArtifactVerifier();
for (const entry of [coordinator, gateway, engineSigner, judgeSigner]) {
  verifier.registerKey({
    keyId: entry.keyId,
    issuer: entry.issuer,
    publicKey: entry.publicKey,
    artifactTypes: entry.artifactTypes,
  });
}

const campaignId = coordinatorRandomId();
const registry = new OpaqueCapabilityRegistry();
const probeEnvelope = createSignedProbeSet({
  campaignId,
  goals: [
    { id: "EXPLORATION_REACHED", weight: 1 },
    { id: "SECOND_REGION_VISITED", weight: 2 },
  ],
  signer: coordinator,
});
const probeRecord = makeProbeRecord({
  envelope: probeEnvelope,
  verifier,
  evaluators: {
    EXPLORATION_REACHED: (state) => state.phase === "explore",
    SECOND_REGION_VISITED: (state) => state.visitedRegions.length >= 2,
  },
});
const probeSetCapability = registry.issue({
  kind: "probe-set",
  campaignId,
  audience: "ENGINE",
  value: probeRecord,
});

const sourceConfig = {
  scenarioSeed: "integration-scenario",
  layoutSeed: "integration-layout-a",
  visualSeed: "integration-visual-a",
  sessionSeed: "integration-session-a",
};
const transferConfig = {
  ...sourceConfig,
  layoutSeed: "integration-layout-b",
  visualSeed: "integration-visual-b",
  sessionSeed: "integration-session-b",
};
assert.equal(generateWorld(sourceConfig).scenarioHash, generateWorld(transferConfig).scenarioHash);
const reproductionRunId = coordinatorRandomId();
const transferRunId = coordinatorRandomId();
const reproductionCapability = registry.issue({
  kind: "target-config",
  campaignId,
  audience: "ENGINE",
  value: sourceConfig,
});
const transferCapability = registry.issue({
  kind: "target-config",
  campaignId,
  audience: "ENGINE",
  value: transferConfig,
});

const candidate = sanitizeNormalizedDocument({
  schemaVersion: "atlas/normalized-document/1",
  pages: [{ title: "항로 조사", nodes: [{ type: "paragraph", text: "브리핑을 마치고 첫 항로를 조사한다." }] }],
});
const oracle = sanitizeNormalizedDocument({
  schemaVersion: "atlas/normalized-document/1",
  pages: [{ title: "검증 절차", nodes: [{ type: "paragraph", text: "브리핑을 마친 후 사용 가능한 첫 이동 대상을 확인한다." }] }],
});
const planPayload = {
  schemaVersion: "atlas/cohort-plan/1",
  evaluationClass: "STRICT",
  sourceRunId: coordinatorRandomId(),
  arms: [...ARMS],
  documents: { BASELINE: null, CANDIDATE: candidate.digest, ORACLE: oracle.digest },
  targets: [
    { targetRunId: reproductionRunId, track: "REPRODUCTION", targetConfigCapability: reproductionCapability, repetitions: 1 },
    { targetRunId: transferRunId, track: "TRANSFER", targetConfigCapability: transferCapability, repetitions: 1 },
  ],
  probeSetCapability,
  probeSetDigest: probeRecord.digest,
  gameBuildHandle: `build_${coordinatorRandomId()}`,
  agentProfileDigest: sha256("quest-atlas-agent-profile"),
  promptDigest: sha256("quest-atlas-reproduction-prompt"),
  budgetProfileDigest: sha256("quest-atlas-budget"),
  capturePolicyDigest: sha256("quest-atlas-canvas-policy"),
  framePolicy: "KEYBOARD",
  overlayPolicyDigest: sha256("quest-atlas-no-overlay"),
  overlayCompositorVersion: "none/v1",
  randomizedOrderCommitment: sha256("quest-atlas-blind-order"),
};
const planEnvelope = createSignedCohortPlan({ campaignId, plan: planPayload, signer: coordinator });
const authorizationIssuer = new ReplayAuthorizationIssuer({ planEnvelope, verifier, signer: coordinator });
const port = new FreshStateEngineReplayPort({
  verifier,
  registry,
  engineFactory: (config) => new QuestAtlasReplayEngine(config),
  engineSigner,
  judgeSigner,
});
port.registerPlan(planEnvelope);

const codes = ["Enter", "Enter", "Enter", "Enter"];
const completions = {};
for (const target of planPayload.targets) {
  const authorization = authorizationIssuer.issue({
    track: target.track,
    arm: "CANDIDATE",
    targetRunId: target.targetRunId,
    repetitionOrdinal: 1,
  });
  const transcript = buildTranscript({ gateway }, authorization, codes);
  const result = port.execute({ authorization, transcript });
  assert.deepEqual(result.first.payload, result.second.payload);
  assert.equal(result.first.payload.completion, 1);
  assert.equal(result.first.payload.finalState.phase, "explore");
  assert.equal(result.first.payload.finalState.visitedRegions.length, 2);
  completions[target.track] = result.verifiedReplay.payload.completion;
}

assert.throws(
  () => new QuestAtlasReplayEngine(sourceConfig).apply({ kind: "keyTap", code: "KeyZ" }),
  /allowlisted keyTap/u,
);
console.log(JSON.stringify({
  adapter: "03_quest_atlas actual reducer",
  freshReplayPasses: 2,
  tracks: completions,
  rawConfigExposed: false,
}, null, 2));
