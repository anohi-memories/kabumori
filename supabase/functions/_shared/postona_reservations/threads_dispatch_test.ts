// G3 Threads reservation dispatch -- contract tests. MOCK_ONLY + DENY-NET (run without --allow-net; global fetch is a
// throwing counter). The store is an in-memory model of the reservation rules (lease CAS, owner / workspace / freeze /
// switch / revoke fence, generation bound at claim) -- NOT the SQL, which does not exist for Threads yet. G4's two
// ports are fakes of the contract in threads_dispatch.ts. No Threads, Meta, Supabase or Vault is reached.
import assert from "node:assert/strict";
import test from "node:test";
import {
  type ClaimedThreadsReservation, dispatchOutcomeOf, runThreadsReservationDelivery, THREADS_DISPATCH_ENABLED, type ThreadsCredentialPort,
  type ThreadsDispatchStore, type ThreadsGenerationCredential, type ThreadsSendOutcome, type ThreadsSendPort,
} from "./threads_dispatch.ts";

let netCalls = 0;
globalThis.fetch = (() => { netCalls += 1; return Promise.reject(new Error("DENY_NET")); }) as typeof fetch;

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const GEN = "d4".repeat(32);

// ---- in-memory model of the reservation store --------------------------------------------------------------
type Row = {
  id: string; provider: string; account: string; owner: string; brand: string; body: string;
  status: "planned" | "claimed" | "published" | "failed" | "uncertain"; lease: string | null; leaseExpired: boolean;
  outcomeCode: string | null; postId: string | null; transport: string | null; boundGeneration: string | null;
};
type World = {
  accountOwner: Map<string, string>; accountBrand: Map<string, string>; brandOwners: Map<string, string[]>;
  frozen: Set<string>; publishOff: Set<string>; revoked: Set<string>; entitlementEnded: Set<string>; generation: Map<string, string>;
};
function model(rows: Partial<Row>[]) {
  let leaseN = 900;
  const world: World = { accountOwner: new Map(), accountBrand: new Map(), brandOwners: new Map(), frozen: new Set(), publishOff: new Set(), revoked: new Set(), entitlementEnded: new Set(), generation: new Map() };
  const table: Row[] = rows.map((r, i) => ({
    id: uuid(i + 1), provider: "threads", account: "th_acct_a", owner: "user_a", brand: "brand_a", body: `本文 ${i + 1}`, status: "planned", lease: null,
    leaseExpired: false, outcomeCode: null, postId: null, transport: null, boundGeneration: null, ...r,
  }));
  for (const r of table) {
    world.accountOwner.set(r.account, world.accountOwner.get(r.account) ?? r.owner);
    world.accountBrand.set(r.account, world.accountBrand.get(r.account) ?? r.brand);
    world.brandOwners.set(r.brand, world.brandOwners.get(r.brand) ?? [r.owner]);
    world.generation.set(r.account, world.generation.get(r.account) ?? GEN);
  }
  const calls: string[] = [];
  const fenceOk = (r: Row) => world.accountOwner.get(r.account) === r.owner && world.accountBrand.get(r.account) === r.brand
    && (world.brandOwners.get(r.brand) ?? []).length === 1 && world.brandOwners.get(r.brand)?.[0] === r.owner
    && !world.frozen.has(r.owner) && !world.entitlementEnded.has(r.owner) && !world.publishOff.has(r.account) && !world.revoked.has(r.account);
  const store: ThreadsDispatchStore = {
    claimDue(_w, _s, limit) {
      calls.push("claimDue");
      const out: ClaimedThreadsReservation[] = [];
      for (const r of table) {
        if (out.length >= limit || r.status !== "planned") continue;
        r.status = "claimed"; r.lease = uuid(++leaseN); r.boundGeneration = world.generation.get(r.account) ?? null;
        out.push({ reservationId: r.id, leaseToken: r.lease, provider: r.provider, socialAccountId: r.account, body: r.body });
      }
      return Promise.resolve(out);
    },
    preflight(id, lease) {
      calls.push("preflight");
      const r = table.find((x) => x.id === id);
      if (!r || r.status !== "claimed" || r.lease !== lease) return Promise.resolve({ verdict: "LEASE_LOST", credentialGeneration: null });
      if (r.leaseExpired) { r.status = "planned"; r.lease = null; return Promise.resolve({ verdict: "RELEASED", credentialGeneration: null }); }
      const now = world.generation.get(r.account) ?? null;
      if (!fenceOk(r) || now !== r.boundGeneration) {
        r.status = "failed"; r.outcomeCode = fenceOk(r) ? "CREDENTIAL_CHANGED" : "NOT_PUBLISHABLE_AT_SEND";
        return Promise.resolve({ verdict: "NOT_PUBLISHABLE", credentialGeneration: null });
      }
      return Promise.resolve({ verdict: "OK", credentialGeneration: now });
    },
    record(id, lease, outcome, postId, code, transport) {
      calls.push("record");
      const r = table.find((x) => x.id === id);
      if (!r || r.lease !== lease || r.status !== "claimed") return Promise.reject(new Error("POSTONA_RESV_LEASE_LOST"));
      if (r.leaseExpired) { r.status = "uncertain"; r.outcomeCode = "LEASE_EXPIRED_AT_FINISH"; return Promise.resolve("lease_lost"); }
      r.status = outcome === "published" ? "published" : outcome === "failed_before_send" ? "failed" : "uncertain";
      r.postId = postId; r.outcomeCode = code; r.transport = transport;
      return Promise.resolve(outcome);
    },
    releaseUnsent(id, lease) {
      calls.push("releaseUnsent");
      const r = table.find((x) => x.id === id);
      if (!r || r.status !== "claimed" || r.lease !== lease) return Promise.resolve("lease_lost");
      r.status = "planned"; r.lease = null;
      return Promise.resolve("released");
    },
  };
  return { store, table, world, calls };
}

