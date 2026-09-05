import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  coordinatorRandomId,
  createSignedEnvelope,
  sha256,
  validatePublicPlayHandoff,
  validateSignedEnvelopeShape,
  verifySignedEnvelope,
} from "../../packages/atlas_protocol/src/index.mjs";
import { SyntheticTrustedAdapter } from "../fixtures/synthetic-runner-adapter.mjs";
import {
  CoordinatorIdentityPool,
  FileArtifactStore,
  FileWalStore,
  PlayerRunnerService,
  RunnerError,
  createPlayerRunnerToolDefinitions,
  handleJsonRpcRequest,
  serveStdio,
} from "../src/index.mjs";

const temporaryRoot = mkdtempSync(join(tmpdir(), "atlas-runner-service-"));
let ordinal = 0;

function expectRunnerError(error, code) {
  return error instanceof RunnerError && error.code === code;
}

function identityPool(size = 256, { matchingTarget = true } = {}) {
  const publicRunId = coordinatorRandomId();
  return new CoordinatorIdentityPool({
    campaignId: coordinatorRandomId(),
    publicRunId,
    targetRunId: matchingTarget ? publicRunId : coordinatorRandomId(),
    artifactIds: Array.from({ length: size }, () => coordinatorRandomId()),
    nonces: Array.from({ length: size }, () => coordinatorRandomId()),
  });
}

function createService(options = {}) {
  ordinal += 1;
  const adapter = options.adapter ?? new SyntheticTrustedAdapter(options.adapterOptions);
  const identities = options.identities ?? identityPool();
  const keys = generateKeyPairSync("ed25519");
  const service = new PlayerRunnerService({
    adapter,
    internalRunId: coordinatorRandomId(),
    identityPool: identities,
    signingPrivateKey: keys.privateKey,
    runnerKeyId: `service-key-${ordinal}`,
    clientBinding: `service-client-${ordinal}`,
    wal: new FileWalStore(join(temporaryRoot, `service-${ordinal}`, "input.wal")),
    artifactStore: options.artifactStore,
    allowedKeys: ["Enter", "ArrowUp"],
    budgets: { observe: 30, keyboard: 10, object: 10, bookmark: 10, handoff: 2 },
  });
  return { service, adapter, identities, privateKey: keys.privateKey, publicKey: keys.publicKey };
}

function recursiveFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? recursiveFiles(path) : [path];
  });
}

async function attach(service) {
  return service.callTool("attach_run", { launchTicket: `approved-ticket-${ordinal}` });
}

