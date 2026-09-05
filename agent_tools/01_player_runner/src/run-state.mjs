import { coordinatorRandomId, sha256 } from "../../packages/atlas_protocol/src/index.mjs";
import { RunnerError } from "./errors.mjs";

const TRANSITIONS = Object.freeze({
  CREATED: ["AWAITING_APPROVED_LAUNCH", "INVALID"],
  AWAITING_APPROVED_LAUNCH: ["CALIBRATING", "INVALID"],
  CALIBRATING: ["READY", "PAUSED_FOCUS", "RECOVERING_CAPTURE", "INVALID"],
  READY: ["OBSERVING", "ACTION_RESERVED", "ENDING", "PAUSED_FOCUS", "PAUSED_POLICY", "RECOVERING_CAPTURE", "RECOVERING_REPLAY", "BLOCKED", "INVALID"],
  OBSERVING: ["READY", "PAUSED_FOCUS", "RECOVERING_CAPTURE", "BLOCKED", "INVALID"],
  ACTION_RESERVED: ["INPUT_DISPATCHING", "READY", "BLOCKED", "INVALID"],
  INPUT_DISPATCHING: ["WAITING_OUTCOME_FRAMES", "READY", "BLOCKED", "INVALID"],
  WAITING_OUTCOME_FRAMES: ["READY", "PAUSED_FOCUS", "RECOVERING_CAPTURE", "BLOCKED", "INVALID"],
  PAUSED_FOCUS: ["READY", "ENDING", "BLOCKED", "INVALID"],
  PAUSED_POLICY: ["READY", "ENDING", "BLOCKED", "INVALID"],
  RECOVERING_CAPTURE: ["READY", "BLOCKED", "INVALID"],
  RECOVERING_REPLAY: ["READY", "BLOCKED", "INVALID"],
  BLOCKED: ["RECOVERING_CAPTURE", "RECOVERING_REPLAY", "ENDING", "INVALID"],
  ENDING: ["PUBLIC_SEALING", "INVALID"],
  PUBLIC_SEALING: ["PRIVATE_SEALING", "INVALID"],
  PRIVATE_SEALING: ["SEALED", "INVALID"],
  SEALED: [],
  INVALID: [],
});

export const RUN_STATES = Object.freeze(Object.keys(TRANSITIONS));

export class RunStateMachine {
  constructor({ runId = coordinatorRandomId(), initialState = "CREATED", clock = () => Date.now() } = {}) {
    if (!RUN_STATES.includes(initialState)) throw new RunnerError("STATE_UNKNOWN", `Unknown run state: ${initialState}`);
    this.runId = runId;
    this.state = initialState;
    this.clock = clock;
    this.sequence = 0;
    this.events = [];
  }

  assert(...allowed) {
    if (!allowed.includes(this.state)) {
      throw new RunnerError("RUN_NOT_ACTIONABLE", `Run is ${this.state}; expected ${allowed.join(" or ")}.`);
    }
  }

  canTransition(next) {
    return TRANSITIONS[this.state]?.includes(next) ?? false;
  }

  transition(next, reason = "policy") {
    if (!this.canTransition(next)) {
      throw new RunnerError("STATE_TRANSITION_DENIED", `${this.state} cannot transition to ${next}.`);
    }
    const previous = this.state;
    this.state = next;
    this.sequence += 1;
    const event = Object.freeze({
      eventId: coordinatorRandomId(),
      ordinal: this.sequence,
      previous,
      next,
      reason,
      recordedAt: this.clock(),
    });
    this.events.push(event);
    return event;
  }

  snapshot() {
    return Object.freeze({
      runId: this.runId,
      state: this.state,
      sequence: this.sequence,
      eventChainDigest: sha256(this.events),
    });
  }
}
