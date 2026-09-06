import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const suites = [
  "packages/atlas_protocol/scripts/verify.mjs",
  "01_player_runner/scripts/verify.mjs",
  "01_player_runner/scripts/verify-service.mjs",
  "02_wiki_foundry/scripts/verify.mjs",
  "03_replay_judge/scripts/verify.mjs",
  "integration/quest_atlas/verify.mjs",
  "integration/quest_atlas/verify-browser-adapter.mjs",
  "integration/pipeline/verify.mjs",
  "04_desktop_bridge/scripts/verify-native.mjs",
  "04_desktop_bridge/src/targeting/target-binding-broker.test.mjs",
  "04_desktop_bridge/src/input/safe-input-broker.test.mjs",
  "04_desktop_bridge/scripts/verify.mjs",
  "04_desktop_bridge/scripts/verify-player-runner.mjs",
  "04_desktop_bridge/scripts/verify-boundaries.mjs",
  "05_vision_agent_host/scripts/verify.mjs",
  "integration/vision_host/verify.mjs",
  "06_assisted_wiki_loop/scripts/verify-core.mjs",
  "06_assisted_wiki_loop/scripts/verify-model.mjs",
  "integration/assisted_wiki_loop/verify.mjs",
  "07_checkpoint_campaign/scripts/verify.mjs",
  "integration/checkpoint_campaign/verify.mjs",
  "scripts/verify-boundaries.mjs",
];

for (const suite of suites) {
  await new Promise((resolveSuite, rejectSuite) => {
    const child = spawn(process.execPath, [suite], { cwd: root, stdio: "inherit" });
    child.once("error", rejectSuite);
    child.once("exit", (code) => code === 0
      ? resolveSuite()
      : rejectSuite(new Error(suite + " failed with exit code " + code)));
  });
}

console.log("atlas_agent_tools: all suites passed");
