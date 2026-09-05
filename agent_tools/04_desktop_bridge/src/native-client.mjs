import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exactRecord, validateRegion, validateTargetIdentity } from "./contract.mjs";

const DEFAULT_EXECUTABLE = fileURLToPath(new URL(
  "../native/bin/Release/net9.0-windows/desktop-bridge-native.exe",
  import.meta.url,
));
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function opaqueError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateResponse(response) {
  if (!response || typeof response !== "object" || Array.isArray(response) || typeof response.id !== "string"
    || typeof response.ok !== "boolean") throw opaqueError("BRIDGE_PROTOCOL_ERROR", "Native bridge returned an invalid response.");
  if (response.ok) exactRecord(response, ["id", "ok", "result"], "bridge response");
  else {
    exactRecord(response, ["id", "ok", "error"], "bridge response");
    exactRecord(response.error, ["code", "message"], "bridge error");
  }
  return response;
}

export class NativeDesktopBridgeClient {
  #child;
  #lines;
  #pending = new Map();
  #nextId = 1;
  #closed = false;

  constructor({ executablePath = process.env.ATLAS_DESKTOP_BRIDGE_EXE ?? DEFAULT_EXECUTABLE, spawnImpl = spawn } = {}) {
    if (typeof executablePath !== "string" || !isAbsolute(executablePath)) {
      throw new TypeError("Desktop bridge executable path must be absolute.");
    }
    if (typeof spawnImpl !== "function") throw new TypeError("spawnImpl must be a function.");
    this.executablePath = resolve(executablePath);
    this.spawnImpl = spawnImpl;
  }

  start() {
    if (this.#child) return this;
    if (this.#closed) throw opaqueError("BRIDGE_CLOSED", "Native bridge client is closed.");
    const child = this.spawnImpl(this.executablePath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    this.#lines = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false });
    void this.#readResponses();
    child.once("error", () => this.#failAll(opaqueError("BRIDGE_START_FAILED", "Native bridge could not start.")));
    child.once("exit", (code) => this.#failAll(opaqueError(
      "BRIDGE_EXITED",
      `Native bridge exited before completing requests (${Number.isInteger(code) ? code : "unknown"}).`,
    )));
    child.stderr.on("data", () => {});
    return this;
  }

  async #readResponses() {
    try {
      for await (const line of this.#lines) {
        if (!line.trim()) continue;
        let response;
        try { response = validateResponse(JSON.parse(line)); }
        catch {
          this.#failAll(opaqueError("BRIDGE_PROTOCOL_ERROR", "Native bridge emitted malformed protocol output."));
          continue;
        }
        const pending = this.#pending.get(response.id);
        if (!pending) continue;
        this.#pending.delete(response.id);
        clearTimeout(pending.timeout);
        if (response.ok) pending.resolve(response.result);
        else pending.reject(opaqueError(String(response.error.code), "Native desktop operation was refused."));
      }
    } catch {
      this.#failAll(opaqueError("BRIDGE_PROTOCOL_ERROR", "Native bridge response stream failed."));
    }
  }

  #failAll(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  request(op, fields = {}) {
    this.start();
    if (!/^(?:listWindows|inspect|capture|tapKey|safeClick)$/u.test(op)) {
      return Promise.reject(opaqueError("BRIDGE_OPERATION_FORBIDDEN", "Native bridge operation is not allowed."));
    }
    const id = `N${String(this.#nextId++).padStart(8, "0")}`;
    const request = { id, op, ...fields };
    return new Promise((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        rejectRequest(opaqueError("BRIDGE_TIMEOUT", "Native desktop operation timed out."));
      }, 10_000);
      this.#pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timeout });
      this.#child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.#pending.delete(id);
        rejectRequest(opaqueError("BRIDGE_WRITE_FAILED", "Native bridge request could not be written."));
      });
    });
  }

  async listWindows() {
    const result = await this.request("listWindows");
    if (!Array.isArray(result)) throw opaqueError("BRIDGE_PROTOCOL_ERROR", "Window listing was invalid.");
    return result;
  }

  async inspect(hwnd) {
    if (typeof hwnd !== "string" || !/^[1-9][0-9]{0,19}$/u.test(hwnd)) throw new TypeError("hwnd is invalid.");
    return validateTargetIdentity(await this.request("inspect", { hwnd }));
  }

  async capture({ binding, region }) {
    const targetIdentity = validateTargetIdentity(binding, "binding");
    const pinnedRegion = validateRegion(region, { width: targetIdentity.clientWidth, height: targetIdentity.clientHeight });
    const result = await this.request("capture", { binding: targetIdentity, region: pinnedRegion });
    exactRecord(result, ["pngBase64", "width", "height", "captureBackend"], "capture result");
    if (result.width !== pinnedRegion.width || result.height !== pinnedRegion.height
      || typeof result.pngBase64 !== "string" || typeof result.captureBackend !== "string") {
      throw opaqueError("BRIDGE_PROTOCOL_ERROR", "Capture result did not match the pinned region.");
    }
    const rawBytes = Buffer.from(result.pngBase64, "base64");
    if (rawBytes.length < PNG_SIGNATURE.length || !rawBytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw opaqueError("BRIDGE_PROTOCOL_ERROR", "Capture result was not a PNG image.");
    }
    return Object.freeze({ rawBytes, width: result.width, height: result.height, captureBackend: result.captureBackend });
  }

  tapKey({ binding, code }) {
    return this.request("tapKey", { binding: validateTargetIdentity(binding, "binding"), code });
  }

  safeClick({ binding, region, point }) {
    const targetIdentity = validateTargetIdentity(binding, "binding");
    const pinnedRegion = validateRegion(region, { width: targetIdentity.clientWidth, height: targetIdentity.clientHeight });
    exactRecord(point, ["x", "y"], "point");
    return this.request("safeClick", { binding: targetIdentity, region: pinnedRegion, point: { ...point } });
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(opaqueError("BRIDGE_CLOSED", "Native bridge client is closed."));
    if (!this.#child) return;
    this.#child.stdin.end();
    await new Promise((resolveClose) => {
      if (this.#child.exitCode !== null) resolveClose();
      else {
        const timer = setTimeout(() => { this.#child.kill(); resolveClose(); }, 1_000);
        this.#child.once("exit", () => { clearTimeout(timer); resolveClose(); });
      }
    });
  }
}

export { DEFAULT_EXECUTABLE as DEFAULT_DESKTOP_BRIDGE_EXECUTABLE };
