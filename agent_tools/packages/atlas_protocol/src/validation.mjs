import {
  publicHandoffPayloadDigest,
  sha256,
  verifyDetached,
} from "./canonical.mjs";

const HEX_256 = /^[a-f0-9]{64}$/;
const OPAQUE_ID = /^(?:[A-Za-z0-9_-]{22}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const FRAME_ID = /^F\d{6}$/;
const ACTION_ID = /^A\d{6}$/;
const OBSERVATION_ID = /^O\d{6}$/;
const FORBIDDEN_TEXT = /(?:GT_CANARY|CUE_CANARY|SEED_CANARY|PROBE_CANARY|SIBLING_CANARY)/i;
const FORBIDDEN_KEY_TOKENS = new Set([
  "seed", "selector", "coordinate", "capability", "cookie",
  "sourcemap", "localstorage", "sessionstorage", "rngstate",
]);

export const DEFAULT_CAMPAIGN_PROFILE = Object.freeze({
  framePolicyVersions: Object.freeze(["canvas-served/v1", "opaque-overlay/v1", "desktop-composited-window/v1"]),
  inputPolicyVersions: Object.freeze(["keyboard-restricted/v1", "opaque-object/v1", "desktop-bounded-input/v1"]),
  allowedKeys: Object.freeze([
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    "Enter", "Tab", "Space", "Shift",
    "KeyA", "KeyB", "KeyC", "KeyD", "KeyE", "KeyF", "KeyN", "KeyR",
    "Digit1", "Digit2", "Digit3", "Digit4",
  ]),
});

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(record, allowed, path, errors) {
  if (!isRecord(record)) {
    errors.push(path + " must be an object");
    return false;
  }
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) errors.push(path + " has unknown field " + key);
  }
  for (const key of allowed) {
    if (!(key in record)) errors.push(path + " is missing " + key);
  }
  return true;
}

function optionalExactKeys(record, required, optional, path, errors) {
  if (!isRecord(record)) {
    errors.push(path + " must be an object");
    return false;
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) errors.push(path + " has unknown field " + key);
  }
  for (const key of required) {
    if (!(key in record)) errors.push(path + " is missing " + key);
  }
  return true;
}

function integer(value, minimum = 0) {
  return Number.isInteger(value) && value >= minimum;
}

function checkOrdinalSeries(values, idKey, pattern, prefix, path, errors) {
  const ids = new Set();
  values.forEach((value, index) => {
    if (!isRecord(value)) return;
    const expected = index + 1;
    if (value.ordinal !== expected) errors.push(path + "[" + index + "].ordinal must be " + expected);
    if (typeof value[idKey] !== "string" || !pattern.test(value[idKey])) {
      errors.push(path + "[" + index + "]." + idKey + " has invalid syntax");
    } else {
      const expectedId = prefix + String(expected).padStart(6, "0");
      if (value[idKey] !== expectedId) errors.push(path + "[" + index + "]." + idKey + " must be " + expectedId);
      if (ids.has(value[idKey])) errors.push(path + " has duplicate " + value[idKey]);
      ids.add(value[idKey]);
    }
  });
  return ids;
}

function textVariants(value) {
  const normalized = String(value).normalize("NFKC");
  const compact = normalized.replace(/[\s\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, "");
  const variants = new Set([normalized, compact, compact.toLowerCase(), compact.split("").reverse().join("")]);
  for (const encoding of ["base64", "base64url", "hex"]) {
    try {
      const decoded = Buffer.from(compact, encoding).toString("utf8");
      if (decoded && !decoded.includes("\ufffd")) variants.add(decoded.normalize("NFKC"));
    } catch {
      // Invalid encoded text is not a leak by itself.
    }
  }
  return variants;
}

function isForbiddenKey(key) {
  const separated = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[^A-Za-z0-9]+/g, " ").toLowerCase();
  const tokens = separated.split(/\s+/).filter(Boolean);
  if (tokens.some((token) => FORBIDDEN_KEY_TOKENS.has(token))) return true;
  const joined = tokens.join("");
  if (["scenariohash", "layouthash", "visualhash", "sessionhash", "rulegraphhash", "confighash", "contentdigest", "boundingbox", "statehash", "privatekey"].includes(joined)) return true;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (["fact", "cue", "probe", "canonical", "target"].includes(tokens[index]) && ["id", "ids"].includes(tokens[index + 1])) return true;
  }
  return false;
}

