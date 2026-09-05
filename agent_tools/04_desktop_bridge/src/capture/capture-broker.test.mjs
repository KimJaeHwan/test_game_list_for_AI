import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPTURE_BROKER_ERROR_CODES,
  CaptureBroker,
} from "./index.mjs";

const IDENTITY = Object.freeze({
  hwnd: "4242",
  pid: 701,
  processStartTimeUtc: "2026-09-05T01:02:03.000Z",
  executableSha256: "a".repeat(64),
  clientWidth: 800,
  clientHeight: 600,
});
const REGION = Object.freeze({ x: 100, y: 80, width: 640, height: 480 });
const PINNED_TARGET = Object.freeze({ targetIdentity: IDENTITY, region: REGION });

function png(width = REGION.width, height = REGION.height) {
  const bytes = Buffer.alloc(57);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  bytes.write("IDAT", 37, "ascii");
  bytes.write("IEND", 49, "ascii");
  return bytes;
}

function fixture({ targetError, providerError, providerResult } = {}) {
  const calls = { target: [], provider: [] };
  const targetBroker = {
    async withPrivateBinding(targetRef, callback) {
      calls.target.push(targetRef);
      if (targetError) throw targetError;
      return callback(PINNED_TARGET);
    },
  };
  const captureProvider = {
    providerId: "test-composited/v1",
    async capture(request) {
      calls.provider.push(request);
      if (providerError) throw providerError;
      return providerResult ?? {
        rawBytes: png(),
        width: REGION.width,
        height: REGION.height,
        providerId: "test-composited/v1",
      };
    },
  };
  return {
    broker: new CaptureBroker({ targetBroker, captureProvider }),
    calls,
  };
}

test("revalidates target then calls the selected capture provider exactly once", async () => {
  const { broker, calls } = fixture();
  const captured = await broker.capture({ targetRef: "opaque-target" });

  assert.deepEqual(calls.target, ["opaque-target"]);
  assert.equal(calls.provider.length, 1);
  assert.deepEqual(calls.provider[0], { binding: IDENTITY, region: REGION });
  assert.equal(Object.isFrozen(calls.provider[0]), true);
  assert.equal(captured.width, REGION.width);
  assert.equal(captured.height, REGION.height);
  assert.equal(captured.providerId, "test-composited/v1");
  assert.deepEqual(Object.keys(captured), ["rawBytes", "width", "height", "providerId"]);
  assert.equal(JSON.stringify({ ...captured, rawBytes: undefined }).includes("4242"), false);
});

test("stale or malformed target causes zero provider calls", async () => {
  for (const targetError of [
    Object.assign(new Error("private hwnd 4242"), { code: "TARGET_CHANGED" }),
    new TypeError("malformed private target"),
  ]) {
    const { broker, calls } = fixture({ targetError });
    await assert.rejects(
      broker.capture({ targetRef: "opaque-target" }),
      (error) => error.code === CAPTURE_BROKER_ERROR_CODES.TARGET_REVALIDATION_FAILED
        && !error.message.includes("4242"),
    );
    assert.equal(calls.provider.length, 0);
  }
});

test("invalid PNG, size, provider ID, or exact shape is rejected without fallback", async () => {
  const invalidResults = [
    { rawBytes: Buffer.from("not-png"), width: 640, height: 480, providerId: "test-composited/v1" },
    { rawBytes: png(639, 480), width: 640, height: 480, providerId: "test-composited/v1" },
    { rawBytes: png(), width: 639, height: 480, providerId: "test-composited/v1" },
    { rawBytes: png(), width: 640, height: 480, providerId: "other-provider/v1" },
    { rawBytes: png(), width: 640, height: 480, providerId: "test-composited/v1", hwnd: "4242" },
  ];

  for (const providerResult of invalidResults) {
    const { broker, calls } = fixture({ providerResult });
    await assert.rejects(
      broker.capture({ targetRef: "opaque-target" }),
      (error) => error.code === CAPTURE_BROKER_ERROR_CODES.RESULT_INVALID,
    );
    assert.equal(calls.provider.length, 1);
  }
});

test("provider exception is sanitized and never retried", async () => {
  const { broker, calls } = fixture({
    providerError: new Error("C:\\private\\target.exe hwnd=4242"),
  });
  await assert.rejects(
    broker.capture({ targetRef: "opaque-target" }),
    (error) => error.code === CAPTURE_BROKER_ERROR_CODES.PROVIDER_FAILED
      && !error.message.includes("4242")
      && !error.message.includes("private"),
  );
  assert.equal(calls.provider.length, 1);
});

test("closed broker refuses capture before target revalidation", async () => {
  const { broker, calls } = fixture();
  broker.close();
  broker.close();
  await assert.rejects(
    broker.capture({ targetRef: "opaque-target" }),
    (error) => error.code === CAPTURE_BROKER_ERROR_CODES.CLOSED,
  );
  assert.equal(calls.target.length, 0);
  assert.equal(calls.provider.length, 0);
});
