import { spawn as nodeSpawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const TOOL_NAMES = Object.freeze([
  'attach_run', 'observe', 'tap_key', 'wait_frame',
  'bookmark_observation', 'request_end', 'seal_handoff',
]);
const TOOL_NAME_SET = new Set(TOOL_NAMES);
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_STDOUT_CAP_BYTES = 32 * 1024 * 1024;
const DEFAULT_STDERR_CAP_BYTES = 1024 * 1024;
const DEFAULT_CLOSE_GRACE_MS = 2_000;
const MAX_REMEMBERED_RESPONSE_IDS = 4_096;

export class PlayerRunnerClientError extends Error {
  constructor(message, { code = 'RUNNER_CLIENT_ERROR', cause, retry = false } = {}) {
    super(message, { cause });
    this.name = 'PlayerRunnerClientError';
    this.code = code;
    this.retry = retry;
  }
}

export class PlayerRunnerToolError extends PlayerRunnerClientError {
  constructor(message, { code = 'RUNNER_TOOL_ERROR', cause, retry = false } = {}) {
    super(message, { code, cause, retry });
    this.name = 'PlayerRunnerToolError';
  }
}

export class MutationOutcomeUnknownError extends PlayerRunnerClientError {
  constructor(message = 'The tap_key outcome is unknown.', { cause, transportCode } = {}) {
    super(message, { code: 'MUTATION_OUTCOME_UNKNOWN', cause, retry: false });
    this.name = 'MutationOutcomeUnknownError';
    this.transportCode = transportCode;
  }
}

export class PlayerRunnerStdioClient {
  #child;
  #nextId = 1;
  #pending = new Map();
  #completedIds = new Set();
  #completedIdQueue = [];
  #stdoutBuffer = '';
  #stdoutBufferBytes = 0;
  #stdoutDecoder = new StringDecoder('utf8');
  #stderrBytes = 0;
  #maxStdoutBytes;
  #maxStderrBytes;
  #requestTimeoutMs;
  #closeGraceMs;
  #readyPromise;
  #closePromise;
  #terminal = false;
  #closing = false;
  #closed = false;

  static async start(options) {
    const client = new PlayerRunnerStdioClient(options);
    try {
      await client.initialize();
      return client;
    } catch (error) {
      try { await client.close(); } catch {}
      throw error;
    }
  }

  constructor({
    executable,
    args = [],
    env = process.env,
    spawnImpl = nodeSpawn,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    maxStdoutBytes = DEFAULT_STDOUT_CAP_BYTES,
    maxStderrBytes = DEFAULT_STDERR_CAP_BYTES,
    closeGraceMs = DEFAULT_CLOSE_GRACE_MS,
  } = {}) {
    if (typeof executable !== 'string' || executable.length === 0) {
      throw new TypeError('executable must be a non-empty string');
    }
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw new TypeError('args must be an array of strings');
    }
    if (env === null || typeof env !== 'object' || Array.isArray(env)) {
      throw new TypeError('env must be an object');
    }
    if (typeof spawnImpl !== 'function') throw new TypeError('spawnImpl must be a function');
    assertPositiveInteger(requestTimeoutMs, 'requestTimeoutMs');
    assertPositiveInteger(maxStdoutBytes, 'maxStdoutBytes');
    assertPositiveInteger(maxStderrBytes, 'maxStderrBytes');
    assertNonNegativeInteger(closeGraceMs, 'closeGraceMs');

    this.#requestTimeoutMs = requestTimeoutMs;
    this.#maxStdoutBytes = maxStdoutBytes;
    this.#maxStderrBytes = maxStderrBytes;
    this.#closeGraceMs = closeGraceMs;
    const fixedArgs = Object.freeze([...args]);
    const fixedEnv = Object.freeze({ ...env });
    this.#child = spawnImpl(executable, fixedArgs, {
      env: fixedEnv,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.#validateChild();
    this.#bindChild();
    this.#readyPromise = this.#performInitialize();
    this.#readyPromise.catch(() => {});
  }

  initialize() { return this.#readyPromise; }

  async callTool(name, arguments_ = {}) {
    if (!TOOL_NAME_SET.has(name)) {
      throw new PlayerRunnerClientError(`Runner method is not allowed: ${String(name)}`, {
        code: 'METHOD_NOT_ALLOWED',
      });
    }
    if (!isRecord(arguments_)) throw new TypeError('tool arguments must be an object');
    await this.#readyPromise;
    const result = await this.#request(
      'tools/call',
      { name, arguments: arguments_ },
      { mutation: name === 'tap_key' },
    );
    return decodeToolResult(result);
  }

  attachRun(arguments_ = {}) { return this.callTool('attach_run', arguments_); }
  observe(arguments_ = {}) { return this.callTool('observe', arguments_); }
  tapKey(arguments_ = {}) { return this.callTool('tap_key', arguments_); }
  waitFrame(arguments_ = {}) { return this.callTool('wait_frame', arguments_); }
  bookmarkObservation(arguments_ = {}) { return this.callTool('bookmark_observation', arguments_); }
  requestEnd(arguments_ = {}) { return this.callTool('request_end', arguments_); }
  sealHandoff(arguments_ = {}) { return this.callTool('seal_handoff', arguments_); }

  close() {
    if (!this.#closePromise) this.#closePromise = this.#closeTransport();
    return this.#closePromise;
  }

  async #closeTransport() {
    if (this.#closed) return;
    this.#closing = true;
    this.#rejectPending(new PlayerRunnerClientError('Runner client was closed.', {
      code: 'CLIENT_CLOSED',
    }));

    if (!this.#terminal) {
      const exited = waitForProcessTermination(this.#child, this.#closeGraceMs);
      try { this.#child.stdin.end(); } catch {}
      if (!await exited && !this.#terminal && typeof this.#child.kill === 'function') {
        this.#terminal = true;
        try { this.#child.kill(); } catch {}
      }
    } else {
      try { this.#child.stdin.end(); } catch {}
    }
    this.#closed = true;
    this.#closing = false;
  }

  async #performInitialize() {
    const result = await this.#request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'vision-agent-host', version: '1.0.0' },
    });
    if (
      !isRecord(result)
      || result.protocolVersion !== '2025-06-18'
      || !isRecord(result.capabilities)
      || !isRecord(result.capabilities.tools)
      || !isRecord(result.serverInfo)
      || result.serverInfo.name !== 'atlas-player-runner'
    ) {
      const error = new PlayerRunnerClientError('Invalid initialize result.', {
        code: 'INVALID_INITIALIZE_RESULT',
      });
      this.#failTransport(error);
      throw error;
    }
    this.#writeMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  #request(method, params, { mutation = false } = {}) {
    if (this.#closed || this.#closing || this.#terminal) {
      const error = new PlayerRunnerClientError('Runner transport is not available.', {
        code: 'TRANSPORT_CLOSED',
      });
      return Promise.reject(mutation ? mutationUnknown(error) : error);
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        this.#rememberCompletedId(id);
        const timeoutError = new PlayerRunnerClientError(
          `Runner request timed out after ${this.#requestTimeoutMs} ms.`,
          { code: 'REQUEST_TIMEOUT' },
        );
        pending.reject(pending.mutation ? mutationUnknown(timeoutError) : timeoutError);
      }, this.#requestTimeoutMs);
      this.#pending.set(id, { resolve, reject, timer, mutation });
      try {
        this.#writeMessage({ jsonrpc: '2.0', id, method, params });
      } catch (cause) {
        clearTimeout(timer);
        this.#pending.delete(id);
        const error = cause instanceof PlayerRunnerClientError
          ? cause
          : new PlayerRunnerClientError('Failed to write to runner stdin.', {
            code: 'TRANSPORT_WRITE_FAILED', cause,
          });
        reject(mutation ? mutationUnknown(error) : error);
      }
    });
  }

  #writeMessage(message) {
    if (this.#closed || this.#closing || this.#terminal) {
      throw new PlayerRunnerClientError('Runner transport is not available.', {
        code: 'TRANSPORT_CLOSED',
      });
    }
    this.#child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8', (error) => {
      if (error) {
        this.#failTransport(new PlayerRunnerClientError('Runner stdin write failed.', {
          code: 'TRANSPORT_WRITE_FAILED', cause: error,
        }));
      }
    });
  }

  #validateChild() {
    if (!this.#child || typeof this.#child.on !== 'function') {
      throw new TypeError('spawnImpl must return a child-process-like object');
    }
    for (const streamName of ['stdin', 'stdout', 'stderr']) {
      if (!this.#child[streamName] || typeof this.#child[streamName].on !== 'function') {
        throw new TypeError(`spawned child must expose ${streamName}`);
      }
    }
    if (typeof this.#child.stdin.write !== 'function') {
      throw new TypeError('spawned child stdin must be writable');
    }
  }

  #bindChild() {
    this.#child.stdout.on('data', (chunk) => this.#onStdout(chunk));
    this.#child.stderr.on('data', (chunk) => this.#onStderr(chunk));
    this.#child.stdout.on('error', (cause) => this.#streamFailed('stdout', cause));
    this.#child.stderr.on('error', (cause) => this.#streamFailed('stderr', cause));
    this.#child.stdin.on('error', (cause) => this.#streamFailed('stdin', cause));
    this.#child.on('error', (cause) => this.#failTransport(
      new PlayerRunnerClientError('Runner process failed.', { code: 'PROCESS_ERROR', cause }),
    ));
    this.#child.on('exit', (code, signal) => this.#onExit(code, signal));
    this.#child.on('close', (code, signal) => this.#onExit(code, signal));
  }

  #onStdout(chunk) {
    if (this.#terminal) return;
    this.#stdoutBuffer += Buffer.isBuffer(chunk)
      ? this.#stdoutDecoder.write(chunk)
      : String(chunk);
    while (!this.#terminal) {
      const newline = this.#stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.#stdoutBuffer.slice(0, newline).replace(/\r$/, '');
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line) > this.#maxStdoutBytes) {
        this.#stdoutCapExceeded();
        return;
      }
      if (line.length === 0) {
        this.#protocolFailure('Runner emitted an empty JSON-RPC line.', 'MALFORMED_JSON_RPC');
        return;
      }
      this.#handleLine(line);
    }
    this.#stdoutBufferBytes = Buffer.byteLength(this.#stdoutBuffer);
    if (!this.#terminal && this.#stdoutBufferBytes > this.#maxStdoutBytes) {
      this.#stdoutCapExceeded();
    }
  }

  #stdoutCapExceeded() {
    this.#failTransport(new PlayerRunnerClientError('Runner stdout line byte cap exceeded.', {
      code: 'STDOUT_CAP_EXCEEDED',
    }));
  }

  #onStderr(chunk) {
    if (this.#terminal) return;
    this.#stderrBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    if (this.#stderrBytes > this.#maxStderrBytes) {
      this.#failTransport(new PlayerRunnerClientError('Runner stderr byte cap exceeded.', {
        code: 'STDERR_CAP_EXCEEDED',
      }));
    }
  }

  #handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch (cause) {
      this.#failTransport(new PlayerRunnerClientError('Runner emitted malformed JSON.', {
        code: 'MALFORMED_JSON_RPC', cause,
      }));
      return;
    }
    if (!isRecord(message) || message.jsonrpc !== '2.0' || !Number.isSafeInteger(message.id)) {
      this.#protocolFailure('Runner emitted an invalid JSON-RPC response.', 'MALFORMED_JSON_RPC');
      return;
    }
    const hasResult = Object.hasOwn(message, 'result');
    const hasError = Object.hasOwn(message, 'error');
    if (hasResult === hasError) {
      this.#protocolFailure('Runner response must contain exactly one of result or error.', 'MALFORMED_JSON_RPC');
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) {
      const duplicate = this.#completedIds.has(message.id);
      this.#protocolFailure(
        duplicate ? 'Runner emitted a duplicate response id.' : 'Runner emitted an unknown response id.',
        duplicate ? 'DUPLICATE_RESPONSE_ID' : 'UNKNOWN_RESPONSE_ID',
      );
      return;
    }
    clearTimeout(pending.timer);
    this.#pending.delete(message.id);
    this.#rememberCompletedId(message.id);
    if (hasError) {
      const rpcError = isRecord(message.error) ? message.error : {};
      pending.reject(new PlayerRunnerClientError(
        typeof rpcError.message === 'string' ? rpcError.message : 'Runner returned a JSON-RPC error.',
        { code: 'JSON_RPC_ERROR' },
      ));
      return;
    }
    pending.resolve(message.result);
  }

  #rememberCompletedId(id) {
    this.#completedIds.add(id);
    this.#completedIdQueue.push(id);
    if (this.#completedIdQueue.length > MAX_REMEMBERED_RESPONSE_IDS) {
      this.#completedIds.delete(this.#completedIdQueue.shift());
    }
  }

  #streamFailed(streamName, cause) {
    this.#failTransport(new PlayerRunnerClientError(`Runner ${streamName} stream failed.`, {
      code: 'TRANSPORT_STREAM_ERROR', cause,
    }));
  }

  #protocolFailure(message, code) {
    this.#failTransport(new PlayerRunnerClientError(message, { code }));
  }

  #onExit(code, signal) {
    if (this.#terminal) return;
    const suffix = signal ? ` (signal ${signal})` : ` (code ${String(code)})`;
    this.#failTransport(new PlayerRunnerClientError(`Runner process exited${suffix}.`, {
      code: 'PROCESS_EXITED',
    }));
  }

  #failTransport(error) {
    if (this.#terminal) return;
    this.#terminal = true;
    this.#rejectPending(error);
    if (!this.#closing && typeof this.#child.kill === 'function') {
      try { this.#child.kill(); } catch {}
    }
  }

  #rejectPending(error) {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#rememberCompletedId(id);
      pending.reject(pending.mutation ? mutationUnknown(error) : error);
    }
    this.#pending.clear();
  }
}

