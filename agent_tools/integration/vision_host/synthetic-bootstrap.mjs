import { generateKeyPairSync } from "node:crypto";
import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import {
  CoordinatorIdentityPool,
  FileArtifactStore,
  FileWalStore,
  PlayerRunnerService,
} from "../../01_player_runner/src/index.mjs";
import {
  coordinatorRandomId,
  sha256,
} from "../../packages/atlas_protocol/src/index.mjs";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class IntegrationAdapter {
  constructor(expectedTicket) {
    this.expectedTicket = expectedTicket;
    this.captureOrdinal = 0;
  }

  async launch({ launchTicket }) {
    if (launchTicket !== this.expectedTicket) throw new Error("Launch ticket was rejected.");
    return Object.freeze({
      sessionHandle: "integration-session",
      configHandle: "integration-private-config",
      gameBuildHandle: "integration-private-build",
      replayAdapterVersion: "integration-replay/v1",
      capturePolicyDigest: sha256("integration-capture/v1"),
      overlayCompositorVersion: "none/v1",
      framePolicyVersion: "canvas-served/v1",
      inputPolicyVersion: "keyboard-restricted/v1",
      width: 1,
      height: 1,
    });
  }

  async capture(context) {
    this.captureOrdinal += 1;
    return Object.freeze({
      rawBytes: Buffer.concat([PNG_SIGNATURE, Buffer.from(`integration-frame-${this.captureOrdinal}`, "utf8")]),
      interactionTargets: [],
      framePolicyVersion: "canvas-served/v1",
      responseRequestDigest: sha256({ purpose: context.purpose, ordinal: this.captureOrdinal }),
      changeClass: context.purpose === "wait" ? "PERSISTENT_CHANGE" : "UNCERTAIN",
    });
  }

  async dispatch() {
    return Object.freeze({ status: "DELIVERED", sinkReceipt: "integration-delivered" });
  }

  async end() {}
}

export async function createPlayerRunnerService() {
  const root = process.env.ATLAS_INTEGRATION_ROOT;
  const launchTicket = process.env.ATLAS_LAUNCH_TICKET;
  if (!root || !isAbsolute(root) || !launchTicket) throw new Error("Integration bootstrap environment is invalid.");
  mkdirSync(root, { recursive: true });

  const campaignId = coordinatorRandomId();
  const publicRunId = coordinatorRandomId();
  const identities = new CoordinatorIdentityPool({
    campaignId,
    publicRunId,
    targetRunId: publicRunId,
    artifactIds: Array.from({ length: 128 }, () => coordinatorRandomId()),
    nonces: Array.from({ length: 128 }, () => coordinatorRandomId()),
  });
  const keys = generateKeyPairSync("ed25519");
  return new PlayerRunnerService({
    adapter: new IntegrationAdapter(launchTicket),
    artifactStore: new FileArtifactStore({
      publicRoot: join(root, "runs-public"),
      privateRoot: join(root, "judge-vault"),
    }),
    internalRunId: coordinatorRandomId(),
    identityPool: identities,
    signingPrivateKey: keys.privateKey,
    runnerKeyId: "vision-integration-key",
    clientBinding: "vision-integration-client",
    wal: new FileWalStore(join(root, "input.wal")),
    allowedKeys: ["Enter"],
    budgets: { observe: 10, keyboard: 5, object: 1, bookmark: 5, handoff: 2 },
  });
}
