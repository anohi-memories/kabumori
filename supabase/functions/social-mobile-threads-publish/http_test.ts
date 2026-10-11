import assert from "node:assert/strict";
import test from "node:test";
import { ThreadsStoreError } from "../_shared/social/threads_manual_publish.ts";
import type { FetchLike } from "../_shared/social/threads_publish_contract.ts";
import { attest, createGetUser, createHandler, createStore, isAcceptableAttestationKey, parseAttempt, THREADS_PUBLISH_RPC } from "./http.ts";

// Fake values only.
const URL_BASE = "https://project.example.supabase.co";
const ANON = "anon-key-fixture";
const ATTEST_KEY = "fake_publish_attestation_key_0123456789abcdef0123";
const JWT = "caller-jwt-fixture";
const USER = "00000000-0000-4000-8000-0000000000a1";
const KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GRANT = "a1".repeat(32);
const NONCE = "ab".repeat(32);
const ATTEMPT = { attempt_id: KEY, social_account_id: "sa_t", status: "reserved", container_id: null, provider_post_id: null, permalink: null, error_code: null, created_at: "2026-10-11T03:00:00Z" };

type Call = { url: string; init?: RequestInit };
function rpcFetch(bodies: unknown[], status = 200): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...bodies];
  return { calls, fetch: (url, init) => { calls.push({ url, init }); return Promise.resolve(new Response(JSON.stringify(queue.shift()), { status })); } };
}
const headers = (call: Call) => call.init?.headers as Record<string, string>;
const args = (call: Call) => JSON.parse(String(call.init?.body));
const config = { supabaseUrl: URL_BASE, anonKey: ANON, attestationKey: ATTEST_KEY };
const fixedClock = { nowSeconds: () => 1760000000, nonce: () => NONCE };
const caller = { userId: USER, bearerToken: JWT };
const released = { status: "released", grant: GRANT, threads_user_id: "1784", access_token: "THQVJfakeToken0123456789", text: "t", container_id: null, provider_post_id: null, attempt_created_at: "2026-10-11T03:00:00Z", attempt: { ...ATTEMPT, status: "creating_container" } };

test("attestation known answer, identical to the database's pgcrypto value (postona_threads_release_behavior.sql)", async () => {
  assert.equal(
    await attest(ATTEST_KEY, ["postona-threads-publish-release-v1", USER, "11111111-2222-4333-8444-555555555555", "publish", "1760000000", NONCE]),
    "c7cf793b40c12170cb179ecac087cd65978177e99bb0b157cac70360eee7d7b3",
  );
  assert.equal(isAcceptableAttestationKey(ATTEST_KEY), true);
  for (const bad of ["", "short", "x".repeat(31), `${"x".repeat(40)} y`, "x".repeat(513)]) assert.equal(isAcceptableAttestationKey(bad), false);
});

test("every RPC uses the caller's JWT with the anon key; there is no service-role key anywhere", async () => {
  const { fetch, calls } = rpcFetch([
    { status: "reserved", attempt: ATTEMPT },
    released,
    { status: "recorded", attempt: { ...ATTEMPT, status: "container_created", container_id: "555" } },
    { status: "ok", attempt: ATTEMPT },
    { status: "updated", permitted: true },
    { status: "ok", permitted: true, open_attempt: null, last_attempt: null },
  ]);
  const store = createStore(config, fetch, fixedClock);
  await store.begin(caller, { socialAccountId: "sa_t", idempotencyKey: KEY, text: "t" });
  const r = await store.release(caller, { attemptId: KEY, step: "create_container" });
  assert.equal(r.credential.threadsUserId, "1784");
  assert.equal(r.grant, GRANT);
  await store.record(caller, { attemptId: KEY, step: "create_container", grant: GRANT, result: { to: "container_created", containerId: "555" } });
  await store.read(caller, KEY);
  await store.setPermission(caller, { socialAccountId: "sa_t", desired: true, expected: false });
  await store.accountState(caller, "sa_t");
  assert.deepEqual(calls.map((c) => c.url.replace(`${URL_BASE}/rest/v1/rpc/`, "")), [
    THREADS_PUBLISH_RPC.begin, THREADS_PUBLISH_RPC.release, THREADS_PUBLISH_RPC.record, THREADS_PUBLISH_RPC.read,
    THREADS_PUBLISH_RPC.setPermission, THREADS_PUBLISH_RPC.accountState,
  ]);
  for (const call of calls) {
    assert.equal(headers(call).Authorization, `Bearer ${JWT}`);
    assert.equal(headers(call).apikey, ANON);
    assert.equal(call.init?.redirect, "manual");
    assert.ok(!JSON.stringify(call).includes(ATTEST_KEY), "the key itself never leaves the server");
  }
  // No user id, brand id or provider id is ever sent as authority.
  assert.deepEqual(Object.keys(args(calls[0])).sort(), ["p_idempotency_key", "p_social_account_id", "p_text"]);
});

