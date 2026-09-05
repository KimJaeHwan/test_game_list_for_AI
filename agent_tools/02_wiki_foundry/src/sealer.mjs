import {
  createSignedEnvelope,
  sha256 as protocolSha256,
  validateNormalizedDocument,
  validateSignedEnvelopeShape,
  verifySignedEnvelope,
} from "../../packages/atlas_protocol/src/index.mjs";
import {
  HEX_64, SAFE_ID, deepFreeze, fail, isObject,
} from "./core.mjs";

const usedCoordinatorValues = new Set();

function exactObject(value, required, context) {
  if (!isObject(value)) fail(`${context}: object required`);
  const keys = Object.keys(value);
  if (keys.length !== required.length
    || keys.some((key) => !required.includes(key))) {
    fail(`${context}: exact fields required`);
  }
  for (const key of required) {
    if (!(key in value)) fail(`${context}: missing '${key}'`);
  }
}

function nonEmptyText(value, context) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    fail(`${context}: non-empty text required`);
  }
}

function validateEnvelopeShape(envelope, context) {
  let result;
  try {
    result = validateSignedEnvelopeShape(envelope);
  } catch (error) {
    fail(`${context}: validator threw: ${error.message}`);
  }
  if (!result || result.valid !== true || !Array.isArray(result.errors)
    || result.errors.length !== 0) {
    const errors = Array.isArray(result?.errors)
      ? result.errors.join("; ")
      : "malformed validator result";
    fail(`${context}: ${errors}`);
  }
}

function sortedUniqueDigests(values, context) {
  if (!Array.isArray(values) || values.length === 0) {
    fail(`${context}: non-empty digest array required`);
  }
  for (const value of values) {
    if (typeof value !== "string" || !HEX_64.test(value)) {
      fail(`${context}: invalid digest`);
    }
  }
  if (new Set(values).size !== values.length) {
    fail(`${context}: duplicate digest`);
  }
  return [...values].sort();
}

