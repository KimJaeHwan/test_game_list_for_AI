import assert from "node:assert/strict";
import test from "node:test";

import {
  TARGET_BINDING_ERROR_CODES,
  TargetBindingBroker,
  TargetBindingError,
} from "./index.mjs";

const HASH = "a".repeat(64);

function identity(overrides = {}) {
  return {
    hwnd: "42",
    pid: 700,
    processStartTimeUtc: "2026-09-05T01:02:03.000Z",
    executableSha256: HASH,
    clientWidth: 1280,
    clientHeight: 720,
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    title: " Quest Atlas ",
    executablePath: " C:\\Games\\QuestAtlas.exe ",
    identity: identity(),
    ...overrides,
  };
}

function fixture({ ids = ["binding-1", "ticket-1", "ticket-2"], now = 1_000 } = {}) {
  let currentIdentity = identity();
  let list = [candidate()];
  let clock = now;
  let inspections = 0;
  const remainingIds = [...ids];
  const bridge = {
    async listWindows() { return list; },
    async inspect(hwnd) {
      inspections += 1;
      assert.equal(hwnd, "42");
      return currentIdentity;
    },
  };
  const broker = new TargetBindingBroker({
    bridge,
    idFactory: () => remainingIds.shift(),
    clock: () => clock,
    defaultTicketTtlMs: 500,
  });
  return {
    broker,
    get inspections() { return inspections; },
    setIdentity(value) { currentIdentity = value; },
    setList(value) { list = value; },
    setTime(value) { clock = value; },
  };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof TargetBindingError);
    assert.equal(error.code, code);
    return true;
  });
}

