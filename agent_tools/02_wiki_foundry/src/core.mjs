import {
  canonicalize as protocolCanonicalize,
  sha256 as protocolSha256,
} from "../../packages/atlas_protocol/src/index.mjs";

export const HEX_64 = /^[a-f0-9]{64}$/;
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
export const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,160}$/;
export const PUBLIC_KEYS = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Enter", "Escape", "Space", "ShiftLeft", "ShiftRight",
  "KeyA", "KeyB", "KeyC", "KeyD", "KeyE", "KeyF", "KeyI", "KeyM",
]);
export const ENTITY_TYPES = new Set(["region", "npc", "item", "quest", "encounter", "recipe", "shop", "state", "unknown"]);
export const PREDICATES = new Set([
  "located-in", "connects-to", "contains", "offered-by", "drops", "produces",
  "requires", "rewards", "sold-by", "exchanged-by", "changes-state-to", "appears-when",
]);
export const PROCEDURE_VERBS = new Set([
  "travel-to", "talk-to", "inspect", "acquire", "craft", "exchange",
  "use-item", "set-world-state", "choose-branch", "verify-outcome",
]);
export const FAILURE_ACTIONS = new Set(["stop", "reinspect", "retry-once"]);
export const SCOPE_KINDS = new Set(["rule", "layout", "session", "visual", "unclassified"]);
export const QUESTION_CODES = new Set(["identity", "source", "requirement", "result", "scope", "route"]);
export const REINSPECTION_OPERATIONS = new Set(["observe", "interact", "compare"]);
export const REINSPECTION_CONTRASTS = new Set([
  "world-state-label", "possessed-item", "interaction-order", "branch-choice",
  "repeat-observation", "unknown",
]);
export const EVIDENCE_NEEDED = new Set(["visible-label", "visible-outcome", "repeat-confirmation", "counterexample"]);
export const PRIORITIES = new Set(["low", "normal", "high"]);

export const ZERO_WIDTH_OR_BIDI = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u;
export const PRIVATE_USE = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u;
export const URL_LIKE = /(?:https?:\/\/|www\.|mailto:|data:)/iu;
export const KEY_MACRO = /\b(?:Arrow(?:Up|Down|Left|Right)|Space|Shift(?:Left|Right)?|Control|Alt|Key[A-Z]|Digit[0-9]|Enter|Escape)\b|(?:Ctrl|Alt|Shift)\s*\+/iu;
export const HIGH_ENTROPY = /(?:[a-f0-9]{32,}|[A-Za-z0-9+/_-]{48,}={0,2})/u;

export function fail(message) {
  throw new Error(message);
}

export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function assertObject(value, context) {
  if (!isObject(value)) fail(`${context}: object required`);
}

export function assertExact(value, required, optional, context) {
  assertObject(value, context);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${context}: additional property '${key}'`);
  }
  for (const key of required) {
    if (!(key in value)) fail(`${context}: missing '${key}'`);
  }
}

export function assertArray(value, context, { min = 0, max = 10_000 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fail(`${context}: array length must be ${min}..${max}`);
  }
}

export function assertString(value, context, { min = 1, max = 512, pattern } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max || (pattern && !pattern.test(value))) {
    fail(`${context}: invalid string`);
  }
}

export function assertInteger(value, context, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`${context}: invalid integer`);
}

export function assertEnum(value, allowed, context) {
  if (!allowed.has(value)) fail(`${context}: unsupported value '${value}'`);
}

export function assertUnique(values, context) {
  if (new Set(values).size !== values.length) fail(`${context}: duplicate values`);
}

export function normalizeText(value) {
  return value.normalize("NFC").replace(/\r\n?/g, "\n");
}

export function assertSafeSemanticText(value, context, max = 160) {
  assertString(value, context, { max });
  const text = normalizeText(value);
  if (ZERO_WIDTH_OR_BIDI.test(text) || PRIVATE_USE.test(text)) fail(`${context}: hidden unicode forbidden`);
  if (URL_LIKE.test(text)) fail(`${context}: URL forbidden`);
  if (KEY_MACRO.test(text)) fail(`${context}: key macro forbidden`);
  if (HIGH_ENTROPY.test(text)) fail(`${context}: high-entropy token forbidden`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) fail(`${context}: control character forbidden`);
  return text;
}

export function canonicalJson(value) {
  const visit = (item) => {
    if (Array.isArray(item)) return item.map(visit);
    if (isObject(item)) {
      const out = {};
      for (const key of Object.keys(item).sort()) {
        if (item[key] !== undefined) out[key] = visit(item[key]);
      }
      return out;
    }
    if (typeof item === "string") return normalizeText(item);
    return item;
  };
  return protocolCanonicalize(visit(value));
}

export function sha256(value) {
  return protocolSha256(value);
}

export function digestCanonical(value) {
  return sha256(canonicalJson(value));
}

export function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function jsonCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

export function sortByCanonical(items) {
  return [...items].sort((a, b) => {
    const aa = canonicalJson(a);
    const bb = canonicalJson(b);
    return aa < bb ? -1 : aa > bb ? 1 : 0;
  });
}

export function remapList(list, map, context) {
  return [...list].map((id) => {
    const mapped = map.get(id);
    if (!mapped) fail(`${context}: unknown reference '${id}'`);
    return mapped;
  }).sort();
}
