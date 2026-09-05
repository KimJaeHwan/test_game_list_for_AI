import {
  exactRecord,
  sameTargetIdentity,
  validateRegion,
  validateTargetIdentity,
} from "../contract.mjs";

const UNSAFE_OPERATOR_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;
const UNSAFE_OPAQUE_ID = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

export const TARGET_BINDING_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: "TARGET_BINDING_INVALID_ARGUMENT",
  BRIDGE_FAILURE: "TARGET_BINDING_BRIDGE_FAILURE",
  MALFORMED_BRIDGE_DATA: "TARGET_BINDING_MALFORMED_BRIDGE_DATA",
  DUPLICATE: "TARGET_BINDING_DUPLICATE",
  NOT_FOUND: "TARGET_BINDING_NOT_FOUND",
  CHANGED: "TARGET_BINDING_CHANGED",
  TICKET_INVALID: "TARGET_BINDING_TICKET_INVALID",
  TICKET_EXPIRED: "TARGET_BINDING_TICKET_EXPIRED",
});

export class TargetBindingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TargetBindingError";
    this.code = code;
  }
}

function invalidArgument(message) {
  return new TargetBindingError(TARGET_BINDING_ERROR_CODES.INVALID_ARGUMENT, message);
}

function sanitizeOperatorText(value, context, { allowEmpty = false } = {}) {
  if (typeof value !== "string") throw new TypeError(`${context} must be a string.`);
  const sanitized = value.replace(UNSAFE_OPERATOR_TEXT, "\ufffd").trim();
  if (!allowEmpty && sanitized.length === 0) throw new TypeError(`${context} must not be empty.`);
  return sanitized;
}

function sanitizeCandidate(value, index) {
  const context = `listWindows result[${index}]`;
  exactRecord(value, ["title", "executablePath", "identity"], context);
  return Object.freeze({
    title: sanitizeOperatorText(value.title, `${context}.title`, { allowEmpty: true }),
    executablePath: sanitizeOperatorText(value.executablePath, `${context}.executablePath`),
    identity: validateTargetIdentity(value.identity, `${context}.identity`),
  });
}

function validateOpaqueId(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096
    || UNSAFE_OPAQUE_ID.test(value)) {
    throw invalidArgument("The ID factory returned an invalid opaque identifier.");
  }
  return value;
}

function validateClockValue(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidArgument("The clock returned an invalid time.");
  }
  return value;
}

function validateTtl(value, context = "ttlMs") {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalidArgument(`${context} must be a positive integer.`);
  }
  return value;
}

function safeTargetRef(targetRef) {
  return Object.freeze({ targetRef });
}

export class TargetBindingBroker {
  #bridge;
  #idFactory;
  #clock;
  #defaultTicketTtlMs;
  #bindings = new Map();
  #bindingByHwnd = new Map();
  #pendingHwnds = new Set();
  #tickets = new Map();
  #issuedIds = new Set();

  constructor({ bridge, idFactory, clock = () => Date.now(), defaultTicketTtlMs = 60_000 } = {}) {
    if (typeof bridge?.listWindows !== "function" || typeof bridge?.inspect !== "function") {
      throw invalidArgument("bridge.listWindows and bridge.inspect are required.");
    }
    if (typeof idFactory !== "function") throw invalidArgument("idFactory is required.");
    if (typeof clock !== "function") throw invalidArgument("clock must be a function.");
    this.#bridge = bridge;
    this.#idFactory = idFactory;
    this.#clock = clock;
    this.#defaultTicketTtlMs = validateTtl(defaultTicketTtlMs, "defaultTicketTtlMs");
  }