export function scanForForbiddenData(value, canaries = []) {
  const hits = [];
  const needles = canaries.map((item) => String(item).normalize("NFKC")).filter(Boolean);
  function visit(current, path) {
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, path + "[" + index + "]"));
      return;
    }
    if (isRecord(current)) {
      for (const [key, entry] of Object.entries(current)) {
        if (isForbiddenKey(key)) hits.push({ path: path + "." + key, reason: "forbidden-key" });
        visit(entry, path + "." + key);
      }
      return;
    }
    if (typeof current !== "string") return;
    for (const variant of textVariants(current)) {
      if (FORBIDDEN_TEXT.test(variant)) hits.push({ path, reason: "canary-pattern" });
      for (const needle of needles) {
        if (variant.includes(needle)) hits.push({ path, reason: "private-canary" });
      }
    }
  }
  visit(value, "$");
  return hits;
}

export function validatePublicPlayHandoff(input, profile = DEFAULT_CAMPAIGN_PROFILE) {
  const errors = [];
  if (!exactKeys(input, ["manifest", "frames", "observations", "actions"], "$", errors)) {
    return { valid: false, errors };
  }
  const manifest = input.manifest;
  if (exactKeys(
    manifest,
    [
      "schemaVersion", "artifactId", "runId", "status", "validity",
      "framePolicyVersion", "inputPolicyVersion", "capture", "counts",
      "files", "payloadDigest",
    ],
    "$.manifest",
    errors,
  )) {
    if (manifest.schemaVersion !== "atlas/public-play-handoff/1") errors.push("$.manifest.schemaVersion is unsupported");
    if (!OPAQUE_ID.test(manifest.artifactId ?? "")) errors.push("$.manifest.artifactId must be a coordinator opaque ID");
    if (!OPAQUE_ID.test(manifest.runId ?? "")) errors.push("$.manifest.runId must be a coordinator opaque ID");
    if (!["COMPLETE", "PARTIAL", "INVALID"].includes(manifest.status)) errors.push("$.manifest.status is invalid");
    if (!["OFFICIAL", "ASSISTED", "INVALID"].includes(manifest.validity)) errors.push("$.manifest.validity is invalid");
    if (!profile.framePolicyVersions.includes(manifest.framePolicyVersion)) errors.push("$.manifest.framePolicyVersion is not allowed");
    if (!profile.inputPolicyVersions.includes(manifest.inputPolicyVersion)) errors.push("$.manifest.inputPolicyVersion is not allowed");
    if (exactKeys(manifest.capture, ["width", "height", "format", "colorSpace"], "$.manifest.capture", errors)) {
      if (!integer(manifest.capture.width, 1) || !integer(manifest.capture.height, 1)) errors.push("$.manifest.capture dimensions are invalid");
      if (manifest.capture.format !== "png" || manifest.capture.colorSpace !== "srgb") errors.push("$.manifest.capture encoding is invalid");
    }
    if (exactKeys(manifest.counts, ["frames", "observations", "actions", "interventions"], "$.manifest.counts", errors)) {
      for (const key of ["frames", "observations", "actions", "interventions"]) {
        if (!integer(manifest.counts[key])) errors.push("$.manifest.counts." + key + " must be a non-negative integer");
      }
    }
    if (!Array.isArray(manifest.files)) {
      errors.push("$.manifest.files must be an array");
    } else {
      const names = new Set();
      manifest.files.forEach((file, index) => {
        const path = "$.manifest.files[" + index + "]";
        if (!exactKeys(file, ["role", "relativeName", "bytes", "sha256"], path, errors)) return;
        if (!["frames", "observations", "actions"].includes(file.role)) errors.push(path + ".role is invalid");
        if (!/^(?:frames\/F\d{6}\.png|observations\.ndjson|actions\.ndjson)$/.test(file.relativeName ?? "")) errors.push(path + ".relativeName is not contract-owned");
        if (names.has(file.relativeName)) errors.push(path + ".relativeName is duplicated");
        names.add(file.relativeName);
        if (!integer(file.bytes)) errors.push(path + ".bytes is invalid");
        if (!HEX_256.test(file.sha256 ?? "")) errors.push(path + ".sha256 is invalid");
      });
    }
    if (!HEX_256.test(manifest.payloadDigest ?? "")) errors.push("$.manifest.payloadDigest is invalid");
  }

  if (!Array.isArray(input.frames) || !Array.isArray(input.observations) || !Array.isArray(input.actions)) {
    errors.push("$.frames, $.observations and $.actions must be arrays");
    return { valid: false, errors };
  }

  const frameIds = checkOrdinalSeries(input.frames, "frameId", FRAME_ID, "F", "$.frames", errors);
  const actionIds = checkOrdinalSeries(input.actions, "actionId", ACTION_ID, "A", "$.actions", errors);
  checkOrdinalSeries(input.observations, "observationId", OBSERVATION_ID, "O", "$.observations", errors);

  input.frames.forEach((frame, index) => {
    const path = "$.frames[" + index + "]";
    if (!exactKeys(frame, ["frameId", "ordinal", "mediaRef", "sha256", "evidenceRole", "sourceActionRefs"], path, errors)) return;
    if (frame.mediaRef !== "frames/" + frame.frameId + ".png") errors.push(path + ".mediaRef does not match frameId");
    if (!HEX_256.test(frame.sha256 ?? "")) errors.push(path + ".sha256 is invalid");
    if (frame.evidenceRole !== "CITEABLE") errors.push(path + ".evidenceRole must be CITEABLE");
    if (!Array.isArray(frame.sourceActionRefs) || frame.sourceActionRefs.some((id) => !actionIds.has(id))) errors.push(path + ".sourceActionRefs are invalid");
  });

  input.observations.forEach((observation, index) => {
    const path = "$.observations[" + index + "]";
    if (!exactKeys(observation, ["observationId", "ordinal", "frameRefs", "precedingActionRefs"], path, errors)) return;
    if (!Array.isArray(observation.frameRefs) || observation.frameRefs.length === 0 || observation.frameRefs.some((id) => !frameIds.has(id))) errors.push(path + ".frameRefs are invalid");
    if (!Array.isArray(observation.precedingActionRefs) || observation.precedingActionRefs.some((id) => !actionIds.has(id))) errors.push(path + ".precedingActionRefs are invalid");
  });

  input.actions.forEach((action, index) => {
    const path = "$.actions[" + index + "]";
    if (!exactKeys(action, ["actionId", "ordinal", "input", "delivery", "beforeFrameRef", "afterFrameRefs", "changeClass"], path, errors)) return;
    if (!frameIds.has(action.beforeFrameRef)) errors.push(path + ".beforeFrameRef is invalid");
    if (!Array.isArray(action.afterFrameRefs) || action.afterFrameRefs.some((id) => !frameIds.has(id))) errors.push(path + ".afterFrameRefs are invalid");
    if (!["DELIVERED", "NOT_DELIVERED", "DELIVERY_UNKNOWN"].includes(action.delivery)) errors.push(path + ".delivery is invalid");
    if (!["UNCHANGED", "TRANSIENT_ONLY", "PERSISTENT_CHANGE", "UNCERTAIN"].includes(action.changeClass)) errors.push(path + ".changeClass is invalid");
    if (!isRecord(action.input)) {
      errors.push(path + ".input must be an object");
    } else if (action.input.kind === "keyTap") {
      exactKeys(action.input, ["kind", "code"], path + ".input", errors);
      if (!profile.allowedKeys.includes(action.input.code)) errors.push(path + ".input.code is not allowed");
    } else if (action.input.kind === "opaqueActivate") {
      exactKeys(action.input, ["kind"], path + ".input", errors);
    } else {
      errors.push(path + ".input.kind is invalid");
    }
  });

  if (isRecord(manifest?.counts)) {
    if (manifest.counts.frames !== input.frames.length) errors.push("$.manifest.counts.frames does not match");
    if (manifest.counts.observations !== input.observations.length) errors.push("$.manifest.counts.observations does not match");
    if (manifest.counts.actions !== input.actions.length) errors.push("$.manifest.counts.actions does not match");
  }
  if (HEX_256.test(manifest?.payloadDigest ?? "") && manifest.payloadDigest !== publicHandoffPayloadDigest(input)) {
    errors.push("$.manifest.payloadDigest does not match payload");
  }
  for (const hit of scanForForbiddenData(input)) errors.push(hit.path + " contains " + hit.reason);
  return { valid: errors.length === 0, errors };
}