// ---- G4 fakes ----------------------------------------------------------------------------------------------
function credentials(world: World, over: Partial<{ answer: (account: string) => ThreadsGenerationCredential | null; afterRead: (account: string) => void }> = {}) {
  const asked: string[] = [];
  const port: ThreadsCredentialPort = {
    available: true,
    credentialFor(account) {
      asked.push(account);
      const answer = over.answer ? over.answer(account)
        : { socialAccountId: account, threadsUserId: "17841400000000001", accessToken: `fake-threads-token-${account}`, generation: world.generation.get(account) ?? GEN };
      over.afterRead?.(account);
      return Promise.resolve(answer);
    },
  };
  return { port, asked };
}
function sender(outcome: ThreadsSendOutcome | ((n: number) => ThreadsSendOutcome | Promise<ThreadsSendOutcome>) = { kind: "published", mediaId: "18000000000000001", readBack: "confirmed" }, transport: "threads" | "simulated" = "simulated") {
  const sent: { userId: string; token: string; text: string }[] = [];
  const port: ThreadsSendPort = {
    available: true, transport,
    async send(credential, text) {
      sent.push({ userId: credential.threadsUserId, token: credential.accessToken, text });
      return typeof outcome === "function" ? await outcome(sent.length) : outcome;
    },
  };
  return { port, sent };
}
const run = (m: ReturnType<typeof model>, c = credentials(m.world), s = sender(), extra: Partial<Parameters<typeof runThreadsReservationDelivery>[0]> = {}) =>
  runThreadsReservationDelivery({ enabled: true, store: m.store, credentials: c.port, sender: s.port, worker: "w1", ...extra });

