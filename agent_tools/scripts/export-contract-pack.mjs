import { exportContractPack } from "./contract-pack.mjs";

const [moduleName, destination] = process.argv.slice(2);
if (!moduleName || !destination) {
  console.error("Usage: node scripts/export-contract-pack.mjs <runner|foundry|judge> <empty-output-directory>");
  process.exitCode = 2;
} else {
  const manifest = await exportContractPack(moduleName, destination);
  console.log(JSON.stringify({
    module: manifest.module,
    files: manifest.files.length,
    treeDigest: manifest.treeDigest,
  }));
}
