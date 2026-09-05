import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coordinatorRandomId, sha256 } from "../../packages/atlas_protocol/src/index.mjs";
import {
  CoordinatorIdentityPool,
  FileWalStore,
  PlayerRunnerService,
} from "../../01_player_runner/src/index.mjs";
import { SyntheticTrustedAdapter } from "../../01_player_runner/fixtures/synthetic-runner-adapter.mjs";
import {
  ContentAddressedEvidenceStore,
  WikiWorkspace,
  attestTranscript,
  buildWikiBundle,
  sealWikiBundle,
} from "../../02_wiki_foundry/src/index.mjs";
import {
  ArtifactVerifier,
  sanitizeNormalizedDocument,
  verifyNormalizedDocumentArtifact,
} from "../../03_replay_judge/src/index.mjs";

const temporaryRoot = mkdtempSync(join(tmpdir(), "atlas-pipeline-"));
try {
  const runnerKeys = generateKeyPairSync("ed25519");
  const transcriptKeys = generateKeyPairSync("ed25519");
  const foundryKeys = generateKeyPairSync("ed25519");
  const publicRunId = coordinatorRandomId();
  const identityPool = new CoordinatorIdentityPool({
    campaignId: coordinatorRandomId(),
    publicRunId,
    targetRunId: publicRunId,
    artifactIds: Array.from({ length: 128 }, () => coordinatorRandomId()),
    nonces: Array.from({ length: 128 }, () => coordinatorRandomId()),
  });
  const adapter = new SyntheticTrustedAdapter({ interactionTargets: [] });
  const runner = new PlayerRunnerService({
    adapter,
    internalRunId: coordinatorRandomId(),
    identityPool,
    signingPrivateKey: runnerKeys.privateKey,
    runnerKeyId: "pipeline-runner-key",
    clientBinding: "pipeline-client",
    wal: new FileWalStore(join(temporaryRoot, "input.wal")),
    allowedKeys: ["Enter"],
  });

  const attached = await runner.callTool("attach_run", { launchTicket: "pipeline-launch-ticket" });
  const before = await runner.callTool("observe", { observeCap: attached.observeCap });
  const input = await runner.callTool("tap_key", {
    keyboardCap: attached.keyboardCap,
    requestId: "pipeline-input-1",
    expectedFrameId: before.frameId,
    code: "Enter",
  });
  assert.equal(input.status, "DELIVERED");
  const after = await runner.callTool("wait_frame", {
    observeCap: attached.observeCap,
    afterFrameId: before.frameId,
    maxFrames: 5,
  });
  const bookmark = await runner.callTool("bookmark_observation", {
    bookmarkCap: attached.bookmarkCap,
    frameIds: [after.frameId],
    precedingActionIds: ["A000001"],
  });
  await runner.callTool("request_end", { handoffCap: attached.handoffCap, reason: "COMPLETE" });
  await runner.callTool("seal_handoff", { handoffCap: attached.handoffCap });
  const artifacts = runner.getSealedArtifacts();

  const header = artifacts.publicHandoff.header;
  const store = new ContentAddressedEvidenceStore();
  const imported = store.importHandoff({
    envelope: artifacts.publicHandoff,
    runnerPublicKey: runnerKeys.publicKey,
    files: artifacts.publicFiles,
    expectedBinding: {
      artifactId: header.artifactId,
      campaignId: header.campaignId,
      track: header.track,
      arm: header.arm,
      targetRunId: header.targetRunId,
      contractDigest: header.contractDigest,
    },
  });
  assert.equal(imported.artifactDigest, sha256(artifacts.publicHandoff));

  const transcript = attestTranscript({
    schemaVersion: "1.0",
    transcriptId: "transcript-service-room",
    artifactDigest: imported.artifactDigest,
    segments: [{ observationId: bookmark.observationId, text: "서비스 룸에서 이동 가능한 출구를 확인했다." }],
  }, transcriptKeys.privateKey);
  const workspace = new WikiWorkspace({ store, transcriptPublicKey: transcriptKeys.publicKey });
  workspace.addTranscript(transcript);
  workspace.addEntity({
    entityId: "submitted-service-room",
    type: "region",
    name: "서비스 룸",
    nameEvidenceId: "transcript-service-room",
    status: "approved",
  });
  const wikiBundle = buildWikiBundle(workspace);
  const judged = sanitizeNormalizedDocument(wikiBundle.normalizedDocument);
  assert.equal(judged.digest, wikiBundle.knowledgeReceipt.normalizedDocumentDigest);
  const foundryBinding = {
    campaignId: header.campaignId,
    track: "KNOWLEDGE",
    arm: "NONE",
    targetRunId: header.targetRunId,
    contractDigest: header.contractDigest,
  };
  const sealedWiki = sealWikiBundle({
    bundle: wikiBundle,
    signer: { issuer: "WikiFoundry", keyId: "pipeline-foundry-key", privateKey: foundryKeys.privateKey },
    ...foundryBinding,
    allocations: [
      { artifactId: coordinatorRandomId(), nonce: coordinatorRandomId() },
      { artifactId: coordinatorRandomId(), nonce: coordinatorRandomId() },
    ],
    parentHandoffEnvelopeDigests: [imported.artifactDigest],
  });
  const judgeVerifier = new ArtifactVerifier();
  judgeVerifier.registerKey({
    keyId: "pipeline-foundry-key",
    issuer: "WikiFoundry",
    publicKey: foundryKeys.publicKey,
    artifactTypes: ["atlas/knowledge-receipt", "atlas/normalized-document"],
  });
  const knowledgeDigest = sha256(sealedWiki.knowledgeReceiptEnvelope);
  judgeVerifier.verify(sealedWiki.knowledgeReceiptEnvelope, {
    artifactType: "atlas/knowledge-receipt",
    ...foundryBinding,
    parentDigests: [imported.artifactDigest],
  });
  const verifiedDocument = verifyNormalizedDocumentArtifact({
    envelope: sealedWiki.normalizedDocumentEnvelope,
    verifier: judgeVerifier,
    expected: { ...foundryBinding, parentDigests: [knowledgeDigest] },
  });
  assert.equal(verifiedDocument.rawDocumentDigest, wikiBundle.knowledgeReceipt.normalizedDocumentDigest);
  const delivered = JSON.stringify(wikiBundle.normalizedDocument);
  for (const forbidden of [
    header.artifactId,
    header.targetRunId,
    before.frameId,
    "A000001",
    bookmark.observationId,
    "transcript-service-room",
  ]) assert.equal(delivered.includes(forbidden), false);

  console.log(JSON.stringify({
    flow: "PlayerRunner signed handoff -> WikiFoundry evidence -> ReplayJudge document gate",
    handoffSignature: "verified",
    evidenceClosure: "attested",
    normalizedDocument: "accepted",
    signedWikiChain: "handoff -> knowledge receipt -> normalized document",
    provenanceLeakage: 0,
  }, null, 2));
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
