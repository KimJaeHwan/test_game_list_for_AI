import { coordinatorRandomId } from "../../packages/atlas_protocol/src/index.mjs";
import { invariant } from "./errors.mjs";

export class OpaqueCapabilityRegistry {
  #records = new Map();

  issue({ kind, campaignId, audience, value, uses = Infinity }) {
    invariant(Number.isInteger(uses) || uses === Infinity, "REGISTRY_POLICY_INVALID", "uses must be an integer or Infinity");
    invariant(uses > 0, "REGISTRY_POLICY_INVALID", "uses must be positive");
    const capability = `cap_${coordinatorRandomId()}`;
    this.#records.set(capability, { kind, campaignId, audience, value, remaining: uses });
    return capability;
  }

  assert(capability, expected) {
    const record = this.#records.get(capability);
    invariant(record, "CAPABILITY_UNKNOWN", "capability is unknown");
    checkScope(record, expected);
    invariant(record.remaining > 0, "CAPABILITY_CONSUMED", "capability has no remaining uses");
    return true;
  }

  resolve(capability, expected) {
    this.assert(capability, expected);
    return this.#records.get(capability).value;
  }

  redeem(capability, expected) {
    this.assert(capability, expected);
    const record = this.#records.get(capability);
    if (record.remaining !== Infinity) record.remaining -= 1;
    return record.value;
  }
}

function checkScope(record, expected) {
  for (const field of ["kind", "campaignId", "audience"]) {
    if (expected[field] !== undefined) {
      invariant(record[field] === expected[field], "CAPABILITY_SCOPE_MISMATCH", `${field} capability scope mismatch`);
    }
  }
}
