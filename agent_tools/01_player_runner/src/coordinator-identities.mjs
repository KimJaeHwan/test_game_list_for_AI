import { RunnerError } from "./errors.mjs";

function requireOpaque(value, field) {
  if (typeof value !== "string" || value.length < 8) {
    throw new RunnerError("COORDINATOR_IDENTITY_INVALID", `${field} must be a coordinator-issued opaque string.`);
  }
  return value;
}

/**
 * Consumable identities minted outside the Runner by the Coordinator.
 * This class validates and spends identities; it never creates them.
 */
export class CoordinatorIdentityPool {
  constructor({ campaignId, publicRunId, targetRunId = publicRunId, artifactIds, nonces } = {}) {
    this.campaignId = requireOpaque(campaignId, "campaignId");
    this.publicRunId = requireOpaque(publicRunId, "publicRunId");
    this.targetRunId = requireOpaque(targetRunId, "targetRunId");
    if (!Array.isArray(artifactIds) || !Array.isArray(nonces) || artifactIds.length === 0 || artifactIds.length !== nonces.length) {
      throw new RunnerError("COORDINATOR_IDENTITY_INVALID", "artifactIds and nonces must be non-empty, equally-sized arrays.");
    }
    const values = [...artifactIds, ...nonces];
    values.forEach((value, index) => requireOpaque(value, `identity[${index}]`));
    if (new Set(values).size !== values.length) {
      throw new RunnerError("COORDINATOR_IDENTITY_INVALID", "Coordinator identities must be unique.");
    }
    this.entries = artifactIds.map((artifactId, index) => Object.freeze({ artifactId, nonce: nonces[index] }));
    this.cursor = 0;
    this.purposes = new Set();
  }

  takeEnvelopeIdentity(purpose) {
    requireOpaque(purpose, "purpose");
    if (this.purposes.has(purpose)) {
      throw new RunnerError("COORDINATOR_IDENTITY_REUSE", `Identity purpose already consumed: ${purpose}.`);
    }
    const identity = this.entries[this.cursor];
    if (!identity) {
      throw new RunnerError("COORDINATOR_IDENTITY_EXHAUSTED", "Coordinator identity pool is exhausted.");
    }
    this.cursor += 1;
    this.purposes.add(purpose);
    return identity;
  }
}
