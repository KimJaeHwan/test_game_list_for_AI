import {
  DEFAULT_CAMPAIGN_PROFILE,
  canonicalize,
  sha256,
} from "../../packages/atlas_protocol/src/index.mjs";
import { RunnerError } from "./errors.mjs";

const CHANGE_CLASSES = new Set(["UNCHANGED", "TRANSIENT_ONLY", "PERSISTENT_CHANGE", "UNCERTAIN"]);
const INPUT_RECEIPT_GENESIS = sha256("SIGNED_INPUT_RECEIPT_GENESIS");

function actionId(ordinal) {
  return `A${String(ordinal).padStart(6, "0")}`;
}

function publicInput(action) {
  if (action.kind === "keyTap") return Object.freeze({ kind: "keyTap", code: action.code });
  return Object.freeze({ kind: "opaqueActivate" });
}

function createReceipt({ requestId, canonicalRequestDigest, status, actionOrdinal, retry, privateReceiptDigest }) {
  const base = { requestId, canonicalRequestDigest, status, actionOrdinal, retry, privateReceiptDigest };
  return Object.freeze({ ...base, receiptDigest: sha256(base) });
}

export class InputGateway {
  constructor({
    campaignId,
    runId,
    publicRunId,
    clientBinding,
    capabilityIssuer,
    wal,
    sink,
    frames,
    optionResolver,
    receiptChain,
    stateMachine,
    allowedKeys = DEFAULT_CAMPAIGN_PROFILE.allowedKeys,
  }) {
    if (!campaignId || !runId || !publicRunId) throw new TypeError("campaignId, runId, and publicRunId are required.");
    this.campaignId = campaignId;
    this.runId = runId;
    this.publicRunId = publicRunId;
    this.clientBinding = clientBinding;
    this.capabilityIssuer = capabilityIssuer;
    this.wal = wal;
    this.sink = sink;
    this.frames = frames;
    this.optionResolver = optionResolver;
    this.receiptChain = receiptChain;
    this.stateMachine = stateMachine;
    this.allowedKeys = new Set(allowedKeys);
  }

