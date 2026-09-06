import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { SupervisorError } from "./SupervisorError.mjs";

const FRAME_ID = /^F\d{6}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export class FrameStore {
  constructor({ directory }) {
    if (!directory) throw new TypeError("FrameStore.directory is required");
    this.directory = path.resolve(directory);
    this.frames = new Map();
    this.bookmarks = new Set();
  }

  async init() {
    await mkdir(this.directory, { recursive: false, mode: 0o700 });
  }

  has(frameId) {
    return this.frames.has(frameId);
  }

  get(frameId) {
    return this.frames.get(frameId);
  }

  async verifyStoredFrame(record) {
    if (
      record === null ||
      typeof record !== "object" ||
      typeof record.frameId !== "string" ||
      !FRAME_ID.test(record.frameId) ||
      typeof record.sha256 !== "string" ||
      !SHA256.test(record.sha256) ||
      this.frames.get(record.frameId) !== record
    ) {
      throw new SupervisorError("INVALID_FRAME", "Stored frame record is not the verified record");
    }
    const requestedDirectory = path.resolve(this.directory);
    const requestedImagePath = path.resolve(record.imagePath);
    const expectedImagePath = path.join(requestedDirectory, `${record.frameId}.png`);
    let directoryEntry;
    let imageEntry;
    let canonicalDirectory;
    let canonicalImagePath;
    let image;
    try {
      directoryEntry = await lstat(requestedDirectory);
      imageEntry = await lstat(requestedImagePath);
      canonicalDirectory = await realpath(requestedDirectory);
      canonicalImagePath = await realpath(requestedImagePath);
      image = await readFile(requestedImagePath);
    } catch (cause) {
      throw new SupervisorError("INVALID_FRAME", "Stored frame could not be reverified", { cause });
    }
    if (
      !directoryEntry.isDirectory() ||
      directoryEntry.isSymbolicLink() ||
      !imageEntry.isFile() ||
      imageEntry.isSymbolicLink() ||
      canonicalDirectory !== requestedDirectory ||
      canonicalImagePath !== requestedImagePath ||
      requestedImagePath !== expectedImagePath
    ) {
      throw new SupervisorError("INVALID_FRAME", "Stored frame path is not a canonical regular file");
    }
    if (
      image.length < PNG_SIGNATURE.length ||
      !image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
      digest(image) !== record.sha256
    ) {
      throw new SupervisorError("FRAME_HASH_MISMATCH", "Stored frame content no longer matches its digest");
    }
    return Object.freeze({ frameId: record.frameId, sha256: record.sha256 });
  }

  list() {
    return [...this.frames.values()];
  }

  async persist(observation) {
    const frameId = observation?.frameId;
    const bytes = observation?.image;
    const claimedHash = observation?.sha256;
    if (typeof frameId !== "string" || !FRAME_ID.test(frameId)) {
      throw new SupervisorError("INVALID_FRAME", "Runner returned an invalid frameId");
    }
    if (this.frames.has(frameId)) {
      throw new SupervisorError("FRAME_ID_REUSED", "Runner reused a frameId");
    }
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
      throw new SupervisorError("INVALID_FRAME", "Runner frame image is not binary PNG data");
    }
    const image = Buffer.from(bytes);
    if (image.length < PNG_SIGNATURE.length || !image.subarray(0, 8).equals(PNG_SIGNATURE)) {
      throw new SupervisorError("INVALID_FRAME", "Runner frame does not have a PNG signature");
    }
    if (typeof claimedHash !== "string" || !SHA256.test(claimedHash)) {
      throw new SupervisorError("INVALID_FRAME_HASH", "Runner frame is missing a canonical sha256");
    }
    const actualHash = digest(image);
    if (actualHash !== claimedHash) {
      throw new SupervisorError("FRAME_HASH_MISMATCH", "Runner frame sha256 does not match its PNG");
    }

    const imagePath = path.join(this.directory, `${frameId}.png`);
    let created = false;
    let handle;
    try {
      handle = await open(imagePath, "wx", 0o600);
      await handle.writeFile(image);
      await handle.sync();
      created = true;
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new SupervisorError("FRAME_ID_REUSED", "Frame path already exists", { cause: error });
      }
      throw error;
    } finally {
      await handle?.close();
    }

    const record = Object.freeze({ frameId, sha256: actualHash, imagePath, created });
    this.frames.set(frameId, record);
    return record;
  }

  markBookmarked(frameIds) {
    for (const frameId of frameIds) {
      if (!this.frames.has(frameId)) {
        throw new SupervisorError("UNKNOWN_FRAME", `Cannot bookmark unknown frameId ${frameId}`);
      }
    }
    for (const frameId of frameIds) this.bookmarks.add(frameId);
  }
}
