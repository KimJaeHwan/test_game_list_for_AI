import {
  createHash,
  randomBytes,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
} from "node:crypto";

function normalizeValue(value, path, seen) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(path + " contains a non-finite number");
    if (Object.is(value, -0)) return 0;
    return value;
  }
  if (typeof value === "bigint" || typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(path + " is not canonical JSON");
  }
  if (seen.has(value)) throw new TypeError(path + " contains a cycle");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => normalizeValue(entry, path + "[" + index + "]", seen));
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError(path + " must be a plain object");
    }
    const result = {};
    const normalizedKeys = new Set();
    for (const key of Object.keys(value).sort()) {
      const normalizedKey = key.normalize("NFC");
      if (normalizedKeys.has(normalizedKey)) throw new TypeError(path + " has colliding normalized keys");
      normalizedKeys.add(normalizedKey);
      result[normalizedKey] = normalizeValue(value[key], path + "." + normalizedKey, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

export function canonicalize(value) {
  return JSON.stringify(normalizeValue(value, "$", new Set()));
}

export function sha256(value) {
  const bytes = value instanceof Uint8Array
    ? value
    : Buffer.from(typeof value === "string" ? value : canonicalize(value), "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

export function coordinatorRandomId() {
  return randomBytes(16).toString("base64url");
}

export function signDetached(value, privateKey) {
  return cryptoSign(null, Buffer.from(canonicalize(value)), privateKey).toString("base64url");
}

export function verifyDetached(value, signature, publicKey) {
  try {
    return cryptoVerify(
      null,
      Buffer.from(canonicalize(value)),
      publicKey,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

export function createSignedEnvelope(header, payload, privateKey) {
  const completeHeader = {
    ...header,
    payloadDigest: sha256(payload),
  };
  const unsigned = { header: completeHeader, payload };
  return Object.freeze({
    ...unsigned,
    signature: signDetached(unsigned, privateKey),
  });
}

export function verifySignedEnvelope(envelope, publicKey) {
  if (!envelope || typeof envelope !== "object") return false;
  if (sha256(envelope.payload) !== envelope.header?.payloadDigest) return false;
  return verifyDetached(
    { header: envelope.header, payload: envelope.payload },
    envelope.signature,
    publicKey,
  );
}

export function sameDigest(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function publicHandoffPayloadDigest(handoff) {
  return sha256({
    frames: handoff.frames,
    observations: handoff.observations,
    actions: handoff.actions,
  });
}
