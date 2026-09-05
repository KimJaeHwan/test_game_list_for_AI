import { exactRecord } from "./contract.mjs";

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

function providerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function validateProviderId(value, context = "providerId") {
  if (typeof value !== "string" || !PROVIDER_ID.test(value)) {
    throw new TypeError(`${context} must be a non-secret stable identifier.`);
  }
  return value;
}

export function validateCaptureProvider(value) {
  exactRecord(value, ["providerId", "capture"], "captureProvider");
  const providerId = validateProviderId(value.providerId, "captureProvider.providerId");
  if (typeof value.capture !== "function") {
    throw new TypeError("captureProvider.capture must be a function.");
  }
  return Object.freeze({
    providerId,
    capture: value.capture.bind(value),
  });
}

/**
 * Compatibility adapter for the current NativeDesktopBridgeClient capture
 * shape. New capture implementations should provide the stable contract
 * directly and must never fall back to another provider.
 */
export function createLegacyBridgeCaptureProvider(options) {
  exactRecord(options, ["bridge", "providerId"], "legacy capture provider options");
  const { bridge, providerId } = options;
  validateProviderId(providerId);
  if (!bridge || typeof bridge.capture !== "function") {
    throw new TypeError("legacy capture bridge must provide capture.");
  }

  return validateCaptureProvider({
    providerId,
    async capture(request) {
      const captured = await bridge.capture(request);
      exactRecord(
        captured,
        ["rawBytes", "width", "height", "captureBackend"],
        "legacy capture result",
      );
      return Object.freeze({
        rawBytes: captured.rawBytes,
        width: captured.width,
        height: captured.height,
        providerId: captured.captureBackend,
      });
    },
  });
}

export function createProviderLifecycle(resources) {
  if (!Array.isArray(resources) || resources.length < 1) {
    throw new TypeError("provider lifecycle requires at least one closeable resource.");
  }
  const closeables = [...new Set(resources)];
  if (closeables.some((resource) => !resource || typeof resource.close !== "function")) {
    throw new TypeError("every provider lifecycle resource must provide close().");
  }

  const pending = new Set(closeables);
  let state = "OPEN";
  let closeAttempt;
  return Object.freeze({
    get state() {
      return state;
    },
    close() {
      if (state === "CLOSED" || state === "CLOSING") return closeAttempt;

      state = "CLOSING";
      closeAttempt = (async () => {
        for (const resource of [...pending]) {
          try {
            await resource.close();
            pending.delete(resource);
          } catch {
            // A failed close remains pending for an explicit cleanup retry.
          }
        }

        if (pending.size > 0) {
          state = "CLOSE_FAILED";
          throw providerError("PROVIDER_CLOSE_FAILED", "Desktop providers could not be closed cleanly.");
        }

        state = "CLOSED";
      })();
      return closeAttempt;
    },
  });
}