test("release and record carry exactly the attested values (the database recomputes the same message)", async () => {
  const { fetch, calls } = rpcFetch([released, { status: "recorded", attempt: { ...ATTEMPT, status: "publish_returned", container_id: "555", provider_post_id: "777" } }]);
  const store = createStore(config, fetch, fixedClock);
  await store.release(caller, { attemptId: KEY, step: "publish" });
  assert.deepEqual(args(calls[0]), {
    p_attempt_id: KEY, p_step: "publish", p_issued_at: 1760000000, p_nonce: NONCE,
    p_attestation: await attest(ATTEST_KEY, ["postona-threads-publish-release-v1", USER, KEY, "publish", "1760000000", NONCE]),
  });
  await store.record(caller, { attemptId: KEY, step: "publish", grant: GRANT, result: { to: "publish_returned", providerPostId: "777" } });
  assert.deepEqual(args(calls[1]), {
    p_attempt_id: KEY, p_step: "publish", p_grant: GRANT, p_to_status: "publish_returned",
    p_container_id: null, p_provider_post_id: "777", p_permalink: null, p_error_code: null,
    p_issued_at: 1760000000, p_nonce: NONCE,
    p_attestation: await attest(ATTEST_KEY, ["postona-threads-publish-record-v1", USER, KEY, "publish", GRANT, "publish_returned", "", "777", "", "", "1760000000", NONCE]),
  });
});

test("each attested call uses a fresh nonce by default", async () => {
  const { fetch, calls } = rpcFetch([released, released]);
  const store = createStore(config, fetch);
  await store.release(caller, { attemptId: KEY, step: "create_container" });
  await store.release(caller, { attemptId: KEY, step: "create_container" });
  assert.match(args(calls[0]).p_nonce, /^[0-9a-f]{64}$/);
  assert.notEqual(args(calls[0]).p_nonce, args(calls[1]).p_nonce);
});

test("refusals map to fixed codes; unknown codes, odd shapes, non-2xx and 401 never become success", async () => {
  const store = (body: unknown, status = 200) => createStore(config, rpcFetch([body], status).fetch, fixedClock);
  const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e instanceof ThreadsStoreError ? e.code : "other"; } return "resolved"; };
  assert.equal(await code(store({ status: "refused", code: "MANUAL_PUBLISH_NOT_PERMITTED" }).begin(caller, { socialAccountId: "s", idempotencyKey: KEY, text: "t" })), "MANUAL_PUBLISH_NOT_PERMITTED");
  assert.equal(await code(store({ status: "refused", code: "ATTESTATION_INVALID" }).release(caller, { attemptId: KEY, step: "publish" })), "ATTESTATION_INVALID");
  assert.equal(await code(store({ status: "refused", code: "DROP_TABLE" }).begin(caller, { socialAccountId: "s", idempotencyKey: KEY, text: "t" })), "STORE_UNAVAILABLE");
  assert.equal(await code(store({ status: "reserved", attempt: { ...ATTEMPT, status: "hacked" } }).begin(caller, { socialAccountId: "s", idempotencyKey: KEY, text: "t" })), "STORE_UNAVAILABLE");
  assert.equal(await code(store({ ...released, grant: "short" }).release(caller, { attemptId: KEY, step: "publish" })), "STORE_UNAVAILABLE");
  assert.equal(await code(store({ ...released, access_token: 42 }).release(caller, { attemptId: KEY, step: "publish" })), "STORE_UNAVAILABLE");
  assert.equal(await code(store({ message: "x" }, 500).read(caller, KEY)), "STORE_UNAVAILABLE");
  assert.equal(await code(store({ message: "JWT expired" }, 401).read(caller, KEY)), "AUTH_REQUIRED");
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
  const env = new Map([["SUPABASE_URL", URL_BASE], ["SUPABASE_ANON_KEY", ANON], ["THREADS_PUBLISH_ATTESTATION_KEY", ATTEST_KEY], ["THREADS_MANUAL_PUBLISH_ENABLED", "true"]]);
  const handler = createHandler({ get: (n) => env.get(n) }, () => { calls += 1; return Promise.resolve(new Response("{}")); });
  const response = await handler(new Request("https://edge.example", { method: "POST", headers: { Authorization: `Bearer ${JWT}`, "Content-Type": "application/json" }, body: "{}" }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { success: false, error: "THREADS_PUBLISH_DISABLED" });
  assert.equal(calls, 0);
});
