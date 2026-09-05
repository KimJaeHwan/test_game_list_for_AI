import assert from "node:assert/strict";
import test from "node:test";

import { DESKTOP_ALLOWED_KEYS } from "../contract.mjs";
import { SafeInputBroker, validatePrivateAction } from "./index.mjs";

const IDENTITY = Object.freeze({
  hwnd: "42",
  pid: 73,
  processStartTimeUtc: "2026-09-05T00:00:00.000Z",
  executableSha256: "a".repeat(64),
  clientWidth: 800,
  clientHeight: 600,
});
const REGION = Object.freeze({ x: 100, y: 50, width: 400, height: 300 });
const PINNED_TARGET = Object.freeze({ targetIdentity: IDENTITY, region: REGION });

function fixture({ revalidateError, privateValue = PINNED_TARGET, afterCallbackError } = {}) {
  const calls = { revalidate: [], tapKey: [], safeClick: [] };
  const targetBroker = {
    async withPrivateBinding(targetRef, callback) {
      calls.revalidate.push(targetRef);
      if (revalidateError) throw revalidateError;
      const value = await callback(privateValue);
      if (afterCallbackError) throw afterCallbackError;
      return value;
    },
  };
  const bridge = {
    async tapKey(request) {
      calls.tapKey.push(request);
      return { delivered: true, sinkReceipt: "fake-key-ack" };
    },
    async safeClick(request) {
      calls.safeClick.push(request);
      return { delivered: true, sinkReceipt: "fake-click-ack" };
    },
  };
  return { broker: new SafeInputBroker({ bridge, targetBroker }), bridge, calls };
}

test("validatePrivateAction accepts every common key and returns exact frozen actions", () => {
  for (const code of DESKTOP_ALLOWED_KEYS) {
    const action = validatePrivateAction({ kind: "keyTap", code });
    assert.deepEqual(action, { kind: "keyTap", code });
    assert.equal(Object.isFrozen(action), true);
  }
});

test("keyTap dispatches once only after private target revalidation", async () => {
  const { broker, calls } = fixture();
  const response = await broker.dispatch(
    { kind: "keyTap", code: "ArrowUp" },
    { targetRef: "opaque-target" },
  );

  assert.deepEqual(response, { status: "DELIVERED", sinkReceipt: "fake-key-ack" });
  assert.deepEqual(Object.keys(response), ["status", "sinkReceipt"]);
  assert.deepEqual(calls.revalidate, ["opaque-target"]);
  assert.equal(calls.tapKey.length, 1);
  assert.equal(calls.safeClick.length, 0);
  assert.deepEqual(calls.tapKey[0], { binding: IDENTITY, code: "ArrowUp" });
});

test("safePointActivate dispatches only an in-region finite integer point", async () => {
  const { broker, calls } = fixture();
  const response = await broker.dispatch(
    { kind: "safePointActivate", safePoint: { x: 499, y: 349 } },
    { targetRef: "opaque-target" },
  );

  assert.deepEqual(response, { status: "DELIVERED", sinkReceipt: "fake-click-ack" });
  assert.equal(calls.safeClick.length, 1);
  assert.deepEqual(calls.safeClick[0], {
    binding: IDENTITY,
    region: REGION,
    point: { x: 499, y: 349 },
  });
});

test("invalid and non-exact actions cause zero revalidation and zero native dispatch", async () => {
  const invalidActions = [
    null,
    { kind: "keyTap", code: "KeyZ" },
    { kind: "keyTap", code: "Enter", extra: true },
    { kind: "safePointActivate", safePoint: { x: 100.5, y: 100 } },
    { kind: "safePointActivate", safePoint: { x: Number.NaN, y: 100 } },
    { kind: "safePointActivate", safePoint: { x: 100, y: 100, button: 1 } },
    { kind: "safePointActivate", safePoint: { x: 100, y: 100 }, dispatchHandle: "private" },
    { kind: "activate", safePoint: { x: 100, y: 100 } },
  ];

  for (const action of invalidActions) {
    const { broker, calls } = fixture();
    const response = await broker.dispatch(action, { targetRef: "opaque-target" });
    assert.deepEqual(response, { status: "NOT_DELIVERED", sinkReceipt: "input-policy-rejected" });
    assert.equal(calls.revalidate.length, 0);
    assert.equal(calls.tapKey.length + calls.safeClick.length, 0);
  }
});

test("invalid dispatch context causes zero revalidation and zero native dispatch", async () => {
  const { broker, calls } = fixture();
  const response = await broker.dispatch(
    { kind: "keyTap", code: "Enter" },
    { targetRef: "opaque-target", targetIdentity: IDENTITY },
  );
  assert.equal(response.status, "NOT_DELIVERED");
  assert.equal(calls.revalidate.length, 0);
  assert.equal(calls.tapKey.length + calls.safeClick.length, 0);
});

test("out-of-region points cause zero native dispatch, including exclusive edges", async () => {
  const points = [
    { x: 99, y: 50 },
    { x: 100, y: 49 },
    { x: 500, y: 50 },
    { x: 100, y: 350 },
  ];
  for (const safePoint of points) {
    const { broker, calls } = fixture();
    const response = await broker.dispatch(
      { kind: "safePointActivate", safePoint },
      { targetRef: "opaque-target" },
    );
    assert.deepEqual(response, { status: "NOT_DELIVERED", sinkReceipt: "input-policy-rejected" });
    assert.equal(calls.revalidate.length, 1);
    assert.equal(calls.safeClick.length, 0);
  }
});