// ---- tests ---------------------------------------------------------------------------------------------------
test("T0 shipped OFF: disabled, a missing / token-only credential port or an unavailable sender claims nothing and sends nothing", async () => {
  assert.equal(THREADS_DISPATCH_ENABLED, false);
  const cases: [boolean, unknown, unknown][] = [
    [false, undefined, undefined],
    [true, { available: true, accessTokenFor: () => Promise.resolve("t") }, undefined],
    [true, { available: false, credentialFor: () => Promise.resolve(null) }, undefined],
    [true, undefined, { available: false, transport: "simulated", send: () => Promise.reject(new Error("never")) }],
  ];
  for (const [enabled, cred, send] of cases) {
    const m = model([{}]);
    const s = sender();
    const report = await runThreadsReservationDelivery({ enabled, store: m.store, credentials: (cred ?? credentials(m.world).port) as ThreadsCredentialPort,
      sender: (send ?? s.port) as ThreadsSendPort, worker: "w1" });
    assert.deepEqual([report.notAvailable, report.claimed, m.calls.length, s.sent.length], [true, 0, 0, 0]);
  }
});

test("T1 happy path: one send with the account's own credential, recorded published with the media id and the transport", async () => {
  const m = model([{}]);
  const c = credentials(m.world);
  const s = sender();
  const report = await run(m, c, s);
  assert.deepEqual([report.published, report.sends], [1, 1]);
  assert.deepEqual(s.sent, [{ userId: "17841400000000001", token: "fake-threads-token-th_acct_a", text: "本文 1" }]);
  assert.deepEqual([m.table[0].status, m.table[0].postId, m.table[0].transport], ["published", "18000000000000001", "simulated"]);
  assert.deepEqual(m.calls, ["claimDue", "preflight", "record"]);
  assert.deepEqual(c.asked, ["th_acct_a"], "credentialFor once, before the preflight");
});

test("T2 a row already published / uncertain / failed is never claimed again: a second run sends nothing (no resend after unknown)", async () => {
  const m = model([{}, {}, {}]);
  const s = sender((n) => n === 1 ? { kind: "published", mediaId: "18000000000000001", readBack: "confirmed" }
    : n === 2 ? { kind: "unknown", stage: "publish", code: "THREADS_UNAVAILABLE" } : { kind: "not_written", stage: "publish", code: "THREADS_REQUEST_REJECTED" });
  const first = await run(m, credentials(m.world), s);
  assert.deepEqual([first.published, first.uncertain, first.failedBeforeSend, first.sends], [1, 1, 1, 3]);
  const second = await run(m, credentials(m.world), s);
  assert.deepEqual([second.claimed, second.sends, s.sent.length], [0, 0, 3]);
  assert.deepEqual(m.table.map((r) => r.status), ["published", "uncertain", "failed"]);
});

test("T3 the same reservation twice in one claim answer (duplicate) is sent once", async () => {
  const m = model([{}]);
  const s = sender();
  const store: ThreadsDispatchStore = { ...m.store, claimDue: async (w, l, n) => { const once = await m.store.claimDue(w, l, n); return [...once, ...once]; } };
  const report = await runThreadsReservationDelivery({ enabled: true, store, credentials: credentials(m.world).port, sender: s.port, worker: "w1" });
  assert.deepEqual([report.claimed, report.sends, report.skipped, s.sent.length], [2, 1, 1, 1]);
  // even a faulty store that answers OK twice for the same row never gets a second send in one run
  const f = model([{}]);
  const fs = sender();
  const faulty: ThreadsDispatchStore = { ...f.store, claimDue: async (w, l, n) => { const once = await f.store.claimDue(w, l, n); return [...once, ...once]; },
    preflight: () => Promise.resolve({ verdict: "OK", credentialGeneration: GEN }), record: () => Promise.resolve("published") };
  const fr = await runThreadsReservationDelivery({ enabled: true, store: faulty, credentials: credentials(f.world).port, sender: fs.port, worker: "w1" });
  assert.deepEqual([fr.sends, fs.sent.length], [1, 1]);
});

