import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { coordinatorRandomId, sha256 } from "../../packages/atlas_protocol/src/index.mjs";
import {
  CoordinatorIdentityPool,
  FileArtifactStore,
  FileWalStore,
  PlayerRunnerService,
} from "../../01_player_runner/src/index.mjs";
import { QuestAtlasBrowserAdapter } from "./browser-adapter.mjs";

function stateRoot() {
  const configured = process.env.ATLAS_RUNNER_STATE_DIR;
  if (configured && !isAbsolute(configured)) throw new Error("ATLAS_RUNNER_STATE_DIR must be absolute.");
  return resolve(configured ?? fileURLToPath(new URL("../../.local", import.meta.url)));
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export async function createPlayerRunnerService() {
  // Coordinator identities are deliberately allocated before the private target
  // URL/config is read or assigned.
  const campaignId = coordinatorRandomId();
  const publicRunId = coordinatorRandomId();
  const internalRunId = coordinatorRandomId();
  const identityPool = new CoordinatorIdentityPool({
    campaignId,
    publicRunId,
    targetRunId: publicRunId,
    artifactIds: Array.from({ length: 1024 }, () => coordinatorRandomId()),
    nonces: Array.from({ length: 1024 }, () => coordinatorRandomId()),
  });

  const launchTicket = requiredEnvironment("ATLAS_LAUNCH_TICKET");
  const debugBaseUrl = requiredEnvironment("ATLAS_CDP_URL");
  const expectedTargetUrl = requiredEnvironment("ATLAS_GAME_URL");
  const root = stateRoot();
  const runRoot = join(root, "coordinator", publicRunId);
  mkdirSync(dirname(runRoot), { recursive: true });
  mkdirSync(runRoot, { recursive: false });
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" });
  writeFileSync(join(runRoot, "runner-public-key.pem"), publicKeyPem, { flag: "wx" });
  writeFileSync(join(runRoot, "operator.json"), `${JSON.stringify({
    campaignId,
    publicRunId,
    runnerKeyId: `runner-${publicRunId}`,
  }, null, 2)}\n`, { flag: "wx" });

  let ticketConsumed = false;
  const adapter = new QuestAtlasBrowserAdapter({
    ticketBroker: {
      async redeem(candidate) {
        if (ticketConsumed || candidate !== launchTicket) throw new Error("Launch ticket is invalid or consumed.");
        ticketConsumed = true;
        return Object.freeze({
          debugBaseUrl,
          expectedTargetUrl,
          sessionHandle: coordinatorRandomId(),
          configHandle: coordinatorRandomId(),
          gameBuildHandle: "quest-atlas-local-v1",
          capturePolicyDigest: sha256("quest-atlas-canvas-1280x720/v1"),
        });
      },
    },
  });
  const artifactStore = new FileArtifactStore({
    publicRoot: join(root, "runs-public"),
    privateRoot: join(root, "judge-vault"),
  });
  return new PlayerRunnerService({
    adapter,
    artifactStore,
    internalRunId,
    identityPool,
    signingPrivateKey: keys.privateKey,
    runnerKeyId: `runner-${publicRunId}`,
    clientBinding: `stdio-${publicRunId}`,
    wal: new FileWalStore(join(runRoot, "input.wal")),
    allowedKeys: [
      "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", "Tab",
      "KeyB", "KeyF", "KeyC", "KeyE", "KeyR", "KeyN",
    ],
  });
}
