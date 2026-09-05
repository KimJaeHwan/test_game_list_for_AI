import assert from "node:assert/strict";
import test from "node:test";

import { DesktopWindowAdapter } from "../desktop-window-adapter.mjs";

function png(width, height, marker = 0) {
  const bytes = Buffer.alloc(57);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  bytes[28] = marker;
  bytes.write("IDAT", 37, "ascii");
  bytes.write("IEND", 49, "ascii");
  return bytes;
}

function fixture({ captureClose, lifecycleClose } = {}) {
  const calls = { capture: [], input: [], captureClose: 0, lifecycleClose: 0 };
  const ids = ["session-ref", "config-ref", "build-ref"];
  let frame = png(320, 200, 1);
  let transformCapture = (captured) => captured;
  const targetBroker = {
    async redeem(ticket) {
      assert.equal(ticket, "launch-ticket");
      return { targetRef: "opaque-target" };
    },
    async withPrivateBinding(targetRef, callback) {
      assert.equal(targetRef, "opaque-target");
      return callback({ region: { x: 10, y: 20, width: 320, height: 200 } });
    },
  };
  const captureBroker = {
    providerId: "capture-test/v1",
    async capture(context) {
      calls.capture.push(context);
      return transformCapture({
        rawBytes: Buffer.from(frame),
        width: 320,
        height: 200,
        providerId: "capture-test/v1",
      });
    },
    async close() {
      calls.captureClose += 1;
      await captureClose?.();
    },
  };
  const inputBroker = {
    async dispatch(action, context) {
      calls.input.push({ action, context });
      return { status: "DELIVERED", sinkReceipt: "input-ack" };
    },
  };
  const providerLifecycle = {
    async close() {
      calls.lifecycleClose += 1;
      await lifecycleClose?.();
    },
  };
  const adapter = new DesktopWindowAdapter({
    targetBroker,
    captureBroker,
    inputBroker,
    providerLifecycle,
    idFactory: () => ids.shift(),
  });
  return {
    adapter,
    calls,
    changeFrame() { frame = png(320, 200, 2); },
    setCaptureTransform(value) { transformCapture = value; },
  };
}

async function launch(adapter) {
  return adapter.launch({
    launchTicket: "launch-ticket",
    internalRunId: "private-run",
    publicRunId: "public-run",
  });
}

test("adapter composes capture and input brokers without a raw bridge", async () => {
  const { adapter, calls, changeFrame } = fixture();
  const launched = await adapter.launch({
    launchTicket: "launch-ticket",
    internalRunId: "private-run",
    publicRunId: "public-run",
  });
  assert.equal(launched.sessionHandle, "session-ref");
  assert.equal(launched.width, 320);
  assert.equal(launched.height, 200);
  for (const privateField of ["targetRef", "providerId", "hwnd", "region", "coordinate"]) {
    assert.equal(JSON.stringify(launched).includes(privateField), false);
  }

  const first = await adapter.capture({ sessionHandle: "session-ref", purpose: "observe" });
  const unchanged = await adapter.capture({
    sessionHandle: "session-ref",
    purpose: "wait",
    afterFrameId: "F000001",
  });
  changeFrame();
  const changed = await adapter.capture({
    sessionHandle: "session-ref",
    purpose: "wait",
    afterFrameId: "F000002",
  });
  assert.equal(first.changeClass, "UNCERTAIN");
  assert.equal(unchanged.changeClass, "UNCHANGED");
  assert.equal(changed.changeClass, "PERSISTENT_CHANGE");
  assert.deepEqual(calls.capture, [
    { targetRef: "opaque-target" },
    { targetRef: "opaque-target" },
    { targetRef: "opaque-target" },
  ]);

  const delivery = await adapter.dispatch({
    kind: "safePointActivate",
    safePoint: { x: 30, y: 40 },
    dispatchHandle: "must-not-cross-policy-boundary",
  }, { sessionHandle: "session-ref" });
  assert.deepEqual(delivery, { status: "DELIVERED", sinkReceipt: "input-ack" });
  assert.deepEqual(calls.input, [{
    action: { kind: "safePointActivate", safePoint: { x: 30, y: 40 } },
    context: { targetRef: "opaque-target" },
  }]);
});

