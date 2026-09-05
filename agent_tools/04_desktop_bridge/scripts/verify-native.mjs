import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("The native desktop bridge is Windows-only.");
const root = fileURLToPath(new URL("..", import.meta.url));
const project = resolve(root, "native", "DesktopBridge.Native.csproj");
const executable = resolve(root, "native", "bin", "Release", "net9.0-windows", "desktop-bridge-native.exe");

async function run(command, args) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: true });
    child.once("error", rejectRun);
    child.once("exit", (code) => code === 0
      ? resolveRun()
      : rejectRun(new Error(`${command} failed with exit code ${code}.`)));
  });
}

await run("dotnet", ["build", project, "--no-restore", "--configuration", "Release"]);
await run(executable, ["--self-test"]);
console.log("desktop_bridge_native: build and self-test passed");
