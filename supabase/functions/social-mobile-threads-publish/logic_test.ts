import assert from "node:assert/strict";
import test from "node:test";
import { FakeThreadsPublishStore } from "../_shared/social/threads_manual_publish_fake.ts";
import type { FetchLike } from "../_shared/social/threads_publish_contract.ts";
import {
  gatedHandler,
  handleThreadsPublish,
  MAX_BODY_BYTES,
  parseFlatJsonObject,
  parseThreadsPublishRequest,
  type ThreadsPublishHandlerDeps,
  THREADS_MANUAL_PUBLISH_PREREQUISITES,
  THREADS_MANUAL_PUBLISH_PREREQUISITES_MET,
} from "./logic.ts";

// Fake values only.
const OWNER = "11111111-1111-4111-8111-111111111111";
const JWT = "owner-jwt-fixture";
const ACCOUNT = "sa_threads_owner";
const TOKEN = "THQVJfakeLongLivedPublishToken0123456789";
const KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEXT = "テスト投稿 \"引用\" \\ バックスラッシュ\n改行";
const MEDIA = "17890000000000003";
const PERMALINK = "https://www.threads.net/@postona_tester/post/AbC_123";

function world() {
  const store = new FakeThreadsPublishStore();
  store.tokens.set(JWT, OWNER);
  store.services.set(OWNER, "active");
  store.accounts.set(ACCOUNT, { brandId: "u_owner", platform: "threads", connection: "identity_verified", threadsUserId: "17841405793187218", token: TOKEN });
  store.memberships.set(`u_owner|${OWNER}`, "owner");
  return store;
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
function provider(responses: Response[]): { fetch: FetchLike; count: () => number } {
  const queue = [...responses];
  let n = 0;
  return { count: () => n, fetch: () => { n += 1; const next = queue.shift(); return next ? Promise.resolve(next) : Promise.reject(new Error("unscripted")); } };
}
const golden = () => [ok({ id: "17890000000000001" }), ok({ id: "17890000000000001", status: "FINISHED" }), ok({ id: MEDIA }), ok({ id: MEDIA, permalink: PERMALINK })];
function deps(store: FakeThreadsPublishStore, fetch: FetchLike): ThreadsPublishHandlerDeps {
  return {
    getUser: (token) => Promise.resolve(store.tokens.has(token) ? { id: store.tokens.get(token)! } : null),
    store,
    fetch,
    sleep: () => Promise.resolve(),
    now: () => new Date(store.clock),
  };
}
const post = (body: unknown, token: string | null = JWT, raw?: string) =>
  new Request("https://edge.example/functions/v1/social-mobile-threads-publish", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: raw ?? JSON.stringify(body),
  });
const publishBody = (over: Record<string, unknown> = {}) => ({ action: "publish", social_account_id: ACCOUNT, idempotency_key: KEY, text: TEXT, ...over });

test("the static gate is closed and lists every prerequisite; the gated entry answers 503 without reading anything", async () => {
  assert.equal(THREADS_MANUAL_PUBLISH_PREREQUISITES_MET, false);
  assert.ok(THREADS_MANUAL_PUBLISH_PREREQUISITES.includes("PILOT_APPROVED"));
  assert.ok(THREADS_MANUAL_PUBLISH_PREREQUISITES.includes("INTEGRATED_SECURITY_REVIEW"));
  let reached = false;
  const entry = gatedHandler(false, () => { reached = true; return Promise.resolve(new Response()); });
  const response = await entry(post(publishBody()));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { success: false, error: "THREADS_PUBLISH_DISABLED" });
  assert.equal(reached, false);
  assert.equal((await entry(new Request("https://edge.example", { method: "OPTIONS" }))).status, 204);
});

test("publish: permission first, then one explicit publish returns the confirmed post; no token or text in the response", async () => {
  const store = world();
  const meta = provider(golden());
  const handler = (r: Request) => handleThreadsPublish(r, deps(store, meta.fetch));
  // Without the per-account permission nothing is reserved and Meta is not called.
  let response = await handler(post(publishBody()));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { success: false, error: "MANUAL_PUBLISH_NOT_PERMITTED" });
  response = await handler(post({ action: "set_permission", social_account_id: ACCOUNT, desired_enabled: true, expected_current_enabled: false }));
  assert.deepEqual(await response.json(), { success: true, status: "updated", account: { id: ACCOUNT, manual_publish_permitted: true } });
  response = await handler(post(publishBody()));
  assert.equal(response.status, 200);
  const raw = await response.text();
  assert.ok(!raw.includes(TOKEN) && !raw.includes("引用") && !raw.includes("17890000000000001"), "no token, text or container id");
  const body = JSON.parse(raw);
  assert.equal(body.success, true);
  assert.deepEqual({ ...body.attempt, id: "x", created_at: "t" }, {
    id: "x", social_account_id: ACCOUNT, status: "published", provider_post_id: MEDIA, permalink: PERMALINK, error_code: null, replayed: false, created_at: "t",
  });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(meta.count(), 4);
  // The stored text is the exact text sent (quotes, backslash and line feed intact).
  assert.equal([...store.attempts.values()][0].text, TEXT);
});

test("account_state shows the permission and the attempts; another user sees nothing", async () => {
  const store = world();
  store.permissions.add(ACCOUNT);
  const handler = (r: Request) => handleThreadsPublish(r, deps(store, provider(golden()).fetch));
  await handler(post(publishBody()));
  const state = await (await handler(post({ action: "account_state", social_account_id: ACCOUNT }))).json();
  assert.equal(state.account.manual_publish_permitted, true);
  assert.equal(state.account.open_attempt, null);
  assert.equal(state.account.last_attempt.status, "published");
  store.tokens.set("other-jwt", "22222222-2222-4222-8222-222222222222");
  store.services.set("22222222-2222-4222-8222-222222222222", "active");
  const other = await handler(post({ action: "account_state", social_account_id: ACCOUNT }, "other-jwt"));
  assert.equal(other.status, 404);
  assert.deepEqual(await other.json(), { success: false, error: "ACCOUNT_NOT_FOUND" });
});