export const PLAYER_RUNNER_TOOL_NAMES = TOOL_NAMES;

function decodeToolResult(result) {
  if (!isRecord(result) || !Array.isArray(result.content) || !isRecord(result.structuredContent)) {
    throw new PlayerRunnerClientError('Runner returned an invalid tool result.', {
      code: 'INVALID_TOOL_RESULT',
    });
  }
  if (result.isError === true) {
    const details = result.structuredContent;
    throw new PlayerRunnerToolError(
      'Runner tool call failed.',
      {
        code: coarseToolCode(details.code),
        retry: details.retry === true,
      },
    );
  }
  const pngItems = result.content.filter(
    (item) => isRecord(item) && item.type === 'image' && item.mimeType === 'image/png',
  );
  if (pngItems.length > 1) {
    throw new PlayerRunnerClientError('Runner returned more than one PNG image.', {
      code: 'INVALID_TOOL_RESULT',
    });
  }
  const decoded = { ...result.structuredContent };
  if (pngItems.length === 1) {
    const data = pngItems[0].data;
    if (typeof data !== 'string' || !isCanonicalBase64(data)) {
      throw new PlayerRunnerClientError('Runner returned invalid PNG base64 data.', {
        code: 'INVALID_IMAGE_DATA',
      });
    }
    decoded.image = Buffer.from(data, 'base64');
  }
  return decoded;
}

function mutationUnknown(cause) {
  return new MutationOutcomeUnknownError(undefined, { cause, transportCode: cause?.code });
}

function coarseToolCode(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)
    ? value
    : 'RUNNER_TOOL_ERROR';
}

function isCanonicalBase64(value) {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return false;
  }
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
}

function waitForProcessTermination(child, graceMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof child.removeListener === 'function') {
        child.removeListener('exit', onExit);
        child.removeListener('close', onExit);
      }
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), graceMs);
    child.once('exit', onExit);
    child.once('close', onExit);
  });
}
