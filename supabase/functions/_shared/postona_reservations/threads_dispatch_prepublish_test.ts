// Pre-publish re-check (beforePublish) of the G3 Threads dispatcher -- G3 Issue #318 TASK 6/50. MOCK_ONLY + DENY-NET.
// The store is an in-memory model of 007's preflight (fence + bound generation + lease; refusals recorded by the
// store); the send port is a fake of the PROPOSED G4 contract (container -> wait -> beforePublish -> publish). Every
// would-be publish request is counted. No network, database, token or Threads.
import assert from "node:assert/strict";
import test from "node:test";
import {
  runThreadsReservationDelivery, type ThreadsCredentialPort, type ThreadsDispatchStore, type ThreadsPreflight, type ThreadsSendHooks,
  type ThreadsSendOutcome, type ThreadsSendPort,
} from "./threads_dispatch.ts";

let net = 0;
globalThis.fetch = (() => { net += 1; return Promise.reject(new Error("DENY_NET")); }) as typeof fetch;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const GEN = "a7".repeat(32);

type World = { allowed: boolean; generation: string; refreshing: boolean; lostLease: boolean };
function model(n = 1) {
  const world: World = { allowed: true, generation: GEN, refreshing: false, lostLease: false };
  const rows = Array.from({ length: n }, (_, i) => ({ id: uuid(i + 1), status: "planned", lease: "", bound: "", code: null as string | null, postId: null as string | null }));
  let leaseN = 500;
  const calls: string[] = [];
  let preflightGate: ((call: number) => Promise<void>) | null = null;
  let preflightCalls = 0;
  const store: ThreadsDispatchStore = {
    claimDue() {
      calls.push("claim");
      const out = rows.filter((r) => r.status === "planned").map((r) => {
        r.status = "claimed"; r.lease = uuid(++leaseN); r.bound = world.generation;
        return { reservationId: r.id, leaseToken: r.lease, provider: "threads", socialAccountId: "th_acct", body: `本文 ${r.id.slice(-2)}` };
      });
      return Promise.resolve(out);
    },
    async preflight(id, lease): Promise<ThreadsPreflight> {
      calls.push("preflight");
      preflightCalls += 1;
      if (preflightGate) await preflightGate(preflightCalls);
      const r = rows.find((x) => x.id === id)!;
      if (r.status !== "claimed" || r.lease !== lease || world.lostLease) return { verdict: "LEASE_LOST", credentialGeneration: null };
      if (world.refreshing) { r.status = "planned"; r.lease = ""; return { verdict: "RELEASED", credentialGeneration: null }; }
      if (!world.allowed) { r.status = "failed"; r.code = "NOT_PUBLISHABLE_AT_SEND"; return { verdict: "NOT_PUBLISHABLE", credentialGeneration: null }; }
      if (world.generation !== r.bound) { r.status = "failed"; r.code = "CREDENTIAL_CHANGED"; return { verdict: "NOT_PUBLISHABLE", credentialGeneration: null }; }
      return { verdict: "OK", credentialGeneration: world.generation };
    },
    record(id, lease, outcome, postId, code) {
      calls.push("record");
      const r = rows.find((x) => x.id === id)!;
      if (r.status !== "claimed" || r.lease !== lease) return Promise.reject(new Error("POSTONA_THREADS_RESV_LEASE_LOST"));
      r.status = outcome === "published" ? "published" : outcome === "failed_before_send" ? "failed" : "uncertain";
      r.postId = postId; r.code = code;
      return Promise.resolve(outcome);
    },
    releaseUnsent(id, lease) {
      const r = rows.find((x) => x.id === id)!;
      if (r.status !== "claimed" || r.lease !== lease) return Promise.resolve("lease_lost");
      r.status = "planned"; r.lease = "";
      return Promise.resolve("released");
    },
  };
  const credentials: ThreadsCredentialPort = {
    available: true,
    credentialFor: (a) => Promise.resolve({ socialAccountId: a, threadsUserId: "17841400000000001", accessToken: "fake-threads-token-0001", generation: world.generation }),
  };
  return { world, rows, store, credentials, calls, setPreflightGate: (g: typeof preflightGate) => { preflightGate = g; } };
}