test("T4 two workers at the same time on the same rows: each row is sent exactly once", async () => {
  const m = model([{}, {}, {}, {}]);
  const s = sender((n) => ({ kind: "published", mediaId: String(18000000000000000 + n), readBack: "confirmed" }));
  const [a, b] = await Promise.all([run(m, credentials(m.world), s, { worker: "w1", limit: 3 }), run(m, credentials(m.world), s, { worker: "w2", limit: 3 })]);
  assert.equal(a.sends + b.sends, 4);
  assert.equal(new Set(s.sent.map((x) => x.text)).size, 4, "no text twice");
  assert.ok(m.table.every((r) => r.status === "published"));
});

test("T5 another person / account / workspace: the fence or the credential binding refuses -- nothing is sent", async () => {
  // credential of another account answered by a buggy port
  const m1 = model([{}]);
  const s1 = sender();
  await run(m1, credentials(m1.world, { answer: () => ({ socialAccountId: "th_acct_other", threadsUserId: "17841400000000009", accessToken: "fake-threads-token-other", generation: GEN }) }), s1);
  assert.deepEqual([s1.sent.length, m1.table[0].status, m1.table[0].outcomeCode], [0, "failed", "THREADS_CREDENTIALS_UNAVAILABLE"]);
  // the account moved to another workspace / owner after the claim
  for (const change of [(w: World) => w.accountBrand.set("th_acct_a", "brand_b"), (w: World) => w.accountOwner.set("th_acct_a", "user_b"), (w: World) => w.brandOwners.set("brand_a", ["user_a", "user_c"])]) {
    const m = model([{}]);
    const s = sender();
    const store: ThreadsDispatchStore = { ...m.store, claimDue: async (...args) => { const out = await m.store.claimDue(...args); change(m.world); return out; } };
    const report = await runThreadsReservationDelivery({ enabled: true, store, credentials: credentials(m.world).port, sender: s.port, worker: "w1" });
    assert.deepEqual([report.sends, m.table[0].status, m.table[0].outcomeCode], [0, "failed", "NOT_PUBLISHABLE_AT_SEND"]);
  }
  // an X row (or any other provider) handed to the Threads dispatcher
  const mx = model([{ provider: "x" }]);
  const sx = sender();
  const rx = await run(mx, credentials(mx.world), sx);
  assert.deepEqual([rx.sends, rx.released, mx.table[0].status], [0, 1, "planned"]);
});

test("T6 revoke / publish switch OFF / freeze / entitlement ended after the claim: NOT_PUBLISHABLE, nothing sent", async () => {
  for (const [name, change] of [["revoke", (w: World) => w.revoked.add("th_acct_a")], ["publish off", (w: World) => w.publishOff.add("th_acct_a")],
    ["freeze", (w: World) => w.frozen.add("user_a")], ["entitlement ended", (w: World) => w.entitlementEnded.add("user_a")]] as const) {
    const m = model([{}]);
    const s = sender();
    // the change happens right after the credential was read: the preflight still catches it
    const report = await run(m, credentials(m.world, { afterRead: () => change(m.world) }), s);
    assert.deepEqual([report.sends, m.table[0].status, m.table[0].outcomeCode], [0, "failed", "NOT_PUBLISHABLE_AT_SEND"], name);
    assert.ok(!m.calls.includes("record"), `${name}: the dispatcher records nothing after a refused preflight`);
  }
  // a refused preflight is final even if the store also answered a (matching) generation
  const m2 = model([{}]);
  const s2 = sender();
  const store2: ThreadsDispatchStore = { ...m2.store, preflight: () => Promise.resolve({ verdict: "NOT_PUBLISHABLE", credentialGeneration: GEN }) };
  const r2 = await runThreadsReservationDelivery({ enabled: true, store: store2, credentials: credentials(m2.world).port, sender: s2.port, worker: "w1" });
  assert.deepEqual([r2.sends, r2.skipped, s2.sent.length], [0, 1, 0]);
});

