import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  MutationOutcomeUnknownError,
  PLAYER_RUNNER_TOOL_NAMES,
  PlayerRunnerStdioClient,
  PlayerRunnerToolError,
} from '../src/runner/index.mjs';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class FakeChild extends EventEmitter {
  constructor(onMessage) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.messages = [];
    this.killCount = 0;
    let input = '';
    this.stdin.on('data', (chunk) => {
      input += chunk.toString('utf8');
      for (;;) {
        const newline = input.indexOf('\n');
        if (newline < 0) break;
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        const message = JSON.parse(line);
        this.messages.push(message);
        queueMicrotask(() => onMessage?.(message, this));
      }
    });
  }

  respond(id, result) {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  kill() {
    this.killCount += 1;
    queueMicrotask(() => {
      this.emit('exit', null, 'SIGTERM');
      this.emit('close', null, 'SIGTERM');
    });
    return true;
  }
}

function successResult(structuredContent = {}) {
  return { content: [{ type: 'text', text: 'ok' }], structuredContent, isError: false };
}

function makeSpawn(handler, capture = {}) {
  return (executable, args, options) => {
    Object.assign(capture, { executable, args, options });
    const child = new FakeChild(handler);
    capture.child = child;
    return child;
  };
}

async function started(handler, options = {}, capture = {}) {
  return PlayerRunnerStdioClient.start({
    executable: 'fixed-runner',
    args: ['fixed-entry.mjs'],
    env: { FIXED_ENV: 'yes' },
    spawnImpl: makeSpawn((message, child) => {
      if (message.method === 'initialize') {
        child.respond(message.id, {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'atlas-player-runner', version: '1' },
        });
        return;
      }
      if (message.method === 'notifications/initialized') return;
      handler?.(message, child);
    }, capture),
    requestTimeoutMs: 40,
    closeGraceMs: 5,
    ...options,
  });
}

async function testInitializeWrappersAndImage() {
  const capture = {};
  const client = await started((message, child) => {
    const toolName = message.params.name;
    const result = toolName === 'observe'
      ? {
        content: [
          { type: 'text', text: '{"ignored":"text transport copy"}' },
          { type: 'image', mimeType: 'image/png', data: PNG_BYTES.toString('base64') },
        ],
        structuredContent: { frameId: 7 },
        isError: false,
      }
      : successResult({ called: toolName });
    child.respond(message.id, result);
  }, {}, capture);

  assert.equal(capture.executable, 'fixed-runner');
  assert.deepEqual(capture.args, ['fixed-entry.mjs']);
  assert.deepEqual(capture.options.env, { FIXED_ENV: 'yes' });
  assert.equal(capture.options.shell, false);
  assert.deepEqual(capture.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(capture.child.messages[0].method, 'initialize');
  assert.equal(capture.child.messages[1].method, 'notifications/initialized');

  const calls = [
    ['attach_run', () => client.attachRun({ runId: 'r' })],
    ['observe', () => client.observe({})],
    ['tap_key', () => client.tapKey({ key: 'A' })],
    ['wait_frame', () => client.waitFrame({ after: 7 })],
    ['bookmark_observation', () => client.bookmarkObservation({ frameId: 7 })],
    ['request_end', () => client.requestEnd({ reason: 'done' })],
    ['seal_handoff', () => client.sealHandoff({})],
  ];
  for (const [name, invoke] of calls) {
    const value = await invoke();
    if (name === 'observe') {
      assert.equal(value.frameId, 7);
      assert(Buffer.isBuffer(value.image));
      assert.deepEqual(value.image, PNG_BYTES);
    } else {
      assert.equal(value.called, name);
    }
  }
  assert.deepEqual(
    capture.child.messages.filter((message) => message.method === 'tools/call')
      .map((message) => message.params.name),
    PLAYER_RUNNER_TOOL_NAMES,
  );
  assert.equal(typeof client.activateOption, 'undefined');
  await client.close();
}

async function testUnknownMethodRejectedBeforeWrite() {
  const capture = {};
  const client = await started(undefined, {}, capture);
  const writesBefore = capture.child.messages.length;
  await assert.rejects(client.callTool('activate_option', {}), { code: 'METHOD_NOT_ALLOWED' });
  assert.equal(capture.child.messages.length, writesBefore);
  await client.close();
}

async function testInitializeMismatchFailsClosed() {
  const capture = {};
  const startPromise = PlayerRunnerStdioClient.start({
    executable: 'fixed-runner',
    args: ['fixed-entry.mjs'],
    env: { FIXED_ENV: 'yes' },
    spawnImpl: makeSpawn((message, child) => {
      if (message.method === 'initialize') {
        child.respond(message.id, {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'wrong-runner', version: '1' },
        });
      }
    }, capture),
    requestTimeoutMs: 40,
  });
  await assert.rejects(startPromise, { code: 'INVALID_INITIALIZE_RESULT' });
  assert.equal(capture.child.killCount, 1);
  assert.equal(
    capture.child.messages.some((message) => message.method === 'notifications/initialized'),
    false,
  );
}

async function testInitializeTimeoutClosesChild() {
  const capture = {};
  const startPromise = PlayerRunnerStdioClient.start({
    executable: 'fixed-runner',
    args: ['fixed-entry.mjs'],
    env: { FIXED_ENV: 'yes' },
    spawnImpl: makeSpawn(() => {}, capture),
    requestTimeoutMs: 10,
    closeGraceMs: 5,
  });
  await assert.rejects(startPromise, { code: 'REQUEST_TIMEOUT' });
  assert.equal(capture.child.stdin.writableEnded, true);
  assert.equal(capture.child.killCount, 1);
  assert.equal(capture.child.messages.filter((message) => message.method === 'initialize').length, 1);
  assert.equal(
    capture.child.messages.some((message) => message.method === 'notifications/initialized'),
    false,
  );
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(capture.child.killCount, 1, 'no pending request may trigger later cleanup');
}