/** Fake of the PROPOSED G4 send: container, wait (duringWait), beforePublish, publish. */
function port(opts: { duringWait?: () => void | Promise<void>; honour?: "yes" | "ignore" | "none"; afterHook?: () => void; outcome?: () => ThreadsSendOutcome; keepHook?: (h: ThreadsSendHooks) => void } = {}) {
  const log = { containers: 0, publishes: 0, hookAnswers: [] as boolean[], tokensSeenByHook: 0 };
  let media = 18000000000000700;
  const p: ThreadsSendPort = {
    available: true,
    transport: "simulated",
    async send(_c, _t, hooks) {
      log.containers += 1;
      if (opts.duringWait) await opts.duringWait();
      if (hooks && opts.keepHook) opts.keepHook(hooks);
      if ((opts.honour ?? "yes") !== "none" && hooks) {
        const ok = await hooks.beforePublish().catch(() => false);
        log.hookAnswers.push(ok);
        if (!ok && (opts.honour ?? "yes") === "yes") return { kind: "not_written", stage: "publish", code: "THREADS_PREPUBLISH_REFUSED" };
      }
      opts.afterHook?.();
      log.publishes += 1;
      return opts.outcome?.() ?? { kind: "published", mediaId: String(++media), readBack: "confirmed" };
    },
  };
  return { p, log };
}
const run = (m: ReturnType<typeof model>, s: ThreadsSendPort, extra: Record<string, unknown> = {}) =>
  runThreadsReservationDelivery({ enabled: true, store: m.store, credentials: m.credentials, sender: s, worker: "w1", ...extra });

test("P1 nothing changed during the container wait: the hook re-runs the preflight once, answers true, one publish", async () => {
  const m = model();
  const s = port();
  const r = await run(m, s.p);
  assert.deepEqual([s.log.publishes, s.log.hookAnswers, r.prepublishRechecks, r.prepublishRefused, r.published], [1, [true], 1, 0, 1]);
  assert.deepEqual(m.calls, ["claim", "preflight", "preflight", "record"]);
  assert.equal(m.rows[0].status, "published");
});

test("P2 changes during the wait: owner / entitlement / freeze (store refuses), generation rotated, refresh started, lease lost -> 0 publishes, recorded once, counted right", async () => {
  const cases: [string, (w: World) => void, string, string | null, keyof Awaited<ReturnType<typeof run>>][] = [
    ["not allowed (owner/G4/G5/freeze/switch)", (w) => { w.allowed = false; }, "failed", "NOT_PUBLISHABLE_AT_SEND", "skipped"],
    ["generation rotated", (w) => { w.generation = "b8".repeat(32); }, "failed", "CREDENTIAL_CHANGED", "skipped"],
    ["refresh in progress", (w) => { w.refreshing = true; }, "planned", null, "released"],
    ["lease lost", (w) => { w.lostLease = true; }, "claimed", null, "skipped"],
  ];
  for (const [label, change, status, code, counter] of cases) {
    const m = model();
    const s = port({ duringWait: () => change(m.world) });
    const r = await run(m, s.p);
    assert.equal(s.log.publishes, 0, label);
    assert.deepEqual([m.rows[0].status, m.rows[0].code], [status, code], label);
    assert.equal(m.calls.filter((c) => c === "record").length, 0, `${label}: the store already decided; nothing recorded again`);
    assert.deepEqual([r.prepublishRefused, r[counter], r.uncertain, r.published], [1, 1, 0, 0], label);
  }
});

test("P3 the hook's re-check is unreadable / times out / answers OK with another generation -> 0 publishes, the still-claimed row recorded failed_before_send", async () => {
  for (const [label, setup, code] of [
    ["throws", (m: ReturnType<typeof model>) => m.setPreflightGate((n) => n === 2 ? Promise.reject(new Error("db down")) : Promise.resolve()), "THREADS_PREPUBLISH_UNVERIFIED"],
    ["times out", (m: ReturnType<typeof model>) => m.setPreflightGate((n) => n === 2 ? new Promise<void>((resolve) => setTimeout(resolve, 200)) : Promise.resolve()), "THREADS_PREPUBLISH_UNVERIFIED"],
  ] as const) {
    const m = model();
    setup(m);
    const s = port();
    const r = await run(m, s.p, { prepublishTimeoutMs: 20 });
    assert.deepEqual([s.log.publishes, m.rows[0].status, m.rows[0].code, r.failedBeforeSend, r.prepublishRefused], [0, "failed", code, 1, 1], label);
  }
  // a store that answers OK with a different generation (credential read before a rotation the store does not bind)
  const m = model();
  const st: ThreadsDispatchStore = { ...m.store, preflight: (() => { let n = 0; return (id: string, l: string) => (++n === 1 ? m.store.preflight(id, l) : Promise.resolve({ verdict: "OK" as const, credentialGeneration: "c9".repeat(32) })); })() };
  const s = port();
  const r = await runThreadsReservationDelivery({ enabled: true, store: st, credentials: m.credentials, sender: s.p, worker: "w1" });
  assert.deepEqual([s.log.publishes, m.rows[0].code, r.failedBeforeSend], [0, "CREDENTIAL_GENERATION_CHANGED", 1]);
});

test("P4 a late hook call (after the send returned) and a second call get no permission; the hook never carries the token", async () => {
  const m = model();
  let kept: ThreadsSendHooks | null = null;
  const s = port({ keepHook: (h) => { kept = h; } });
  await run(m, s.p);
  assert.equal(await kept!.beforePublish(), false, "after the send returned");
  assert.ok(!JSON.stringify(kept).includes("fake-threads-token"), "no token in the hook object");
  assert.equal(Object.keys(kept!).join(","), "beforePublish");
});

