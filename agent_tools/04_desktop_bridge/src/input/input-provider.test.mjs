import assert from "node:assert/strict";
import test from "node:test";

import {
  SafeInputBroker,
  createLegacyBridgeInputProvider,
  normalizeInputProviderResult,
} from "./index.mjs";

const TARGET = Object.freeze({
  targetIdentity: Object.freeze({
    hwnd: "8080",
    pid: 77,
    processStartTimeUtc: "2026-09-05T00:00:00.000Z",
    executableSha256: "c".repeat(64),
    clientWidth: 640,
    clientHeight: 480,
  }),
  region: Object.freeze({ x: 20, y: 30, width: 400, height: 300 }),
});

function targetBroker() {
  return {
    async withPrivateBinding(targetRef, callback) {
      assert.equal(targetRef, "opaque-target");
      return callback(TARGET);
    },
  };
}

test("explicit inputProvider receives frozen validated input and its stable statuses", async () => {
  for (const status of ["DELIVERED", "NOT_DELIVERED", "DELIVERY_UNKNOWN"]) {
    const calls = [];
    const inputProvider = {
      async dispatch(action, pinnedTarget) {
        calls.push({ action, pinnedTarget });
        return { status, sinkReceipt: `provider-${status.toLowerCase()}` };
      },
    };
    const broker = new SafeInputBroker({ inputProvider, targetBroker: targetBroker() });
    const response = await broker.dispatch(
      { kind: "safePointActivate", safePoint: { x: 30, y: 40 } },
      { targetRef: "opaque-target" },
    );

    assert.deepEqual(response, { status, sinkReceipt: `provider-${status.toLowerCase()}` });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      action: { kind: "safePointActivate", safePoint: { x: 30, y: 40 } },
      pinnedTarget: TARGET,
    });
    assert.equal(Object.isFrozen(calls[0].action), true);
    assert.equal(Object.isFrozen(calls[0].action.safePoint), true);
    assert.equal(Object.isFrozen(calls[0].pinnedTarget), true);
  }
});

test("provider throw and malformed result become unknown with one invocation and no secret leakage", async () => {
  const cases = [
    async () => { throw new Error("C:\\private\\target.exe hwnd=8080 x=30"); },
    async () => ({
      status: "DELIVERED",
      sinkReceipt: "ack",
      targetIdentity: TARGET.targetIdentity,
    }),
    async () => ({ status: "DELIVERED", sinkReceipt: { hwnd: "8080", x: 30 } }),
  ];

  for (const dispatch of cases) {
    let calls = 0;
    const inputProvider = {
      async dispatch(...args) {
        calls += 1;
        return dispatch(...args);
      },
    };
    const broker = new SafeInputBroker({ inputProvider, targetBroker: targetBroker() });
    const response = await broker.dispatch(
      { kind: "keyTap", code: "Enter" },
      { targetRef: "opaque-target" },
    );
    assert.equal(response.status, "DELIVERY_UNKNOWN");
    assert.deepEqual(Object.keys(response), ["status", "sinkReceipt"]);
    assert.equal(JSON.stringify(response).includes("8080"), false);
    assert.equal(JSON.stringify(response).includes("private"), false);
    assert.equal(calls, 1);
  }
});

test("normalization accepts only exact upper-layer-compatible provider receipts", () => {
  const valid = normalizeInputProviderResult({ status: "DELIVERED", sinkReceipt: "opaque-ack" });
  assert.deepEqual(valid, { status: "DELIVERED", sinkReceipt: "opaque-ack" });
  assert.equal(Object.isFrozen(valid), true);

  for (const invalid of [
    { delivery: "delivered", receipt: "opaque-ack" },
    { status: "DELIVERED", sinkReceipt: "opaque ack" },
    { status: "DELIVERED", sinkReceipt: "opaque-ack", hwnd: "8080" },
  ]) {
    assert.deepEqual(normalizeInputProviderResult(invalid), {
      status: "DELIVERY_UNKNOWN",
      sinkReceipt: "invalid-input-provider-result",
    });
  }
});

test("bridge migration alias is explicit and cannot be combined with inputProvider", async () => {
  const bridgeCalls = [];
  const bridge = {
    async tapKey(request) {
      bridgeCalls.push(request);
      return { delivered: true, sinkReceipt: "legacy-ack" };
    },
    async safeClick() {
      throw new Error("unused");
    },
  };
  const legacyProvider = createLegacyBridgeInputProvider(bridge);
  assert.deepEqual(
    await legacyProvider.dispatch({ kind: "keyTap", code: "Enter" }, TARGET),
    { status: "DELIVERED", sinkReceipt: "legacy-ack" },
  );
  assert.equal(bridgeCalls.length, 1);

  assert.throws(
    () => new SafeInputBroker({
      inputProvider: { dispatch() {} },
      bridge,
      targetBroker: targetBroker(),
    }),
    /migration alias/iu,
  );
});
