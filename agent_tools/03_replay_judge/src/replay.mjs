import { canonicalize, sha256 } from "../../packages/atlas_protocol/src/index.mjs";
import { ARTIFACT, artifactDigest, issueArtifact } from "./attestation.mjs";
import { validateActionTranscript } from "./chains.mjs";
import { exactKeys, invariant } from "./errors.mjs";
import { validateReplayAuthorization, validateSignedCohortPlan } from "./plans.mjs";
import { evaluateProbeRecord, validateProbeResults, validateSignedProbeSet } from "./probes.mjs";

export class SyntheticRoomTokenEngine {
  #state;

  constructor(config = {}) {
    this.#state = {
      room: config.initialRoom ?? "Room A",
      inventory: [],
      complete: false,
      steps: 0,
    };
  }

  apply(action) {
    invariant(action?.kind === "keyTap", "ENGINE_ACTION_REJECTED", "synthetic engine accepts keyTap only");
    this.#state.steps += 1;
    if (action.code === "ArrowRight" && this.#state.room === "Room A") this.#state.room = "Room B";
    if (action.code === "ArrowLeft" && this.#state.room === "Room B") this.#state.room = "Room A";
    if (action.code === "Space" && this.#state.room === "Room B" && !this.#state.inventory.includes("Token B")) {
      this.#state.inventory.push("Token B");
      this.#state.inventory.sort();
    }
    if (action.code === "Enter" && this.#state.room === "Room B" && this.#state.inventory.includes("Token B")) {
      this.#state.complete = true;
    }
  }

  snapshot() {
    return structuredClone(this.#state);
  }
}

export class FreshStateEngineReplayPort {
  #verifier;
  #registry;
  #plans = new Map();
  #usedAuthorizations = new Set();
  #engineFactory;
  #engineSigner;
  #judgeSigner;
  #probeExecutor;
  #composeOverlay;

  constructor({ verifier, registry, engineFactory = (config) => new SyntheticRoomTokenEngine(config), engineSigner, judgeSigner, probeExecutor = evaluateProbeRecord, composeOverlay = undefined }) {
    this.#verifier = verifier;
    this.#registry = registry;
    this.#engineFactory = engineFactory;
    this.#engineSigner = engineSigner;
    this.#judgeSigner = judgeSigner;
    this.#probeExecutor = probeExecutor;
    this.#composeOverlay = composeOverlay;
  }

  registerPlan(planEnvelope) {
    const verified = validateSignedCohortPlan(planEnvelope, this.#verifier);
    this.#plans.set(verified.digest, planEnvelope);
    return verified.digest;
  }

  execute({ authorization, transcript }) {
    const planEnvelope = this.#plans.get(authorization?.payload?.cohortPlanDigest);
    invariant(planEnvelope, "AUTHORIZATION_PLAN_UNKNOWN", "authorization references an unregistered plan");
    const authorizationVerified = validateReplayAuthorization({ authorization, planEnvelope, verifier: this.#verifier });
    invariant(!this.#usedAuthorizations.has(authorizationVerified.digest), "AUTHORIZATION_CONSUMED", "replay authorization is one-time");
    this.#usedAuthorizations.add(authorizationVerified.digest);

    const transcriptVerified = validateActionTranscript({
      authorization,
      transcript,
      verifier: this.#verifier,
      composeOverlay: this.#composeOverlay,
    });
    const auth = authorization.payload;
    const config = this.#registry.resolve(auth.targetConfigCapability, {
      kind: "target-config",
      campaignId: authorization.header.campaignId,
      audience: "ENGINE",
    });
    const probeRecord = this.#registry.resolve(auth.probeSetCapability, {
      kind: "probe-set",
      campaignId: authorization.header.campaignId,
      audience: "ENGINE",
    });
    const probeVerified = validateSignedProbeSet(probeRecord.envelope, this.#verifier, authorization.header.campaignId);
    invariant(probeVerified.digest === probeRecord.digest, "PROBE_SET_BINDING_MISMATCH", "registry probe record digest mismatch");
    invariant(probeRecord.digest === auth.probeSetDigest, "PROBE_SET_BINDING_MISMATCH", "authorization probe digest mismatch");

    const first = this.#runOnce({ authorization, transcript, actions: transcriptVerified.inputChain.deliveredActions, config, probeRecord });
    const second = this.#runOnce({ authorization, transcript, actions: transcriptVerified.inputChain.deliveredActions, config, probeRecord });
    const firstVerified = this.#verifyEngineOutcome(first, authorizationVerified.digest, transcriptVerified.verified.digest, authorization);
    const secondVerified = this.#verifyEngineOutcome(second, authorizationVerified.digest, transcriptVerified.verified.digest, authorization);
    invariant(canonicalize(first.payload) === canonicalize(second.payload), "INVALID_ENGINE_RUN", "fresh replay payloads are nondeterministic");

    const verifiedReplay = issueArtifact({
      artifactType: ARTIFACT.VERIFIED_REPLAY,
      schemaVersion: "atlas/verified-replay/1",
      campaignId: authorization.header.campaignId,
      track: auth.track,
      arm: auth.arm,
      targetRunId: auth.targetRunId,
      issuer: this.#judgeSigner.issuer,
      keyId: this.#judgeSigner.keyId,
      parentDigests: [authorizationVerified.digest, transcriptVerified.verified.digest, firstVerified.digest, secondVerified.digest],
      contractDigest: authorization.header.contractDigest,
      payload: {
        schemaVersion: "atlas/verified-replay/1",
        cohortPlanDigest: auth.cohortPlanDigest,
        authorizationDigest: authorizationVerified.digest,
        transcriptDigest: transcriptVerified.verified.digest,
        evaluationClass: auth.evaluationClass,
        track: auth.track,
        arm: auth.arm,
        targetRunId: auth.targetRunId,
        repetitionOrdinal: auth.repetitionOrdinal,
        outcomePayloadDigest: sha256(first.payload),
        completion: first.payload.completion,
      },
      privateKey: this.#judgeSigner.privateKey,
    });
    this.#verifier.verify(verifiedReplay, {
      artifactType: ARTIFACT.VERIFIED_REPLAY,
      campaignId: authorization.header.campaignId,
      track: auth.track,
      arm: auth.arm,
      targetRunId: auth.targetRunId,
      contractDigest: authorization.header.contractDigest,
      parentDigests: [authorizationVerified.digest, transcriptVerified.verified.digest, firstVerified.digest, secondVerified.digest],
    });
    return Object.freeze({ first, second, verifiedReplay });
  }

  #runOnce({ authorization, transcript, actions, config, probeRecord }) {
    const engine = this.#engineFactory(structuredClone(config));
    invariant(engine && typeof engine.apply === "function" && typeof engine.snapshot === "function", "ENGINE_ADAPTER_INVALID", "engine adapter is invalid");
    for (const action of actions) engine.apply(structuredClone(action));
    const finalState = engine.snapshot();
    const probeResults = this.#probeExecutor(probeRecord, structuredClone(finalState));
    const scoring = validateProbeResults(probeRecord.envelope, probeResults);
    const authorizationDigest = artifactDigest(authorization);
    const transcriptDigest = artifactDigest(transcript);
    const payload = {
      schemaVersion: "atlas/engine-outcome/1",
      authorizationDigest,
      transcriptDigest,
      finalState,
      finalStateHash: sha256(finalState),
      probeSetDigest: probeRecord.digest,
      probeResults,
      earned: scoring.earned,
      denominator: scoring.denominator,
      completion: scoring.completion,
    };
    return issueArtifact({
      artifactType: ARTIFACT.ENGINE_OUTCOME,
      schemaVersion: "atlas/engine-outcome/1",
      campaignId: authorization.header.campaignId,
      track: authorization.header.track,
      arm: authorization.header.arm,
      targetRunId: authorization.header.targetRunId,
      issuer: this.#engineSigner.issuer,
      keyId: this.#engineSigner.keyId,
      parentDigests: [authorizationDigest, transcriptDigest],
      contractDigest: authorization.header.contractDigest,
      payload,
      privateKey: this.#engineSigner.privateKey,
    });
  }

  #verifyEngineOutcome(outcome, authorizationDigest, transcriptDigest, authorization) {
    exactKeys(outcome.payload, ["schemaVersion", "authorizationDigest", "transcriptDigest", "finalState", "finalStateHash", "probeSetDigest", "probeResults", "earned", "denominator", "completion"], "ENGINE_OUTCOME_INVALID", "engineOutcome.payload");
    const verified = this.#verifier.verify(outcome, {
      artifactType: ARTIFACT.ENGINE_OUTCOME,
      campaignId: authorization.header.campaignId,
      track: authorization.header.track,
      arm: authorization.header.arm,
      targetRunId: authorization.header.targetRunId,
      contractDigest: authorization.header.contractDigest,
      parentDigests: [authorizationDigest, transcriptDigest],
    });
    invariant(outcome.payload.schemaVersion === "atlas/engine-outcome/1", "ENGINE_OUTCOME_INVALID", "unsupported engine outcome schema");
    invariant(outcome.payload.authorizationDigest === authorizationDigest && outcome.payload.transcriptDigest === transcriptDigest, "ENGINE_OUTCOME_INVALID", "engine outcome parent payload mismatch");
    invariant(outcome.payload.finalStateHash === sha256(outcome.payload.finalState), "ENGINE_OUTCOME_INVALID", "engine state hash mismatch");
    return verified;
  }
}
