import {
  canonicalize as protocolCanonicalize,
  publicHandoffPayloadDigest,
  sha256 as protocolSha256,
  signDetached,
  validateEvidenceComparisonPlan as protocolValidateEvidenceComparisonPlan,
  validatePublicPlayHandoff as protocolValidatePublicPlayHandoff,
  validateSignedEnvelopeShape,
  verifyDetached,
  verifySignedEnvelope,
} from "../../packages/atlas_protocol/src/index.mjs";
import {
  canonicalJson, deepFreeze, fail, isObject, jsonCopy,
} from "./core.mjs";

function failProtocol(name, result) {
  if (!isObject(result) || result.valid !== true || !Array.isArray(result.errors)) {
    fail(`${name}: malformed validator result`);
  }
  if (result.errors.length !== 0) {
    fail(`${name}: ${result.errors.join("; ")}`);
  }
}

export function validatePublicPlayHandoff(handoff) {
  let result;
  try {
    result = protocolValidatePublicPlayHandoff(handoff);
  } catch (error) {
    fail(`PublicPlayHandoff: validator threw: ${error.message}`);
  }
  failProtocol("PublicPlayHandoff", result);
  const recomputed = publicHandoffPayloadDigest(handoff);
  if (handoff.manifest.payloadDigest !== recomputed) {
    fail("PublicPlayHandoff: payloadDigest mismatch");
  }
  return true;
}

function unsignedPlan(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    planId: plan.planId,
    groups: jsonCopy(plan.groups),
  };
}

export function signEvidenceComparisonPlan(plan, privateKey) {
  const unsigned = unsignedPlan(plan);
  const signed = {
    ...unsigned,
    signature: signDetached(unsigned, privateKey),
  };
  const shape = protocolValidateEvidenceComparisonPlan(signed);
  failProtocol("EvidenceComparisonPlan", shape);
  return deepFreeze(signed);
}

export function verifyEvidenceComparisonPlan(plan, publicKey) {
  let result;
  try {
    result = protocolValidateEvidenceComparisonPlan(plan);
  } catch (error) {
    fail(`EvidenceComparisonPlan: validator threw: ${error.message}`);
  }
  failProtocol("EvidenceComparisonPlan", result);
  if (!verifyDetached(unsignedPlan(plan), plan.signature, publicKey)) {
    fail("EvidenceComparisonPlan: invalid detached signature");
  }
  return true;
}

function entriesOfFiles(files) {
  if (files instanceof Map) return [...files.entries()];
  if (isObject(files)) return Object.entries(files);
  fail("files: Map or plain object required");
}

function canonicalNdjson(entries) {
  return Buffer.from(
    entries.length === 0
      ? ""
      : entries.map((entry) => protocolCanonicalize(entry)).join("\n") + "\n",
    "utf8",
  );
}