test("a stale permission switch changes nothing and says so", async () => {
  const store = world();
  const handler = (r: Request) => handleThreadsPublish(r, deps(store, provider([]).fetch));
  const response = await handler(post({ action: "set_permission", social_account_id: ACCOUNT, desired_enabled: false, expected_current_enabled: true }));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { success: false, error: "STALE_STEP", current_permitted: false });
});

test("auth: missing, malformed or unverified bearer tokens are refused before any store call", async () => {
  const store = world();
  const handler = (r: Request) => handleThreadsPublish(r, deps(store, provider([]).fetch));
  for (const request of [post(publishBody(), null), post(publishBody(), "forged")]) {
    const response = await handler(request);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { success: false, error: "AUTH_REQUIRED" });
  }
  assert.deepEqual(store.log, []);
});

test("request shape: exact keys per action, UUIDs, no duplicates, no numbers or nesting; bounded size", async () => {
  const store = world();
  const handler = (r: Request) => handleThreadsPublish(r, deps(store, provider([]).fetch));
  const bad = [
    publishBody({ extra: true }),
    { action: "publish", social_account_id: ACCOUNT, text: TEXT },
    publishBody({ idempotency_key: "not-a-uuid" }),
    publishBody({ social_account_id: "../etc" }),
    publishBody({ text: 42 }),
    publishBody({ user_id: OWNER }),
    { action: "status", attempt_id: KEY, social_account_id: ACCOUNT },
    { action: "delete_everything", attempt_id: KEY },
    { action: "set_permission", social_account_id: ACCOUNT, desired_enabled: "true", expected_current_enabled: false },
  ];
  for (const body of bad) {
    const response = await handler(post(body));
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  const duplicate = `{"action":"publish","social_account_id":"${ACCOUNT}","idempotency_key":"${KEY}","text":"a","text":"b"}`;
  assert.equal((await handler(post(null, JWT, duplicate))).status, 400);
  const tooBig = JSON.stringify(publishBody({ text: "a".repeat(MAX_BODY_BYTES) }));
  assert.equal((await handler(post(null, JWT, tooBig))).status, 400);
  assert.equal((await handler(new Request("https://edge.example", { method: "GET" }))).status, 405);
  assert.deepEqual(store.log, []);
});

test("the strict flat JSON parser", () => {
  assert.deepEqual([...parseFlatJsonObject(`{ "a" : "x\\"y" , "b":true,"c":false }`)], [["a", 'x"y'], ["b", true], ["c", false]]);
  for (const bad of [`{}`, `[]`, `{"a":1}`, `{"a":null}`, `{"a":{"b":"c"}}`, `{"a":"x",}`, `{"a":"x"} x`, `{"a":"x","a":"y"}`, `{"a":"\u0001"}`, `{"a":"x"`, `{"a" "x"}`]) {
    assert.throws(() => parseFlatJsonObject(bad), /REQUEST_INVALID/, bad);
  }
  assert.deepEqual(parseThreadsPublishRequest(JSON.stringify({ action: "resume", attempt_id: KEY })), { action: "resume", attemptId: KEY });
});

test("invalid text gets TEXT_INVALID without reserving anything", async () => {
  const store = world();
  store.permissions.add(ACCOUNT);
  const handler = (r: Request) => handleThreadsPublish(r, deps(store, provider([]).fetch));
  for (const text of ["   ", "a".repeat(501), "a\rb"]) {
    const response = await handler(post(publishBody({ text })));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { success: false, error: "TEXT_INVALID" });
  }
  assert.equal(store.attempts.size, 0);
});

test("uncertain publish: reported as uncertain (no post id), never resent; reconcile resolves it read-only", async () => {
  const store = world();
  store.permissions.add(ACCOUNT);
  const responses = [ok({ id: "17890000000000001" }), ok({ id: "17890000000000001", status: "FINISHED" }), new Response("{}", { status: 504 }),
    ok({ id: "17890000000000001", status: "EXPIRED" })];
  const meta = provider(responses);
  const handler = (r: Request) => handleThreadsPublish(r, deps(store, meta.fetch));
  const first = await (await handler(post(publishBody()))).json();
  assert.deepEqual([first.attempt.status, first.attempt.provider_post_id, first.attempt.permalink], ["uncertain", null, null]);
  const replay = await (await handler(post(publishBody()))).json();
  assert.equal(replay.attempt.status, "uncertain");
  assert.equal(replay.attempt.replayed, true);
  const resolved = await (await handler(post({ action: "reconcile", attempt_id: first.attempt.id }))).json();
  assert.deepEqual([resolved.attempt.status, resolved.attempt.error_code], ["failed", "CONTAINER_EXPIRED"]);
  assert.equal(meta.count(), 4, "create, status, ONE publish, status");
});

test("an unexpected internal error is answered as STORE_UNAVAILABLE with no detail", async () => {
  const store = world();
  store.permissions.add(ACCOUNT);
  const broken: ThreadsPublishHandlerDeps = { ...deps(store, provider([]).fetch), getUser: () => Promise.reject(new Error(`boom ${TOKEN}`)) };
  const response = await handleThreadsPublish(post(publishBody()), broken);
  assert.equal(response.status, 503);
  const raw = await response.text();
  assert.equal(raw, JSON.stringify({ success: false, error: "STORE_UNAVAILABLE" }));
});