async function verifyLifecycle() {
  const publicRoot = join(temporaryRoot, "persisted-public");
  const privateRoot = join(temporaryRoot, "persisted-private");
  const artifactStore = new FileArtifactStore({ publicRoot, privateRoot });
  const { service, adapter, privateKey, publicKey } = createService({ artifactStore });
  const attached = await attach(service);
  assert.equal(attached.runId, service.identityPool.publicRunId);
  assert.deepEqual(attached.actionProfile.allowedKeys, ["Enter", "ArrowUp"]);
  assert.equal(adapter.launches.length, 1);

  const first = await service.callTool("observe", { observeCap: attached.observeCap });
  assert.equal(first.frameId, "F000001");
  assert.equal(first.actionState, "READY");
  assert.equal(first.options.length, 1);
  assert.deepEqual(Object.keys(first.options[0]), ["optionRef"]);
  assert.equal(Object.hasOwn(first.options[0], "glyph"), false);
  assert.equal(Object.hasOwn(first.options[0], "x"), false);

  const objectReceipt = await service.callTool("activate_option", {
    objectCap: attached.objectCap,
    requestId: "object-request-1",
    expectedFrameId: first.frameId,
    optionRef: first.options[0].optionRef,
  });
  assert.equal(objectReceipt.status, "DELIVERED");
  assert.deepEqual(adapter.inputSink.calls[0].action.safePoint, { x: 320, y: 180 });
  const objectAfter = await service.callTool("wait_frame", {
    observeCap: attached.observeCap,
    afterFrameId: first.frameId,
    maxFrames: 5,
  });
  assert.equal(objectAfter.changeClass, "PERSISTENT_CHANGE");

  const beforeKey = await service.callTool("observe", { observeCap: attached.observeCap });
  const keyReceipt = await service.callTool("tap_key", {
    keyboardCap: attached.keyboardCap,
    requestId: "keyboard-request-1",
    expectedFrameId: beforeKey.frameId,
    code: "Enter",
  });
  assert.equal(keyReceipt.status, "DELIVERED");
  const keyAfter = await service.callTool("wait_frame", {
    observeCap: attached.observeCap,
    afterFrameId: beforeKey.frameId,
    maxFrames: 5,
  });
  assert.equal(keyAfter.frameId, "F000004");

  const bookmark = service.bookmarkObservation({
    bookmarkCap: attached.bookmarkCap,
    frameIds: [objectAfter.frameId, keyAfter.frameId],
    precedingActionIds: ["A000001", "A000002"],
  });
  assert.equal(bookmark.observationId, "O000001");
  assert.deepEqual(await service.callTool("request_end", { handoffCap: attached.handoffCap, reason: "COMPLETE" }), { state: "ENDING" });
  const sealedDigests = await service.callTool("seal_handoff", { handoffCap: attached.handoffCap });
  assert.match(sealedDigests.publicArtifactDigest, /^[a-f0-9]{64}$/u);
  assert.match(sealedDigests.privateEnvelopeDigest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(sealedDigests).sort(), ["privateEnvelopeDigest", "publicArtifactDigest"]);
  assert.equal(service.stateMachine.state, "SEALED");
  assert.equal(adapter.ends.length, 1);

  const artifacts = service.getSealedArtifacts();
  assert.equal(validatePublicPlayHandoff(artifacts.publicHandoff.payload).valid, true);
  assert.equal(validateSignedEnvelopeShape(artifacts.publicHandoff).valid, true);
  assert.equal(validateSignedEnvelopeShape(artifacts.privateJudgeEnvelope).valid, true);
  assert.equal(artifacts.publicHandoff.header.schemaVersion, "atlas/public-play-handoff/1");
  assert.equal(artifacts.privateJudgeEnvelope.header.schemaVersion, "atlas/private-judge-envelope/1");
  assert.equal(verifySignedEnvelope(artifacts.publicHandoff, publicKey), true);
  assert.equal(verifySignedEnvelope(artifacts.privateJudgeEnvelope, publicKey), true);
  assert.equal(sha256(artifacts.publicHandoff), sealedDigests.publicArtifactDigest);
  assert.equal(sha256(artifacts.privateJudgeEnvelope), sealedDigests.privateEnvelopeDigest);
  assert.equal(artifacts.publicHandoff.header.targetRunId, artifacts.publicHandoff.payload.manifest.runId);
  assert.equal(artifacts.publicHandoff.payload.actions[0].input.kind, "opaqueActivate");
  const publicText = JSON.stringify(artifacts.publicHandoff);
  for (const forbidden of ["safePoint", "dispatchHandle", "optionRef", "keyboardCap", "configHandle", "gameBuildHandle"]) {
    assert.equal(publicText.includes(forbidden), false, `${forbidden} must remain private`);
  }

  const publicDirectory = join(publicRoot, artifacts.publicHandoff.header.artifactId);
  const privateDirectory = join(privateRoot, artifacts.privateJudgeEnvelope.header.artifactId);
  assert.equal(existsSync(join(publicDirectory, "handoff.json")), true);
  assert.equal(existsSync(join(privateDirectory, "private-envelope.json")), true);
  assert.equal(artifacts.publicFiles.size, artifacts.publicHandoff.payload.manifest.files.length);
  for (const file of artifacts.publicHandoff.payload.manifest.files) {
    const diskPath = join(publicDirectory, ...file.relativeName.split("/"));
    assert.equal(existsSync(diskPath), true, `${file.relativeName} must be persisted`);
    const bytes = readFileSync(diskPath);
    assert.equal(bytes.byteLength, file.bytes);
    assert.equal(sha256(bytes), file.sha256);
    assert.deepEqual(bytes, artifacts.publicFiles.get(file.relativeName));
  }
  const allPublicBytes = Buffer.concat(recursiveFiles(publicDirectory).map((path) => readFileSync(path))).toString("utf8");
  for (const forbidden of ["trusted-private-config", "trusted-private-build", "safePoint", "optionRef", "synthetic-private-target"]) {
    assert.equal(allPublicBytes.includes(forbidden), false, `persisted public archive leaked ${forbidden}`);
  }
  const privateBytes = readFileSync(join(privateDirectory, "private-envelope.json"), "utf8");
  assert.equal(privateBytes.includes("trusted-private-config"), true);
  await assert.rejects(
    artifactStore.persist({
      publicHandoff: artifacts.publicHandoff,
      publicFiles: artifacts.publicFiles,
      privateJudgeEnvelope: artifacts.privateJudgeEnvelope,
    }),
    (error) => expectRunnerError(error, "ARTIFACT_ALREADY_EXISTS"),
  );

  const { payloadDigest: _payloadDigest, ...unsignedHeader } = artifacts.publicHandoff.header;
  const wrongSchemaHandoff = createSignedEnvelope({
    ...unsignedHeader,
    schemaVersion: "atlas/signed-envelope/1",
  }, artifacts.publicHandoff.payload, privateKey);
  assert.equal(verifySignedEnvelope(wrongSchemaHandoff, publicKey), true, "wrong schema fixture must still have a valid signature");
  const importStore = new FileArtifactStore({
    publicRoot: join(temporaryRoot, "wrong-schema-public"),
    privateRoot: join(temporaryRoot, "wrong-schema-private"),
  });
  await assert.rejects(
    importStore.persist({
      publicHandoff: wrongSchemaHandoff,
      publicFiles: artifacts.publicFiles,
      privateJudgeEnvelope: artifacts.privateJudgeEnvelope,
    }),
    (error) => expectRunnerError(error, "PUBLIC_HANDOFF_SCHEMA_INVALID"),
  );
}

