import { canonicalize, scanForForbiddenData, sha256 } from "../../packages/atlas_protocol/src/index.mjs";
import { ARTIFACT } from "./attestation.mjs";
import { exactKeys, invariant } from "./errors.mjs";

const NODE_TYPES = new Set(["heading", "paragraph", "emphasis", "strong", "list", "table", "link"]);
const NODE_RANK = Object.freeze({ heading: 0, paragraph: 1, emphasis: 2, strong: 3, list: 4, table: 5, link: 6 });
const FORBIDDEN_TEXT = /(?:https?:\/\/|file:\/\/|data:|<\/?[a-z!]|```|<!--|-->|[a-f0-9]{40,}|[A-Za-z0-9+/]{48,}={0,2})/iu;
const RAW_KEY_TOKEN = /(?<![\p{L}\p{N}_])(?:Arrow(?:Up|Down|Left|Right)|Enter|Space|Shift|Key[A-Z]|Digit\d)(?![\p{L}\p{N}_])/iu;
const FORBIDDEN_CODEPOINT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ue000-\uf8ff]/u;

export function sanitizeNormalizedDocument(input, { canaries = [] } = {}) {
  assertNoLeakage(input, canaries);
  exactKeys(input, ["schemaVersion", "pages"], "DOCUMENT_REJECTED", "document");
  invariant(input.schemaVersion === "atlas/normalized-document/1", "DOCUMENT_REJECTED", "unsupported document schema");
  invariant(Array.isArray(input.pages) && input.pages.length > 0 && input.pages.length <= 64, "DOCUMENT_REJECTED", "document must contain 1..64 pages");
  const seenTitles = new Set();
  const pages = input.pages.map((page, pageIndex) => {
    exactKeys(page, ["title", "nodes"], "DOCUMENT_REJECTED", `pages[${pageIndex}]`);
    const title = normalizeSafeText(page.title, `pages[${pageIndex}].title`, 120);
    invariant(!seenTitles.has(title), "DOCUMENT_REJECTED", "page titles must be unique after normalization");
    seenTitles.add(title);
    invariant(Array.isArray(page.nodes) && page.nodes.length <= 256, "DOCUMENT_REJECTED", "page node limit exceeded");
    const nodes = page.nodes.map((node, nodeIndex) => normalizeNode(node, `pages[${pageIndex}].nodes[${nodeIndex}]`));
    nodes.sort((left, right) => NODE_RANK[left.type] - NODE_RANK[right.type] || canonicalize(left).localeCompare(canonicalize(right), "en"));
    return { title, nodes };
  });
  pages.sort((left, right) => left.title.localeCompare(right.title, "ko"));
  for (const page of pages) {
    for (const node of page.nodes) {
      if (node.type === "link") invariant(seenTitles.has(node.targetTitle), "DOCUMENT_REJECTED", "internal link target does not exist");
    }
  }
  const document = deepFreeze({ schemaVersion: "atlas/normalized-document/1", pages });
  assertNoLeakage(document, canaries);
  return Object.freeze({ document, digest: sha256(document) });
}

export function verifyNormalizedDocumentArtifact({ envelope, verifier, expected }) {
  invariant(expected && typeof expected === "object" && !Array.isArray(expected), "DOCUMENT_ARTIFACT_EXPECTATION_INVALID", "expected bindings are required");
  const required = ["campaignId", "track", "arm", "targetRunId", "contractDigest", "parentDigests"];
  for (const field of required) invariant(expected[field] !== undefined, "DOCUMENT_ARTIFACT_EXPECTATION_INVALID", `${field} binding is required`);
  const verified = verifier.verify(envelope, {
    artifactType: ARTIFACT.NORMALIZED_DOCUMENT,
    schemaVersion: "atlas/normalized-document/1",
    campaignId: expected.campaignId,
    track: expected.track,
    arm: expected.arm,
    targetRunId: expected.targetRunId,
    contractDigest: expected.contractDigest,
    parentDigests: expected.parentDigests,
  });
  const sanitized = sanitizeNormalizedDocument(envelope.payload, { canaries: expected.canaries ?? [] });
  const rawDocumentDigest = sha256(envelope.payload);
  invariant(envelope.header.payloadDigest === sanitized.digest, "DOCUMENT_NOT_CANONICAL", "signed payload is not the canonical sanitized document");
  return Object.freeze({
    document: sanitized.document,
    rawDocumentDigest,
    signedArtifactDigest: verified.digest,
  });
}

export function scanCanaries(value, canaries = []) {
  const hits = scanForForbiddenData(value, canaries).map((hit) => ({ path: hit.path, reason: hit.reason }));
  const needles = canaries.flatMap(canaryVariants).filter(Boolean);
  const leaves = [];
  collectStrings(value, "$", leaves);
  const joined = leaves.map((leaf) => leaf.value).join("");
  leaves.push({ path: "$::<joined>", value: joined });
  for (const leaf of leaves) {
    const variants = decodeVariants(leaf.value);
    for (const variant of variants) {
      const folded = compact(variant);
      for (const needle of needles) {
        if (folded.includes(needle)) hits.push({ path: leaf.path, reason: "private-canary" });
      }
    }
  }
  return deduplicateHits(hits);
}

export function assertNoLeakage(value, canaries = []) {
  const hits = scanCanaries(value, canaries);
  invariant(hits.length === 0, "LEAKAGE_QUARANTINED", "artifact contains forbidden or canary data", hits);
  return true;
}

function normalizeNode(node, path) {
  invariant(node && typeof node === "object" && !Array.isArray(node), "DOCUMENT_REJECTED", `${path} must be an object`);
  invariant(NODE_TYPES.has(node.type), "DOCUMENT_REJECTED", `${path}.type is not allowed`);
  if (node.type === "heading") {
    exactKeys(node, ["type", "level", "text"], "DOCUMENT_REJECTED", path);
    invariant(Number.isInteger(node.level) && node.level >= 1 && node.level <= 4, "DOCUMENT_REJECTED", `${path}.level is invalid`);
    return { type: node.type, level: node.level, text: normalizeSafeText(node.text, `${path}.text`, 200) };
  }
  if (["paragraph", "emphasis", "strong"].includes(node.type)) {
    exactKeys(node, ["type", "text"], "DOCUMENT_REJECTED", path);
    return { type: node.type, text: normalizeSafeText(node.text, `${path}.text`, 800) };
  }
  if (node.type === "list") {
    exactKeys(node, ["type", "ordered", "items"], "DOCUMENT_REJECTED", path);
    invariant(typeof node.ordered === "boolean", "DOCUMENT_REJECTED", `${path}.ordered must be boolean`);
    invariant(Array.isArray(node.items) && node.items.length > 0 && node.items.length <= 64, "DOCUMENT_REJECTED", `${path}.items is invalid`);
    return { type: node.type, ordered: node.ordered, items: node.items.map((item, index) => normalizeSafeText(item, `${path}.items[${index}]`, 400)) };
  }
  if (node.type === "table") {
    exactKeys(node, ["type", "headers", "rows"], "DOCUMENT_REJECTED", path);
    invariant(Array.isArray(node.headers) && node.headers.length > 0 && node.headers.length <= 12, "DOCUMENT_REJECTED", `${path}.headers is invalid`);
    const headers = node.headers.map((item, index) => normalizeSafeText(item, `${path}.headers[${index}]`, 120));
    invariant(Array.isArray(node.rows) && node.rows.length <= 128, "DOCUMENT_REJECTED", `${path}.rows is invalid`);
    const rows = node.rows.map((row, rowIndex) => {
      invariant(Array.isArray(row) && row.length === headers.length, "DOCUMENT_REJECTED", `${path}.rows[${rowIndex}] width mismatch`);
      return row.map((item, columnIndex) => normalizeSafeText(item, `${path}.rows[${rowIndex}][${columnIndex}]`, 400));
    });
    return { type: node.type, headers, rows };
  }
  exactKeys(node, ["type", "label", "targetTitle"], "DOCUMENT_REJECTED", path);
  return {
    type: node.type,
    label: normalizeSafeText(node.label, `${path}.label`, 160),
    targetTitle: normalizeSafeText(node.targetTitle, `${path}.targetTitle`, 120),
  };
}

function normalizeSafeText(value, path, maxLength) {
  invariant(typeof value === "string", "DOCUMENT_REJECTED", `${path} must be text`);
  const normalized = value.normalize("NFC");
  invariant(normalized.length > 0 && normalized.length <= maxLength, "DOCUMENT_REJECTED", `${path} length is invalid`);
  invariant(normalized === normalized.trim() && !/[\t\r\n]| {2,}/u.test(normalized), "DOCUMENT_REJECTED", `${path} whitespace is not canonical`);
  invariant(!FORBIDDEN_CODEPOINT.test(normalized), "DOCUMENT_REJECTED", `${path} contains forbidden Unicode`);
  const securityFold = normalized.normalize("NFKC");
  const compactKeyCandidate = securityFold.replace(/[\s\p{P}\p{S}]+/gu, "");
  invariant(!FORBIDDEN_TEXT.test(securityFold), "DOCUMENT_REJECTED", `${path} contains forbidden content`);
  invariant(!RAW_KEY_TOKEN.test(securityFold) && !RAW_KEY_TOKEN.test(compactKeyCandidate), "DOCUMENT_REJECTED", `${path} contains a raw key token`);
  return normalized;
}

function collectStrings(value, path, output) {
  if (typeof value === "string") {
    output.push({ path, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectStrings(entry, `${path}[${index}]`, output));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      output.push({ path: `${path}::<key>`, value: key });
      collectStrings(entry, `${path}.${key}`, output);
    }
  }
}

function canaryVariants(value) {
  return decodeVariants(String(value)).map(compact);
}

function compact(value) {
  return String(value).normalize("NFKC").toLocaleLowerCase("en-US").replace(/[\s\u0000-\u001f\u007f\-_.,:;/\\|]+/gu, "");
}

function decodeVariants(value) {
  const variants = new Set([value, value.normalize("NFKC"), [...value].reverse().join("")]);
  try { variants.add(decodeURIComponent(value)); } catch {}
  const compactValue = value.replace(/\s+/gu, "");
  if (/^[A-Za-z0-9+/]+={0,2}$/u.test(compactValue) && compactValue.length >= 8 && compactValue.length % 4 === 0) {
    try { variants.add(Buffer.from(compactValue, "base64").toString("utf8")); } catch {}
  }
  if (/^[a-f0-9]+$/iu.test(compactValue) && compactValue.length >= 8 && compactValue.length % 2 === 0) {
    try { variants.add(Buffer.from(compactValue, "hex").toString("utf8")); } catch {}
  }
  const base32 = decodeBase32(compactValue);
  if (base32 !== null) variants.add(base32);
  return [...variants];
}

function decodeBase32(value) {
  if (!/^[A-Z2-7]+=*$/iu.test(value) || value.replace(/=/gu, "").length < 8) return null;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of value.toUpperCase().replace(/=/gu, "")) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  try { return Buffer.from(bytes).toString("utf8"); } catch { return null; }
}

function deduplicateHits(hits) {
  const seen = new Set();
  return hits.filter((hit) => {
    const key = `${hit.path}\u0000${hit.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}