test("P5 a port that IGNORES a refusal and publishes anyway: what it says happened is recorded attempt (never hidden); a port without hook support behaves as before", async () => {
  const m = model();
  const s = port({ duringWait: () => { m.world.allowed = false; }, honour: "ignore" });
  const r = await run(m, s.p);
  assert.deepEqual([s.log.publishes, s.log.hookAnswers], [1, [false]]);
  assert.equal(m.calls.filter((c) => c === "record").length, 1, "the publish is recorded (attempt), not swallowed");
  assert.equal(r.uncertain, 1, "the store had already failed the row: the dispatcher counts the publish as uncertain, never as published");
  const m2 = model();
  const s2 = port({ honour: "none" });
  const r2 = await run(m2, s2.p);
  assert.deepEqual([s2.log.publishes, r2.prepublishRechecks, r2.published], [1, 0, 1], "PR #337 as it is today (no hook call)");
});

test("P6 a freeze AFTER the hook (inside the publish request) is published once and never resent; unknown publish -> uncertain, never resent; readback mismatch -> uncertain", async () => {
  const late = model();
  const s = port({ afterHook: () => { late.world.allowed = false; } });
  const r = await run(late, s.p);
  assert.deepEqual([s.log.publishes, r.published, late.rows[0].status], [1, 1, "published"], "late freeze: recorded as it happened (007 marks after_freeze)");
  for (const [outcome, status] of [[{ kind: "unknown", stage: "publish", code: "THREADS_UNAVAILABLE" }, "uncertain"], [{ kind: "published", mediaId: "18000000000000999", readBack: "mismatch" }, "uncertain"]] as const) {
    const m = model();
    const sp = port({ outcome: () => outcome as ThreadsSendOutcome });
    await run(m, sp.p);
    assert.equal(m.rows[0].status, status);
    assert.equal((await run(m, sp.p)).sends, 0, "never resent");
    assert.equal(sp.log.publishes, 1);
  }
});

test("P7 two workers over the same rows: each row is published at most once, each hook re-checks its own row", async () => {
  const m = model(6);
  const s = port();
  const [a, b] = await Promise.all([run(m, s.p, { worker: "wa" }), run(m, s.p, { worker: "wb" })]);
  assert.equal(s.log.publishes, 6);
  assert.equal(a.prepublishRechecks + b.prepublishRechecks, 6);
  assert.ok(m.rows.every((r) => r.status === "published"));
});

test("P8 shipped OFF and the deployable G4 ports unavailable: nothing is claimed, no hook, no network", async () => {
  const m = model();
  const s = port();
  for (const [enabled, sender, credentials] of [[false, s.p, m.credentials], [true, { ...s.p, available: false }, m.credentials], [true, s.p, { ...m.credentials, available: false }]] as const) {
    const r = await runThreadsReservationDelivery({ enabled, store: m.store, credentials, sender, worker: "w1" });
    assert.deepEqual([r.notAvailable, r.claimed, r.prepublishRechecks], [true, 0, 0]);
  }
  assert.equal(s.log.containers, 0);
  assert.equal(net, 0);
});

test("P9 the row is still claimed after the send (the record was lost): a hook call after the send, or a re-check that answers after it, never grants", async () => {
  const m = model();
  const lostRecord: ThreadsDispatchStore = { ...m.store, record: () => Promise.reject(new Error("COMMIT lost")) };
  let kept: ThreadsSendHooks | null = null;
  let pending: Promise<boolean> | null = null;
  const sender: ThreadsSendPort = {
    available: true, transport: "simulated",
    send(_c, _t, hooks) {
      kept = hooks ?? null;
      pending = hooks ? hooks.beforePublish() : null; // started, not awaited: it answers after the send returned
      return Promise.resolve({ kind: "not_written", stage: "container", code: "THREADS_CONTAINER_REJECTED" });
    },
  };
  m.setPreflightGate((n) => n === 2 ? new Promise<void>((resolve) => setTimeout(resolve, 30)) : Promise.resolve());
  await runThreadsReservationDelivery({ enabled: true, store: lostRecord, credentials: m.credentials, sender, worker: "w1", prepublishTimeoutMs: 1000 });
  assert.equal(m.rows[0].status, "claimed", "the lost record left the row claimed (its lease would fence it later)");
  assert.equal(await pending!, false, "a re-check that answers after the send returned grants nothing");
  m.setPreflightGate(null);
  const preflightsBefore = m.calls.filter((c) => c === "preflight").length;
  assert.equal(await kept!.beforePublish(), false, "a call after the send returned grants nothing, even though the store would still say OK");
  assert.equal(m.calls.filter((c) => c === "preflight").length, preflightsBefore,
    "and it does not even run the store's preflight (which could hand back a row that MAY have been sent)");
});
