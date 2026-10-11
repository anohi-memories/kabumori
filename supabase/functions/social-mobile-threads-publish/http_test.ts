import assert from "node:assert/strict";
import test from "node:test";
import { ThreadsStoreError } from "../_shared/social/threads_manual_publish.ts";
import type { FetchLike } from "../_shared/social/threads_publish_contract.ts";
import { createGetUser, createHandler, createStore, parseAttempt, THREADS_PUBLISH_RPC } from "./http.ts";

// Fake values only.
const URL_BASE = "https://project.example.supabase.co";
const ANON = "anon-key-fixture";
const SERVICE = "service-role-key-fixture";
const JWT = "caller-jwt-fixture";
const KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GRANT = "a1".repeat(32);
const ATTEMPT = { attempt_id: KEY, social_account_id: "sa_t", status: "reserved", container_id: null, provider_post_id: null, permalink: null, error_code: null, created_at: "2026-10-11T03:00:00Z" };

type Call = { url: string; init?: RequestInit };
function rpcFetch(bodies: unknown[], status = 200): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...bodies];
  return { calls, fetch: (url, init) => { calls.push({ url, init }); return Promise.resolve(new Response(JSON.stringify(queue.shift()), { status })); } };
}
const headers = (call: Call) => call.init?.headers as Record<string, string>;
const args = (call: Call) => JSON.parse(String(call.init?.body));
const config = { supabaseUrl: URL_BASE, anonKey: ANON, serviceRoleKey: SERVICE };
const caller = { userId: "u", bearerToken: JWT };

test("caller-side RPCs use the caller's JWT with the anon key; never the service-role key", async () => {
  const { fetch, calls } = rpcFetch([
    { status: "reserved", attempt: ATTEMPT },
    { status: "claimed", grant: GRANT, attempt: { ...ATTEMPT, status: "creating_container" } },
    { status: "ok", attempt: ATTEMPT },
    { status: "updated", permitted: true },
    { status: "ok", permitted: true, open_attempt: null, last_attempt: null },
  ]);
  const store = createStore(config, fetch);
  await store.begin(caller, { socialAccountId: "sa_t", idempotencyKey: KEY, text: "t" });
  await store.claim(caller, { attemptId: KEY, step: "create_container" });
  await store.read(caller, KEY);
  await store.setPermission(caller, { socialAccountId: "sa_t", desired: true, expected: false });
  await store.accountState(caller, "sa_t");
  assert.deepEqual(calls.map((c) => c.url.replace(`${URL_BASE}/rest/v1/rpc/`, "")), [
    THREADS_PUBLISH_RPC.begin, THREADS_PUBLISH_RPC.claim, THREADS_PUBLISH_RPC.read, THREADS_PUBLISH_RPC.setPermission, THREADS_PUBLISH_RPC.accountState,
  ]);
  for (const call of calls) {
    assert.equal(headers(call).Authorization, `Bearer ${JWT}`);
    assert.equal(headers(call).apikey, ANON);
    assert.ok(!JSON.stringify(call).includes(SERVICE));
    assert.equal(call.init?.redirect, "manual");
  }
  // No user id, brand id or provider id is ever sent as authority.
  assert.deepEqual(Object.keys(args(calls[0])).sort(), ["p_idempotency_key", "p_social_account_id", "p_text"]);
  assert.deepEqual(Object.keys(args(calls[1])).sort(), ["p_attempt_id", "p_step"]);
});