  async listOperatorCandidates() {
    let raw;
    try {
      raw = await this.#bridge.listWindows();
    } catch {
      throw new TargetBindingError(
        TARGET_BINDING_ERROR_CODES.BRIDGE_FAILURE,
        "The desktop candidate list is unavailable.",
      );
    }
    if (!Array.isArray(raw)) {
      throw new TargetBindingError(
        TARGET_BINDING_ERROR_CODES.MALFORMED_BRIDGE_DATA,
        "The desktop bridge returned a malformed candidate list.",
      );
    }
    try {
      const seenHwnds = new Set();
      const candidates = raw.map((candidate, index) => {
        const sanitized = sanitizeCandidate(candidate, index);
        if (seenHwnds.has(sanitized.identity.hwnd)) throw new TypeError("duplicate HWND");
        seenHwnds.add(sanitized.identity.hwnd);
        return sanitized;
      });
      return Object.freeze(candidates);
    } catch {
      throw new TargetBindingError(
        TARGET_BINDING_ERROR_CODES.MALFORMED_BRIDGE_DATA,
        "The desktop bridge returned malformed or duplicate candidates.",
      );
    }
  }

  async bind(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw invalidArgument("binding request must be an object.");
    }
    const keys = Object.keys(value);
    const validKeys = (keys.length === 1 && keys[0] === "hwnd")
      || (keys.length === 2 && keys.includes("hwnd") && keys.includes("region"));
    if (!validKeys || typeof value.hwnd !== "string") {
      throw invalidArgument("binding request must contain a valid hwnd and optional region.");
    }
    // validateTargetIdentity is the canonical HWND validator. A placeholder
    // identity avoids maintaining a subtly different HWND grammar here.
    try {
      validateTargetIdentity({
        hwnd: value.hwnd,
        pid: 1,
        processStartTimeUtc: "1970-01-01T00:00:00.000Z",
        executableSha256: "0".repeat(64),
        clientWidth: 1,
        clientHeight: 1,
      }, "binding request");
    } catch {
      throw invalidArgument("binding request must contain a valid hwnd and optional region.");
    }

    if (this.#bindingByHwnd.has(value.hwnd) || this.#pendingHwnds.has(value.hwnd)) {
      throw new TargetBindingError(
        TARGET_BINDING_ERROR_CODES.DUPLICATE,
        "That desktop target already has an active or pending binding.",
      );
    }