  #requestPayload(request) {
    return {
      runId: request.runId,
      requestId: request.requestId,
      expectedFrameId: request.expectedFrameId,
      action: request.action,
    };
  }

  #existingReceipt(requestId, canonicalRequestDigest) {
    const state = this.wal.requestState(requestId);
    if (!state) return undefined;
    if (state.reservation?.payload.canonicalRequestDigest !== canonicalRequestDigest) {
      throw new RunnerError("REQUEST_PAYLOAD_MISMATCH", "A requestId cannot be reused with a different payload.");
    }
    return state.terminal?.payload.receipt;
  }

  #nextOrdinal() {
    return this.wal.history().filter((record) => record.kind === "INPUT_RESERVED").length + 1;
  }

  #previousInputReceiptDigest() {
    const terminal = this.wal.history().findLast((record) => record.kind === "INPUT_TERMINAL");
    return terminal?.payload.receipt.privateReceiptDigest ?? INPUT_RECEIPT_GENESIS;
  }

  #appendOutcome({ reservation, receipt, afterFrameIds, changeClass }) {
    const afterFrameReceiptDigests = afterFrameIds.map((frameId) => this.frames.getFrameReceiptDigest(frameId));
    const signedOutcomeEvent = this.receiptChain.append("SignedInputOutcomeSettledEvent", Object.freeze({
      eventType: "INPUT_OUTCOME_SETTLED",
      campaignId: this.campaignId,
      internalRunId: this.runId,
      publicRunId: this.publicRunId,
      requestId: reservation.requestId,
      actionId: reservation.actionId,
      canonicalRequestDigest: reservation.canonicalRequestDigest,
      inputReceiptDigest: receipt.privateReceiptDigest,
      beforeFrameReceiptDigest: reservation.beforeFrameReceiptDigest,
      afterFrameReceiptDigests,
      changeClass,
    }));
    const outcome = {
      requestId: reservation.requestId,
      actionId: reservation.actionId,
      afterFrameRefs: [...afterFrameIds],
      changeClass,
      privateOutcomeReceiptDigest: sha256(signedOutcomeEvent),
    };
    this.wal.append("INPUT_OUTCOME", outcome);
    return outcome;
  }

  async submit(request) {
    if (!request || request.runId !== this.runId || typeof request.requestId !== "string") {
      throw new RunnerError("INPUT_REQUEST_INVALID", "Input request is not bound to this run.");
    }
    const requestPayload = this.#requestPayload(request);
    const canonicalRequestDigest = sha256(canonicalize(requestPayload));
    const existing = this.#existingReceipt(request.requestId, canonicalRequestDigest);
    if (existing) return structuredClone(existing);
    if (this.wal.requestState(request.requestId)?.reservation) {
      throw new RunnerError("INPUT_DELIVERY_UNKNOWN", "The request was reserved but has no terminal receipt.", { retry: "DO_NOT_RETRY" });
    }

    this.stateMachine.assert("READY");
    if (request.expectedFrameId !== this.frames.latestServedFrameId) {
      throw new RunnerError("STALE_OBSERVATION", "expectedFrameId is not the latest served frame.", { retry: "DO_NOT_RETRY" });
    }

    const isKeyboard = request.action?.kind === "keyTap";
    const isObject = request.action?.kind === "activate";
    if (!isKeyboard && !isObject) throw new RunnerError("INPUT_REQUEST_INVALID", "Action kind is not supported.");
    if (isKeyboard && !this.allowedKeys.has(request.action.code)) {
      throw new RunnerError("INPUT_REQUEST_INVALID", "Key is not allowed by this input profile.");
    }

    this.capabilityIssuer.authorize({
      token: request.capability,
      runId: this.runId,
      clientBinding: this.clientBinding,
      scope: isKeyboard ? "keyboard" : "object",
      consume: false,
    });

    let privateDispatch = request.action;
    let optionSetDigest = null;
    let selectedOptionDigest = null;
    if (isObject) {
      const resolved = this.optionResolver.reserve({
        optionRef: request.action.optionRef,
        expectedFrameId: request.expectedFrameId,
      });
      privateDispatch = {
        kind: "safePointActivate",
        safePoint: resolved.safePoint,
        dispatchHandle: resolved.dispatchHandle,
      };
      optionSetDigest = resolved.optionSetDigest;
      selectedOptionDigest = resolved.selectedOptionDigest;
    }

    const authorization = this.capabilityIssuer.authorize({
      token: request.capability,
      runId: this.runId,
      clientBinding: this.clientBinding,
      scope: isKeyboard ? "keyboard" : "object",
      consume: true,
    });

    const ordinal = this.#nextOrdinal();
    const id = actionId(ordinal);
    const reservation = {
      requestId: request.requestId,
      canonicalRequestDigest,
      expectedFrameId: request.expectedFrameId,
      beforeFrameReceiptDigest: this.frames.getFrameReceiptDigest(request.expectedFrameId),
      previousInputReceiptDigest: this.#previousInputReceiptDigest(),
      actionId: id,
      actionOrdinal: ordinal,
      publicInput: publicInput(request.action),
      capabilityId: authorization.capabilityId,
      optionSetDigest,
      selectedOptionDigest,
    };
    this.wal.append("INPUT_RESERVED", reservation);
    this.stateMachine.transition("ACTION_RESERVED", "input-reserved-durable");
    this.stateMachine.transition("INPUT_DISPATCHING", "input-dispatch-started");

    let dispatchResult;
    try {
      dispatchResult = await this.sink.dispatch(structuredClone(privateDispatch), {
        requestId: request.requestId,
        actionId: id,
        expectedFrameId: request.expectedFrameId,
      });
    } catch (error) {
      if (error?.simulatedProcessCrash === true) throw error;
      dispatchResult = { status: "DELIVERY_UNKNOWN", sinkReceipt: String(error?.code ?? "sink-error") };
    }

    if (!["DELIVERED", "NOT_DELIVERED", "DELIVERY_UNKNOWN"].includes(dispatchResult?.status)) {
      dispatchResult = { status: "DELIVERY_UNKNOWN", sinkReceipt: "invalid-sink-response" };
    }
    const dispatchReceiptDigest = sha256({
      status: dispatchResult.status,
      sinkReceipt: dispatchResult.sinkReceipt ?? null,
      requestId: request.requestId,
      actionId: id,
    });
    const signedInputEvent = this.receiptChain.append("SignedInputReceipt", Object.freeze({
      eventType: "INPUT_TERMINAL",
      campaignId: this.campaignId,
      internalRunId: this.runId,
      publicRunId: this.publicRunId,
      requestId: request.requestId,
      canonicalRequestDigest,
      actionId: id,
      actionOrdinal: ordinal,
      expectedFrameId: request.expectedFrameId,
      beforeFrameReceiptDigest: reservation.beforeFrameReceiptDigest,
      previousInputReceiptDigest: reservation.previousInputReceiptDigest,
      capabilityId: authorization.capabilityId,
      optionSetDigest,
      selectedOptionDigest,
      dispatchReceiptDigest,
      status: dispatchResult.status,
    }));
    const retry = dispatchResult.status === "NOT_DELIVERED" ? "NEW_REQUEST_REQUIRED" : "DO_NOT_RETRY";
    const receipt = createReceipt({
      requestId: request.requestId,
      canonicalRequestDigest,
      status: dispatchResult.status,
      actionOrdinal: ordinal,
      retry,
      privateReceiptDigest: sha256(signedInputEvent),
    });
    this.wal.append("INPUT_TERMINAL", { requestId: request.requestId, receipt });

    if (dispatchResult.status === "DELIVERED") {
      this.stateMachine.transition("WAITING_OUTCOME_FRAMES", "input-delivered");
    } else if (dispatchResult.status === "NOT_DELIVERED") {
      this.#appendOutcome({ reservation, receipt, afterFrameIds: [], changeClass: "UNCHANGED" });
      this.stateMachine.transition("READY", "input-not-delivered");
    } else {
      this.#appendOutcome({ reservation, receipt, afterFrameIds: [], changeClass: "UNCERTAIN" });
      this.stateMachine.transition("BLOCKED", "input-delivery-unknown");
    }
    return structuredClone(receipt);
  }

  settleDelivered({ requestId, afterFrameIds, changeClass }) {
    const state = this.wal.requestState(requestId);
    const receipt = state?.terminal?.payload.receipt;
    if (!state?.reservation || receipt?.status !== "DELIVERED") {
      throw new RunnerError("INPUT_NOT_SETTLEABLE", "Only a delivered input can receive outcome frames.");
    }
    if (!Array.isArray(afterFrameIds) || afterFrameIds.some((frameId) => !this.frames.isServed(frameId))) {
      throw new RunnerError("FRAME_NOT_SERVED", "Outcome references must be served frames.");
    }
    if (!CHANGE_CLASSES.has(changeClass)) throw new RunnerError("CHANGE_CLASS_INVALID", "Unknown change class.");
    const previousOutcome = this.wal.history().find((record) => record.kind === "INPUT_OUTCOME" && record.payload.requestId === requestId);
    if (previousOutcome) return structuredClone(previousOutcome.payload);

    const outcome = this.#appendOutcome({
      reservation: state.reservation.payload,
      receipt,
      afterFrameIds,
      changeClass,
    });
    for (const frameId of afterFrameIds) this.frames.linkAction(frameId, outcome.actionId);
    this.stateMachine.assert("WAITING_OUTCOME_FRAMES");
    this.stateMachine.transition("READY", "outcome-frames-recorded");
    return structuredClone(outcome);
  }

  recoverInDoubt() {
    const recovered = [];
    for (const state of this.wal.inDoubtReservations()) {
      const reservation = state.reservation.payload;
      const signedInputEvent = this.receiptChain.append("SignedInputReceipt", Object.freeze({
        eventType: "INPUT_RECOVERED_UNKNOWN",
        campaignId: this.campaignId,
        internalRunId: this.runId,
        publicRunId: this.publicRunId,
        requestId: reservation.requestId,
        canonicalRequestDigest: reservation.canonicalRequestDigest,
        actionId: reservation.actionId,
        actionOrdinal: reservation.actionOrdinal,
        expectedFrameId: reservation.expectedFrameId,
        beforeFrameReceiptDigest: reservation.beforeFrameReceiptDigest,
        previousInputReceiptDigest: reservation.previousInputReceiptDigest,
        optionSetDigest: reservation.optionSetDigest,
        selectedOptionDigest: reservation.selectedOptionDigest,
        status: "DELIVERY_UNKNOWN",
        walRootBeforeRecovery: this.wal.rootDigest,
      }));
      const receipt = createReceipt({
        requestId: reservation.requestId,
        canonicalRequestDigest: reservation.canonicalRequestDigest,
        status: "DELIVERY_UNKNOWN",
        actionOrdinal: reservation.actionOrdinal,
        retry: "DO_NOT_RETRY",
        privateReceiptDigest: sha256(signedInputEvent),
      });
      this.wal.append("INPUT_TERMINAL", { requestId: reservation.requestId, receipt });
      this.#appendOutcome({ reservation, receipt, afterFrameIds: [], changeClass: "UNCERTAIN" });
      recovered.push(receipt);
    }
    if (recovered.length && this.stateMachine.state === "READY") {
      this.stateMachine.transition("BLOCKED", "wal-in-doubt-input");
    }
    return recovered.map((receipt) => structuredClone(receipt));
  }

  publicActions() {
    const records = this.wal.history();
    const reservations = records.filter((record) => record.kind === "INPUT_RESERVED");
    return reservations.map((record) => {
      const terminal = records.find((candidate) => candidate.kind === "INPUT_TERMINAL" && candidate.payload.requestId === record.payload.requestId);
      const outcome = records.find((candidate) => candidate.kind === "INPUT_OUTCOME" && candidate.payload.requestId === record.payload.requestId);
      if (!terminal || !outcome) throw new RunnerError("ACTION_UNSETTLED", "Every public action needs a terminal receipt and outcome classification.");
      return Object.freeze({
        actionId: record.payload.actionId,
        ordinal: record.payload.actionOrdinal,
        input: structuredClone(record.payload.publicInput),
        delivery: terminal.payload.receipt.status,
        beforeFrameRef: record.payload.expectedFrameId,
        afterFrameRefs: [...outcome.payload.afterFrameRefs],
        changeClass: outcome.payload.changeClass,
      });
    });
  }
}
