import {
  DESKTOP_ALLOWED_KEYS,
  exactRecord,
  validateRegion,
  validateTargetIdentity,
} from "../contract.mjs";
import {
  createLegacyBridgeInputProvider,
  normalizeInputProviderResult,
  validateInputProvider,
} from "./input-provider.mjs";

const ALLOWED_KEYS = new Set(DESKTOP_ALLOWED_KEYS);

function result(status, sinkReceipt) {
  return Object.freeze({ status, sinkReceipt });
}

function notDelivered(sinkReceipt = "input-not-delivered") {
  return result("NOT_DELIVERED", sinkReceipt);
}

function deliveryUnknown(sinkReceipt = "delivery-unknown") {
  return result("DELIVERY_UNKNOWN", sinkReceipt);
}

function validateSafePoint(value, context = "action.safePoint") {
  exactRecord(value, ["x", "y"], context);
  const x = value.x;
  const y = value.y;
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
    throw new TypeError(`${context} must contain finite integer coordinates.`);
  }
  return Object.freeze({ x, y });
}

export function validatePrivateAction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("action must be an object.");
  }

  const kind = value.kind;
  if (kind === "keyTap") {
    exactRecord(value, ["kind", "code"], "action");
    const code = value.code;
    if (typeof code !== "string" || !ALLOWED_KEYS.has(code)) {
      throw new TypeError("action.code is not an allowed desktop key.");
    }
    return Object.freeze({ kind: "keyTap", code });
  }

  if (kind === "safePointActivate") {
    exactRecord(value, ["kind", "safePoint"], "action");
    const safePoint = value.safePoint;
    return Object.freeze({
      kind: "safePointActivate",
      safePoint: validateSafePoint(safePoint),
    });
  }

  throw new TypeError("action.kind is not supported by the desktop input policy.");
}

function validateDispatchContext(value) {
  exactRecord(value, ["targetRef"], "dispatch context");
  const targetRef = value.targetRef;
  if (typeof targetRef !== "string" || targetRef.length < 1 || targetRef.length > 4096
    || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(targetRef)) {
    throw new TypeError("dispatch context.targetRef is not a valid opaque reference.");
  }
  return targetRef;
}

function validatePinnedTarget(value) {
  exactRecord(value, ["targetIdentity", "region"], "pinned target");
  const targetIdentity = validateTargetIdentity(value.targetIdentity);
  const region = validateRegion(value.region, {
    width: targetIdentity.clientWidth,
    height: targetIdentity.clientHeight,
  }, "pinned target.region");
  return Object.freeze({ targetIdentity, region });
}

function pointIsInsideRegion(point, region) {
  return point.x >= region.x
    && point.y >= region.y
    && point.x < region.x + region.width
    && point.y < region.y + region.height;
}

export class SafeInputBroker {
  #inputProvider;
  #targetBroker;

  constructor({ inputProvider, bridge, targetBroker } = {}) {
    if (inputProvider && bridge) {
      throw new TypeError("Provide inputProvider only; bridge is a legacy migration alias.");
    }
    if (!targetBroker || typeof targetBroker.withPrivateBinding !== "function") {
      throw new TypeError("targetBroker must provide withPrivateBinding.");
    }
    this.#inputProvider = validateInputProvider(
      inputProvider ?? createLegacyBridgeInputProvider(bridge),
    );
    this.#targetBroker = targetBroker;
  }

  async dispatch(untrustedAction, untrustedContext) {
    let action;
    let targetRef;
    try {
      action = validatePrivateAction(untrustedAction);
      targetRef = validateDispatchContext(untrustedContext);
    } catch {
      return notDelivered("input-policy-rejected");
    }

    let providerInvoked = false;
    try {
      const providerResult = await this.#targetBroker.withPrivateBinding(targetRef, async (privateValue) => {
        const pinnedTarget = validatePinnedTarget(privateValue);

        if (action.kind === "safePointActivate"
          && !pointIsInsideRegion(action.safePoint, pinnedTarget.region)) {
          return notDelivered("input-policy-rejected");
        }

        providerInvoked = true;
        return this.#inputProvider.dispatch(action, pinnedTarget);
      });
      return normalizeInputProviderResult(providerResult);
    } catch {
      if (!providerInvoked) {
        return notDelivered("target-revalidation-refused");
      }
      return deliveryUnknown("input-provider-unknown");
    }
  }
}