export function validateEvidenceComparisonPlan(input, publicKey) {
  const errors = [];
  if (!exactKeys(input, ["schemaVersion", "planId", "groups", "signature"], "$", errors)) return { valid: false, errors };
  if (input.schemaVersion !== "atlas/evidence-comparison-plan/1") errors.push("$.schemaVersion is unsupported");
  if (!OPAQUE_ID.test(input.planId ?? "")) errors.push("$.planId is invalid");
  if (!Array.isArray(input.groups) || input.groups.length === 0) {
    errors.push("$.groups must be a non-empty array");
  } else {
    const groupRefs = new Set();
    const allMembers = new Set();
    input.groups.forEach((group, index) => {
      const path = "$.groups[" + index + "]";
      if (!exactKeys(group, ["groupRef", "handoffDigests"], path, errors)) return;
      const expected = "G" + String(index + 1).padStart(2, "0");
      if (group.groupRef !== expected || groupRefs.has(group.groupRef)) errors.push(path + ".groupRef must be " + expected);
      groupRefs.add(group.groupRef);
      if (!Array.isArray(group.handoffDigests) || group.handoffDigests.length < 2) {
        errors.push(path + ".handoffDigests must contain at least two runs");
      } else {
        for (const digest of group.handoffDigests) {
          if (!HEX_256.test(digest)) errors.push(path + " has an invalid handoff digest");
          if (allMembers.has(digest)) errors.push(path + " reuses a handoff across groups");
          allMembers.add(digest);
        }
      }
    });
  }
  if (typeof input.signature !== "string" || input.signature.length < 32) errors.push("$.signature is invalid");
  if (publicKey && !verifyDetached(
    { schemaVersion: input.schemaVersion, planId: input.planId, groups: input.groups },
    input.signature,
    publicKey,
  )) errors.push("$.signature verification failed");
  return { valid: errors.length === 0, errors };
}

