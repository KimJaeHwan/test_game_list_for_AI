import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_CAMPAIGN_PROFILE } from "../../packages/atlas_protocol/src/index.mjs";
import { RunnerError } from "./errors.mjs";

const opaque = { type: "string", minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9_.:-]+$" };
const frameId = { type: "string", pattern: "^F[0-9]{6}$" };
const actionId = { type: "string", pattern: "^A[0-9]{6}$" };

function objectSchema(properties, required = Object.keys(properties)) {
  return { type: "object", properties, required, additionalProperties: false };
}

export function createPlayerRunnerToolDefinitions({ allowedKeys = DEFAULT_CAMPAIGN_PROFILE.allowedKeys } = {}) {
  return [
    { name: "attach_run", description: "Attach one Coordinator-approved local run.", inputSchema: objectSchema({ launchTicket: opaque }) },
    { name: "observe", description: "Serve a current game frame and opaque options.", inputSchema: objectSchema({ observeCap: opaque }) },
    {
      name: "tap_key",
      description: "Tap one key from the fixed game profile.",
      inputSchema: objectSchema({ keyboardCap: opaque, requestId: opaque, expectedFrameId: frameId, code: { type: "string", enum: [...allowedKeys] } }),
    },
    {
      name: "activate_option",
      description: "Activate one frame-bound opaque option.",
      inputSchema: objectSchema({ objectCap: opaque, requestId: opaque, expectedFrameId: frameId, optionRef: opaque }),
    },
    {
      name: "wait_frame",
      description: "Wait for and serve a later frame.",
      inputSchema: objectSchema({ observeCap: opaque, afterFrameId: frameId, maxFrames: { type: "integer", minimum: 1, maximum: 120 } }),
    },
    {
      name: "bookmark_observation",
      description: "Bookmark already served evidence using public references only.",
      inputSchema: objectSchema({
        bookmarkCap: opaque,
        frameIds: { type: "array", minItems: 1, items: frameId },
        precedingActionIds: { type: "array", items: actionId },
      }),
    },
    {
      name: "request_end",
      description: "Request the end of the attached run.",
      inputSchema: objectSchema({ handoffCap: opaque, reason: { type: "string", enum: ["COMPLETE", "PARTIAL", "ABORT"] } }),
    },
    { name: "seal_handoff", description: "Seal public and private artifacts after ending.", inputSchema: objectSchema({ handoffCap: opaque }) },
  ];
}

function exactObject(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message, data) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
}

function toolResult(value) {
  const result = value && typeof value === "object" ? { ...value } : { value };
  const image = result.image;
  delete result.image;
  const content = [];
  if (image instanceof Uint8Array) {
    content.push({ type: "image", data: Buffer.from(image).toString("base64"), mimeType: "image/png" });
  }
  content.push({ type: "text", text: JSON.stringify(result) });
  return { content, structuredContent: result, isError: false };
}

function toolFailure(error) {
  const safe = error instanceof RunnerError
    ? { code: error.code, retry: error.retry }
    : { code: "INTERNAL_ERROR", retry: "DO_NOT_RETRY" };
  return { content: [{ type: "text", text: JSON.stringify(safe) }], structuredContent: safe, isError: true };
}

export async function handleJsonRpcRequest(service, request) {
  const hasId = Boolean(request && typeof request === "object" && Object.hasOwn(request, "id"));
  if (!request || typeof request !== "object" || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return hasId ? jsonRpcError(request.id, -32600, "Invalid Request") : undefined;
  }
  if (!hasId) {
    // JSON-RPC notifications, including notifications/initialized, never receive a response.
    return undefined;
  }
  if (request.method === "initialize") {
    return jsonRpcResult(request.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "atlas-player-runner", version: "0.2.0" },
    });
  }
  if (request.method === "tools/list") {
    if (request.params !== undefined && !exactObject(request.params, [])) return jsonRpcError(request.id, -32602, "Invalid params");
    return jsonRpcResult(request.id, { tools: createPlayerRunnerToolDefinitions({ allowedKeys: service.allowedKeys }) });
  }
  if (request.method === "ping") return jsonRpcResult(request.id, {});
  if (request.method === "tools/call") {
    if (!exactObject(request.params, ["name", "arguments"]) || typeof request.params.name !== "string") {
      return jsonRpcError(request.id, -32602, "Invalid params");
    }
    try {
      return jsonRpcResult(request.id, toolResult(await service.callTool(request.params.name, request.params.arguments)));
    } catch (error) {
      return jsonRpcResult(request.id, toolFailure(error));
    }
  }
  return jsonRpcError(request.id, -32601, "Method not found");
}

export async function serveStdio({ service, input = process.stdin, output = process.stdout, errorOutput = process.stderr }) {
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch (error) {
      errorOutput.write(`atlas-player-runner parse failure: ${error?.name ?? "Error"}\n`);
      output.write(`${JSON.stringify(jsonRpcError(null, -32700, "Parse error"))}\n`);
      continue;
    }
    let response;
    try {
      response = await handleJsonRpcRequest(service, request);
    } catch (error) {
      errorOutput.write(`atlas-player-runner request failure: ${error?.name ?? "Error"}\n`);
      response = Object.hasOwn(request, "id") ? jsonRpcError(request.id, -32603, "Internal error") : undefined;
    }
    if (response !== undefined) output.write(`${JSON.stringify(response)}\n`);
  }
}

async function main() {
  const bootstrapPath = process.env.ATLAS_RUNNER_BOOTSTRAP;
  if (!bootstrapPath) throw new Error("ATLAS_RUNNER_BOOTSTRAP must name a trusted ESM bootstrap module.");
  const bootstrap = await import(pathToFileURL(resolve(bootstrapPath)).href);
  if (typeof bootstrap.createPlayerRunnerService !== "function") {
    throw new Error("Trusted bootstrap must export createPlayerRunnerService().");
  }
  const service = await bootstrap.createPlayerRunnerService();
  await serveStdio({ service });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`atlas-player-runner startup failed: ${error?.message ?? "unknown error"}\n`);
    process.exitCode = 1;
  });
}
