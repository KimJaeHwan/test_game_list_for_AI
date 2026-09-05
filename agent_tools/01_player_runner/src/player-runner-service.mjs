import { DEFAULT_CAMPAIGN_PROFILE, sha256 } from "../../packages/atlas_protocol/src/index.mjs";
import { CapabilityIssuer } from "./capability-issuer.mjs";
import { FrameProvenance } from "./frame-provenance.mjs";
import { HandoffSealer } from "./handoff-sealer.mjs";
import { InputGateway } from "./input-gateway.mjs";
import { OpaqueOptionResolver } from "./option-resolver.mjs";
import { RunStateMachine } from "./run-state.mjs";
import { RunnerError } from "./errors.mjs";
import { SignedReceiptChain } from "./signed-chain.mjs";

const TOOL_NAMES = Object.freeze([
  "attach_run",
  "observe",
  "tap_key",
  "activate_option",
  "wait_frame",
  "bookmark_observation",
  "request_end",
  "seal_handoff",
]);

const TOOL_KEYS = Object.freeze({
  attach_run: ["launchTicket"],
  observe: ["observeCap"],
  tap_key: ["keyboardCap", "requestId", "expectedFrameId", "code"],
  activate_option: ["objectCap", "requestId", "expectedFrameId", "optionRef"],
  wait_frame: ["observeCap", "afterFrameId", "maxFrames"],
  bookmark_observation: ["bookmarkCap", "frameIds", "precedingActionIds"],
  request_end: ["handoffCap", "reason"],
  seal_handoff: ["handoffCap"],
});

const FORBIDDEN_ARGUMENT_KEY = /^(?:x|y|url|uri|selector|dom|press|click|navigate|coordinate|coordinates|position|point|rect|bounds|script|html)$/iu;
const OPAQUE_VALUE = /^[A-Za-z0-9_.:-]{1,256}$/u;
const FRAME_ID = /^F\d{6}$/u;
const ACTION_ID = /^A\d{6}$/u;
const CHANGE_CLASSES = new Set(["UNCHANGED", "TRANSIENT_ONLY", "PERSISTENT_CHANGE", "UNCERTAIN"]);
const END_REASONS = new Set(["COMPLETE", "PARTIAL", "ABORT"]);

const DEFAULT_BUDGETS = Object.freeze({ observe: 100, keyboard: 50, object: 50, bookmark: 50, handoff: 2 });

function rejectForbiddenArgumentKeys(value) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach(rejectForbiddenArgumentKeys);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_ARGUMENT_KEY.test(key)) {
      throw new RunnerError("TOOL_ARGUMENT_FORBIDDEN", `Raw interaction field is forbidden: ${key}.`);
    }
    rejectForbiddenArgumentKeys(child);
  }
}

function exactArguments(toolName, args) {
  rejectForbiddenArgumentKeys(args);
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new RunnerError("TOOL_ARGUMENT_INVALID", `${toolName} arguments must be an object.`);
  }
  const expected = TOOL_KEYS[toolName];
  const actual = Object.keys(args);
  if (actual.length !== expected.length || expected.some((key) => !Object.hasOwn(args, key))) {
    throw new RunnerError("TOOL_ARGUMENT_INVALID", `${toolName} accepts exactly: ${expected.join(", ")}.`);
  }
  return args;
}

function requireOpaque(value, field) {
  if (typeof value !== "string" || !OPAQUE_VALUE.test(value)) {
    throw new RunnerError("TOOL_ARGUMENT_INVALID", `${field} must be a non-semantic opaque string.`);
  }
  return value;
}

function requireFrameId(value, field = "frameId") {
  if (typeof value !== "string" || !FRAME_ID.test(value)) throw new RunnerError("TOOL_ARGUMENT_INVALID", `${field} is invalid.`);
  return value;
}

function actionState(state) {
  if (state === "READY") return "READY";
  if (["ENDING", "PUBLIC_SEALING", "PRIVATE_SEALING", "SEALED", "INVALID"].includes(state)) return "ENDED";
  if (state.startsWith("PAUSED") || state.startsWith("RECOVERING") || state === "BLOCKED") return "PAUSED";
  return "BUSY";
}