async function verifyIdentityAndPersistenceFailClosed() {
  const mismatched = identityPool(32, { matchingTarget: false });
  const keys = generateKeyPairSync("ed25519");
  assert.throws(
    () => new PlayerRunnerService({
      adapter: new SyntheticTrustedAdapter(),
      internalRunId: coordinatorRandomId(),
      identityPool: mismatched,
      signingPrivateKey: keys.privateKey,
      runnerKeyId: "mismatched-run-key",
      clientBinding: "mismatched-run-client",
      wal: new FileWalStore(join(temporaryRoot, "mismatched", "input.wal")),
      allowedKeys: ["Enter"],
    }),
    (error) => expectRunnerError(error, "RUN_IDENTITY_MISMATCH"),
  );

  const failingStore = {
    calls: 0,
    async persist() {
      this.calls += 1;
      throw new Error("synthetic persistence failure");
    },
  };
  const { service } = createService({ artifactStore: failingStore });
  const attached = await attach(service);
  await service.observe({ observeCap: attached.observeCap });
  await service.requestEnd({ handoffCap: attached.handoffCap, reason: "COMPLETE" });
  await assert.rejects(service.sealHandoff({ handoffCap: attached.handoffCap }), /synthetic persistence failure/u);
  assert.equal(failingStore.calls, 1);
  assert.equal(service.stateMachine.state, "INVALID");
  assert.throws(() => service.getSealedArtifacts(), (error) => expectRunnerError(error, "HANDOFF_NOT_SEALED"));
}

async function verifyBadArgumentsBeforeAdapter() {
  const { service, adapter } = createService();
  const attached = await attach(service);
  const frame = await service.observe({ observeCap: attached.observeCap });
  const base = {
    keyboardCap: attached.keyboardCap,
    requestId: "bad-args-request",
    expectedFrameId: frame.frameId,
  };
  await assert.rejects(
    service.observe({ observeCap: attached.observeCap, x: 10 }),
    (error) => expectRunnerError(error, "TOOL_ARGUMENT_FORBIDDEN"),
  );
  for (const args of [{ url: "http://localhost" }, { selector: "canvas" }, { DOM: {} }]) {
    await assert.rejects(
      service.callTool("observe", { observeCap: attached.observeCap, ...args }),
      (error) => expectRunnerError(error, "TOOL_ARGUMENT_FORBIDDEN"),
    );
  }
  await assert.rejects(
    service.callTool("tap_key", { ...base, press: "q" }),
    (error) => expectRunnerError(error, "TOOL_ARGUMENT_FORBIDDEN"),
  );
  await assert.rejects(
    service.callTool("tap_key", { ...base, code: "KeyQ" }),
    (error) => expectRunnerError(error, "TOOL_ARGUMENT_INVALID"),
  );
  await assert.rejects(
    service.callTool("tap_key", { ...base, code: "Enter", extra: true }),
    (error) => expectRunnerError(error, "TOOL_ARGUMENT_INVALID"),
  );
  assert.equal(adapter.inputSink.calls.length, 0, "schema failures must not reach the trusted input adapter");
}

async function verifyStaleFrameAndCapability() {
  const { service, adapter } = createService();
  const attached = await attach(service);
  const oldFrame = await service.observe({ observeCap: attached.observeCap });
  const latestFrame = await service.observe({ observeCap: attached.observeCap });
  await assert.rejects(
    service.tapKey({
      keyboardCap: attached.keyboardCap,
      requestId: "stale-request",
      expectedFrameId: oldFrame.frameId,
      code: "Enter",
    }),
    (error) => expectRunnerError(error, "STALE_OBSERVATION"),
  );
  await assert.rejects(
    service.tapKey({
      keyboardCap: attached.bookmarkCap,
      requestId: "wrong-capability-request",
      expectedFrameId: latestFrame.frameId,
      code: "Enter",
    }),
    (error) => expectRunnerError(error, "CAPABILITY_DENIED"),
  );
  assert.equal(adapter.inputSink.calls.length, 0, "stale/capability failures must not dispatch input");
}

