import { DEFAULT_CAMPAIGN_PROFILE } from "../../packages/atlas_protocol/src/index.mjs";

export const DESKTOP_BRIDGE_PROTOCOL_VERSION = "atlas-desktop-bridge/1";
export const DESKTOP_FRAME_POLICY_VERSION = "desktop-composited-window/v1";
export const DESKTOP_INPUT_POLICY_VERSION = "desktop-bounded-input/v1";
export const DESKTOP_ALLOWED_KEYS = Object.freeze([...DEFAULT_CAMPAIGN_PROFILE.allowedKeys]);

const HEX_256 = /^[a-f0-9]{64}$/u;
const HWND = /^[1-9][0-9]{0,19}$/u;

export function exactRecord(value, required, context = "value") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${context} must be an object.`);
  }
  const keys = Object.keys(value);
  if (keys.length !== required.length || required.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError(`${context} must contain exactly: ${required.join(", ")}.`);
  }
  return value;
}

export function validateRegion(value, bounds, context = "region") {
  exactRecord(value, ["x", "y", "width", "height"], context);
  for (const key of ["x", "y", "width", "height"]) {
    if (!Number.isSafeInteger(value[key])) throw new TypeError(`${context}.${key} must be an integer.`);
  }
  if (value.x < 0 || value.y < 0 || value.width < 1 || value.height < 1) {
    throw new RangeError(`${context} must have a positive in-bounds extent.`);
  }
  if (bounds && (value.x + value.width > bounds.width || value.y + value.height > bounds.height)) {
    throw new RangeError(`${context} is outside the pinned client bounds.`);
  }
  return Object.freeze({ ...value });
}

export function validateTargetIdentity(value, context = "targetIdentity") {
  exactRecord(value, [
    "hwnd", "pid", "processStartTimeUtc", "executableSha256", "clientWidth", "clientHeight",
  ], context);
  if (typeof value.hwnd !== "string" || !HWND.test(value.hwnd)) throw new TypeError(`${context}.hwnd is invalid.`);
  if (!Number.isSafeInteger(value.pid) || value.pid < 1) throw new TypeError(`${context}.pid is invalid.`);
  if (typeof value.processStartTimeUtc !== "string" || !Number.isFinite(Date.parse(value.processStartTimeUtc))) {
    throw new TypeError(`${context}.processStartTimeUtc is invalid.`);
  }
  if (typeof value.executableSha256 !== "string" || !HEX_256.test(value.executableSha256)) {
    throw new TypeError(`${context}.executableSha256 is invalid.`);
  }
  if (!Number.isSafeInteger(value.clientWidth) || value.clientWidth < 1
    || !Number.isSafeInteger(value.clientHeight) || value.clientHeight < 1) {
    throw new TypeError(`${context} client dimensions are invalid.`);
  }
  return Object.freeze({ ...value });
}

export function sameTargetIdentity(left, right) {
  const a = validateTargetIdentity(left, "leftIdentity");
  const b = validateTargetIdentity(right, "rightIdentity");
  return Object.keys(a).every((key) => a[key] === b[key]);
}
