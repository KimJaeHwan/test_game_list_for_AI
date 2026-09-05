import { coordinatorRandomId, sha256 } from "../../packages/atlas_protocol/src/index.mjs";
import {
  DESKTOP_BRIDGE_PROTOCOL_VERSION,
  DESKTOP_FRAME_POLICY_VERSION,
  DESKTOP_INPUT_POLICY_VERSION,
  exactRecord,
} from "./contract.mjs";
import { validateProviderId } from "./provider-contract.mjs";

const PROVIDER_STATES = Object.freeze({
  OPEN: "OPEN",
  CLOSING: "CLOSING",
  CLOSE_FAILED: "CLOSE_FAILED",
  CLOSED: "CLOSED",
});

function requireOpaque(value, context) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/u.test(value)) {
    throw new TypeError(`${context} must be an opaque identifier.`);
  }
  return value;
}

function providerCloseError() {
  const error = new Error("Desktop providers could not be closed cleanly.");
  error.code = "PROVIDER_CLOSE_FAILED";
  return error;
}

function validateCapturedFrame(value, session, captureBroker, expectedProviderId) {
  try {
    exactRecord(value, ["rawBytes", "width", "height", "providerId"], "capture broker result");
    const currentProviderId = validateProviderId(
      captureBroker.providerId,
      "captureBroker.providerId",
    );
    if (!(value.rawBytes instanceof Uint8Array)
      || value.width !== session.width
      || value.height !== session.height
      || currentProviderId !== expectedProviderId
      || value.providerId !== currentProviderId) {
      throw new TypeError("capture broker result did not match its session.");
    }
    return value;
  } catch {
    throw new Error("Desktop capture did not match the pinned target region and provider.");
  }
}

export class DesktopWindowAdapter {
  #targetBroker;
  #captureBroker;
  #inputBroker;
  #providerLifecycle;
  #captureProviderId;
  #idFactory;
  #sessions = new Map();
  #providerState = PROVIDER_STATES.OPEN;
  #providerCloseAttempt;
  #captureBrokerClosed = false;
  #providerLifecycleClosed = false;

  constructor({
    targetBroker,
    captureBroker,
    inputBroker,
    providerLifecycle,
    idFactory = coordinatorRandomId,
  } = {}) {
    if (typeof targetBroker?.redeem !== "function" || typeof targetBroker?.withPrivateBinding !== "function") {
      throw new TypeError("targetBroker must provide redeem and withPrivateBinding.");
    }
    const captureProviderId = captureBroker?.providerId;
    if (typeof captureBroker?.capture !== "function"
      || typeof captureProviderId !== "string"
      || typeof captureBroker?.close !== "function") {
      throw new TypeError("captureBroker must provide capture, providerId, and close.");
    }
    const validatedCaptureProviderId = validateProviderId(
      captureProviderId,
      "captureBroker.providerId",
    );
    if (typeof inputBroker?.dispatch !== "function") throw new TypeError("inputBroker must provide dispatch.");
    if (typeof providerLifecycle?.close !== "function") {
      throw new TypeError("providerLifecycle must provide close.");
    }
    if (typeof idFactory !== "function") throw new TypeError("idFactory must be a function.");
    this.#targetBroker = targetBroker;
    this.#captureBroker = captureBroker;
    this.#inputBroker = inputBroker;
    this.#providerLifecycle = providerLifecycle;
    this.#captureProviderId = validatedCaptureProviderId;
    this.#idFactory = idFactory;
  }

