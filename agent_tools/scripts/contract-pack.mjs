import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const TOOL_ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const MODULES = Object.freeze({
  runner: "01_player_runner",
  foundry: "02_wiki_foundry",
  judge: "03_replay_judge",
});
const COMMON_ROOT = "packages/atlas_protocol";
const COMMON_FILES = new Set(["package.json", "CONTRACT_PACK.md"]);
const COMMON_DIRS = ["src", "schemas", "fixtures"];
const MODULE_FILES = new Set(["package.json", "CONTRACT_PACK.md"]);
const MODULE_DIRS = ["src", "scripts", "fixtures"];

function normalizePath(value) {
  return value.split(sep).join("/");
}

async function walkFiles(root, relativeRoot = "") {
  const directory = join(root, relativeRoot);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const child = join(relativeRoot, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Symbolic links and junctions are forbidden: " + child);
    if (entry.isDirectory()) files.push(...await walkFiles(root, child));
    else if (entry.isFile()) {
      const info = await stat(join(root, child));
      if (info.nlink > 1) throw new Error("Hard links are forbidden: " + child);
      if (entry.name.includes(":")) throw new Error("NTFS ADS-like name is forbidden: " + child);
      files.push(child);
    }
  }
  return files;
}

async function selectedFiles(root, fixedFiles, directories) {
  const result = [];
  for (const file of fixedFiles) {
    try {
      const info = await lstat(join(root, file));
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("Forbidden file type: " + file);
      result.push(file);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  for (const directory of directories) {
    try {
      result.push(...await walkFiles(root, directory));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return result.sort();
}

function digestEntries(entries) {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.sha256);
    hash.update("\n");
  }
  return hash.digest("hex");
}

function ensureOutsideToolRoot(destination) {
  const delta = relative(TOOL_ROOT, destination);
  if (delta === "" || (!delta.startsWith("..") && !isAbsolute(delta))) {
    throw new Error("Contract Pack destination must be outside the repository tool root.");
  }
}

async function ensureEmptyDestination(destination) {
  try {
    const entries = await readdir(destination);
    if (entries.length > 0) throw new Error("Destination must not already contain files.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(destination, { recursive: true });
  }
}

async function copySelected(sourceRoot, destinationRoot, paths, prefix, manifestEntries) {
  for (const sourceRelative of paths) {
    if (sourceRelative.includes("..") || isAbsolute(sourceRelative)) throw new Error("Path traversal rejected.");
    const source = join(sourceRoot, sourceRelative);
    const canonicalSource = await realpath(source);
    const canonicalRoot = await realpath(sourceRoot);
    if (!canonicalSource.startsWith(canonicalRoot + sep)) throw new Error("Source escaped allowlisted root.");
    const destinationRelative = normalizePath(join(prefix, sourceRelative));
    const destination = join(destinationRoot, destinationRelative);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    const bytes = await readFile(source);
    manifestEntries.push({
      path: destinationRelative,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
}

export async function exportContractPack(moduleName, destinationInput) {
  const moduleDirectory = MODULES[moduleName];
  if (!moduleDirectory) throw new Error("Unknown module. Use runner, foundry, or judge.");
  const destination = resolve(destinationInput);
  ensureOutsideToolRoot(destination);
  await ensureEmptyDestination(destination);

  const commonRoot = join(TOOL_ROOT, COMMON_ROOT);
  const moduleRoot = join(TOOL_ROOT, moduleDirectory);
  const commonPaths = await selectedFiles(commonRoot, COMMON_FILES, COMMON_DIRS);
  const modulePaths = await selectedFiles(moduleRoot, MODULE_FILES, MODULE_DIRS);
  const entries = [];
  await copySelected(commonRoot, destination, commonPaths, "contracts", entries);
  await copySelected(moduleRoot, destination, modulePaths, "work/module", entries);
  entries.sort((left, right) => left.path.localeCompare(right.path, "en"));

  const manifest = {
    schemaVersion: "atlas/contract-pack/1",
    module: moduleName,
    files: entries,
    treeDigest: digestEntries(entries),
  };
  await writeFile(
    join(destination, "contract-pack.manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { encoding: "utf8", flag: "wx" },
  );
  return manifest;
}

export { MODULES, TOOL_ROOT };
