import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { coordinatorRandomId } from "../../packages/atlas_protocol/src/index.mjs";
import {
  CoordinatorIdentityPool,
  FileArtifactStore,
  FileWalStore,
  PlayerRunnerService,
} from "../../01_player_runner/src/index.mjs";
import {
  DESKTOP_ALLOWED_KEYS,
  DesktopWindowAdapter,
  NativeDesktopBridgeClient,
  SafeInputBroker,
  TargetBindingBroker,
} from "../src/index.mjs";
import { CaptureBroker } from "../src/capture/index.mjs";
import { createLegacyBridgeInputProvider } from "../src/input/index.mjs";
import {
  createLegacyBridgeCaptureProvider,
  createProviderLifecycle,
} from "../src/provider-contract.mjs";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function stateRoot() {
  const configured = process.env.ATLAS_RUNNER_STATE_DIR;
  if (configured && !isAbsolute(configured)) throw new Error("ATLAS_RUNNER_STATE_DIR must be absolute.");
  return resolve(configured ?? fileURLToPath(new URL("../../.local", import.meta.url)));
}

function parseRegion(value) {
  if (!value) return undefined;
  const values = value.split(",").map((part) => Number(part.trim()));
  if (values.length !== 4 || values.some((part) => !Number.isSafeInteger(part))) {
    throw new Error("ATLAS_CAPTURE_REGION must be x,y,width,height using integers.");
  }
  return Object.freeze({ x: values[0], y: values[1], width: values[2], height: values[3] });
}

function parseAllowedKeys(value) {
  if (!value) return [...DESKTOP_ALLOWED_KEYS];
  const requested = [...new Set(value.split(",").map((part) => part.trim()).filter(Boolean))];
  if (requested.length === 0 || requested.some((code) => !DESKTOP_ALLOWED_KEYS.includes(code))) {
    throw new Error("ATLAS_ALLOWED_KEYS contains a key outside the fixed desktop profile.");
  }
  return requested;
}

export async function createPlayerRunnerService() {
  // Coordinator identities exist before the operator-selected private target is read.
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

  const externalLaunchTicket = requiredEnvironment("ATLAS_LAUNCH_TICKET");
  const hwnd = requiredEnvironment("ATLAS_TARGET_HWND");
  const region = parseRegion(process.env.ATLAS_CAPTURE_REGION);
  const allowedKeys = parseAllowedKeys(process.env.ATLAS_ALLOWED_KEYS);
  const root = stateRoot();
  const runRoot = join(root, "coordinator", publicRunId);
  mkdirSync(dirname(runRoot), { recursive: true });
  mkdirSync(runRoot, { recursive: false });

  const bridge = new NativeDesktopBridgeClient().start();
  try {
  const targetBroker = new TargetBindingBroker({ bridge, idFactory: coordinatorRandomId });
  const binding = await targetBroker.bind(region ? { hwnd, region } : { hwnd });
  const internalTicket = await targetBroker.issueLaunchTicket({ bindingRef: binding.bindingRef, ttlMs: 5 * 60_000 });
  const captureProvider = createLegacyBridgeCaptureProvider({
    bridge,
    providerId: "gdi-composited-screen/v1",
  });
  const inputProvider = createLegacyBridgeInputProvider(bridge);
  const captureBroker = new CaptureBroker({ targetBroker, captureProvider });
  const inputBroker = new SafeInputBroker({ inputProvider, targetBroker });
  const providerLifecycle = createProviderLifecycle([bridge]);
  let externalTicketConsumed = false;
  const adapterBroker = Object.freeze({
    async redeem(candidate) {
      if (externalTicketConsumed || candidate !== externalLaunchTicket) {
        throw new Error("Launch ticket is invalid or consumed.");
      }
      externalTicketConsumed = true;
      return targetBroker.redeem(internalTicket.launchTicket);
    },
    withPrivateBinding(targetRef, callback) {
      return targetBroker.withPrivateBinding(targetRef, callback);
    },
  });
  const adapter = new DesktopWindowAdapter({
    targetBroker: adapterBroker,
    captureBroker,
    inputBroker,
    providerLifecycle,
    idFactory: coordinatorRandomId,
  });

  const keys = generateKeyPairSync("ed25519");
  const runnerKeyId = `runner-${publicRunId}`;
  writeFileSync(join(runRoot, "runner-public-key.pem"), keys.publicKey.export({ type: "spki", format: "pem" }), { flag: "wx" });
  writeFileSync(join(runRoot, "operator.json"), `${JSON.stringify({
    campaignId,
    publicRunId,
    runnerKeyId,
    adapter: "desktop-window-native/v1",
  }, null, 2)}\n`, { flag: "wx" });

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
    runnerKeyId,
    clientBinding: `stdio-${publicRunId}`,
    wal: new FileWalStore(join(runRoot, "input.wal")),
    allowedKeys,
  });
  } catch (error) {
    try {
      await bridge.close();
    } catch {
      // Preserve the construction failure while still making one close attempt.
    }
    throw error;
  }
}