function validateBudgets(budgets) {
  const merged = { ...DEFAULT_BUDGETS, ...budgets };
  for (const key of Object.keys(DEFAULT_BUDGETS)) {
    if (!Number.isSafeInteger(merged[key]) || merged[key] < 1) throw new TypeError(`Invalid ${key} budget.`);
  }
  return Object.freeze(merged);
}

function validateAdapter(adapter) {
  for (const method of ["launch", "capture", "dispatch"]) {
    if (typeof adapter?.[method] !== "function") throw new TypeError(`Trusted adapter must implement ${method}().`);
  }
  return adapter;
}

export { TOOL_NAMES as PLAYER_RUNNER_TOOL_NAMES };

/**
 * One-run service façade. Tool arguments are public/untrusted; adapter calls are
 * private/trusted. No tool accepts a URL, DOM selector, coordinate, or raw press.
 */
export class PlayerRunnerService {
  constructor({
    adapter,
    internalRunId,
    identityPool,
    signingPrivateKey,
    runnerKeyId,
    clientBinding,
    wal,
    artifactStore,
    clock = () => Date.now(),
    capabilityTtlMs = 30 * 60 * 1_000,
    budgets,
    allowedKeys = DEFAULT_CAMPAIGN_PROFILE.allowedKeys,
  }) {
    if (!internalRunId || !identityPool || !signingPrivateKey || !runnerKeyId || !clientBinding || !wal) {
      throw new TypeError("PlayerRunnerService requires Coordinator identity, signing, client binding, and WAL dependencies.");
    }
    if (identityPool.targetRunId !== identityPool.publicRunId) {
      throw new RunnerError("RUN_IDENTITY_MISMATCH", "Exploration targetRunId must equal publicRunId.");
    }
    if (artifactStore !== undefined && typeof artifactStore?.persist !== "function") {
      throw new TypeError("artifactStore must implement persist().");
    }
    this.adapter = validateAdapter(adapter);
    this.internalRunId = internalRunId;
    this.identityPool = identityPool;
    this.signingPrivateKey = signingPrivateKey;
    this.runnerKeyId = runnerKeyId;
    this.clientBinding = clientBinding;
    this.wal = wal;
    this.artifactStore = artifactStore;
    this.clock = clock;
    this.capabilityTtlMs = capabilityTtlMs;
    this.budgets = validateBudgets(budgets);
    const campaignKeys = new Set(DEFAULT_CAMPAIGN_PROFILE.allowedKeys);
    if (!Array.isArray(allowedKeys) || allowedKeys.length === 0 || allowedKeys.some((code) => typeof code !== "string" || !campaignKeys.has(code))) {
      throw new TypeError("allowedKeys must be a non-empty subset of the fixed campaign keyboard profile.");
    }
    this.allowedKeys = Object.freeze([...new Set(allowedKeys)]);
    this.capabilityIssuer = new CapabilityIssuer({ clock });
    this.stateMachine = new RunStateMachine({ runId: internalRunId, initialState: "CREATED", clock });
    this.receiptChain = new SignedReceiptChain({
      privateKey: signingPrivateKey,
      keyId: runnerKeyId,
      identityPool,
    });
    this.optionResolver = new OpaqueOptionResolver({ clock });
    this.observations = [];
    this.pendingDeliveredRequestId = undefined;
    this.endReason = undefined;
    this.launchContext = undefined;
    this.frames = undefined;
    this.inputGateway = undefined;
    this.sealedArtifacts = undefined;
    this.capabilities = undefined;
  }