test("T7 credential generation: changed after the claim (refresh) -> CREDENTIAL_CHANGED; a stale / malformed / 32-hex token generation -> CREDENTIAL_GENERATION_CHANGED; nothing sent", async () => {
  const m = model([{}]);
  const s = sender();
  await run(m, credentials(m.world, { afterRead: () => m.world.generation.set("th_acct_a", "e5".repeat(32)) }), s);
  assert.deepEqual([s.sent.length, m.table[0].outcomeCode], [0, "CREDENTIAL_CHANGED"]);
  for (const generation of ["f6".repeat(32), "d4".repeat(16), GEN.toUpperCase(), ""]) {
    const mm = model([{}]);
    const ss = sender();
    await run(mm, credentials(mm.world, { answer: (a) => ({ socialAccountId: a, threadsUserId: "17841400000000001", accessToken: "fake-threads-token-th_acct_a", generation }) }), ss);
    assert.deepEqual([ss.sent.length, mm.table[0].status, mm.table[0].outcomeCode], [0, "failed", "CREDENTIAL_GENERATION_CHANGED"], generation);
  }
  // both sides agree on a malformed generation (retired 32-hex, uppercase): still never sent
  for (const generation of ["d4".repeat(16), GEN.toUpperCase()]) {
    const ma = model([{}]);
    ma.world.generation.set("th_acct_a", generation);
    const sa = sender();
    await run(ma, credentials(ma.world), sa);
    assert.deepEqual([sa.sent.length, ma.table[0].outcomeCode], [0, "CREDENTIAL_GENERATION_CHANGED"], `agreed ${generation}`);
  }
  const mn = model([{}]);
  const sn = sender();
  await run(mn, credentials(mn.world, { answer: () => null }), sn);
  assert.deepEqual([sn.sent.length, mn.table[0].outcomeCode], [0, "THREADS_CREDENTIALS_UNAVAILABLE"]);
});

test("T8 two-step outcomes: unknown container is NOT a post; unknown publish / read-back is uncertain; never sent twice", async () => {
  const table: [ThreadsSendOutcome | (() => Promise<never>), string, string | null, string][] = [
    [{ kind: "not_written", stage: "container", code: "THREADS_TOKEN_INVALID" }, "failed", null, "THREADS_TOKEN_INVALID"],
    [{ kind: "unknown", stage: "container", code: "THREADS_UNAVAILABLE" }, "failed", null, "THREADS_CONTAINER_UNKNOWN_NOT_POSTED"],
    [{ kind: "not_written", stage: "publish", code: "THREADS_RATE_LIMITED" }, "failed", null, "THREADS_RATE_LIMITED"],
    [{ kind: "unknown", stage: "publish", code: "THREADS_UNAVAILABLE" }, "uncertain", null, "THREADS_UNAVAILABLE"],
    [{ kind: "unknown", stage: "readback", code: "THREADS_UNAVAILABLE" }, "uncertain", null, "THREADS_UNAVAILABLE"],
    [{ kind: "published", mediaId: "18000000000000001", readBack: "unknown" }, "uncertain", null, "THREADS_READBACK_UNKNOWN"],
    [{ kind: "published", mediaId: "18000000000000001", readBack: "mismatch" }, "uncertain", null, "THREADS_READBACK_MISMATCH"],
    [{ kind: "published", mediaId: "0123", readBack: "confirmed" }, "uncertain", null, "THREADS_MEDIA_ID_INVALID"],
    [() => Promise.reject(new Error("boom")), "uncertain", null, "THREADS_SENDER_THREW"],
  ];
  for (const [outcome, status, postId, code] of table) {
    const m = model([{}]);
    const s = sender(typeof outcome === "function" ? outcome : () => outcome);
    const report = await run(m, credentials(m.world), s);
    assert.deepEqual([m.table[0].status, m.table[0].postId, m.table[0].outcomeCode, s.sent.length, report.sends], [status, postId, code, 1, 1], code);
    assert.equal((await run(m, credentials(m.world), s)).sends, 0, `${code}: never resent`);
  }
  // a malformed outcome never becomes a success
  for (const odd of [null, {}, { kind: "published" }, { kind: "not_written", stage: "readback", code: "X" }, { kind: "sent", mediaId: "1" }]) {
    assert.notEqual(dispatchOutcomeOf(odd).outcome, "published", JSON.stringify(odd));
    assert.notEqual(dispatchOutcomeOf(odd).outcome, "failed_before_send", JSON.stringify(odd));
  }
});