function validateArchive(handoff, files) {
  const entries = entriesOfFiles(files);
  const supplied = new Map(
    entries.map(([relativeName, bytes]) => [relativeName, Buffer.from(bytes)]),
  );
  if (supplied.size !== entries.length) fail("files: duplicate relativeName");
  const manifestNames = handoff.manifest.files
    .map((file) => file.relativeName);
  if (new Set(manifestNames).size !== manifestNames.length) {
    fail("manifest.files: duplicate relativeName");
  }
  const expectedNames = new Set(manifestNames);
  if (supplied.size !== expectedNames.size) {
    fail("files: exact manifest file set required");
  }
  for (const relativeName of supplied.keys()) {
    if (!expectedNames.has(relativeName)) {
      fail(`files.${relativeName}: extra file`);
    }
  }
  for (const file of handoff.manifest.files) {
    const bytes = supplied.get(file.relativeName);
    if (!bytes) fail(`files.${file.relativeName}: missing file`);
    if (bytes.byteLength !== file.bytes) {
      fail(`files.${file.relativeName}: byte length mismatch`);
    }
    if (protocolSha256(bytes) !== file.sha256) {
      fail(`files.${file.relativeName}: sha256 mismatch`);
    }
  }

  const observationFiles = handoff.manifest.files.filter(
    (file) => file.role === "observations",
  );
  const actionFiles = handoff.manifest.files.filter(
    (file) => file.role === "actions",
  );
  if (observationFiles.length !== 1
    || observationFiles[0].relativeName !== "observations.ndjson") {
    fail("manifest.files: exactly one observations.ndjson with observations role required");
  }
  if (actionFiles.length !== 1
    || actionFiles[0].relativeName !== "actions.ndjson") {
    fail("manifest.files: exactly one actions.ndjson with actions role required");
  }
  if (!supplied.get("observations.ndjson").equals(
    canonicalNdjson(handoff.observations),
  )) {
    fail("observations.ndjson: canonical payload mismatch");
  }
  if (!supplied.get("actions.ndjson").equals(
    canonicalNdjson(handoff.actions),
  )) {
    fail("actions.ndjson: canonical payload mismatch");
  }

  const frameFiles = handoff.manifest.files.filter(
    (file) => file.role === "frames",
  );
  if (frameFiles.length !== handoff.frames.length) {
    fail("manifest.files: frame role must map 1:1 to frames");
  }
  const frameByMediaRef = new Map();
  for (const frame of handoff.frames) {
    if (frameByMediaRef.has(frame.mediaRef)) {
      fail("frames: duplicate mediaRef");
    }
    frameByMediaRef.set(frame.mediaRef, frame);
  }
  for (const file of frameFiles) {
    const frame = frameByMediaRef.get(file.relativeName);
    if (!frame) fail("manifest.files: orphan frame role");
    if (file.sha256 !== frame.sha256) {
      fail("manifest.files: frame/file sha256 mismatch");
    }
  }
  for (const frame of handoff.frames) {
    const matches = frameFiles.filter(
      (file) => file.relativeName === frame.mediaRef,
    );
    if (matches.length !== 1) {
      fail("manifest.files: every frame mediaRef needs one frame role");
    }
  }
  if (handoff.manifest.files.some(
    (file) => !["frames", "observations", "actions"].includes(file.role),
  )) {
    fail("manifest.files: unsupported archive role");
  }
  return supplied;
}

function validateExpectedBinding(expectedBinding) {
  if (!isObject(expectedBinding)) {
    fail("expectedBinding: object required");
  }
  const fields = [
    "artifactId",
    "campaignId",
    "track",
    "arm",
    "targetRunId",
    "contractDigest",
  ];
  const keys = Object.keys(expectedBinding);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
    fail("expectedBinding: exact artifact/campaign/track/arm/target/contract fields required");
  }
  for (const field of fields) {
    if (typeof expectedBinding[field] !== "string" || expectedBinding[field].length === 0) {
      fail(`expectedBinding.${field}: non-empty text required`);
    }
  }
}

export function validateRunnerHandoffEnvelope(
  envelope,
  runnerPublicKey,
  expectedBinding,
) {
  let shape;
  try {
    shape = validateSignedEnvelopeShape(envelope);
  } catch (error) {
    fail(`SignedEnvelope: validator threw: ${error.message}`);
  }
  failProtocol("SignedEnvelope", shape);
  if (!verifySignedEnvelope(envelope, runnerPublicKey)) {
    fail("SignedEnvelope: invalid Runner signature");
  }
  validateExpectedBinding(expectedBinding);
  const { header, payload } = envelope;
  if (header.artifactType !== "PublicPlayHandoff") {
    fail("SignedEnvelope: artifactType must be PublicPlayHandoff");
  }
  if (header.schemaVersion !== "atlas/public-play-handoff/1") {
    fail("SignedEnvelope: PublicPlayHandoff header schemaVersion mismatch");
  }
  for (const field of [
    "artifactId",
    "campaignId",
    "track",
    "arm",
    "targetRunId",
    "contractDigest",
  ]) {
    if (header[field] !== expectedBinding[field]) {
      fail(`SignedEnvelope: header ${field} binding mismatch`);
    }
  }
  if (header.payloadDigest !== protocolSha256(payload)) {
    fail("SignedEnvelope: header payloadDigest mismatch");
  }
  validatePublicPlayHandoff(payload);
  if (payload.manifest.artifactId !== header.artifactId) {
    fail("SignedEnvelope: payload artifactId binding mismatch");
  }
  if (payload.manifest.runId !== header.targetRunId) {
    fail("SignedEnvelope: payload runId binding mismatch");
  }
  return true;
}