function sameStrings(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function sealWikiBundle(input) {
  exactObject(input, [
    "bundle",
    "signer",
    "campaignId",
    "track",
    "arm",
    "targetRunId",
    "contractDigest",
    "allocations",
    "parentHandoffEnvelopeDigests",
  ], "sealWikiBundle");
  const {
    bundle,
    signer,
    campaignId,
    track,
    arm,
    targetRunId,
    contractDigest,
    allocations,
    parentHandoffEnvelopeDigests,
  } = input;
  if (!isObject(bundle)
    || !isObject(bundle.knowledgeReceipt)
    || !isObject(bundle.normalizedDocument)) {
    fail("sealWikiBundle.bundle: buildWikiBundle result required");
  }
  exactObject(signer, ["issuer", "keyId", "privateKey"], "sealWikiBundle.signer");
  nonEmptyText(signer.issuer, "sealWikiBundle.signer.issuer");
  nonEmptyText(signer.keyId, "sealWikiBundle.signer.keyId");
  for (const [field, value] of Object.entries({
    campaignId,
    track,
    arm,
    targetRunId,
  })) {
    nonEmptyText(value, `sealWikiBundle.${field}`);
  }
  if (typeof contractDigest !== "string" || !HEX_64.test(contractDigest)) {
    fail("sealWikiBundle.contractDigest: invalid digest");
  }
  if (!Array.isArray(allocations) || allocations.length !== 2) {
    fail("sealWikiBundle.allocations: exactly two allocations required");
  }
  const coordinatorValues = [];
  allocations.forEach((allocation, index) => {
    exactObject(
      allocation,
      ["artifactId", "nonce"],
      `sealWikiBundle.allocations[${index}]`,
    );
    if (!SAFE_ID.test(allocation.artifactId)
      || !SAFE_ID.test(allocation.nonce)) {
      fail(`sealWikiBundle.allocations[${index}]: invalid coordinator value`);
    }
    coordinatorValues.push(allocation.artifactId, allocation.nonce);
  });
  if (new Set(coordinatorValues).size !== coordinatorValues.length) {
    fail("sealWikiBundle.allocations: artifact IDs and nonces must be unique");
  }
  for (const value of coordinatorValues) {
    if (usedCoordinatorValues.has(value)) {
      fail("sealWikiBundle.allocations: coordinator value reuse");
    }
  }

  const parents = sortedUniqueDigests(
    parentHandoffEnvelopeDigests,
    "sealWikiBundle.parentHandoffEnvelopeDigests",
  );
  const receiptParents = sortedUniqueDigests(
    bundle.knowledgeReceipt.inputEnvelopeDigests,
    "bundle.knowledgeReceipt.inputEnvelopeDigests",
  );
  if (!sameStrings(parents, receiptParents)) {
    fail("sealWikiBundle: parent handoff digests do not match knowledge receipt");
  }
  const normalizedResult = validateNormalizedDocument(
    bundle.normalizedDocument,
  );
  if (!normalizedResult || normalizedResult.valid !== true
    || !Array.isArray(normalizedResult.errors)
    || normalizedResult.errors.length !== 0) {
    fail("sealWikiBundle: invalid NormalizedDocument");
  }
  if (bundle.knowledgeReceipt.normalizedDocumentDigest
    !== protocolSha256(bundle.normalizedDocument)) {
    fail("sealWikiBundle: normalizedDocumentDigest mismatch");
  }

  const commonHeader = {
    campaignId,
    track,
    arm,
    targetRunId,
    issuer: signer.issuer,
    keyId: signer.keyId,
    contractDigest,
  };
  const knowledgeReceiptEnvelope = createSignedEnvelope({
    ...commonHeader,
    artifactType: "atlas/knowledge-receipt",
    schemaVersion: "atlas/knowledge-receipt/1",
    artifactId: allocations[0].artifactId,
    nonce: allocations[0].nonce,
    parentDigests: parents,
  }, bundle.knowledgeReceipt, signer.privateKey);
  validateEnvelopeShape(
    knowledgeReceiptEnvelope,
    "KnowledgeReceipt SignedEnvelope",
  );
  if (knowledgeReceiptEnvelope.header.payloadDigest
    !== protocolSha256(bundle.knowledgeReceipt)) {
    fail("KnowledgeReceipt SignedEnvelope: payloadDigest mismatch");
  }

  const knowledgeReceiptEnvelopeDigest = protocolSha256(
    knowledgeReceiptEnvelope,
  );
  const normalizedDocumentEnvelope = createSignedEnvelope({
    ...commonHeader,
    artifactType: "atlas/normalized-document",
    schemaVersion: "atlas/normalized-document/1",
    artifactId: allocations[1].artifactId,
    nonce: allocations[1].nonce,
    parentDigests: [knowledgeReceiptEnvelopeDigest],
  }, bundle.normalizedDocument, signer.privateKey);
  validateEnvelopeShape(
    normalizedDocumentEnvelope,
    "NormalizedDocument SignedEnvelope",
  );
  if (normalizedDocumentEnvelope.header.payloadDigest
    !== protocolSha256(bundle.normalizedDocument)) {
    fail("NormalizedDocument SignedEnvelope: payloadDigest mismatch");
  }

  for (const value of coordinatorValues) usedCoordinatorValues.add(value);
  return deepFreeze({
    knowledgeReceiptEnvelope,
    normalizedDocumentEnvelope,
  });
}

export function validateSealedWikiBundle(sealed, signerPublicKey) {
  exactObject(
    sealed,
    ["knowledgeReceiptEnvelope", "normalizedDocumentEnvelope"],
    "sealedWikiBundle",
  );
  const {
    knowledgeReceiptEnvelope,
    normalizedDocumentEnvelope,
  } = sealed;
  validateEnvelopeShape(
    knowledgeReceiptEnvelope,
    "KnowledgeReceipt SignedEnvelope",
  );
  validateEnvelopeShape(
    normalizedDocumentEnvelope,
    "NormalizedDocument SignedEnvelope",
  );
  if (!verifySignedEnvelope(knowledgeReceiptEnvelope, signerPublicKey)) {
    fail("KnowledgeReceipt SignedEnvelope: invalid signature");
  }
  if (!verifySignedEnvelope(normalizedDocumentEnvelope, signerPublicKey)) {
    fail("NormalizedDocument SignedEnvelope: invalid signature");
  }
  if (knowledgeReceiptEnvelope.header.artifactType
    !== "atlas/knowledge-receipt") {
    fail("KnowledgeReceipt SignedEnvelope: artifactType mismatch");
  }
  if (knowledgeReceiptEnvelope.header.schemaVersion
    !== "atlas/knowledge-receipt/1") {
    fail("KnowledgeReceipt SignedEnvelope: schemaVersion mismatch");
  }
  if (normalizedDocumentEnvelope.header.artifactType
    !== "atlas/normalized-document") {
    fail("NormalizedDocument SignedEnvelope: artifactType mismatch");
  }
  if (normalizedDocumentEnvelope.header.schemaVersion
    !== "atlas/normalized-document/1") {
    fail("NormalizedDocument SignedEnvelope: schemaVersion mismatch");
  }
  if (knowledgeReceiptEnvelope.header.payloadDigest
    !== protocolSha256(knowledgeReceiptEnvelope.payload)) {
    fail("KnowledgeReceipt SignedEnvelope: payloadDigest mismatch");
  }
  if (normalizedDocumentEnvelope.header.payloadDigest
    !== protocolSha256(normalizedDocumentEnvelope.payload)) {
    fail("NormalizedDocument SignedEnvelope: payloadDigest mismatch");
  }
  const expectedParent = protocolSha256(knowledgeReceiptEnvelope);
  if (!Array.isArray(normalizedDocumentEnvelope.header.parentDigests)
    || normalizedDocumentEnvelope.header.parentDigests.length !== 1
    || normalizedDocumentEnvelope.header.parentDigests[0] !== expectedParent) {
    fail("NormalizedDocument SignedEnvelope: parent chain mismatch");
  }
  const normalizedResult = validateNormalizedDocument(
    normalizedDocumentEnvelope.payload,
  );
  if (!normalizedResult || normalizedResult.valid !== true
    || !Array.isArray(normalizedResult.errors)
    || normalizedResult.errors.length !== 0) {
    fail("NormalizedDocument SignedEnvelope: invalid payload");
  }
  if (knowledgeReceiptEnvelope.payload.normalizedDocumentDigest
    !== protocolSha256(normalizedDocumentEnvelope.payload)) {
    fail("Sealed Wiki bundle: normalizedDocumentDigest mismatch");
  }
  return true;
}