test("T9 simulated vs real transport is recorded as such; a recorded result is the only success; a lost record is uncertain", async () => {
  const sim = model([{}]);
  await run(sim, credentials(sim.world), sender(undefined, "simulated"));
  assert.equal(sim.table[0].transport, "simulated");
  const real = model([{}]);
  const odd = sender(undefined, "threads");
  await run(real, credentials(real.world), odd);
  assert.equal(real.table[0].transport, "threads");
  const weird = model([{}]);
  const ws = sender();
  await run(weird, credentials(weird.world), { port: { ...ws.port, transport: "THREADS" as never }, sent: ws.sent });
  assert.equal(weird.table[0].transport, "simulated", "only exactly 'threads' is the real transport");
  const lost = model([{}]);
  const store: ThreadsDispatchStore = { ...lost.store, record: () => Promise.reject(new Error("COMMIT lost")) };
  const report = await runThreadsReservationDelivery({ enabled: true, store, credentials: credentials(lost.world).port, sender: sender().port, worker: "w1" });
  assert.deepEqual([report.published, report.uncertain], [0, 1]);
  const late = model([{}]);
  const storeLate: ThreadsDispatchStore = { ...late.store, preflight: async (...a) => { const p = await late.store.preflight(...a); late.table[0].leaseExpired = true; return p; } };
  const r2 = await runThreadsReservationDelivery({ enabled: true, store: storeLate, credentials: credentials(late.world).port, sender: sender().port, worker: "w1" });
  assert.deepEqual([r2.published, r2.uncertain, late.table[0].status, late.table[0].outcomeCode], [0, 1, "uncertain", "LEASE_EXPIRED_AT_FINISH"]);
});

test("T10 not sent -> handed back: preflight unreadable / lease ran out before the send / graceful stop; nothing recorded as sent", async () => {
  const m = model([{}, {}]);
  const store: ThreadsDispatchStore = { ...m.store, preflight: () => Promise.reject(new Error("down")) };
  const r = await runThreadsReservationDelivery({ enabled: true, store, credentials: credentials(m.world).port, sender: sender().port, worker: "w1" });
  assert.deepEqual([r.released, r.sends], [2, 0]);
  assert.ok(m.table.every((x) => x.status === "planned"));
  const e = model([{ leaseExpired: true }]);
  const re = await run(e);
  assert.deepEqual([re.released, re.sends, e.table[0].status], [1, 0, "planned"]);
  const st = model([{}, {}, {}]);
  let n = 0;
  const rs = await run(st, credentials(st.world), sender(), { shouldStop: () => ++n > 1 });
  assert.deepEqual([rs.stopped, rs.sends, rs.released], [true, 1, 2]);
});

test("T11 no token or text in the report; the source has no network client, Vault, console or env", async () => {
  const m = model([{}]);
  const report = await run(m);
  assert.ok(!JSON.stringify(report).includes("fake-threads-token") && !JSON.stringify(report).includes("本文"));
  const source = await Deno.readTextFile(new URL("./threads_dispatch.ts", import.meta.url));
  for (const banned of ["fetch(", "vault", "console.", "Deno.env", "graph.threads.net"]) assert.ok(!source.includes(banned), banned);
});

test("T12 deny-net held", () => assert.equal(netCalls, 0));