export function validateSignedEnvelopeShape(input) {
  const errors = [];
  if (!exactKeys(input, ["header", "payload", "signature"], "$", errors)) return { valid: false, errors };
  if (exactKeys(
    input.header,
    [
      "artifactType", "schemaVersion", "artifactId", "campaignId", "track", "arm",
      "targetRunId", "issuer", "keyId", "nonce", "parentDigests",
      "payloadDigest", "contractDigest",
    ],
    "$.header",
    errors,
  )) {
    for (const key of ["artifactType", "schemaVersion", "campaignId", "track", "arm", "targetRunId", "issuer", "keyId", "nonce"]) {
      if (typeof input.header[key] !== "string" || input.header[key].length === 0) errors.push("$.header." + key + " must be text");
    }
    if (!OPAQUE_ID.test(input.header.artifactId ?? "")) errors.push("$.header.artifactId is invalid");
    if (!Array.isArray(input.header.parentDigests) || input.header.parentDigests.some((value) => !HEX_256.test(value))) errors.push("$.header.parentDigests are invalid");
    if (!HEX_256.test(input.header.payloadDigest ?? "") || input.header.payloadDigest !== sha256(input.payload)) errors.push("$.header.payloadDigest is invalid");
    if (!HEX_256.test(input.header.contractDigest ?? "")) errors.push("$.header.contractDigest is invalid");
  }
  if (typeof input.signature !== "string" || input.signature.length < 32) errors.push("$.signature is invalid");
  return { valid: errors.length === 0, errors };
}

