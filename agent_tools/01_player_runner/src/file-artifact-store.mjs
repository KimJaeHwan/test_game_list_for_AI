import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { canonicalize, sha256 } from "../../packages/atlas_protocol/src/index.mjs";
import { RunnerError } from "./errors.mjs";

const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const PUBLIC_FILE_NAME = /^(?:frames\/F\d{6}\.png|observations\.ndjson|actions\.ndjson)$/u;

function normalizeForComparison(path) {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function isWithin(root, target) {
  const result = relative(root, target);
  return result !== "" && !result.startsWith("..") && !isAbsolute(result);
}

function safeRoot(path, label) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new TypeError(`${label} must be an absolute trusted path.`);
  const absolute = resolve(path);
  if (dirname(absolute) === absolute) throw new TypeError(`${label} cannot be a filesystem root.`);
  return absolute;
}

function requireArtifactId(value, label) {
  if (typeof value !== "string" || !ARTIFACT_ID.test(value)) {
    throw new RunnerError("ARTIFACT_ID_INVALID", `${label} is not a safe Coordinator artifact id.`);
  }
  return value;
}

function writeNewFile(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { flag: "wx" });
}

/**
 * Trusted persistence boundary. Roots are constructor-only configuration and
 * are never accepted from an agent tool call.
 */
export class FileArtifactStore {
  constructor({ publicRoot, privateRoot }) {
    this.publicRoot = safeRoot(publicRoot, "publicRoot");
    this.privateRoot = safeRoot(privateRoot, "privateRoot");
    const publicComparable = normalizeForComparison(this.publicRoot);
    const privateComparable = normalizeForComparison(this.privateRoot);
    if (
      publicComparable === privateComparable
      || isWithin(publicComparable, privateComparable)
      || isWithin(privateComparable, publicComparable)
    ) {
      throw new TypeError("publicRoot and privateRoot must be separate, non-nested directories.");
    }
  }

  #validatePublicFiles(publicHandoff, publicFiles) {
    if (!(publicFiles instanceof Map)) throw new RunnerError("PUBLIC_FILES_INVALID", "publicFiles must be a Map.");
    const manifest = publicHandoff?.payload?.manifest;
    const declared = manifest?.files;
    if (!Array.isArray(declared)) throw new RunnerError("PUBLIC_FILES_INVALID", "Signed public handoff has no file manifest.");
    if (
      publicHandoff.header?.artifactType !== "PublicPlayHandoff"
      || publicHandoff.header?.schemaVersion !== "atlas/public-play-handoff/1"
      || manifest.schemaVersion !== "atlas/public-play-handoff/1"
    ) {
      throw new RunnerError("PUBLIC_HANDOFF_SCHEMA_INVALID", "Public handoff header must bind the public payload schema.");
    }
    if (manifest.artifactId !== publicHandoff.header?.artifactId) {
      throw new RunnerError("PUBLIC_FILES_INVALID", "Public artifact identity does not match its signed envelope.");
    }
    const names = new Set(declared.map((file) => file.relativeName));
    if (names.size !== declared.length || publicFiles.size !== declared.length) {
      throw new RunnerError("PUBLIC_FILES_INVALID", "Manifest and publicFiles must be one-to-one.");
    }
    for (const file of declared) {
      if (typeof file.relativeName !== "string" || !PUBLIC_FILE_NAME.test(file.relativeName)) {
        throw new RunnerError("PUBLIC_FILE_NAME_FORBIDDEN", "Only contract-owned public filenames may be persisted.");
      }
      const bytes = publicFiles.get(file.relativeName);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
        throw new RunnerError("PUBLIC_FILE_MANIFEST_MISMATCH", "Public file bytes do not match the signed manifest.");
      }
    }
  }

  async persist({ publicHandoff, publicFiles, privateJudgeEnvelope }) {
    this.#validatePublicFiles(publicHandoff, publicFiles);
    if (
      privateJudgeEnvelope?.header?.artifactType !== "PrivateJudgeEnvelope"
      || privateJudgeEnvelope?.header?.schemaVersion !== "atlas/private-judge-envelope/1"
      || privateJudgeEnvelope?.payload?.schemaVersion !== "atlas/private-judge-envelope/1"
    ) {
      throw new RunnerError("PRIVATE_ENVELOPE_SCHEMA_INVALID", "Private envelope header must bind the private payload schema.");
    }
    const publicArtifactId = requireArtifactId(publicHandoff?.header?.artifactId, "public artifactId");
    const privateArtifactId = requireArtifactId(privateJudgeEnvelope?.header?.artifactId, "private artifactId");
    mkdirSync(this.publicRoot, { recursive: true });
    mkdirSync(this.privateRoot, { recursive: true });
    const publicTarget = resolve(this.publicRoot, publicArtifactId);
    const privateTarget = resolve(this.privateRoot, privateArtifactId);
    if (!isWithin(this.publicRoot, publicTarget) || !isWithin(this.privateRoot, privateTarget)) {
      throw new RunnerError("ARTIFACT_PATH_INVALID", "Artifact target escaped its configured root.");
    }
    if (existsSync(publicTarget) || existsSync(privateTarget)) {
      throw new RunnerError("ARTIFACT_ALREADY_EXISTS", "Artifact targets are immutable and cannot be overwritten.");
    }

    const publicStage = mkdtempSync(join(this.publicRoot, ".atlas-stage-"));
    const privateStage = mkdtempSync(join(this.privateRoot, ".atlas-stage-"));
    let privateCommitted = false;
    let publicCommitted = false;
    try {
      writeNewFile(join(publicStage, "handoff.json"), Buffer.from(`${canonicalize(publicHandoff)}\n`, "utf8"));
      for (const [relativeName, bytes] of publicFiles) {
        const destination = resolve(publicStage, ...relativeName.split("/"));
        if (!isWithin(publicStage, destination)) throw new RunnerError("ARTIFACT_PATH_INVALID", "Public filename escaped its staging directory.");
        writeNewFile(destination, Buffer.from(bytes));
      }
      writeNewFile(join(privateStage, "private-envelope.json"), Buffer.from(`${canonicalize(privateJudgeEnvelope)}\n`, "utf8"));

      if (existsSync(publicTarget) || existsSync(privateTarget)) {
        throw new RunnerError("ARTIFACT_ALREADY_EXISTS", "Artifact targets appeared during persistence; overwrite refused.");
      }
      renameSync(privateStage, privateTarget);
      privateCommitted = true;
      renameSync(publicStage, publicTarget);
      publicCommitted = true;
      return Object.freeze({ persisted: true });
    } catch (error) {
      if (!publicCommitted && existsSync(publicStage)) rmSync(publicStage, { recursive: true, force: true });
      if (!privateCommitted && existsSync(privateStage)) rmSync(privateStage, { recursive: true, force: true });
      if (privateCommitted && !publicCommitted && existsSync(privateTarget)) rmSync(privateTarget, { recursive: true, force: true });
      if (error instanceof RunnerError) throw error;
      throw new RunnerError("ARTIFACT_PERSIST_FAILED", "Artifact persistence failed closed.");
    }
  }
}
