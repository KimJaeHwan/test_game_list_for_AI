import { sha256 } from "../../packages/atlas_protocol/src/index.mjs";
import { SyntheticCanvas, SyntheticInputSink } from "./synthetic.mjs";

export class SyntheticTrustedAdapter {
  constructor({ behaviors = [], interactionTargets = [{ safePoint: { x: 320, y: 180 }, dispatchHandle: "synthetic-private-target" }] } = {}) {
    this.canvas = new SyntheticCanvas("service-adapter");
    this.inputSink = new SyntheticInputSink(behaviors);
    this.interactionTargets = interactionTargets;
    this.launches = [];
    this.captures = [];
    this.compositions = [];
    this.ends = [];
  }

  async launch(context) {
    this.launches.push(structuredClone(context));
    return Object.freeze({
      sessionHandle: "trusted-synthetic-session",
      configHandle: "trusted-private-config",
      gameBuildHandle: "trusted-private-build",
      replayAdapterVersion: "synthetic-replay/v1",
      capturePolicyDigest: sha256("synthetic-capture-policy/v1"),
      overlayCompositorVersion: "synthetic-compositor/v1",
      framePolicyVersion: "opaque-overlay/v1",
      inputPolicyVersion: "opaque-object/v1",
      width: 1280,
      height: 720,
    });
  }

  async capture(context) {
    this.captures.push(structuredClone(context));
    return Object.freeze({
      rawBytes: this.canvas.frame(context.purpose),
      interactionTargets: this.interactionTargets.map((entry) => structuredClone(entry)),
      framePolicyVersion: "opaque-overlay/v1",
      responseRequestDigest: sha256({ purpose: context.purpose, ordinal: this.captures.length }),
      changeClass: context.purpose === "wait" ? "PERSISTENT_CHANGE" : "UNCERTAIN",
    });
  }

  async compose({ rawBytes, primitives }) {
    this.compositions.push(structuredClone(primitives));
    const visibleGlyphsOnly = primitives.map((primitive) => primitive.glyph).join(",");
    return Object.freeze({
      servedBytes: Buffer.concat([Buffer.from(rawBytes), Buffer.from(`|OPAQUE:${visibleGlyphsOnly}`, "utf8")]),
      overlayPrimitivesDigest: sha256(primitives),
    });
  }

  async dispatch(action, context) {
    return this.inputSink.dispatch(action, context);
  }

  async end(context) {
    this.ends.push(structuredClone(context));
  }
}
