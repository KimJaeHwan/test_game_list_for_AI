import { randomBytes } from "node:crypto";
import { coordinatorRandomId, sha256 } from "../../packages/atlas_protocol/src/index.mjs";
import { RunnerError } from "./errors.mjs";

export const CAPABILITY_SCOPES = Object.freeze([
  "observe",
  "keyboard",
  "object",
  "bookmark",
  "handoff",
]);

function opaqueToken() {
  return `cap_${randomBytes(32).toString("base64url")}`;
}

export class CapabilityIssuer {
  constructor({ clock = () => Date.now() } = {}) {
    this.clock = clock;
    this.records = new Map();
  }

  issue({ runId, clientBinding, scopes, expiresAt, budget = Number.MAX_SAFE_INTEGER }) {
    if (!runId || !clientBinding) throw new RunnerError("CAPABILITY_INVALID", "runId and clientBinding are required.");
    if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some((scope) => !CAPABILITY_SCOPES.includes(scope))) {
      throw new RunnerError("CAPABILITY_INVALID", "Capability scopes are invalid.");
    }
    if (!Number.isSafeInteger(budget) || budget < 0) throw new RunnerError("CAPABILITY_INVALID", "Capability budget is invalid.");
    if (!Number.isFinite(expiresAt) || expiresAt <= this.clock()) throw new RunnerError("CAPABILITY_INVALID", "Capability expiry must be in the future.");

    const token = opaqueToken();
    const tokenDigest = sha256(token);
    this.records.set(tokenDigest, {
      id: coordinatorRandomId(),
      runId,
      clientBinding,
      scopes: new Set(scopes),
      expiresAt,
      remaining: budget,
      revoked: false,
    });
    return token;
  }

  authorize({ token, runId, clientBinding, scope, consume = false }) {
    const record = this.records.get(sha256(token ?? ""));
    if (!record || record.revoked || record.runId !== runId || record.clientBinding !== clientBinding || !record.scopes.has(scope)) {
      throw new RunnerError("CAPABILITY_DENIED", "Capability is not valid for this run, client, or scope.");
    }
    if (record.expiresAt <= this.clock()) throw new RunnerError("CAPABILITY_EXPIRED", "Capability has expired.");
    if (record.remaining <= 0) throw new RunnerError("CAPABILITY_BUDGET_EXHAUSTED", "Capability budget is exhausted.");
    if (consume) record.remaining -= 1;
    return Object.freeze({ capabilityId: record.id, remaining: record.remaining, expiresAt: record.expiresAt });
  }

  revoke(token) {
    const record = this.records.get(sha256(token ?? ""));
    if (record) record.revoked = true;
  }

  revokeRun(runId) {
    for (const record of this.records.values()) if (record.runId === runId) record.revoked = true;
  }
}