test("ending the final session closes broker and provider lifecycle exactly once", async () => {
  const { adapter, calls } = fixture();
  await launch(adapter);
  await adapter.end({ sessionHandle: "session-ref", reason: "COMPLETE" });
  assert.equal(calls.captureClose, 1);
  assert.equal(calls.lifecycleClose, 1);
  await assert.rejects(
    adapter.capture({ sessionHandle: "session-ref", purpose: "observe" }),
    /not open/iu,
  );
  await assert.rejects(
    adapter.launch({ launchTicket: "launch-ticket", internalRunId: "x", publicRunId: "y" }),
    /not open/iu,
  );
});

test("adapter rejects non-exact or mismatched capture broker provenance", async (context) => {
  await context.test("additional fields", async () => {
    const { adapter, setCaptureTransform } = fixture();
    await launch(adapter);
    setCaptureTransform((captured) => ({ ...captured, targetIdentity: "must-not-pass" }));
    await assert.rejects(
      adapter.capture({ sessionHandle: "session-ref", purpose: "observe" }),
      /pinned target region and provider/iu,
    );
  });

  await context.test("provider mismatch", async () => {
    const { adapter, setCaptureTransform } = fixture();
    await launch(adapter);
    setCaptureTransform((captured) => ({ ...captured, providerId: "spoofed-provider/v1" }));
    await assert.rejects(
      adapter.capture({ sessionHandle: "session-ref", purpose: "observe" }),
      /pinned target region and provider/iu,
    );
  });
});

test("adapter close failure blocks use while allowing cleanup retry", async () => {
  let lifecycleAttempts = 0;
  const { adapter, calls } = fixture({
    lifecycleClose() {
      lifecycleAttempts += 1;
      if (lifecycleAttempts === 1) throw new Error("private lifecycle failure");
    },
  });
  await launch(adapter);

  await assert.rejects(
    adapter.end({ sessionHandle: "session-ref", reason: "COMPLETE" }),
    (error) => error.code === "PROVIDER_CLOSE_FAILED" && !error.message.includes("private"),
  );
  assert.equal(calls.captureClose, 1);
  assert.equal(calls.lifecycleClose, 1);
  await assert.rejects(
    adapter.capture({ sessionHandle: "session-ref", purpose: "observe" }),
    /not open/iu,
  );
  await assert.rejects(
    adapter.dispatch({ kind: "keyTap", code: "Enter" }, { sessionHandle: "session-ref" }),
    /not open/iu,
  );
  await assert.rejects(
    adapter.launch({ launchTicket: "launch-ticket", internalRunId: "x", publicRunId: "y" }),
    /not open/iu,
  );

  await adapter.end({ sessionHandle: "session-ref", reason: "CLEANUP_RETRY" });
  assert.equal(calls.captureClose, 1);
  assert.equal(calls.lifecycleClose, 2);
  await adapter.end({ sessionHandle: "session-ref", reason: "CLEANUP_RETRY" });
  assert.equal(calls.captureClose, 1);
  assert.equal(calls.lifecycleClose, 2);
});

test("adapter retries only the close component that failed", async () => {
  let captureAttempts = 0;
  const { adapter, calls } = fixture({
    captureClose() {
      captureAttempts += 1;
      if (captureAttempts === 1) throw new Error("private capture close failure");
    },
  });
  await launch(adapter);

  await assert.rejects(
    adapter.end({ sessionHandle: "session-ref", reason: "COMPLETE" }),
    (error) => error.code === "PROVIDER_CLOSE_FAILED" && !error.message.includes("private"),
  );
  await adapter.end({ sessionHandle: "session-ref", reason: "CLEANUP_RETRY" });
  assert.equal(calls.captureClose, 2);
  assert.equal(calls.lifecycleClose, 1);
});

test("concurrent adapter cleanup shares one close attempt", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const { adapter, calls } = fixture({ lifecycleClose: () => blocked });
  await launch(adapter);

  const first = adapter.end({ sessionHandle: "session-ref", reason: "COMPLETE" });
  const second = adapter.end({ sessionHandle: "session-ref", reason: "COMPLETE" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.captureClose, 1);
  assert.equal(calls.lifecycleClose, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(calls.captureClose, 1);
  assert.equal(calls.lifecycleClose, 1);
});

test("constructor refuses raw bridge-only composition", () => {
  assert.throws(
    () => new DesktopWindowAdapter({
      targetBroker: { redeem() {}, withPrivateBinding() {} },
      bridge: { capture() {} },
      inputBroker: { dispatch() {} },
      providerLifecycle: { close() {} },
    }),
    /captureBroker/iu,
  );
});
