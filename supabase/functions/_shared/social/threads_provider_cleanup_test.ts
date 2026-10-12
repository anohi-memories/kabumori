import assert from "node:assert/strict";
import test from "node:test";
import {
  createThreadsCleanupRpcStore,
  createThreadsProviderCleanupAdapter,
  type ProviderCleanupContext,
  type ThreadsCleanupStore,
} from "./threads_provider_cleanup.ts";

const USER = "00000000-0000-4000-8000-0000000000a1";
type Over = Partial<{ state: unknown; cleanup: unknown; throwState: boolean; throwCleanup: boolean; during: () => void }>;

/** A store that records every call (and the ownership questions, through `events`). */
const store = (over: Over = {}, events: string[] = []) => {
  const signals: AbortSignal[] = [];
  const s: ThreadsCleanupStore = {
    connectionState: (u, signal) => {
      events.push(`state:${u}`);
      signals.push(signal);
      over.during?.();
      return over.throwState ? Promise.reject(new Error("lost")) : Promise.resolve("state" in over ? over.state : "connected");
    },
    cleanup: (u, signal) => {
      events.push(`cleanup:${u}`);
      signals.push(signal);
      over.during?.();
      return over.throwCleanup ? Promise.reject(new Error("lost")) : Promise.resolve("cleanup" in over ? over.cleanup : { outcome: "local_removed_remote_unverified", code: "LOCAL_REMOVED" });
    },
  };
  return { s, events, signals };
};

/** G5's context: answers `owned` in order (the last one repeats), records each question in `events`. */
const context = (owned: unknown[] = [true], events: string[] = []) => {
  const abort = new AbortController();
  let i = 0;
  const ctx: ProviderCleanupContext = {
    signal: abort.signal,
    stillOwned: () => {
      events.push("owned?");
      const answer = owned[Math.min(i++, owned.length - 1)];
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer as boolean);
    },
  };
  return { ctx, abort, events };
};

test("structurally G5's repaired ProviderCleanupAdapter: provider 'threads', hasConnection(user, ctx), cleanup(user, ctx)", () => {
  const adapter = createThreadsProviderCleanupAdapter(store().s);
  assert.equal(adapter.provider, "threads");
  assert.equal(adapter.hasConnection.length, 2);
  assert.equal(adapter.cleanup.length, 2);
  assert.ok(Object.isFrozen(adapter));
});

test("hasConnection: connected / not connected / anything else, a throw, or an abandoned read is unreadable (null)", async () => {
  assert.equal(await createThreadsProviderCleanupAdapter(store({ state: "connected" }).s).hasConnection(USER, context().ctx), true);
  assert.equal(await createThreadsProviderCleanupAdapter(store({ state: "not_connected" }).s).hasConnection(USER, context().ctx), false);
  for (const state of ["invalid", null, true, { state: "connected" }]) {
    assert.equal(await createThreadsProviderCleanupAdapter(store({ state }).s).hasConnection(USER, context().ctx), null, JSON.stringify(state));
  }
  assert.equal(await createThreadsProviderCleanupAdapter(store({ throwState: true }).s).hasConnection(USER, context().ctx), null);
  // The port stopped waiting before the read started: the database is not even asked.
  const before = store();
  const c1 = context();
  c1.abort.abort();
  assert.equal(await createThreadsProviderCleanupAdapter(before.s).hasConnection(USER, c1.ctx), null);
  assert.deepEqual(before.events, []);
  // ... or while it ran: its (late) answer is not used.
  const c2 = context();
  const during = store({ state: "not_connected", during: () => c2.abort.abort() });
  assert.equal(await createThreadsProviderCleanupAdapter(during.s).hasConnection(USER, c2.ctx), null);
  assert.equal(during.signals[0], c2.ctx.signal, "the read carries the port's signal");
  const malformed = store();
  assert.equal(await createThreadsProviderCleanupAdapter(malformed.s).hasConnection("not-a-uuid", context().ctx), null);
  assert.deepEqual(malformed.events, [], "a malformed id never reaches the database");
  // Reading never asks ownership (it changes nothing; the port asks before cleanup).
  const c3 = context();
  await createThreadsProviderCleanupAdapter(store().s).hasConnection(USER, c3.ctx);
  assert.deepEqual(c3.events, []);
});

test("cleanup asks ownership immediately before the one mutation and again after it", async () => {
  const events: string[] = [];
  const { ctx } = context([true], events);
  const s = store({}, events);
  assert.equal(await createThreadsProviderCleanupAdapter(s.s).cleanup(USER, ctx), "local_removed_remote_unverified");
  assert.deepEqual(events, ["owned?", `cleanup:${USER}`, "owned?"]);
  assert.equal(s.signals[0], ctx.signal, "the removal carries the port's signal");
});

