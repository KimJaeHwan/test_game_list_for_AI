import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { exportContractPack, MODULES, TOOL_ROOT } from "./contract-pack.mjs";

const protocolRoot = resolve(TOOL_ROOT, "packages/atlas_protocol");
const forbiddenExtensions = new Set([".exe", ".dll", ".node", ".bat", ".cmd", ".ps1"]);
const importPattern = /(?:from\s+|import\s*\()\s*["']([^"']+)["']/g;

async function walk(root, relativeRoot = "") {
  const results = [];
  for (const entry of await readdir(join(root, relativeRoot), { withFileTypes: true })) {
    const child = join(relativeRoot, entry.name);
    const info = await lstat(join(root, child));
    assert.equal(info.isSymbolicLink(), false, "symlink/junction rejected: " + child);
    if (entry.isDirectory()) results.push(...await walk(root, child));
    else if (entry.isFile()) {
      const details = await stat(join(root, child));
      assert.equal(details.nlink, 1, "hard link rejected: " + child);
      assert.equal(entry.name.includes(":"), false, "ADS-like name rejected: " + child);
      assert.equal(forbiddenExtensions.has(extname(entry.name).toLowerCase()), false, "binary/hook file rejected: " + child);
      results.push(child);
    }
  }
  return results;
}

function within(candidate, root) {
  const delta = relative(root, candidate);
  return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
}

async function verifyModule(moduleName, directory) {
  const root = resolve(TOOL_ROOT, directory);
  const files = await walk(root);
  const packagePath = join(root, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
    assert.equal(packageJson.scripts?.[hook], undefined, moduleName + " has forbidden lifecycle hook " + hook);
  }

  for (const file of files.filter((path) => [".mjs", ".js"].includes(extname(path)))) {
    const absolute = join(root, file);
    const source = await readFile(absolute, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      if (specifier.startsWith("node:")) continue;
      assert.equal(specifier.startsWith("."), true, moduleName + " has external import " + specifier);
      const target = resolve(dirname(absolute), specifier);
      assert.equal(
        within(target, root) || within(target, protocolRoot),
        true,
        moduleName + " import escaped module/protocol boundary: " + specifier,
      );
    }
  }
}

for (const [moduleName, directory] of Object.entries(MODULES)) {
  await verifyModule(moduleName, directory);
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "atlas-contract-pack-"));
try {
  for (const moduleName of Object.keys(MODULES)) {
    const destination = join(temporaryRoot, moduleName);
    const manifest = await exportContractPack(moduleName, destination);
    assert.equal(manifest.module, moduleName);
    assert.equal(manifest.files.some((entry) => entry.path.includes(".git")), false);
    assert.equal(manifest.files.some((entry) => /(?:DESIGN|MEETING_NOTES|BLIND_DEVELOPMENT|README)\.md$/.test(entry.path)), false);
    assert.equal(manifest.files.every((entry) => entry.path.startsWith("contracts/") || entry.path.startsWith("work/module/")), true);
    const manifestPath = join(destination, "contract-pack.manifest.json");
    assert.equal((await realpath(manifestPath)).startsWith(await realpath(destination)), true);
  }
} finally {
  const canonicalTemp = await realpath(temporaryRoot);
  const canonicalSystemTemp = await realpath(tmpdir());
  assert.equal(canonicalTemp.startsWith(canonicalSystemTemp + sep), true);
  assert.equal(canonicalTemp.includes("atlas-contract-pack-"), true);
  await rm(canonicalTemp, { recursive: true, force: true });
}

console.log("atlas_boundaries: module imports and clean exports passed");
