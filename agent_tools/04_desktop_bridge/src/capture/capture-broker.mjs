import { Buffer } from "node:buffer";
import { exactRecord, validateRegion, validateTargetIdentity } from "../contract.mjs";
import { validateCaptureProvider } from "../provider-contract.mjs";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export const CAPTURE_BROKER_ERROR_CODES = Object.freeze({
  CLOSED: "CAPTURE_BROKER_CLOSED",
  TARGET_REVALIDATION_FAILED: "CAPTURE_TARGET_REVALIDATION_FAILED",
  PROVIDER_FAILED: "CAPTURE_PROVIDER_FAILED",
  RESULT_INVALID: "CAPTURE_RESULT_INVALID",
});

export class CaptureBrokerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CaptureBrokerError";
    this.code = code;
  }
}

function fail(code, message) {
  return new CaptureBrokerError(code, message);
}

function validateTargetRef(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096
    || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new TypeError("targetRef must be an opaque reference.");
  }
  return value;
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

function validatePng(rawBytes, width, height) {
  if (!(rawBytes instanceof Uint8Array)) {
    throw fail(CAPTURE_BROKER_ERROR_CODES.RESULT_INVALID, "Capture provider returned invalid PNG bytes.");
  }
  const bytes = Buffer.from(rawBytes);
  if (bytes.length < 57
    || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    || bytes.readUInt32BE(8) !== 13
    || bytes.toString("ascii", 12, 16) !== "IHDR"
    || bytes.readUInt32BE(16) !== width
    || bytes.readUInt32BE(20) !== height) {
    throw fail(CAPTURE_BROKER_ERROR_CODES.RESULT_INVALID, "Capture provider returned invalid PNG bytes.");
  }

  let offset = PNG_SIGNATURE.length;
  let chunkOrdinal = 0;
  let sawImageData = false;
  let sawEnd = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) break;
    const length = bytes.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.length) break;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (chunkOrdinal === 0 && (type !== "IHDR" || length !== 13)) break;
    if (type === "IDAT") sawImageData = true;
    if (type === "IEND") {
      sawEnd = length === 0 && chunkEnd === bytes.length;
      offset = chunkEnd;
      break;
    }
    offset = chunkEnd;
    chunkOrdinal += 1;
  }
  if (!sawImageData || !sawEnd || offset !== bytes.length) {
    throw fail(CAPTURE_BROKER_ERROR_CODES.RESULT_INVALID, "Capture provider returned invalid PNG bytes.");
  }
  return bytes;
}

function validateCaptureResult(value, expectedRegion, expectedProviderId) {
  try {
    exactRecord(value, ["rawBytes", "width", "height", "providerId"], "capture provider result");
    if (!Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)
      || value.width !== expectedRegion.width || value.height !== expectedRegion.height
      || value.providerId !== expectedProviderId) {
      throw fail(CAPTURE_BROKER_ERROR_CODES.RESULT_INVALID, "Capture provider result did not match its binding.");
    }
    const rawBytes = validatePng(value.rawBytes, value.width, value.height);
    return Object.freeze({
      rawBytes,
      width: value.width,
      height: value.height,
      providerId: expectedProviderId,
    });
  } catch (error) {
    if (error instanceof CaptureBrokerError) throw error;
    throw fail(CAPTURE_BROKER_ERROR_CODES.RESULT_INVALID, "Capture provider returned an invalid result.");
  }
}

export class CaptureBroker {
  #targetBroker;
  #captureProvider;
  #closed = false;

  constructor({ targetBroker, captureProvider } = {}) {
    if (!targetBroker || typeof targetBroker.withPrivateBinding !== "function") {
      throw new TypeError("targetBroker must provide withPrivateBinding.");
    }
    this.#targetBroker = targetBroker;
    this.#captureProvider = validateCaptureProvider(captureProvider);
  }

  get providerId() {
    return this.#captureProvider.providerId;
  }

  async capture(untrustedContext) {
    if (this.#closed) {
      throw fail(CAPTURE_BROKER_ERROR_CODES.CLOSED, "Capture broker is closed.");
    }

    let targetRef;
    try {
      exactRecord(untrustedContext, ["targetRef"], "capture context");
      targetRef = validateTargetRef(untrustedContext.targetRef);
    } catch {
      throw fail(CAPTURE_BROKER_ERROR_CODES.TARGET_REVALIDATION_FAILED, "Capture target could not be revalidated.");
    }

    let providerInvoked = false;
    try {
      return await this.#targetBroker.withPrivateBinding(targetRef, async (privateValue) => {
        const pinnedTarget = validatePinnedTarget(privateValue);
        providerInvoked = true;
        const captured = await this.#captureProvider.capture(Object.freeze({
          binding: pinnedTarget.targetIdentity,
          region: pinnedTarget.region,
        }));
        return validateCaptureResult(
          captured,
          pinnedTarget.region,
          this.#captureProvider.providerId,
        );
      });
    } catch (error) {
      if (error instanceof CaptureBrokerError) throw error;
      throw providerInvoked
        ? fail(CAPTURE_BROKER_ERROR_CODES.PROVIDER_FAILED, "Capture provider failed.")
        : fail(CAPTURE_BROKER_ERROR_CODES.TARGET_REVALIDATION_FAILED, "Capture target could not be revalidated.");
    }
  }

  close() {
    this.#closed = true;
  }
}
