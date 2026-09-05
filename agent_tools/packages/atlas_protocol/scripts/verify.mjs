import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { verify as cryptoVerify } from "node:crypto";
import {
  canonicalize,
  createSignedEnvelope,
  publicHandoffPayloadDigest,
  scanForForbiddenData,
  sha256,
  signDetached,
  validateEvidenceComparisonPlan,
  validateNormalizedDocument,
  validatePublicPlayHandoff,
  validateSignedEnvelopeShape,
  verifySignedEnvelope,
} from "../src/index.mjs";

const vector = JSON.parse(await readFile(
  new URL("../fixtures/ed25519-test-vector.json", import.meta.url),
  "utf8",
));

assert.equal(canonicalize({ z: 1, a: "e\u0301" }), '{"a":"é","z":1}');
assert.equal(sha256({ b: 2, a: 1 }), sha256({ a: 1, b: 2 }));
assert.throws(() => canonicalize({ value: Number.NaN }), /non-finite/);
const cycle = {};
cycle.self = cycle;
assert.throws(() => canonicalize(cycle), /cycle/);

assert.equal(
  cryptoVerify(
    null,
    Buffer.from(vector.message),
    vector.publicKeyPem,
    Buffer.from(vector.signatureBase64url, "base64url"),
  ),
  true,
);
const signedValue = { room: "Room A", token: "Token B" };
const detached = signDetached(signedValue, vector.privateKeyPem);

const frames = [
  {
    frameId: "F000001",
    ordinal: 1,
    mediaRef: "frames/F000001.png",
    sha256: "1".repeat(64),
    evidenceRole: "CITEABLE",
    sourceActionRefs: [],
  },
  {
    frameId: "F000002",
    ordinal: 2,
    mediaRef: "frames/F000002.png",
    sha256: "2".repeat(64),
    evidenceRole: "CITEABLE",
    sourceActionRefs: ["A000001"],
  },
];
const observations = [
  {
    observationId: "O000001",
    ordinal: 1,
    frameRefs: ["F000002"],
    precedingActionRefs: ["A000001"],
  },
];
const actions = [
  {
    actionId: "A000001",
    ordinal: 1,
    input: { kind: "keyTap", code: "Enter" },
    delivery: "DELIVERED",
    beforeFrameRef: "F000001",
    afterFrameRefs: ["F000002"],
    changeClass: "PERSISTENT_CHANGE",
  },
];
const handoff = {
  manifest: {
    schemaVersion: "atlas/public-play-handoff/1",
    artifactId: "AAAAAAAAAAAAAAAAAAAAAA",
    runId: "BBBBBBBBBBBBBBBBBBBBBB",
    status: "COMPLETE",
    validity: "OFFICIAL",
    framePolicyVersion: "canvas-served/v1",
    inputPolicyVersion: "keyboard-restricted/v1",
    capture: { width: 1280, height: 720, format: "png", colorSpace: "srgb" },
    counts: { frames: 2, observations: 1, actions: 1, interventions: 0 },
    files: [
      { role: "frames", relativeName: "frames/F000001.png", bytes: 3, sha256: "1".repeat(64) },
      { role: "frames", relativeName: "frames/F000002.png", bytes: 3, sha256: "2".repeat(64) },
      { role: "observations", relativeName: "observations.ndjson", bytes: 3, sha256: "3".repeat(64) },
      { role: "actions", relativeName: "actions.ndjson", bytes: 3, sha256: "4".repeat(64) },
    ],
    payloadDigest: "",
  },
  frames,
  observations,
  actions,
};
handoff.manifest.payloadDigest = publicHandoffPayloadDigest(handoff);
assert.deepEqual(validatePublicPlayHandoff(handoff), { valid: true, errors: [] });

const withSeed = structuredClone(handoff);
withSeed.manifest.scenarioSeed = 7;
assert.equal(validatePublicPlayHandoff(withSeed).valid, false);

const withTarget = structuredClone(handoff);
withTarget.actions[0].input = { kind: "opaqueActivate", optionRef: "OPT-A7" };
withTarget.manifest.payloadDigest = publicHandoffPayloadDigest(withTarget);
assert.equal(validatePublicPlayHandoff(withTarget).valid, false);

const withMutation = structuredClone(handoff);
withMutation.frames[0].sha256 = "9".repeat(64);
assert.equal(validatePublicPlayHandoff(withMutation).valid, false);
assert.equal(scanForForbiddenData({ note: "R1RfQ0FOQVJZX2xlYWs=" }).length > 0, true);

const planUnsigned = {
  schemaVersion: "atlas/evidence-comparison-plan/1",
  planId: "CCCCCCCCCCCCCCCCCCCCCC",
  groups: [{ groupRef: "G01", handoffDigests: ["1".repeat(64), "2".repeat(64)] }],
};
const plan = { ...planUnsigned, signature: signDetached(planUnsigned, vector.privateKeyPem) };
assert.deepEqual(validateEvidenceComparisonPlan(plan, vector.publicKeyPem), { valid: true, errors: [] });
const forgedPlan = structuredClone(plan);
forgedPlan.groups[0].handoffDigests[0] = "3".repeat(64);
assert.equal(validateEvidenceComparisonPlan(forgedPlan, vector.publicKeyPem).valid, false);

const envelope = createSignedEnvelope(
  {
    artifactType: "synthetic",
    schemaVersion: "atlas/signed-envelope/1",
    artifactId: "DDDDDDDDDDDDDDDDDDDDDD",
    campaignId: "campaign-test",
    track: "TRANSFER",
    arm: "CANDIDATE",
    targetRunId: "EEEEEEEEEEEEEEEEEEEEEE",
    issuer: "test",
    keyId: "test-key",
    nonce: "nonce-1",
    parentDigests: ["5".repeat(64)],
    contractDigest: "6".repeat(64),
  },
  { value: 1 },
  vector.privateKeyPem,
);
assert.equal(validateSignedEnvelopeShape(envelope).valid, true);
assert.equal(verifySignedEnvelope(envelope, vector.publicKeyPem), true);
const forgedEnvelope = structuredClone(envelope);
forgedEnvelope.payload.value = 2;
assert.equal(verifySignedEnvelope(forgedEnvelope, vector.publicKeyPem), false);
assert.equal(detached.length > 32, true);

const normalizedDocument = {
  schemaVersion: "atlas/normalized-document/1",
  pages: [{
    title: "Room B",
    nodes: [
      { type: "heading", level: 1, text: "Room B" },
      { type: "list", ordered: true, items: ["Token B를 확인한다."] },
    ],
  }],
};
assert.deepEqual(validateNormalizedDocument(normalizedDocument), { valid: true, errors: [] });
const documentWithMacro = structuredClone(normalizedDocument);
documentWithMacro.pages[0].nodes[0].script = "ArrowRight";
assert.equal(validateNormalizedDocument(documentWithMacro).valid, false);
const documentWithMissingLink = structuredClone(normalizedDocument);
documentWithMissingLink.pages[0].nodes.push({ type: "link", label: "missing", targetTitle: "Nowhere" });
assert.equal(validateNormalizedDocument(documentWithMissingLink).valid, false);

console.log("atlas_protocol: 21 checks passed");