function assertNoForbiddenSchemaProperty(definitions) {
  const forbidden = new Set(["x", "y", "url", "selector", "dom", "press", "click", "navigate"]);
  for (const definition of definitions) {
    assert.equal(definition.inputSchema.additionalProperties, false);
    for (const property of Object.keys(definition.inputSchema.properties)) {
      assert.equal(forbidden.has(property.toLowerCase()), false, `${definition.name} exposes forbidden ${property}`);
    }
  }
}

async function verifyJsonRpcTransport() {
  const { service } = createService();
  const initialized = await handleJsonRpcRequest(service, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(initialized.result.serverInfo.name, "atlas-player-runner");
  assert.equal(
    await handleJsonRpcRequest(service, { jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    undefined,
  );
  assert.equal(await handleJsonRpcRequest(service, { jsonrpc: "2.0", method: "notifications/unknown" }), undefined);
  const listed = await handleJsonRpcRequest(service, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.equal(listed.result.tools.length, 8);
  assertNoForbiddenSchemaProperty(listed.result.tools);
  assert.deepEqual(listed.result.tools, createPlayerRunnerToolDefinitions({ allowedKeys: service.allowedKeys }));

  const attachedRpc = await handleJsonRpcRequest(service, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "attach_run", arguments: { launchTicket: "rpc-approved-ticket" } },
  });
  assert.equal(attachedRpc.result.isError, false);
  const observedRpc = await handleJsonRpcRequest(service, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "observe", arguments: { observeCap: attachedRpc.result.structuredContent.observeCap } },
  });
  assert.equal(observedRpc.result.isError, false);
  assert.equal(observedRpc.result.content.some((entry) => entry.type === "image" && entry.mimeType === "image/png"), true);
  assert.deepEqual(Object.keys(observedRpc.result.structuredContent.options[0]), ["optionRef"]);
  const badRpc = await handleJsonRpcRequest(service, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "observe", arguments: { observeCap: attachedRpc.result.structuredContent.observeCap, y: 9 } },
  });
  assert.equal(badRpc.result.isError, true);
  assert.equal(badRpc.result.structuredContent.code, "TOOL_ARGUMENT_FORBIDDEN");
  const ping = await handleJsonRpcRequest(service, { jsonrpc: "2.0", id: 6, method: "ping" });
  assert.deepEqual(ping, { jsonrpc: "2.0", id: 6, result: {} });

  let stdout = "";
  let stderr = "";
  const output = new Writable({ write(chunk, _encoding, callback) { stdout += chunk.toString(); callback(); } });
  const errorOutput = new Writable({ write(chunk, _encoding, callback) { stderr += chunk.toString(); callback(); } });
  const input = Readable.from([
    `${JSON.stringify({ jsonrpc: "2.0", id: 10, method: "initialize", params: {} })}\n`,
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/unknown" })}\n`,
    `${JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/list", params: {} })}\n`,
    `${JSON.stringify({ jsonrpc: "2.0", id: 12, method: "ping" })}\n`,
  ]);
  await serveStdio({ service, input, output, errorOutput });
  const messages = stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.deepEqual(messages.map((message) => message.id), [10, 11, 12]);
  assert.deepEqual(messages[2].result, {});
  assert.equal(stderr, "");

  let parseStdout = "";
  let parseStderr = "";
  const parseOutput = new Writable({ write(chunk, _encoding, callback) { parseStdout += chunk.toString(); callback(); } });
  const parseErrorOutput = new Writable({ write(chunk, _encoding, callback) { parseStderr += chunk.toString(); callback(); } });
  await serveStdio({ service, input: Readable.from(["{not-json\n"]), output: parseOutput, errorOutput: parseErrorOutput });
  const parseResponse = JSON.parse(parseStdout.trim());
  assert.equal(parseResponse.id, null);
  assert.equal(parseResponse.error.code, -32700);
  assert.match(parseStderr, /parse failure/u);
}

try {
  await verifyLifecycle();
  await verifyIdentityAndPersistenceFailClosed();
  await verifyBadArgumentsBeforeAdapter();
  await verifyStaleFrameAndCapability();
  await verifyJsonRpcTransport();
  console.log("Player Runner service verification passed");
  console.log(JSON.stringify({
    lifecycle: "attach-observe-input-wait-bookmark-end-seal",
    publicToolCount: 8,
    observeOptions: "optionRef-only",
    forbiddenRawArguments: "rejected-before-adapter",
    staleFrame: "zero-input",
    wrongCapability: "zero-input",
    stdio: "protocol-json-only",
    mcpHandshake: "initialize-notification-list-ping",
    publicAndPrivateSeal: "verified",
    artifactPersistence: "separate-atomic-no-overwrite",
    persistenceFailure: "invalid-fail-closed",
    explorationRunBinding: "targetRunId-equals-manifest-runId",
    handoffSchemaBinding: "payload-schema-header-required",
  }, null, 2));
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
