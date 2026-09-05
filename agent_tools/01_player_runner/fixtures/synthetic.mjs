export class SyntheticCanvas {
  constructor(label = "synthetic-canvas") {
    this.label = label;
    this.ordinal = 0;
  }

  frame(state = "idle") {
    this.ordinal += 1;
    return Buffer.from(`PNG-SYNTHETIC|${this.label}|${this.ordinal}|${state}`, "utf8");
  }
}

export class SyntheticInputSink {
  constructor(behaviors = []) {
    this.behaviors = [...behaviors];
    this.calls = [];
  }

  async dispatch(action, context) {
    this.calls.push({ action: structuredClone(action), context: structuredClone(context) });
    const behavior = this.behaviors.shift() ?? "DELIVERED";
    if (behavior === "CRASH_AFTER_DISPATCH") {
      const error = new Error("Synthetic process crash after dispatch.");
      error.simulatedProcessCrash = true;
      throw error;
    }
    if (behavior === "THROW_UNKNOWN") throw Object.assign(new Error("Synthetic unknown sink failure."), { code: "SINK_UNKNOWN" });
    return { status: behavior, sinkReceipt: `synthetic-${this.calls.length}` };
  }
}