async function testErrorResult() {
  const canary = 'SECRET_ERROR_CANARY_7391';
  const client = await started((message, child) => {
    child.respond(message.id, {
      content: [{ type: 'text', text: `bad key ${canary}` }],
      structuredContent: { code: 'BAD_KEY', retry: false },
      isError: true,
    });
  });
  await assert.rejects(client.tapKey({ key: 'nope' }), (error) => {
    assert(error instanceof PlayerRunnerToolError);
    assert.equal(error.code, 'BAD_KEY');
    assert.equal(error.retry, false);
    assert.equal(error.message, 'Runner tool call failed.');
    assert(!error.message.includes(canary));
    assert(!JSON.stringify(error).includes(canary));
    return true;
  });
  await client.close();
}

async function testMalformedLine() {
  const client = await started((_message, child) => child.stdout.write('{bad json}\n'));
  await assert.rejects(client.observe({}), { code: 'MALFORMED_JSON_RPC' });
  await client.close();
}

async function testResponseIdsAndOutputCaps() {
  const unknownClient = await started((_message, child) => child.respond(999, successResult()));
  await assert.rejects(unknownClient.observe({}), { code: 'UNKNOWN_RESPONSE_ID' });
  await unknownClient.close();

  const duplicateClient = await started((_message, child) => child.respond(1, successResult()));
  await assert.rejects(duplicateClient.observe({}), { code: 'DUPLICATE_RESPONSE_ID' });
  await duplicateClient.close();

  const repeatedImage = Buffer.alloc(192, 0x5a);
  const cumulativeClient = await started((message, child) => {
    child.respond(message.id, {
      content: [{
        type: 'image',
        mimeType: 'image/png',
        data: repeatedImage.toString('base64'),
      }],
      structuredContent: { frame: message.id },
      isError: false,
    });
  }, { maxStdoutBytes: 512 });
  assert.deepEqual((await cumulativeClient.observe({})).image, repeatedImage);
  assert.deepEqual((await cumulativeClient.observe({})).image, repeatedImage);
  await cumulativeClient.close();

  const stdoutClient = await started((_message, child) => {
    child.stdout.write('x'.repeat(600));
  }, { maxStdoutBytes: 512 });
  await assert.rejects(stdoutClient.observe({}), { code: 'STDOUT_CAP_EXCEEDED' });
  await stdoutClient.close();

  const stderrClient = await started((_message, child) => {
    child.stderr.write('x'.repeat(33));
  }, { maxStderrBytes: 32 });
  await assert.rejects(stderrClient.observe({}), { code: 'STDERR_CAP_EXCEEDED' });
  await stderrClient.close();
}

async function testMutationTimeoutAndExit() {
  const timeoutCapture = {};
  const timeoutClient = await started(() => {}, {}, timeoutCapture);
  await assert.rejects(timeoutClient.tapKey({ key: 'A' }), (error) => {
    assert(error instanceof MutationOutcomeUnknownError);
    assert.equal(error.code, 'MUTATION_OUTCOME_UNKNOWN');
    assert.equal(error.transportCode, 'REQUEST_TIMEOUT');
    return true;
  });
  assert.equal(
    timeoutCapture.child.messages.filter((message) => message.params?.name === 'tap_key').length,
    1,
    'tap_key must never be automatically resent',
  );
  await assert.rejects(timeoutClient.observe({}), { code: 'REQUEST_TIMEOUT' });
  await timeoutClient.close();

  const exitClient = await started((_message, child) => child.emit('exit', 9, null));
  await assert.rejects(exitClient.tapKey({ key: 'B' }), (error) => {
    assert.equal(error.code, 'MUTATION_OUTCOME_UNKNOWN');
    assert.equal(error.transportCode, 'PROCESS_EXITED');
    return true;
  });
  await exitClient.close();
}

async function testCloseGraceAndPendingMutation() {
  const gracefulCapture = {};
  const gracefulClient = await started(() => {}, {}, gracefulCapture);
  gracefulCapture.child.stdin.once('finish', () => {
    gracefulCapture.child.emit('exit', 0, null);
    gracefulCapture.child.emit('close', 0, null);
  });
  await gracefulClient.close();
  assert.equal(gracefulCapture.child.killCount, 0);

  const capture = {};
  const client = await started(() => {}, {}, capture);
  const pendingTap = client.tapKey({ key: 'C' });
  await new Promise((resolve) => setImmediate(resolve));
  const pendingRejection = assert.rejects(pendingTap, { code: 'MUTATION_OUTCOME_UNKNOWN' });
  await client.close();
  await pendingRejection;
  assert.equal(capture.child.killCount, 1);
  await client.close();
}

await testInitializeWrappersAndImage();
await testUnknownMethodRejectedBeforeWrite();
await testInitializeMismatchFailsClosed();
await testInitializeTimeoutClosesChild();
await testErrorResult();
await testMalformedLine();
await testResponseIdsAndOutputCaps();
await testMutationTimeoutAndExit();
await testCloseGraceAndPendingMutation();

console.log('verify-runner-client: ok');
