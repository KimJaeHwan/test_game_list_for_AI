import assert from "node:assert/strict";
import { lstat, readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function filesBelow(directory) {
  const results = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (["bin", "obj"].includes(entry.name)) continue;
      const path = join(current, entry.name);
      const info = await lstat(path);
      assert.equal(info.isSymbolicLink(), false, `desktop bridge symlink rejected: ${relative(root, path)}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) results.push(path);
    }
  }
  await visit(directory);
  return results;
}

const nativeRoot = join(root, "native");
const nativeFiles = await filesBelow(nativeRoot);
const nativeSource = (await Promise.all(
  nativeFiles.filter((path) => extname(path) === ".cs").map((path) => readFile(path, "utf8")),
)).join("\n");
assert.doesNotMatch(nativeSource, /\b(?:CDP|WebSocket|HttpClient|Accessibility|ReadProcessMemory|WriteProcessMemory|VirtualAllocEx|CreateRemoteThread)\b/iu);
const importedDlls = [...nativeSource.matchAll(/DllImport\("([^"]+)"/gu)].map((match) => match[1].toLowerCase());
assert.ok(importedDlls.length > 0);
assert.equal(importedDlls.every((name) => ["user32.dll", "gdi32.dll", "kernel32.dll", "dwmapi.dll"].includes(name)), true);
const project = await readFile(join(nativeRoot, "DesktopBridge.Native.csproj"), "utf8");
assert.doesNotMatch(project, /PackageReference/iu);

const importPattern = /(?:from\s+|import\s*\()\s*["']([^"']+)["']/gu;
for (const directoryName of ["targeting", "input"]) {
  const directory = join(root, "src", directoryName);
  for (const path of await filesBelow(directory)) {
    if (extname(path) !== ".mjs") continue;
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      if (specifier.startsWith("node:")) continue;
      const resolved = resolve(path, "..", specifier);
      assert.equal(
        resolved.startsWith(directory) || resolved === join(root, "src", "contract.mjs"),
        true,
        `${directoryName} import escaped its assigned module: ${specifier}`,
      );
    }
  }
}

const adapterSource = await readFile(join(root, "src", "desktop-window-adapter.mjs"), "utf8");
assert.doesNotMatch(adapterSource, /\b(?:CDP|WebSocket|DOM|selector|https?)\b/iu);

console.log(JSON.stringify({
  nativeLibraries: [...new Set(importedDlls)].sort(),
  externalPackages: 0,
  browserOrApplicationApis: 0,
  assignedModuleImportEscapes: 0,
}, null, 2));
