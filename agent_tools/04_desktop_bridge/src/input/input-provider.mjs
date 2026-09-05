import { exactRecord } from "../contract.mjs";

const DELIVERY_STATUSES = new Set([
  "DELIVERED",
  "NOT_DELIVERED",
  "DELIVERY_UNKNOWN",
]);
const RECEIPT_TOKEN = /^[a-z0-9][a-z0-9._:-]{0,127}$/iu;
const DEFINITE_LEGACY_REFUSALS = new Set([
  "INPUT_NOT_DELIVERED",
  "KEY_NOT_ALLOWED",
  "WINDOW_NOT_FOUND",
  "IDENTITY_MISMATCH",
  "WINDOW_NOT_VISIBLE",
  "WINDOW_MINIMIZED",
  "WINDOW_NOT_FOREGROUND",
  "WINDOW_STATE_CHANGED",
  "DESKTOP_UNAVAILABLE",
  "REGION_NOT_COMPOSITED",
  "WINDOW_OCCLUDED",
  "OCCLUSION_UNKNOWN",
  "CLICK_TARGET_MISMATCH",
  "INVALID_REQUEST",
  "INVALID_REGION",
  "INVALID_POINT",
]);

function result(status, sinkReceipt) {
  return Object.freeze({ status, sinkReceipt });
}

function errorCode(error) {
  return error && typeof error === "object" && typeof error.code === "string"
    ? error.code
    : null;
}

export function normalizeInputProviderResult(value) {
  try {
    exactRecord(value, ["status", "sinkReceipt"], "input provider result");
    const status = value.status;
    const sinkReceipt = value.sinkReceipt;
    if (!DELIVERY_STATUSES.has(status) || typeof sinkReceipt !== "string"
      || !RECEIPT_TOKEN.test(sinkReceipt)) {
      throw new TypeError("input provider result is invalid.");
    }
    return result(status, sinkReceipt);
  } catch {
    return result("DELIVERY_UNKNOWN", "invalid-input-provider-result");
  }
}

export function validateInputProvider(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.dispatch !== "function") {
    throw new TypeError("inputProvider must provide dispatch(action, pinnedTarget).");
  }
  const dispatch = value.dispatch.bind(value);
  return Object.freeze({ dispatch });
}

/**
 * Migration adapter for the original NativeDesktopBridgeClient-shaped input
 * dependency. New composition should inject an explicit inputProvider instead.
 */
export function createLegacyBridgeInputProvider(bridge) {
  if (!bridge || typeof bridge.tapKey !== "function" || typeof bridge.safeClick !== "function") {
    throw new TypeError("legacy bridge must provide tapKey and safeClick methods.");
  }

  return Object.freeze({
    async dispatch(action, pinnedTarget) {
      try {
        const legacyResult = action.kind === "keyTap"
          ? await bridge.tapKey(Object.freeze({
            binding: pinnedTarget.targetIdentity,
            code: action.code,
          }))
          : await bridge.safeClick(Object.freeze({
            binding: pinnedTarget.targetIdentity,
            region: pinnedTarget.region,
            point: action.safePoint,
          }));

        try {
          exactRecord(legacyResult, ["delivered", "sinkReceipt"], "legacy bridge result");
          if (legacyResult.delivered !== true) throw new TypeError("legacy delivery is invalid.");
          return normalizeInputProviderResult({
            status: "DELIVERED",
            sinkReceipt: legacyResult.sinkReceipt,
          });
        } catch {
          return result("DELIVERY_UNKNOWN", "invalid-legacy-bridge-result");
        }
      } catch (error) {
        const code = errorCode(error);
        if (DEFINITE_LEGACY_REFUSALS.has(code)) {
          return result("NOT_DELIVERED", "native-not-delivered");
        }
        return result(
          "DELIVERY_UNKNOWN",
          code === "DELIVERY_UNKNOWN" ? "native-delivery-unknown" : "bridge-delivery-unknown",
        );
      }
    },
  });
}
