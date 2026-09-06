import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import {
  CoordinatorIdentityPool,
  FileArtifactStore,
  FileWalStore,
  PlayerRunnerService,
} from "../../01_player_runner/src/index.mjs";
import { coordinatorRandomId, sha256 } from "../../packages/atlas_protocol/src/index.mjs";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class WikiIntegrationAdapter {
  constructor(expectedTicket) {
    this.expectedTicket = expectedTicket;
    this.captureOrdinal = 0;
  }

  async launch({ launchTicket }) {
    if (launchTicket !== this.expectedTicket) throw new Error("launch ticket rejected");
    return Object.freeze({
      sessionHandle: "wiki-integration-session",
      configHandle: "wiki-integration-private-config",
      gameBuildHandle: "wiki-integration-private-build",
      replayAdapterVersion: "wiki-integration-replay/v1",
      capturePolicyDigest: sha256("wiki-integration-capture/v1"),
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
      rawBytes: Buffer.concat([PNG_SIGNATURE, Buffer.from(`wiki-frame-${this.captureOrdinal}`, "utf8")]),
      interactionTargets: [],
      framePolicyVersion: "canvas-served/v1",
      responseRequestDigest: sha256({ purpose: context.purpose, ordinal: this.captureOrdinal }),
      changeClass: context.purpose === "wait" ? "PERSISTENT_CHANGE" : "UNCERTAIN",
    });
  }

  async dispatch() {
    return Object.freeze({ status: "DELIVERED", sinkReceipt: "wiki-integration-delivered" });
  }

  async end() {}
}

export async function createPlayerRunnerService() {
  const root = process.env.ATLAS_WIKI_INTEGRATION_RUNNER_ROOT;
  const launchTicket = process.env.ATLAS_LAUNCH_TICKET;
  const extendedRun = process.env.ATLAS_WIKI_INTEGRATION_EXTENDED_RUN === "1";
  const identityCapacity = extendedRun ? 1_024 : 128;
  if (!root || !isAbsolute(root) || !launchTicket) throw new Error("integration environment invalid");
  mkdirSync(root, { recursive: true });
  const campaignId = coordinatorRandomId();
  const publicRunId = coordinatorRandomId();
  const internalRunId = coordinatorRandomId();
  const identities = new CoordinatorIdentityPool({
    campaignId,
    publicRunId,
    targetRunId: publicRunId,
    artifactIds: Array.from({ length: identityCapacity }, () => coordinatorRandomId()),
    nonces: Array.from({ length: identityCapacity }, () => coordinatorRandomId()),
  });
  const keys = generateKeyPairSync("ed25519");
  const runnerKeyId = `runner-${publicRunId}`;
  const coordinatorRoot = join(root, "coordinator", publicRunId);
  mkdirSync(coordinatorRoot, { recursive: true });
  writeFileSync(join(coordinatorRoot, "runner-public-key.pem"), keys.publicKey.export({ type: "spki", format: "pem" }), { flag: "wx" });
  writeFileSync(join(coordinatorRoot, "operator.json"), `${JSON.stringify({
    campaignId,
    publicRunId,
    runnerKeyId,
    adapter: "wiki-integration/v1",
  }, null, 2)}\n`, { flag: "wx" });
  return new PlayerRunnerService({
    adapter: new WikiIntegrationAdapter(launchTicket),
    artifactStore: new FileArtifactStore({
      publicRoot: join(root, "runs-public"),
      privateRoot: join(root, "judge-vault"),
    }),
    internalRunId,
    identityPool: identities,
    signingPrivateKey: keys.privateKey,
    runnerKeyId,
    clientBinding: `wiki-integration-${publicRunId}`,
    wal: new FileWalStore(join(coordinatorRoot, "input.wal")),
    allowedKeys: ["Enter"],
    budgets: extendedRun
      ? { observe: 120, keyboard: 60, object: 1, bookmark: 60, handoff: 2 }
      : { observe: 30, keyboard: 20, object: 1, bookmark: 5, handoff: 2 },
    ...(extendedRun ? { capabilityTtlMs: 3_000_000 } : {}),
    explorationTrack: process.env.ATLAS_EXPLORATION_TRACK ?? "EXPLORATION",
  });
}