  #authorize(token, scope, consume = true) {
    return this.capabilityIssuer.authorize({
      token,
      runId: this.internalRunId,
      clientBinding: this.clientBinding,
      scope,
      consume,
    });
  }

  #assertAttached() {
    if (!this.launchContext || !this.frames || !this.inputGateway) {
      throw new RunnerError("RUN_NOT_ATTACHED", "attach_run must complete first.");
    }
  }

  async attachRun(untrustedArgs) {
    const args = exactArguments("attach_run", untrustedArgs);
    requireOpaque(args.launchTicket, "launchTicket");
    this.stateMachine.assert("CREATED");
    this.stateMachine.transition("AWAITING_APPROVED_LAUNCH", "approved-ticket-received");
    const launchContext = await this.adapter.launch(Object.freeze({
      launchTicket: args.launchTicket,
      internalRunId: this.internalRunId,
      publicRunId: this.identityPool.publicRunId,
    }));
    for (const field of ["sessionHandle", "configHandle", "gameBuildHandle", "replayAdapterVersion", "capturePolicyDigest", "overlayCompositorVersion"]) {
      if (!launchContext?.[field]) throw new RunnerError("TRUSTED_ADAPTER_INVALID", `launch() omitted ${field}.`);
    }
    this.stateMachine.transition("CALIBRATING", "trusted-adapter-launched");
    this.launchContext = Object.freeze({ ...launchContext });
    this.frames = new FrameProvenance({
      campaignId: this.identityPool.campaignId,
      internalRunId: this.internalRunId,
      publicRunId: this.identityPool.publicRunId,
      gameBuildHandle: launchContext.gameBuildHandle,
      capturePolicyDigest: launchContext.capturePolicyDigest,
      overlayCompositorVersion: launchContext.overlayCompositorVersion,
      clientBindingDigest: sha256(this.clientBinding),
      receiptChain: this.receiptChain,
      width: launchContext.width ?? 1280,
      height: launchContext.height ?? 720,
    });
    this.inputGateway = new InputGateway({
      campaignId: this.identityPool.campaignId,
      runId: this.internalRunId,
      publicRunId: this.identityPool.publicRunId,
      clientBinding: this.clientBinding,
      capabilityIssuer: this.capabilityIssuer,
      wal: this.wal,
      sink: {
        dispatch: (action, context) => this.adapter.dispatch(action, Object.freeze({
          ...context,
          sessionHandle: launchContext.sessionHandle,
        })),
      },
      frames: this.frames,
      optionResolver: this.optionResolver,
      receiptChain: this.receiptChain,
      stateMachine: this.stateMachine,
      allowedKeys: this.allowedKeys,
    });
    const expiresAt = this.clock() + this.capabilityTtlMs;
    this.capabilities = Object.freeze({
      observeCap: this.capabilityIssuer.issue({ runId: this.internalRunId, clientBinding: this.clientBinding, scopes: ["observe"], expiresAt, budget: this.budgets.observe }),
      keyboardCap: this.capabilityIssuer.issue({ runId: this.internalRunId, clientBinding: this.clientBinding, scopes: ["keyboard"], expiresAt, budget: this.budgets.keyboard }),
      objectCap: this.capabilityIssuer.issue({ runId: this.internalRunId, clientBinding: this.clientBinding, scopes: ["object"], expiresAt, budget: this.budgets.object }),
      bookmarkCap: this.capabilityIssuer.issue({ runId: this.internalRunId, clientBinding: this.clientBinding, scopes: ["bookmark"], expiresAt, budget: this.budgets.bookmark }),
      handoffCap: this.capabilityIssuer.issue({ runId: this.internalRunId, clientBinding: this.clientBinding, scopes: ["handoff"], expiresAt, budget: this.budgets.handoff }),
    });
    this.stateMachine.transition("READY", "calibration-complete");
    return Object.freeze({
      runId: this.identityPool.publicRunId,
      ...this.capabilities,
      actionProfile: Object.freeze({ allowedKeys: [...this.allowedKeys], objectActions: typeof this.adapter.compose === "function" }),
      budgets: Object.freeze({ ...this.budgets }),
    });
  }

  async #captureAndServe({ purpose, afterFrameId, maxFrames }) {
    const captured = await this.adapter.capture(Object.freeze({
      sessionHandle: this.launchContext.sessionHandle,
      purpose,
      afterFrameId,
      maxFrames,
    }));
    if (!(captured?.rawBytes instanceof Uint8Array)) {
      throw new RunnerError("TRUSTED_ADAPTER_INVALID", "capture() must return rawBytes.");
    }
    const targets = captured.interactionTargets ?? [];
    if (!Array.isArray(targets)) throw new RunnerError("TRUSTED_ADAPTER_INVALID", "interactionTargets must be an array.");
    const frameId = this.frames.allocateFrameId();
    const optionSet = this.optionResolver.bindFrame({ frameId, safePoints: targets });
    const primitives = targets.map((target, index) => Object.freeze({
      glyph: optionSet.overlays[index].glyph,
      safePoint: target.safePoint,
    }));
    let servedBytes = Buffer.from(captured.rawBytes);
    let overlayPrimitivesDigest = sha256({ primitives: [] });
    if (primitives.length > 0) {
      if (typeof this.adapter.compose !== "function") {
        throw new RunnerError("TRUSTED_ADAPTER_INVALID", "Object options require trusted compose().");
      }
      const composed = await this.adapter.compose(Object.freeze({
        sessionHandle: this.launchContext.sessionHandle,
        rawBytes: Buffer.from(captured.rawBytes),
        primitives,
      }));
      if (!(composed?.servedBytes instanceof Uint8Array)) {
        throw new RunnerError("TRUSTED_ADAPTER_INVALID", "compose() must return servedBytes.");
      }
      servedBytes = Buffer.from(composed.servedBytes);
      overlayPrimitivesDigest = composed.overlayPrimitivesDigest ?? sha256(primitives);
    }
    const captureId = this.frames.capture(captured.rawBytes);
    const served = this.frames.serve({
      captureId,
      frameId,
      servedBytes,
      framePolicyVersion: captured.framePolicyVersion ?? this.launchContext.framePolicyVersion ?? "canvas-served/v1",
      responseRequestDigest: captured.responseRequestDigest ?? sha256({ purpose, publicRunId: this.identityPool.publicRunId, frameId }),
      optionSetDigest: optionSet.optionSetDigest,
      overlayPrimitivesDigest,
    });
    return Object.freeze({
      frameId: served.frameId,
      image: Buffer.from(served.image),
      sha256: served.sha256,
      options: optionSet.overlays.map(({ optionRef }) => Object.freeze({ optionRef })),
      changeClass: captured.changeClass ?? "UNCERTAIN",
    });
  }

  async observe(untrustedArgs) {
    const args = exactArguments("observe", untrustedArgs);
    this.#assertAttached();
    this.stateMachine.assert("READY");
    const authorization = this.#authorize(requireOpaque(args.observeCap, "observeCap"), "observe", true);
    this.stateMachine.transition("OBSERVING", "observe-requested");
    try {
      const frame = await this.#captureAndServe({ purpose: "observe" });
      this.stateMachine.transition("READY", "frame-served");
      return Object.freeze({
        frameId: frame.frameId,
        image: frame.image,
        sha256: frame.sha256,
        actionState: actionState(this.stateMachine.state),
        remainingBudget: authorization.remaining,
        options: frame.options,
      });
    } catch (error) {
      if (this.stateMachine.canTransition("BLOCKED")) this.stateMachine.transition("BLOCKED", "capture-failed");
      throw error;
    }
  }

  async tapKey(untrustedArgs) {
    const args = exactArguments("tap_key", untrustedArgs);
    this.#assertAttached();
    requireOpaque(args.keyboardCap, "keyboardCap");
    requireOpaque(args.requestId, "requestId");
    requireFrameId(args.expectedFrameId, "expectedFrameId");
    if (typeof args.code !== "string" || !this.allowedKeys.includes(args.code)) {
      throw new RunnerError("TOOL_ARGUMENT_INVALID", "code is not in the fixed keyboard profile.");
    }
    const receipt = await this.inputGateway.submit({
      runId: this.internalRunId,
      requestId: args.requestId,
      expectedFrameId: args.expectedFrameId,
      capability: args.keyboardCap,
      action: { kind: "keyTap", code: args.code },
    });
    if (receipt.status === "DELIVERED") this.pendingDeliveredRequestId = args.requestId;
    return receipt;
  }

  async activateOption(untrustedArgs) {
    const args = exactArguments("activate_option", untrustedArgs);
    this.#assertAttached();
    requireOpaque(args.objectCap, "objectCap");
    requireOpaque(args.requestId, "requestId");
    requireFrameId(args.expectedFrameId, "expectedFrameId");
    requireOpaque(args.optionRef, "optionRef");
    const receipt = await this.inputGateway.submit({
      runId: this.internalRunId,
      requestId: args.requestId,
      expectedFrameId: args.expectedFrameId,
      capability: args.objectCap,
      action: { kind: "activate", optionRef: args.optionRef },
    });
    if (receipt.status === "DELIVERED") this.pendingDeliveredRequestId = args.requestId;
    return receipt;
  }

  async waitFrame(untrustedArgs) {
    const args = exactArguments("wait_frame", untrustedArgs);
    this.#assertAttached();
    requireOpaque(args.observeCap, "observeCap");
    requireFrameId(args.afterFrameId, "afterFrameId");
    if (!Number.isSafeInteger(args.maxFrames) || args.maxFrames < 1 || args.maxFrames > 120) {
      throw new RunnerError("TOOL_ARGUMENT_INVALID", "maxFrames must be an integer from 1 to 120.");
    }
    this.#authorize(args.observeCap, "observe", true);
    this.stateMachine.assert("READY", "WAITING_OUTCOME_FRAMES");
    if (args.afterFrameId !== this.frames.latestServedFrameId) {
      throw new RunnerError("STALE_OBSERVATION", "afterFrameId is not the latest served frame.", { retry: "DO_NOT_RETRY" });
    }
    const frame = await this.#captureAndServe({ purpose: "wait", afterFrameId: args.afterFrameId, maxFrames: args.maxFrames });
    if (!CHANGE_CLASSES.has(frame.changeClass)) {
      throw new RunnerError("TRUSTED_ADAPTER_INVALID", "capture() returned an invalid visual change class.");
    }
    if (this.pendingDeliveredRequestId) {
      this.inputGateway.settleDelivered({
        requestId: this.pendingDeliveredRequestId,
        afterFrameIds: [frame.frameId],
        changeClass: frame.changeClass,
      });
      this.pendingDeliveredRequestId = undefined;
    }
    return Object.freeze({
      frameId: frame.frameId,
      image: frame.image,
      sha256: frame.sha256,
      changeClass: frame.changeClass,
    });
  }

  bookmarkObservation(untrustedArgs) {
    const args = exactArguments("bookmark_observation", untrustedArgs);
    this.#assertAttached();
    this.stateMachine.assert("READY");
    if (!Array.isArray(args.frameIds) || args.frameIds.length === 0 || args.frameIds.some((id) => typeof id !== "string" || !FRAME_ID.test(id))) {
      throw new RunnerError("TOOL_ARGUMENT_INVALID", "frameIds must contain valid frame references.");
    }
    if (!Array.isArray(args.precedingActionIds) || args.precedingActionIds.some((id) => typeof id !== "string" || !ACTION_ID.test(id))) {
      throw new RunnerError("TOOL_ARGUMENT_INVALID", "precedingActionIds must reference settled public actions.");
    }
    this.#authorize(requireOpaque(args.bookmarkCap, "bookmarkCap"), "bookmark", true);
    if (args.frameIds.some((id) => !this.frames.isServed(id))) {
      throw new RunnerError("TOOL_ARGUMENT_INVALID", "frameIds must reference served frames.");
    }
    const publicActions = this.inputGateway.publicActions();
    const actionIds = new Set(publicActions.map((action) => action.actionId));
    if (args.precedingActionIds.some((id) => !actionIds.has(id))) {
      throw new RunnerError("TOOL_ARGUMENT_INVALID", "precedingActionIds must reference settled public actions.");
    }
    const observationId = `O${String(this.observations.length + 1).padStart(6, "0")}`;
    this.observations.push(Object.freeze({
      frameRefs: [...args.frameIds],
      precedingActionRefs: [...args.precedingActionIds],
    }));
    return Object.freeze({ observationId });
  }

  async requestEnd(untrustedArgs) {
    const args = exactArguments("request_end", untrustedArgs);
    this.#assertAttached();
    if (!END_REASONS.has(args.reason)) throw new RunnerError("TOOL_ARGUMENT_INVALID", "reason is not allowed.");
    this.#authorize(requireOpaque(args.handoffCap, "handoffCap"), "handoff", true);
    this.stateMachine.assert("READY", "PAUSED_FOCUS", "PAUSED_POLICY", "BLOCKED");
    this.stateMachine.transition("ENDING", `agent-end-${args.reason.toLowerCase()}`);
    if (typeof this.adapter.end === "function") {
      await this.adapter.end(Object.freeze({ sessionHandle: this.launchContext.sessionHandle, reason: args.reason }));
    }
    this.endReason = args.reason;
    return Object.freeze({ state: "ENDING" });
  }

  async sealHandoff(untrustedArgs) {
    const args = exactArguments("seal_handoff", untrustedArgs);
    this.#assertAttached();
    this.#authorize(requireOpaque(args.handoffCap, "handoffCap"), "handoff", true);
    this.stateMachine.assert("ENDING");
    this.stateMachine.transition("PUBLIC_SEALING", "public-handoff-build");
    try {
      const sealer = new HandoffSealer({
        internalRunId: this.internalRunId,
        configHandle: this.launchContext.configHandle,
        gameBuildHandle: this.launchContext.gameBuildHandle,
        replayAdapterVersion: this.launchContext.replayAdapterVersion,
        runnerKeyId: this.runnerKeyId,
        signingPrivateKey: this.signingPrivateKey,
        identityPool: this.identityPool,
        receiptChain: this.receiptChain,
        frames: this.frames,
        inputGateway: this.inputGateway,
      });
      this.sealedArtifacts = sealer.seal({
        observations: this.observations,
        status: this.endReason === "COMPLETE" ? "COMPLETE" : "PARTIAL",
        validity: "OFFICIAL",
        framePolicyVersion: this.launchContext.framePolicyVersion ?? "canvas-served/v1",
        inputPolicyVersion: this.launchContext.inputPolicyVersion ?? "keyboard-restricted/v1",
      });
      this.stateMachine.transition("PRIVATE_SEALING", "private-envelope-build");
      if (this.artifactStore) {
        await this.artifactStore.persist({
          publicHandoff: this.sealedArtifacts.publicHandoff,
          publicFiles: this.sealedArtifacts.publicFiles,
          privateJudgeEnvelope: this.sealedArtifacts.privateJudgeEnvelope,
        });
      }
      this.stateMachine.transition("SEALED", "handoff-sealed");
      this.capabilityIssuer.revokeRun(this.internalRunId);
      return Object.freeze({
        publicArtifactDigest: sha256(this.sealedArtifacts.publicHandoff),
        privateEnvelopeDigest: sha256(this.sealedArtifacts.privateJudgeEnvelope),
      });
    } catch (error) {
      this.sealedArtifacts = undefined;
      if (this.stateMachine.canTransition("INVALID")) this.stateMachine.transition("INVALID", "seal-failed");
      throw error;
    }
  }

  async callTool(name, args) {
    if (!TOOL_NAMES.includes(name)) throw new RunnerError("TOOL_UNKNOWN", `Unknown Player Runner tool: ${name}.`);
    const methods = {
      attach_run: () => this.attachRun(args),
      observe: () => this.observe(args),
      tap_key: () => this.tapKey(args),
      activate_option: () => this.activateOption(args),
      wait_frame: () => this.waitFrame(args),
      bookmark_observation: () => this.bookmarkObservation(args),
      request_end: () => this.requestEnd(args),
      seal_handoff: () => this.sealHandoff(args),
    };
    return methods[name]();
  }

  getSealedArtifacts() {
    if (!this.sealedArtifacts) throw new RunnerError("HANDOFF_NOT_SEALED", "No sealed artifacts are available.");
    return this.sealedArtifacts;
  }
}