function assertAgentSafe(value) {
  const serialized = JSON.stringify(value).toLowerCase();
  for (const forbidden of [
    "title", "pid", "hwnd", "executable", "path", "sha256", "bounds", "region",
    "quest atlas", "questatlas.exe", HASH,
  ]) assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`);
}

test("lists frozen sanitized candidates only to the operator", async () => {
  const fx = fixture();
  fx.setList([candidate({ title: " Quest\u001b[31m Atlas\u202e " })]);
  const result = await fx.broker.listOperatorCandidates();
  assert.deepEqual(result, [{
    title: "Quest�[31m Atlas�",
    executablePath: "C:\\Games\\QuestAtlas.exe",
    identity: identity(),
  }]);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result[0]));
  assert.ok(Object.isFrozen(result[0].identity));
});

test("fails closed on malformed and duplicate bridge candidates", async () => {
  const fx = fixture();
  fx.setList([candidate(), candidate()]);
  await expectCode(fx.broker.listOperatorCandidates(), TARGET_BINDING_ERROR_CODES.MALFORMED_BRIDGE_DATA);
  fx.setList([candidate({ unexpected: true })]);
  await expectCode(fx.broker.listOperatorCandidates(), TARGET_BINDING_ERROR_CODES.MALFORMED_BRIDGE_DATA);
});

test("pins exact identity and a validated private client-relative region", async () => {
  const fx = fixture();
  const bound = await fx.broker.bind({
    hwnd: "42",
    region: { x: 10, y: 20, width: 300, height: 200 },
  });
  assert.deepEqual(bound, { bindingRef: "binding-1" });
  assertAgentSafe(bound);
  const result = await fx.broker.withPrivateBinding("binding-1", (binding) => {
    assert.ok(Object.isFrozen(binding));
    assert.ok(Object.isFrozen(binding.targetIdentity));
    assert.ok(Object.isFrozen(binding.region));
    assert.deepEqual(binding, {
      targetIdentity: identity(),
      region: { x: 10, y: 20, width: 300, height: 200 },
    });
    return "used";
  });
  assert.equal(result, "used");
  assert.equal(fx.inspections, 2);
});

test("defaults to full client area and rejects out-of-bounds regions", async () => {
  const fx = fixture();
  await fx.broker.bind({ hwnd: "42" });
  await fx.broker.withPrivateBinding("binding-1", ({ region }) => {
    assert.deepEqual(region, { x: 0, y: 0, width: 1280, height: 720 });
  });
  const other = fixture();
  await expectCode(
    other.broker.bind({ hwnd: "42", region: { x: 1200, y: 0, width: 100, height: 10 } }),
    TARGET_BINDING_ERROR_CODES.INVALID_ARGUMENT,
  );
});

test("issues expiring one-time tickets with agent-safe redemption", async () => {
  const fx = fixture();
  await fx.broker.bind({ hwnd: "42" });
  const issued = await fx.broker.issueLaunchTicket({ bindingRef: "binding-1" });
  assert.deepEqual(issued, { launchTicket: "ticket-1", expiresAt: 1500 });
  const redeemed = await fx.broker.redeem(issued.launchTicket);
  assert.deepEqual(redeemed, { targetRef: "binding-1" });
  assertAgentSafe(redeemed);
  await expectCode(fx.broker.redeem(issued.launchTicket), TARGET_BINDING_ERROR_CODES.TICKET_INVALID);
});

test("expired tickets fail closed and remain consumed", async () => {
  const fx = fixture();
  await fx.broker.bind({ hwnd: "42" });
  await fx.broker.issueLaunchTicket({ bindingRef: "binding-1", ttlMs: 10 });
  fx.setTime(1010);
  await expectCode(fx.broker.redeem("ticket-1"), TARGET_BINDING_ERROR_CODES.TICKET_EXPIRED);
  await expectCode(fx.broker.redeem("ticket-1"), TARGET_BINDING_ERROR_CODES.TICKET_INVALID);
});

test("identity or geometry changes invalidate binding and pending tickets", async () => {
  for (const changed of [
    identity({ pid: 701 }),
    identity({ executableSha256: "b".repeat(64) }),
    identity({ clientWidth: 1279 }),
  ]) {
    const fx = fixture();
    await fx.broker.bind({ hwnd: "42" });
    await fx.broker.issueLaunchTicket({ bindingRef: "binding-1" });
    fx.setIdentity(changed);
    await expectCode(fx.broker.revalidate("binding-1"), TARGET_BINDING_ERROR_CODES.CHANGED);
    await expectCode(fx.broker.revalidate("binding-1"), TARGET_BINDING_ERROR_CODES.NOT_FOUND);
    await expectCode(fx.broker.redeem("ticket-1"), TARGET_BINDING_ERROR_CODES.TICKET_INVALID);
  }
});

test("malformed inspection invalidates an established binding", async () => {
  const fx = fixture();
  await fx.broker.bind({ hwnd: "42" });
  fx.setIdentity({ ...identity(), privateExtra: "must not be accepted" });
  await expectCode(fx.broker.revalidate("binding-1"), TARGET_BINDING_ERROR_CODES.MALFORMED_BRIDGE_DATA);
  await expectCode(fx.broker.revalidate("binding-1"), TARGET_BINDING_ERROR_CODES.NOT_FOUND);
});

test("duplicate generated identifiers fail closed even across namespaces", async () => {
  const fx = fixture({ ids: ["same", "same"] });
  await fx.broker.bind({ hwnd: "42" });
  await expectCode(fx.broker.issueLaunchTicket({ bindingRef: "same" }), TARGET_BINDING_ERROR_CODES.DUPLICATE);
});

test("bridge failures do not disclose native details", async () => {
  const broker = new TargetBindingBroker({
    bridge: {
      async listWindows() { throw new Error("secret C:\\private\\game.exe hwnd=42"); },
      async inspect() { throw new Error("secret pid 700"); },
    },
    idFactory: () => "unused",
  });
  await assert.rejects(broker.listOperatorCandidates(), (error) => {
    assert.equal(error.code, TARGET_BINDING_ERROR_CODES.BRIDGE_FAILURE);
    assert.equal(error.message.includes("secret"), false);
    return true;
  });
  await assert.rejects(broker.bind({ hwnd: "42" }), (error) => {
    assert.equal(error.code, TARGET_BINDING_ERROR_CODES.BRIDGE_FAILURE);
    assert.equal(error.message.includes("700"), false);
    return true;
  });
});