test("stale, hidden, minimized, foreground-lost, geometry-changed, and identity-changed targets fail closed", async () => {
  const conditions = [
    "TARGET_STALE",
    "TARGET_NOT_VISIBLE",
    "TARGET_MINIMIZED",
    "TARGET_NOT_FOREGROUND",
    "TARGET_GEOMETRY_CHANGED",
    "TARGET_IDENTITY_CHANGED",
  ];
  for (const code of conditions) {
    const { broker, calls } = fixture({ revalidateError: Object.assign(new Error(code), { code }) });
    const response = await broker.dispatch(
      { kind: "keyTap", code: "Enter" },
      { targetRef: "opaque-target" },
    );
    assert.deepEqual(response, {
      status: "NOT_DELIVERED",
      sinkReceipt: "target-revalidation-refused",
    });
    assert.equal(calls.tapKey.length + calls.safeClick.length, 0);
  }
});

test("malformed private binding fails closed before native dispatch", async () => {
  const malformedTargets = [
    { ...PINNED_TARGET, extra: true },
    { targetIdentity: { ...IDENTITY, hwnd: "0" }, region: REGION },
    { targetIdentity: IDENTITY, region: { ...REGION, width: 1000 } },
  ];
  for (const privateValue of malformedTargets) {
    const { broker, calls } = fixture({ privateValue });
    const response = await broker.dispatch(
      { kind: "keyTap", code: "Space" },
      { targetRef: "opaque-target" },
    );
    assert.equal(response.status, "NOT_DELIVERED");
    assert.equal(calls.tapKey.length, 0);
  }
});

test("every native pre-dispatch refusal is NOT_DELIVERED without retry", async () => {
  const definiteRefusals = [
    "INPUT_NOT_DELIVERED",
    "KEY_NOT_ALLOWED",
    "WINDOW_NOT_FOUND",
    "IDENTITY_MISMATCH",
    "WINDOW_NOT_VISIBLE",
    "WINDOW_MINIMIZED",
    "WINDOW_NOT_FOREGROUND",
    "WINDOW_STATE_CHANGED",
    "DESKTOP_UNAVAILABLE",
    "REGION_NOT_COMPOSITED",
    "WINDOW_OCCLUDED",
    "OCCLUSION_UNKNOWN",
    "CLICK_TARGET_MISMATCH",
    "INVALID_REQUEST",
    "INVALID_REGION",
    "INVALID_POINT",
  ];
  for (const code of definiteRefusals) {
    const { broker, bridge, calls } = fixture();
    bridge.tapKey = async (request) => {
      calls.tapKey.push(request);
      throw Object.assign(new Error(code), { code });
    };
    const response = await broker.dispatch(
      { kind: "keyTap", code: "Enter" },
      { targetRef: "opaque-target" },
    );
    assert.deepEqual(response, { status: "NOT_DELIVERED", sinkReceipt: "native-not-delivered" });
    assert.equal(calls.tapKey.length, 1);
  }
});

test("native delivery uncertainty, internal failure, and transport ambiguity are never retried", async () => {
  for (const code of ["DELIVERY_UNKNOWN", "INTERNAL", "TRANSPORT_CLOSED"]) {
    const { broker, bridge, calls } = fixture();
    bridge.tapKey = async (request) => {
      calls.tapKey.push(request);
      throw Object.assign(new Error(code), { code });
    };
    const response = await broker.dispatch(
      { kind: "keyTap", code: "Enter" },
      { targetRef: "opaque-target" },
    );
    assert.equal(response.status, "DELIVERY_UNKNOWN");
    assert.equal(calls.tapKey.length, 1, "an ambiguous delivery must never be retried");
  }
});

test("invalid native acknowledgement cannot leak metadata", async () => {
  const { broker, bridge, calls } = fixture();
  bridge.safeClick = async (request) => {
    calls.safeClick.push(request);
    return { delivered: true, sinkReceipt: { hwnd: "42", x: 101, y: 51 } };
  };
  const response = await broker.dispatch(
    { kind: "safePointActivate", safePoint: { x: 101, y: 51 } },
    { targetRef: "opaque-target" },
  );
  assert.deepEqual(response, { status: "DELIVERY_UNKNOWN", sinkReceipt: "invalid-input-provider-result" });
  assert.equal(JSON.stringify(response).includes("42"), false);
  assert.equal(JSON.stringify(response).includes("101"), false);
});

test("a failure after native dispatch is DELIVERY_UNKNOWN and is never retried", async () => {
  const { broker, calls } = fixture({
    afterCallbackError: Object.assign(new Error("post-dispatch failure"), { code: "TARGET_STALE" }),
  });
  const response = await broker.dispatch(
    { kind: "keyTap", code: "Enter" },
    { targetRef: "opaque-target" },
  );
  assert.deepEqual(response, { status: "DELIVERY_UNKNOWN", sinkReceipt: "input-provider-unknown" });
  assert.equal(calls.tapKey.length, 1);
});
