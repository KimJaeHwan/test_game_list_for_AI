import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalize, sha256 } from "../../packages/atlas_protocol/src/index.mjs";
import { RunnerError } from "./errors.mjs";

export class FileWalStore {
  constructor(filePath) {
    if (!filePath) throw new RunnerError("WAL_PATH_REQUIRED", "A WAL path is required.");
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    this.records = this.#load();
  }

  #load() {
    if (!existsSync(this.filePath)) return [];
    const text = readFileSync(this.filePath, "utf8").trim();
    if (!text) return [];
    const records = text.split(/\r?\n/u).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new RunnerError("WAL_CORRUPT", `WAL line ${index + 1} is not valid JSON.`);
      }
    });
    let previousDigest = "GENESIS";
    records.forEach((record, index) => {
      const unsigned = {
        sequence: record.sequence,
        kind: record.kind,
        payload: record.payload,
        previousDigest: record.previousDigest,
      };
      if (record.sequence !== index + 1 || record.previousDigest !== previousDigest || record.digest !== sha256(unsigned)) {
        throw new RunnerError("WAL_CORRUPT", `WAL integrity failed at line ${index + 1}.`);
      }
      previousDigest = record.digest;
    });
    return records;
  }

  append(kind, payload) {
    const unsigned = {
      sequence: this.records.length + 1,
      kind,
      payload,
      previousDigest: this.records.at(-1)?.digest ?? "GENESIS",
    };
    const record = Object.freeze({ ...unsigned, digest: sha256(unsigned) });
    const descriptor = openSync(this.filePath, "a");
    try {
      writeSync(descriptor, `${canonicalize(record)}\n`, null, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    this.records.push(record);
    return record;
  }

  history() {
    return this.records.map((record) => structuredClone(record));
  }

  requestState(requestId) {
    const matching = this.records.filter((record) => record.payload?.requestId === requestId);
    if (matching.length === 0) return undefined;
    const reservation = matching.find((record) => record.kind === "INPUT_RESERVED");
    const terminal = matching.findLast((record) => record.kind === "INPUT_TERMINAL");
    return { reservation, terminal };
  }

  inDoubtReservations() {
    const ids = new Set(
      this.records.filter((record) => record.kind === "INPUT_RESERVED").map((record) => record.payload.requestId),
    );
    return [...ids]
      .map((requestId) => this.requestState(requestId))
      .filter((state) => state?.reservation && !state.terminal);
  }

  get rootDigest() {
    return this.records.at(-1)?.digest ?? sha256("GENESIS");
  }
}
