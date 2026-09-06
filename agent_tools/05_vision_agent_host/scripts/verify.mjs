import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1"));
const suites = [
  "scripts/verify-model-port.mjs",
  "scripts/verify-runner-client.mjs",
  "scripts/verify-supervisor.mjs",
  "scripts/verify-cli.mjs",
];

for (const suite of suites) {
  await new Promise((resolveSuite, rejectSuite) => {
    const child = spawn(process.execPath, [suite], {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", rejectSuite);
    child.once("exit", (code) => code === 0
      ? resolveSuite()
      : rejectSuite(new Error(`${suite} failed with exit code ${code}`)));
  });
}

console.log("vision_agent_host: all offline suites passed");
