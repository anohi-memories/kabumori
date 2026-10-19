// Unit tests of the worker TEST FIXTURE: the proposed pre-publish hook composition (MOCK_ONLY, DENY-NET).
import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadsDispatchStore, ThreadsPreflight } from "../../../functions/_shared/postona_reservations/threads_dispatch.ts";
import { createFixtureTwoStepSendPort, PR337_DEPLOYABLE_SHAPE, withPrepublishRecheck } from "../fixture/threads_worker_fixture.ts";

let net = 0;
globalThis.fetch = (() => { net += 1; return Promise.reject(new Error("DENY_NET")); }) as typeof fetch;
const GEN = "e5".repeat(32);
const cred = { threadsUserId: "17841400000000001", accessToken: "fake-threads-token-0001" };

function store(answers: ThreadsPreflight[]) {
  const calls: string[] = [];
  const s: ThreadsDispatchStore = {
    claimDue: () => Promise.resolve([]),
    preflight: (id) => { calls.push(id); return Promise.resolve(answers.shift() ?? { verdict: "LEASE_LOST", credentialGeneration: null }); },
    record: () => Promise.resolve("published"),
    releaseUnsent: () => Promise.resolve("released"),
  };
  return { s, calls };
}

test("the hook re-runs the preflight for exactly the row in flight and needs OK + the same generation", async () => {
  for (const [second, publishes] of [[{ verdict: "OK", credentialGeneration: GEN }, 1], [{ verdict: "OK", credentialGeneration: "f6".repeat(32) }, 0],
    [{ verdict: "NOT_PUBLISHABLE", credentialGeneration: null }, 0], [{ verdict: "RELEASED", credentialGeneration: null }, 0]] as const) {
    const st = store([{ verdict: "OK", credentialGeneration: GEN }, second]);
    const send = createFixtureTwoStepSendPort({ honourHook: true });
    const w = withPrepublishRecheck(st.s, send.port);
    await w.store.preflight("row-1", "lease-1");
    const out = await w.sender.send(cred, "本文");
    assert.equal(send.log.publishes, publishes, JSON.stringify(second));
    assert.deepEqual(st.calls, ["row-1", "row-1"]);
    if (!publishes) assert.deepEqual(out, { kind: "not_written", stage: "publish", code: "THREADS_PREPUBLISH_REFUSED" });
  }
});

test("a send without a fresh OK preflight (a second send, or after a refused one) is never allowed by a stale row", async () => {
  const st = store([{ verdict: "OK", credentialGeneration: GEN }, { verdict: "OK", credentialGeneration: GEN }, { verdict: "OK", credentialGeneration: GEN }]);
  const send = createFixtureTwoStepSendPort({ honourHook: true });
  const w = withPrepublishRecheck(st.s, send.port);
  await w.store.preflight("row-1", "lease-1");
  await w.sender.send(cred, "一回目");
  await w.sender.send(cred, "二回目");
  assert.equal(send.log.publishes, 1, "the second send has no row in flight");
  const refused = store([{ verdict: "NOT_PUBLISHABLE", credentialGeneration: null }]);
  const s2 = createFixtureTwoStepSendPort({ honourHook: true });
  const w2 = withPrepublishRecheck(refused.s, s2.port);
  await w2.store.preflight("row-2", "lease-2");
  await w2.sender.send(cred, "拒否の後");
  assert.equal(s2.log.publishes, 0);
});

test("a throwing / failing re-check refuses; the deployable PR #337 shape is unavailable; no network", async () => {
  const throwing: ThreadsDispatchStore = { ...store([]).s, preflight: (() => { let n = 0; return () => (++n === 1 ? Promise.resolve({ verdict: "OK" as const, credentialGeneration: GEN }) : Promise.reject(new Error("down"))); })() };
  const send = createFixtureTwoStepSendPort({ honourHook: true });
  const w = withPrepublishRecheck(throwing, send.port);
  await w.store.preflight("row-1", "lease-1");
  await w.sender.send(cred, "本文");
  assert.equal(send.log.publishes, 0);
  assert.deepEqual([PR337_DEPLOYABLE_SHAPE.credentials.available, PR337_DEPLOYABLE_SHAPE.sender.available, PR337_DEPLOYABLE_SHAPE.sender.transport], [false, false, "threads"]);
  assert.equal(net, 0);
});