  async launch(untrustedContext) {
    this.#requireOpenProviders();
    exactRecord(untrustedContext, ["launchTicket", "internalRunId", "publicRunId"], "launch context");
    const redeemed = await this.#targetBroker.redeem(requireOpaque(untrustedContext.launchTicket, "launchTicket"));
    exactRecord(redeemed, ["targetRef"], "redeemed target");
    const targetRef = requireOpaque(redeemed.targetRef, "targetRef");
    const dimensions = await this.#targetBroker.withPrivateBinding(targetRef, ({ region }) => Object.freeze({
      width: region.width,
      height: region.height,
    }));
    const sessionHandle = requireOpaque(this.#idFactory(), "sessionHandle");
    const session = {
      targetRef,
      width: dimensions.width,
      height: dimensions.height,
      ended: false,
      lastFrameDigest: undefined,
    };
    this.#sessions.set(sessionHandle, session);
    return Object.freeze({
      sessionHandle,
      configHandle: requireOpaque(this.#idFactory(), "configHandle"),
      gameBuildHandle: requireOpaque(this.#idFactory(), "gameBuildHandle"),
      replayAdapterVersion: "desktop-window-native/v1",
      capturePolicyDigest: sha256({
        protocol: DESKTOP_BRIDGE_PROTOCOL_VERSION,
        framePolicy: DESKTOP_FRAME_POLICY_VERSION,
        captureProviderId: this.#captureProviderId,
        source: "composited-visible-window",
      }),
      overlayCompositorVersion: "none/v1",
      framePolicyVersion: DESKTOP_FRAME_POLICY_VERSION,
      inputPolicyVersion: DESKTOP_INPUT_POLICY_VERSION,
      width: session.width,
      height: session.height,
    });
  }

  async capture(context) {
    if (!context || typeof context !== "object" || Array.isArray(context)) {
      throw new TypeError("capture context must be an object.");
    }
    const session = this.#requireSession(context.sessionHandle);
    const captured = validateCapturedFrame(
      await this.#captureBroker.capture({ targetRef: session.targetRef }),
      session,
      this.#captureBroker,
      this.#captureProviderId,
    );
    const digest = sha256(captured.rawBytes);
    const changeClass = context.purpose === "wait"
      ? (session.lastFrameDigest === digest ? "UNCHANGED" : "PERSISTENT_CHANGE")
      : "UNCERTAIN";
    session.lastFrameDigest = digest;
    return Object.freeze({
      rawBytes: Buffer.from(captured.rawBytes),
      interactionTargets: [],
      framePolicyVersion: DESKTOP_FRAME_POLICY_VERSION,
      responseRequestDigest: sha256({
        sessionHandle: context.sessionHandle,
        purpose: context.purpose ?? "observe",
        previousFrame: context.afterFrameId ?? null,
      }),
      changeClass,
    });
  }

  async dispatch(action, context) {
    const session = this.#requireSession(context?.sessionHandle);
    // InputGateway may attach a private detector handle to an opaque option.
    // The desktop sink needs only the resolver-approved point and deliberately
    // drops that game-specific handle before applying the exact input policy.
    const policyAction = action?.kind === "safePointActivate"
      ? { kind: "safePointActivate", safePoint: action.safePoint }
      : action;
    return this.#inputBroker.dispatch(policyAction, { targetRef: session.targetRef });
  }

  async end(context) {
    const session = this.#findSessionForEnd(context?.sessionHandle);
    session.ended = true;
    if ([...this.#sessions.values()].every((candidate) => candidate.ended)) {
      await this.#closeProviders();
    }
  }

  #requireSession(sessionHandle) {
    this.#requireOpenProviders();
    requireOpaque(sessionHandle, "sessionHandle");
    const session = this.#sessions.get(sessionHandle);
    if (!session || session.ended) throw new Error("Desktop session is unavailable.");
    return session;
  }

  #requireOpenProviders() {
    if (this.#providerState !== PROVIDER_STATES.OPEN) {
      throw new Error("Desktop providers are not open.");
    }
  }

  #findSessionForEnd(sessionHandle) {
    requireOpaque(sessionHandle, "sessionHandle");
    const session = this.#sessions.get(sessionHandle);
    if (!session) throw new Error("Desktop session is unavailable.");
    return session;
  }

  #closeProviders() {
    if (this.#providerState === PROVIDER_STATES.CLOSED
      || this.#providerState === PROVIDER_STATES.CLOSING) {
      return this.#providerCloseAttempt;
    }

    this.#providerState = PROVIDER_STATES.CLOSING;
    this.#providerCloseAttempt = (async () => {
      let failed = false;
      if (!this.#captureBrokerClosed) {
        try {
          await this.#captureBroker.close();
          this.#captureBrokerClosed = true;
        } catch {
          failed = true;
        }
      }
      if (!this.#providerLifecycleClosed) {
        try {
          await this.#providerLifecycle.close();
          this.#providerLifecycleClosed = true;
        } catch {
          failed = true;
        }
      }

      if (failed) {
        this.#providerState = PROVIDER_STATES.CLOSE_FAILED;
        throw providerCloseError();
      }
      this.#providerState = PROVIDER_STATES.CLOSED;
    })();
    return this.#providerCloseAttempt;
  }
}
