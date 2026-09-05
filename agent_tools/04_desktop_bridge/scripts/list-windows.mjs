import { NativeDesktopBridgeClient } from "../src/native-client.mjs";

const bridge = new NativeDesktopBridgeClient();
try {
  const windows = await bridge.listWindows();
  if (windows.length === 0) {
    console.log("No eligible visible top-level windows were found.");
    process.exitCode = 1;
  } else {
    console.log("INDEX  HWND                CLIENT       TITLE");
    windows.forEach((entry, index) => {
      const identity = entry?.identity ?? {};
      const size = `${identity.clientWidth ?? "?"}x${identity.clientHeight ?? "?"}`;
      const title = String(entry?.title ?? "").replace(/[\r\n\t]+/gu, " ").slice(0, 100);
      console.log(`${String(index + 1).padEnd(6)} ${String(identity.hwnd ?? "?").padEnd(19)} ${size.padEnd(12)} ${title}`);
    });
    console.log("\nHWND values are private operator data. Do not include them in agent prompts or public artifacts.");
  }
} finally {
  await bridge.close();
}
