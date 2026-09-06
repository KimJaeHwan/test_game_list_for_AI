import { mkdir, open } from "node:fs/promises";
import path from "node:path";

const FORBIDDEN_KEY = /(?:cap(?:ability)?|hwnd|window.?handle|url|selector|coordinate|(?:^|screen|client|page|offset)[xy]$)/i;
const URL_VALUE = /(?:\b(?:https?|file|wss?):\/\/|\bwww\.)\S+/gi;

function clean(value, seen = new WeakSet(), secrets = []) {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    let sanitized = value.replace(URL_VALUE, "[REDACTED_URL]");
    for (const secret of secrets) sanitized = sanitized.split(secret).join("[REDACTED_SECRET]");
    return sanitized;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return undefined;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { binaryBytes: value.byteLength };
  if (value instanceof Error) {
    return { name: value.name, code: value.code, message: clean(String(value.message), seen, secrets) };
  }
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => clean(item, seen, secrets)).filter((item) => item !== undefined);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) continue;
    const sanitized = clean(item, seen, secrets);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

export function redactJournalValue(value) {
  return clean(value);
}

export class DriverJournal {
  constructor({ filePath, now = () => new Date().toISOString() }) {
    if (!filePath) throw new TypeError("DriverJournal.filePath is required");
    this.filePath = path.resolve(filePath);
    this.now = now;
    this.sequence = 0;
    this.secrets = new Set();
    this.pending = Promise.resolve();
    this.handle = undefined;
    this.closed = false;
  }

  async init() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    if (this.handle || this.closed) throw new Error("DriverJournal cannot be initialized twice");
    this.handle = await open(this.filePath, "wx", 0o600);
  }

  addSecrets(values) {
    for (const value of values) {
      if (typeof value === "string" && value.length > 0) this.secrets.add(value);
    }
  }

  append(type, payload = {}) {
    if (!this.handle || this.closed) throw new Error("DriverJournal is not open");
    const entry = clean({ seq: ++this.sequence, at: this.now(), type, ...payload }, new WeakSet(), this.secrets);
    const line = `${JSON.stringify(entry)}\n`;
    const handle = this.handle;
    this.pending = this.pending.then(async () => {
      await handle.writeFile(line, { encoding: "utf8" });
      await handle.sync();
    });
    return this.pending;
  }

  async flush() {
    await this.pending;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const handle = this.handle;
    try {
      await this.pending;
    } finally {
      this.handle = undefined;
      await handle?.close();
    }
  }
}