test("server-only RPCs (redeem, record) use the service-role key and carry the grant", async () => {
  const { fetch, calls } = rpcFetch([
    { status: "redeemed", threads_user_id: "1784", access_token: "THQVJfakeToken0123456789", text: "t", container_id: null, provider_post_id: null, attempt_created_at: "2026-10-11T03:00:00Z" },
    { status: "recorded", attempt: { ...ATTEMPT, status: "container_created", container_id: "555" } },
  ]);
  const store = createStore(config, fetch);
  const redeemed = await store.redeem({ attemptId: KEY, step: "create_container", grant: GRANT });
  assert.equal(redeemed.credential.threadsUserId, "1784");
  await store.record({ attemptId: KEY, step: "create_container", grant: GRANT, result: { to: "container_created", containerId: "555" } });
  for (const call of calls) {
    assert.equal(headers(call).Authorization, `Bearer ${SERVICE}`);
    assert.equal(args(call).p_grant, GRANT);
  }
  assert.deepEqual(args(calls[1]), { p_attempt_id: KEY, p_step: "create_container", p_grant: GRANT, p_to_status: "container_created", p_container_id: "555", p_provider_post_id: null, p_permalink: null, p_error_code: null });
});

test("refusals map to fixed codes; unknown codes, odd shapes, non-2xx and 401 never become success", async () => {
  const store = (body: unknown, status = 200) => createStore(config, rpcFetch([body], status).fetch);
  const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e instanceof ThreadsStoreError ? e.code : "other"; } return "resolved"; };
  assert.equal(await code(store({ status: "refused", code: "MANUAL_PUBLISH_NOT_PERMITTED" }).begin(caller, { socialAccountId: "s", idempotencyKey: KEY, text: "t" })), "MANUAL_PUBLISH_NOT_PERMITTED");
  assert.equal(await code(store({ status: "refused", code: "DROP_TABLE" }).begin(caller, { socialAccountId: "s", idempotencyKey: KEY, text: "t" })), "STORE_UNAVAILABLE");
  assert.equal(await code(store({ status: "reserved", attempt: { ...ATTEMPT, status: "hacked" } }).begin(caller, { socialAccountId: "s", idempotencyKey: KEY, text: "t" })), "STORE_UNAVAILABLE");
  assert.equal(await code(store({ status: "claimed", grant: "short", attempt: ATTEMPT }).claim(caller, { attemptId: KEY, step: "publish" })), "STORE_UNAVAILABLE");
  assert.equal(await code(store({ message: "x" }, 500).read(caller, KEY)), "STORE_UNAVAILABLE");
  assert.equal(await code(store({ message: "JWT expired" }, 401).read(caller, KEY)), "AUTH_REQUIRED");
  assert.equal(await code(store({ status: "redeemed" }).redeem({ attemptId: KEY, step: "publish", grant: GRANT })), "STORE_UNAVAILABLE");
  assert.throws(() => parseAttempt({ ...ATTEMPT, permalink: "x".repeat(600) }));
});

test("getUser: only a 2xx with an id is a user; 5xx is unavailable, not anonymous", async () => {
  const user = (status: number, body: unknown) => createGetUser({ supabaseUrl: URL_BASE, anonKey: ANON }, () => Promise.resolve(new Response(JSON.stringify(body), { status })));
  assert.deepEqual(await user(200, { id: "u1" })(JWT), { id: "u1" });
  assert.equal(await user(401, { msg: "bad" })(JWT), null);
  assert.equal(await user(200, {})(JWT), null);
  await assert.rejects(user(503, {})(JWT));
});

test("the deployable entry is closed: 503 THREADS_PUBLISH_DISABLED with no network call at all", async () => {
  let calls = 0;
  const env = new Map([["SUPABASE_URL", URL_BASE], ["SUPABASE_ANON_KEY", ANON], ["SUPABASE_SERVICE_ROLE_KEY", SERVICE], ["THREADS_MANUAL_PUBLISH_ENABLED", "true"]]);
  const handler = createHandler({ get: (n) => env.get(n) }, () => { calls += 1; return Promise.resolve(new Response("{}")); });
  const response = await handler(new Request("https://edge.example", { method: "POST", headers: { Authorization: `Bearer ${JWT}`, "Content-Type": "application/json" }, body: "{}" }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { success: false, error: "THREADS_PUBLISH_DISABLED" });
  assert.equal(calls, 0);
});