export function validateNormalizedDocument(input) {
  const errors = [];
  if (!exactKeys(input, ["schemaVersion", "pages"], "$", errors)) return { valid: false, errors };
  if (input.schemaVersion !== "atlas/normalized-document/1") errors.push("$.schemaVersion is unsupported");
  if (!Array.isArray(input.pages) || input.pages.length === 0 || input.pages.length > 64) {
    errors.push("$.pages must contain 1..64 pages");
    return { valid: false, errors };
  }
  const titles = new Set();
  input.pages.forEach((page, pageIndex) => {
    const path = `$.pages[${pageIndex}]`;
    if (!exactKeys(page, ["title", "nodes"], path, errors)) return;
    if (typeof page.title !== "string" || page.title.length === 0 || page.title.length > 120) {
      errors.push(path + ".title is invalid");
    } else if (titles.has(page.title)) {
      errors.push(path + ".title is duplicated");
    } else {
      titles.add(page.title);
    }
    if (!Array.isArray(page.nodes) || page.nodes.length > 256) {
      errors.push(path + ".nodes must contain at most 256 nodes");
      return;
    }
    page.nodes.forEach((node, nodeIndex) => validateDocumentNode(node, `${path}.nodes[${nodeIndex}]`, errors));
  });
  input.pages.forEach((page, pageIndex) => {
    if (!Array.isArray(page?.nodes)) return;
    page.nodes.forEach((node, nodeIndex) => {
      if (node?.type === "link" && !titles.has(node.targetTitle)) {
        errors.push(`$.pages[${pageIndex}].nodes[${nodeIndex}].targetTitle is unknown`);
      }
    });
  });
  for (const hit of scanForForbiddenData(input)) errors.push(hit.path + " contains " + hit.reason);
  return { valid: errors.length === 0, errors };
}

function validateDocumentNode(node, path, errors) {
  if (!isRecord(node) || typeof node.type !== "string") {
    errors.push(path + " must be a typed object");
    return;
  }
  if (node.type === "heading") {
    if (!exactKeys(node, ["type", "level", "text"], path, errors)) return;
    if (!integer(node.level, 1) || node.level > 4) errors.push(path + ".level is invalid");
    validateDocumentText(node.text, path + ".text", 200, errors);
  } else if (["paragraph", "emphasis", "strong"].includes(node.type)) {
    if (!exactKeys(node, ["type", "text"], path, errors)) return;
    validateDocumentText(node.text, path + ".text", 800, errors);
  } else if (node.type === "list") {
    if (!exactKeys(node, ["type", "ordered", "items"], path, errors)) return;
    if (typeof node.ordered !== "boolean") errors.push(path + ".ordered must be boolean");
    if (!Array.isArray(node.items) || node.items.length === 0 || node.items.length > 64) {
      errors.push(path + ".items must contain 1..64 strings");
    } else node.items.forEach((item, index) => validateDocumentText(item, `${path}.items[${index}]`, 400, errors));
  } else if (node.type === "table") {
    if (!exactKeys(node, ["type", "headers", "rows"], path, errors)) return;
    if (!Array.isArray(node.headers) || node.headers.length === 0 || node.headers.length > 12) {
      errors.push(path + ".headers must contain 1..12 strings");
      return;
    }
    node.headers.forEach((item, index) => validateDocumentText(item, `${path}.headers[${index}]`, 120, errors));
    if (!Array.isArray(node.rows) || node.rows.length > 128) {
      errors.push(path + ".rows must contain at most 128 rows");
    } else node.rows.forEach((row, rowIndex) => {
      if (!Array.isArray(row) || row.length !== node.headers.length) {
        errors.push(`${path}.rows[${rowIndex}] has invalid width`);
      } else row.forEach((item, columnIndex) => validateDocumentText(item, `${path}.rows[${rowIndex}][${columnIndex}]`, 400, errors));
    });
  } else if (node.type === "link") {
    if (!exactKeys(node, ["type", "label", "targetTitle"], path, errors)) return;
    validateDocumentText(node.label, path + ".label", 160, errors);
    validateDocumentText(node.targetTitle, path + ".targetTitle", 120, errors);
  } else {
    errors.push(path + ".type is unsupported");
  }
}

function validateDocumentText(value, path, maximum, errors) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) errors.push(path + " is invalid");
}