test("not the owner (or abandoned) before the mutation: blocked, and the database is never called", async () => {
  for (const answer of [false, "true", 1, null, undefined, new Error("lost")]) {
    const s = store();
    assert.equal(await createThreadsProviderCleanupAdapter(s.s).cleanup(USER, context([answer]).ctx), "blocked", String(answer));
    assert.deepEqual(s.events, [], `${String(answer)}: nothing sent`);
  }
  const s = store();
  const c = context([true]);
  c.abort.abort();
  assert.equal(await createThreadsProviderCleanupAdapter(s.s).cleanup(USER, c.ctx), "blocked");
  assert.deepEqual(s.events, [], "aborted: nothing sent");
  assert.deepEqual(c.events, [], "aborted: not even asked");
  // The port gave up while ownership was being asked (true arrives after the abort).
  const late = context([true]);
  const lateOwned = late.ctx.stillOwned;
  const lateCtx: ProviderCleanupContext = { signal: late.ctx.signal, stillOwned: async () => { const v = await lateOwned(); late.abort.abort(); return v; } };
  const s2 = store();
  assert.equal(await createThreadsProviderCleanupAdapter(s2.s).cleanup(USER, lateCtx), "blocked");
  assert.deepEqual(s2.events, []);
});

test("after the mutation was sent: lost lease, abort, throw, or an unknown answer is reconciliation_required, never replayed", async () => {
  // The lease was lost while the removal ran (it may have committed).
  const lost = store();
  assert.equal(await createThreadsProviderCleanupAdapter(lost.s).cleanup(USER, context([true, false]).ctx), "reconciliation_required");
  assert.deepEqual(lost.events, [`cleanup:${USER}`], "called once");
  // The port stopped waiting while the removal ran.
  const c = context([true]);
  const aborted = store({ during: () => c.abort.abort() });
  assert.equal(await createThreadsProviderCleanupAdapter(aborted.s).cleanup(USER, c.ctx), "reconciliation_required");
  // A lost answer (network, abort error) may have committed.
  const thrown = store({ throwCleanup: true });
  assert.equal(await createThreadsProviderCleanupAdapter(thrown.s).cleanup(USER, context().ctx), "reconciliation_required");
  assert.deepEqual(thrown.events, [`cleanup:${USER}`], "called once, not retried");
  // The database said it removed nothing: that stays blocked even if the lease is gone now.
  const refused = store({ cleanup: { outcome: "blocked", code: "LEASE_NOT_HELD" } });
  assert.equal(await createThreadsProviderCleanupAdapter(refused.s).cleanup(USER, context([true, false]).ctx), "blocked");
});

test("cleanup: only the three answers the database can honestly give; never confirmed_remote_revoked", async () => {
  for (const outcome of ["local_removed_remote_unverified", "reconciliation_required", "blocked"]) {
    assert.equal(await createThreadsProviderCleanupAdapter(store({ cleanup: { outcome, code: "X" } }).s).cleanup(USER, context().ctx), outcome);
  }
  // Even if a store claimed a confirmed remote revoke, nothing here can verify it.
  assert.equal(await createThreadsProviderCleanupAdapter(store({ cleanup: { outcome: "confirmed_remote_revoked" } }).s).cleanup(USER, context().ctx), "reconciliation_required");
  for (const cleanup of [null, "ok", [], {}, { outcome: "done" }]) {
    assert.equal(await createThreadsProviderCleanupAdapter(store({ cleanup }).s).cleanup(USER, context().ctx), "reconciliation_required", JSON.stringify(cleanup));
  }
  const malformed = store();
  assert.equal(await createThreadsProviderCleanupAdapter(malformed.s).cleanup("x", context().ctx), "blocked");
  assert.deepEqual(malformed.events, []);
});

test("the RPC store sends only the user id (with the port's signal) to the two owner-only functions; a refusal is a throw (fail closed)", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const ok = createThreadsCleanupRpcStore({ supabaseUrl: "https://p.example", apiKey: "k", bearer: "b" }, (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(url.endsWith("state") ? "connected" : { outcome: "blocked", code: "DELETION_NOT_IN_PROGRESS" }), { status: 200 }));
  });
  const signal = new AbortController().signal;
  assert.equal(await ok.connectionState(USER, signal), "connected");
  assert.deepEqual(await ok.cleanup(USER, signal), { outcome: "blocked", code: "DELETION_NOT_IN_PROGRESS" });
  assert.deepEqual(calls.map((c) => c.url), ["https://p.example/rest/v1/rpc/threads_provider_connection_state", "https://p.example/rest/v1/rpc/cleanup_threads_provider_footprint"]);
  for (const c of calls) {
    assert.deepEqual(JSON.parse(String(c.init?.body)), { p_user_id: USER });
    assert.equal(c.init?.signal, signal);
    assert.equal(c.init?.redirect, "manual");
  }
  const refused = createThreadsCleanupRpcStore({ supabaseUrl: "https://p.example", apiKey: "k", bearer: "b" }, () => Promise.resolve(new Response('{"code":"42501"}', { status: 403 })));
  const adapter = createThreadsProviderCleanupAdapter(refused);
  assert.equal(await adapter.hasConnection(USER, context().ctx), null, "not granted yet: unreadable, so G5 stops for reconciliation");
  assert.equal(await adapter.cleanup(USER, context().ctx), "reconciliation_required");
});
