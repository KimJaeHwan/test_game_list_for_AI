import { coordinatorRandomId, sha256 } from "../../packages/atlas_protocol/src/index.mjs";
import { RunnerError } from "./errors.mjs";

function validateSafePoint(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.y >= 0;
}

export class OpaqueOptionResolver {
  constructor({ clock = () => Date.now(), defaultTtlMs = 5_000 } = {}) {
    this.clock = clock;
    this.defaultTtlMs = defaultTtlMs;
    this.activeFrameId = undefined;
    this.optionSetDigest = sha256({ options: [] });
    this.options = new Map();
  }

  bindFrame({ frameId, safePoints, ttlMs = this.defaultTtlMs }) {
    if (!frameId || !Array.isArray(safePoints) || safePoints.some((entry) => !validateSafePoint(entry.safePoint))) {
      throw new RunnerError("OPTION_SET_INVALID", "Trusted safe points are invalid.");
    }
    this.invalidate();
    this.activeFrameId = frameId;
    const expiresAt = this.clock() + ttlMs;
    const entries = safePoints.map((entry, index) => {
      const optionRef = `OPT-${coordinatorRandomId()}`;
      const glyph = `${String.fromCharCode(65 + (index % 26))}${(index % 9) + 1}`;
      const privateEntry = {
        optionRef,
        glyph,
        frameId,
        expiresAt,
        safePoint: Object.freeze({ x: entry.safePoint.x, y: entry.safePoint.y }),
        dispatchHandle: entry.dispatchHandle ?? coordinatorRandomId(),
        used: false,
      };
      this.options.set(optionRef, privateEntry);
      return privateEntry;
    });
    this.optionSetDigest = sha256(entries.map((entry) => ({
      optionRef: entry.optionRef,
      glyph: entry.glyph,
      safePoint: entry.safePoint,
      dispatchHandle: entry.dispatchHandle,
    })));
    return Object.freeze({
      frameId,
      optionSetDigest: this.optionSetDigest,
      overlays: entries.map(({ optionRef, glyph }) => Object.freeze({ optionRef, glyph })),
    });
  }

  reserve({ optionRef, expectedFrameId }) {
    const option = this.options.get(optionRef);
    if (!option || option.frameId !== expectedFrameId || this.activeFrameId !== expectedFrameId) {
      throw new RunnerError("OPTION_EXPIRED", "Option is not valid for the expected served frame.");
    }
    if (option.expiresAt <= this.clock() || option.used) {
      throw new RunnerError("OPTION_EXPIRED", "Option has expired or was already reserved.");
    }
    option.used = true;
    return Object.freeze({
      safePoint: option.safePoint,
      dispatchHandle: option.dispatchHandle,
      optionSetDigest: this.optionSetDigest,
      selectedOptionDigest: sha256({
        frameId: option.frameId,
        optionRef: option.optionRef,
        safePoint: option.safePoint,
        dispatchHandle: option.dispatchHandle,
      }),
    });
  }

  invalidate() {
    this.options.clear();
    this.activeFrameId = undefined;
    this.optionSetDigest = sha256({ options: [] });
  }
}
