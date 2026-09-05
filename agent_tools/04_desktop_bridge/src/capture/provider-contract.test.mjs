import assert from "node:assert/strict";
import test from "node:test";

import {
  createLegacyBridgeCaptureProvider,
  createProviderLifecycle,
  validateCaptureProvider,
  validateProviderId,
} from "../provider-contract.mjs";

test("capture provider contract validates and freezes stable provider identity", () => {
  const source = {
    providerId: "capture-provider/v1",
    capture() {},
  };
  const provider = validateCaptureProvider(source);
  assert.equal(provider.providerId, "capture-provider/v1");
  assert.equal(Object.isFrozen(provider), true);
  assert.equal(validateProviderId("capture-provider/v1"), "capture-provider/v1");
  for (const invalid of ["", "C:\\private", "provider id", "../provider", "x".repeat(129)]) {
    assert.throws(() => validateProviderId(invalid));
  }
});

test("legacy capture bridge adapter normalizes one call without fallback", async () => {
  const calls = [];
  const bridge = {
    async capture(request) {
      calls.push(request);
      return {
        rawBytes: new Uint8Array([1, 2, 3]),
        width: 10,
        height: 20,
        captureBackend: "legacy-provider/v1",
      };
    },
  };
  const provider = createLegacyBridgeCaptureProvider({
    bridge,
    providerId: "legacy-provider/v1",
  });
  const captured = await provider.capture({ binding: "private", region: "private" });
  assert.deepEqual(captured, {
    rawBytes: new Uint8Array([1, 2, 3]),
    width: 10,
    height: 20,
    providerId: "legacy-provider/v1",
  });
  assert.equal(calls.length, 1);
});

test("provider lifecycle retries only failed resources and exposes sanitized state", async () => {
  const calls = [];
  let firstAttempts = 0;
  const first = {
    async close() {
      calls.push("first");
      firstAttempts += 1;
      if (firstAttempts === 1) throw new Error("private close failure");
    },
  };
  const second = { async close() { calls.push("second"); } };
  const lifecycle = createProviderLifecycle([first, second, second]);

  assert.equal(lifecycle.state, "OPEN");
  await assert.rejects(
    lifecycle.close(),
    (error) => error.code === "PROVIDER_CLOSE_FAILED" && !error.message.includes("private"),
  );
  assert.equal(lifecycle.state, "CLOSE_FAILED");
  assert.deepEqual(calls, ["first", "second"]);
  await lifecycle.close();
  assert.equal(lifecycle.state, "CLOSED");
  assert.deepEqual(calls, ["first", "second", "first"]);
  await lifecycle.close();
  assert.deepEqual(calls, ["first", "second", "first"]);
});

test("provider lifecycle shares a concurrent close attempt without duplicate calls", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const lifecycle = createProviderLifecycle([{
    async close() {
      calls += 1;
      await blocked;
    },
  }]);

  const first = lifecycle.close();
  const second = lifecycle.close();
  assert.equal(first, second);
  assert.equal(lifecycle.state, "CLOSING");
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(lifecycle.state, "CLOSED");
  assert.equal(calls, 1);
});