export class ContentAddressedEvidenceStore {
  #artifacts = new Map();
  #frameFiles = new Map();

  importHandoff(request) {
    if (!isObject(request)) fail("importHandoff: object required");
    const allowed = new Set([
      "envelope",
      "runnerPublicKey",
      "files",
      "expectedBinding",
      "comparisonMembership",
    ]);
    for (const key of Object.keys(request)) {
      if (!allowed.has(key)) {
        fail(`importHandoff: unsupported property '${key}'`);
      }
    }
    for (const key of [
      "envelope",
      "runnerPublicKey",
      "files",
      "expectedBinding",
    ]) {
      if (!(key in request)) fail(`importHandoff: missing '${key}'`);
    }
    const {
      envelope,
      runnerPublicKey,
      files,
      expectedBinding,
      comparisonMembership,
    } = request;
    validateRunnerHandoffEnvelope(
      envelope,
      runnerPublicKey,
      expectedBinding,
    );
    const handoff = envelope.payload;
    const supplied = validateArchive(handoff, files);

    const artifactDigest = protocolSha256(envelope);
    const groupRefs = [];
    if (comparisonMembership !== undefined) {
      if (!isObject(comparisonMembership)
        || !("plan" in comparisonMembership)
        || !("publicKey" in comparisonMembership)
        || Object.keys(comparisonMembership).some((key) => key !== "plan" && key !== "publicKey")) {
        fail("comparisonMembership: exact plan/publicKey object required");
      }
      verifyEvidenceComparisonPlan(
        comparisonMembership.plan,
        comparisonMembership.publicKey,
      );
      for (const group of comparisonMembership.plan.groups) {
        if (group.handoffDigests.includes(artifactDigest)) {
          groupRefs.push(group.groupRef);
        }
      }
      if (groupRefs.length === 0) {
        fail("comparisonMembership: payloadDigest is not a group member");
      }
    }

    const artifact = deepFreeze({
      artifactDigest,
      envelopeHeader: jsonCopy(envelope.header),
      handoff: jsonCopy(handoff),
      payloadDigest: handoff.manifest.payloadDigest,
      groupRefs: [...groupRefs].sort(),
    });
    const prior = this.#artifacts.get(artifactDigest);
    if (prior && canonicalJson(prior) !== canonicalJson(artifact)) {
      fail("artifact payloadDigest collision or membership mutation");
    }
    if (!prior) {
      this.#artifacts.set(artifactDigest, artifact);
      const copies = new Map();
      for (const [relativeName, bytes] of supplied) {
        copies.set(relativeName, Buffer.from(bytes));
      }
      this.#frameFiles.set(artifactDigest, copies);
    }
    return this.getArtifact(artifactDigest);
  }

  has(artifactDigest) {
    return this.#artifacts.has(artifactDigest);
  }

  getArtifact(artifactDigest) {
    const artifact = this.#artifacts.get(artifactDigest);
    return artifact ? deepFreeze(jsonCopy(artifact)) : undefined;
  }

  getFile(artifactDigest, relativeName) {
    const bytes = this.#frameFiles.get(artifactDigest)?.get(relativeName);
    return bytes ? Buffer.from(bytes) : undefined;
  }

  observation(artifactDigest, observationId) {
    return this.#artifacts.get(artifactDigest)?.handoff.observations
      .find((entry) => entry.observationId === observationId);
  }

  frame(artifactDigest, frameId) {
    return this.#artifacts.get(artifactDigest)?.handoff.frames
      .find((entry) => entry.frameId === frameId);
  }

  action(artifactDigest, actionId) {
    return this.#artifacts.get(artifactDigest)?.handoff.actions
      .find((entry) => entry.actionId === actionId);
  }

  isComparisonMember(artifactDigest, groupRef) {
    return this.#artifacts.get(artifactDigest)
      ?.groupRefs.includes(groupRef) ?? false;
  }
}