    this.#pendingHwnds.add(value.hwnd);
    try {
      const targetIdentity = await this.#inspect(value.hwnd);
      if (targetIdentity.hwnd !== value.hwnd) {
        throw new TargetBindingError(
          TARGET_BINDING_ERROR_CODES.MALFORMED_BRIDGE_DATA,
          "The desktop bridge inspected a different target.",
        );
      }

      let region;
      try {
        region = validateRegion(
          Object.hasOwn(value, "region")
            ? value.region
            : { x: 0, y: 0, width: targetIdentity.clientWidth, height: targetIdentity.clientHeight },
          { width: targetIdentity.clientWidth, height: targetIdentity.clientHeight },
          "region",
        );
      } catch {
        throw invalidArgument("region is invalid or outside the target client bounds.");
      }

      const bindingRef = this.#nextId();
      const record = Object.freeze({ targetIdentity, region });
      this.#bindings.set(bindingRef, record);
      this.#bindingByHwnd.set(targetIdentity.hwnd, bindingRef);
      return Object.freeze({ bindingRef });
    } finally {
      this.#pendingHwnds.delete(value.hwnd);
    }
  }

  async issueLaunchTicket(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw invalidArgument("ticket request must be an object.");
    }
    const keys = Object.keys(value);
    const validKeys = (keys.length === 1 && keys[0] === "bindingRef")
      || (keys.length === 2 && keys.includes("bindingRef") && keys.includes("ttlMs"));
    if (!validKeys || typeof value.bindingRef !== "string") {
      throw invalidArgument("ticket request must contain bindingRef and optional ttlMs.");
    }
    const ttlMs = Object.hasOwn(value, "ttlMs")
      ? validateTtl(value.ttlMs)
      : this.#defaultTicketTtlMs;
    await this.#revalidateRecord(value.bindingRef);
    const issuedAt = validateClockValue(this.#clock());
    const expiresAt = issuedAt + ttlMs;
    if (!Number.isSafeInteger(expiresAt)) throw invalidArgument("ticket expiry is out of range.");
    const launchTicket = this.#nextId();
    this.#tickets.set(launchTicket, Object.freeze({ bindingRef: value.bindingRef, expiresAt }));
    return Object.freeze({ launchTicket, expiresAt });
  }

  async redeem(launchTicket) {
    if (typeof launchTicket !== "string") {
      throw new TargetBindingError(
        TARGET_BINDING_ERROR_CODES.TICKET_INVALID,
        "The launch ticket is invalid or already consumed.",
      );
    }
    // Consume synchronously before revalidation so concurrent redemption loses.
    const ticket = this.#tickets.get(launchTicket);
    this.#tickets.delete(launchTicket);
    if (!ticket) {
      throw new TargetBindingError(
        TARGET_BINDING_ERROR_CODES.TICKET_INVALID,
        "The launch ticket is invalid or already consumed.",
      );
    }
    if (ticket.expiresAt <= validateClockValue(this.#clock())) {
      throw new TargetBindingError(
        TARGET_BINDING_ERROR_CODES.TICKET_EXPIRED,
        "The launch ticket has expired.",
      );
    }
    await this.#revalidateRecord(ticket.bindingRef);
    return safeTargetRef(ticket.bindingRef);
  }

  async revalidate(targetRef) {
    await this.#revalidateRecord(targetRef);
    return safeTargetRef(targetRef);
  }

  async withPrivateBinding(targetRef, callback) {
    if (typeof callback !== "function") throw invalidArgument("callback must be a function.");
    const record = await this.#revalidateRecord(targetRef);
    return callback(Object.freeze({
      targetIdentity: record.targetIdentity,
      region: record.region,
    }));
  }

  #nextId() {
    let value;
    try {
      value = validateOpaqueId(this.#idFactory());
    } catch (error) {
      if (error instanceof TargetBindingError) throw error;
      throw invalidArgument("The ID factory failed.");
    }
    if (this.#issuedIds.has(value)) {
      throw new TargetBindingError(
        TARGET_BINDING_ERROR_CODES.DUPLICATE,
        "The ID factory returned a duplicate identifier.",
      );
    }
    this.#issuedIds.add(value);
    return value;
  }

  async #inspect(hwnd) {
    let raw;
    try {
      raw = await this.#bridge.inspect(hwnd);
    } catch {
      throw new TargetBindingError(
        TARGET_BINDING_ERROR_CODES.BRIDGE_FAILURE,
        "The desktop target could not be inspected.",
      );
    }
    try {
      return validateTargetIdentity(raw, "inspect result");
    } catch {
      throw new TargetBindingError(
        TARGET_BINDING_ERROR_CODES.MALFORMED_BRIDGE_DATA,
        "The desktop bridge returned malformed target identity data.",
      );
    }
  }

  async #revalidateRecord(targetRef) {
    if (typeof targetRef !== "string") {
      throw new TargetBindingError(
        TARGET_BINDING_ERROR_CODES.NOT_FOUND,
        "The desktop target reference is invalid.",
      );
    }
    const record = this.#bindings.get(targetRef);
    if (!record) {
      throw new TargetBindingError(
        TARGET_BINDING_ERROR_CODES.NOT_FOUND,
        "The desktop target reference is invalid.",
      );
    }

    let current;
    try {
      current = await this.#inspect(record.targetIdentity.hwnd);
    } catch (error) {
      this.#invalidateBinding(targetRef, record);
      throw error;
    }
    if (!sameTargetIdentity(record.targetIdentity, current)) {
      this.#invalidateBinding(targetRef, record);
      throw new TargetBindingError(
        TARGET_BINDING_ERROR_CODES.CHANGED,
        "The bound desktop target changed and must be rebound by the operator.",
      );
    }
    return record;
  }

  #invalidateBinding(bindingRef, record) {
    this.#bindings.delete(bindingRef);
    if (this.#bindingByHwnd.get(record.targetIdentity.hwnd) === bindingRef) {
      this.#bindingByHwnd.delete(record.targetIdentity.hwnd);
    }
    for (const [ticket, pending] of this.#tickets) {
      if (pending.bindingRef === bindingRef) this.#tickets.delete(ticket);
    }
  }
}
