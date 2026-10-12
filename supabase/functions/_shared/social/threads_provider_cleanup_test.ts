import assert from "node:assert/strict";
import test from "node:test";
import {
  createThreadsCleanupRpcStore,
  createThreadsProviderCleanupAdapter,
  type ThreadsCleanupStore,
} from "./threads_provider_cleanup.ts";

const USER = "00000000-0000-4000-8000-0000000000a1";
const store = (over: Partial<{ state: unknown; cleanup: unknown; throwState: boolean; throwCleanup: boolean }> = {}) => {
  const calls: string[] = [];
  const s: ThreadsCleanupStore = {
    connectionState: (u) => { calls.push(`state:${u}`); return over.throwState ? Promise.reject(new Error("lost")) : Promise.resolve("state" in over ? over.state : "connected"); },
    cleanup: (u) => { calls.push(`cleanup:${u}`); return over.throwCleanup ? Promise.reject(new Error("lost")) : Promise.resolve("cleanup" in over ? over.cleanup : { outcome: "local_removed_remote_unverified", code: "LOCAL_REMOVED" }); },
  };
  return { s, calls };
};

test("structurally G5's ProviderCleanupAdapter: provider 'threads', hasConnection, cleanup", () => {
  const adapter = createThreadsProviderCleanupAdapter(store().s);
  assert.equal(adapter.provider, "threads");
  assert.equal(typeof adapter.hasConnection, "function");
  assert.equal(typeof adapter.cleanup, "function");
  assert.ok(Object.isFrozen(adapter));
});

test("hasConnection: connected / not connected / anything else is unreadable (null)", async () => {
  assert.equal(await createThreadsProviderCleanupAdapter(store({ state: "connected" }).s).hasConnection(USER), true);
  assert.equal(await createThreadsProviderCleanupAdapter(store({ state: "not_connected" }).s).hasConnection(USER), false);
  for (const state of ["invalid", null, true, { state: "connected" }]) {
    assert.equal(await createThreadsProviderCleanupAdapter(store({ state }).s).hasConnection(USER), null, JSON.stringify(state));
  }
  assert.equal(await createThreadsProviderCleanupAdapter(store({ throwState: true }).s).hasConnection(USER), null);
  const s = store();
  assert.equal(await createThreadsProviderCleanupAdapter(s.s).hasConnection("not-a-uuid"), null);
  assert.deepEqual(s.calls, [], "a malformed id never reaches the database");
});

test("cleanup: only the three answers the database can honestly give; never confirmed_remote_revoked", async () => {
  for (const outcome of ["local_removed_remote_unverified", "reconciliation_required", "blocked"]) {
    assert.equal(await createThreadsProviderCleanupAdapter(store({ cleanup: { outcome, code: "X" } }).s).cleanup(USER), outcome);
  }
  // Even if a store claimed a confirmed remote revoke, nothing here can verify it.
  assert.equal(await createThreadsProviderCleanupAdapter(store({ cleanup: { outcome: "confirmed_remote_revoked" } }).s).cleanup(USER), "reconciliation_required");
  for (const cleanup of [null, "ok", [], {}, { outcome: "done" }]) {
    assert.equal(await createThreadsProviderCleanupAdapter(store({ cleanup }).s).cleanup(USER), "reconciliation_required", JSON.stringify(cleanup));
  }
  // A lost answer may have committed: reconcile, never replay.
  const lost = store({ throwCleanup: true });
  assert.equal(await createThreadsProviderCleanupAdapter(lost.s).cleanup(USER), "reconciliation_required");
  assert.deepEqual(lost.calls, [`cleanup:${USER}`], "called once, not retried");
  assert.equal(await createThreadsProviderCleanupAdapter(store().s).cleanup("x"), "blocked");
});

test("the RPC store sends only the user id to the two owner-only functions; a refusal is a throw (fail closed)", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const ok = createThreadsCleanupRpcStore({ supabaseUrl: "https://p.example", apiKey: "k", bearer: "b" }, (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(url.endsWith("state") ? "connected" : { outcome: "blocked", code: "DELETION_NOT_IN_PROGRESS" }), { status: 200 }));
  });
  assert.equal(await ok.connectionState(USER), "connected");
  assert.deepEqual(await ok.cleanup(USER), { outcome: "blocked", code: "DELETION_NOT_IN_PROGRESS" });
  assert.deepEqual(calls.map((c) => c.url), ["https://p.example/rest/v1/rpc/threads_provider_connection_state", "https://p.example/rest/v1/rpc/cleanup_threads_provider_footprint"]);
  for (const c of calls) assert.deepEqual(JSON.parse(String(c.init?.body)), { p_user_id: USER });
  const refused = createThreadsCleanupRpcStore({ supabaseUrl: "https://p.example", apiKey: "k", bearer: "b" }, () => Promise.resolve(new Response('{"code":"42501"}', { status: 403 })));
  const adapter = createThreadsProviderCleanupAdapter(refused);
  assert.equal(await adapter.hasConnection(USER), null, "not granted yet: unreadable, so G5 stops for reconciliation");
  assert.equal(await adapter.cleanup(USER), "reconciliation_required");
});
