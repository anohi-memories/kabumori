import assert from "node:assert/strict";
import test from "node:test";
import {
  publishThreadsTextNow,
  reconcileThreadsAttempt,
  resumeThreadsAttempt,
  THREADS_CLAIM_RULES,
  THREADS_RECORD_TRANSITIONS,
  type ThreadsAttempt,
  type ThreadsManualPublishDeps,
  ThreadsStoreError,
  type VerifiedCaller,
} from "./threads_manual_publish.ts";
import { ATTEMPT_MAX_AGE_MS, FakeThreadsPublishStore, GRANT_TTL_MS } from "./threads_manual_publish_fake.ts";
import type { FetchLike } from "./threads_publish_contract.ts";

// Fake values only.
const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const JWT = "owner-jwt-fixture";
const OTHER_JWT = "other-jwt-fixture";
const ACCOUNT = "sa_threads_owner";
const X_ACCOUNT = "sa_x_owner";
const THREADS_USER = "17841405793187218";
const TOKEN = "THQVJfakeLongLivedPublishToken0123456789";
const CONTAINER = "17890000000000001";
const MEDIA = "17890000000000003";
const PERMALINK = "https://www.threads.net/@postona_tester/post/AbC_123";
const KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KEY2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TEXT = "POSTONAから手動で1件だけ投稿します。";
const CALLER: VerifiedCaller = { userId: OWNER, bearerToken: JWT };

type Step = "create" | "status" | "publish" | "readback" | "list";
type Scripted = Response | Error;
function scriptedFetch(script: Partial<Record<Step, Scripted[]>>): { fetch: FetchLike; calls: Array<{ step: Step; url: string; body: string }> } {
  const calls: Array<{ step: Step; url: string; body: string }> = [];
  const queues = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, [...(v ?? [])]])) as Record<Step, Scripted[]>;
  return {
    calls,
    fetch: (url, init) => {
      const parsed = new URL(url);
      const step: Step = parsed.pathname.endsWith("/threads_publish") ? "publish"
        : parsed.pathname.endsWith("/threads") && init?.method === "POST" ? "create"
        : parsed.pathname.endsWith("/threads") ? "list"
        : parsed.searchParams.get("fields")?.includes("status") ? "status"
        : "readback";
      calls.push({ step, url, body: String(init?.body ?? "") });
      const next = queues[step]?.shift();
      if (next === undefined) return Promise.reject(new Error(`unscripted ${step}`));
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const err = (status: number, code: number) => new Response(JSON.stringify({ error: { code, message: `detail ${TOKEN}` } }), { status });
const status = (value: string, id = CONTAINER) => ok({ id, status: value });
const readback = (over: Record<string, unknown> = {}) => ok({ id: MEDIA, permalink: PERMALINK, owner: { id: THREADS_USER }, ...over });

function world() {
  const store = new FakeThreadsPublishStore();
  store.tokens.set(JWT, OWNER);
  store.tokens.set(OTHER_JWT, OTHER);
  store.services.set(OWNER, "active");
  store.services.set(OTHER, "active");
  store.accounts.set(ACCOUNT, { brandId: "u_owner", platform: "threads", connection: "identity_verified", threadsUserId: THREADS_USER, token: TOKEN });
  store.accounts.set(X_ACCOUNT, { brandId: "u_owner", platform: "x", connection: "identity_verified", threadsUserId: "1", token: TOKEN });
  store.memberships.set(`u_owner|${OWNER}`, "owner");
  store.permissions.add(ACCOUNT);
  return store;
}
function deps(store: FakeThreadsPublishStore, fetch: FetchLike, over: Partial<ThreadsManualPublishDeps> = {}): ThreadsManualPublishDeps {
  return { store, fetch, sleep: () => Promise.resolve(), now: () => new Date(store.clock), containerChecks: 3, containerCheckDelayMs: 0, ...over };
}
const golden = () => ({ create: [ok({ id: CONTAINER })], status: [status("FINISHED")], publish: [ok({ id: MEDIA })], readback: [readback()] });
const input = (over: Partial<{ socialAccountId: string; idempotencyKey: string; text: string }> = {}) => ({ socialAccountId: ACCOUNT, idempotencyKey: KEY, text: TEXT, ...over });

async function refuses(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error) => error instanceof ThreadsStoreError && error.code === code);
}
function noSecrets(value: unknown) {
  assert.ok(!JSON.stringify(value).includes(TOKEN), "no token in a result");
}

// --- Golden path -------------------------------------------------------------------------------------------

test("golden path: one tap -> container -> FINISHED -> publish -> read-back -> published (confirmed)", async () => {
  const store = world();
  const provider = scriptedFetch(golden());
  const attempt = await publishThreadsTextNow(deps(store, provider.fetch), CALLER, input());
  assert.equal(attempt.status, "published");
  assert.equal(attempt.providerPostId, MEDIA);
  assert.equal(attempt.permalink, PERMALINK);
  assert.equal(attempt.containerId, CONTAINER);
  assert.deepEqual(provider.calls.map((c) => c.step), ["create", "status", "publish", "readback"]);
  // The text sent is the stored text, exactly.
  assert.equal(new URLSearchParams(provider.calls[0].body).get("text"), TEXT);
  assert.equal(new URLSearchParams(provider.calls[2].body).get("creation_id"), CONTAINER);
  // Each provider call was preceded by its own claim (a fresh authorization) and redeem.
  assert.deepEqual(store.log, [
    "begin:sa_threads_owner",
    "claim:create_container", "redeem:create_container", "record:create_container:container_created",
    "claim:check_container", "redeem:check_container",
    "claim:publish", "redeem:publish", "record:publish:publish_returned",
    "claim:confirm", "redeem:confirm", "record:confirm:published",
  ]);
  noSecrets(attempt);
});

test("the claim rules and the record transitions never lead back to a write that may already have happened", () => {
  assert.deepEqual(THREADS_CLAIM_RULES.create_container, { from: "reserved", to: "creating_container" });
  assert.deepEqual(THREADS_CLAIM_RULES.publish, { from: "container_created", to: "publishing" });
  for (const [, , to] of THREADS_RECORD_TRANSITIONS) assert.ok(to !== "reserved" && to !== "container_created" || to === "container_created");
  const intoWritable = THREADS_RECORD_TRANSITIONS.filter(([, , to]) => to === "reserved" || to === "container_created");
  assert.deepEqual(intoWritable, [["create_container", "creating_container", "container_created"]], "only container creation leads to a publishable state");
  for (const [, from] of THREADS_RECORD_TRANSITIONS) assert.ok(!["published", "published_unidentified", "failed"].includes(from), "terminal statuses never change");
});

// --- Refusals before any provider call -------------------------------------------------------------------

test("refusals before anything is reserved: auth, cross-user, role, provider, lifecycle, connection, credential, permission", async () => {
  const cases: Array<[string, (s: FakeThreadsPublishStore) => VerifiedCaller | void, string, Partial<ReturnType<typeof input>>?]> = [
    ["unknown bearer token", () => ({ userId: OWNER, bearerToken: "forged" }), "AUTH_REQUIRED"],
    ["a verified token for another user id", () => ({ userId: OTHER, bearerToken: JWT }), "AUTH_REQUIRED"],
    ["another user's account", () => ({ userId: OTHER, bearerToken: OTHER_JWT }), "ACCOUNT_NOT_FOUND"],
    ["a viewer of the workspace", (s) => { s.memberships.set(`u_owner|${OTHER}`, "viewer"); return { userId: OTHER, bearerToken: OTHER_JWT }; }, "PUBLISH_FORBIDDEN"],
    ["an X account routed to Threads", () => {}, "PLATFORM_NOT_SUPPORTED", { socialAccountId: X_ACCOUNT }],
    ["a missing account", () => {}, "ACCOUNT_NOT_FOUND", { socialAccountId: "sa_missing" }],
    ["POSTONA service ended", (s) => { s.services.set(OWNER, "ended"); }, "SERVICE_NOT_ACTIVE"],
    ["POSTONA service never registered", (s) => { s.services.delete(OWNER); }, "SERVICE_NOT_ACTIVE"],
    ["common account deletion in progress", (s) => { s.services.set(OWNER, "deleting"); }, "ACCOUNT_LIFECYCLE_BLOCKED"],
    ["account locked", (s) => { s.services.set(OWNER, "locked"); }, "ACCOUNT_LIFECYCLE_BLOCKED"],
    ["G5 fence unavailable", (s) => { s.services.set(OWNER, "fence_unavailable"); }, "ACCOUNT_LIFECYCLE_BLOCKED"],
    ["connection revoked", (s) => { s.accounts.get(ACCOUNT)!.connection = "failed"; }, "CONNECTION_NOT_VERIFIED"],
    ["connection only pending", (s) => { s.accounts.get(ACCOUNT)!.connection = "authorization_pending"; }, "CONNECTION_NOT_VERIFIED"],
    ["Vault credential missing", (s) => { s.accounts.get(ACCOUNT)!.token = null; }, "CREDENTIALS_MISSING"],
    ["per-account manual publish not permitted", (s) => { s.permissions.clear(); }, "MANUAL_PUBLISH_NOT_PERMITTED"],
  ];
  for (const [label, arrange, code, over] of cases) {
    const store = world();
    const caller = arrange(store) ?? CALLER;
    const provider = scriptedFetch({});
    await refuses(publishThreadsTextNow(deps(store, provider.fetch), caller, input(over)), code);
    assert.equal(provider.calls.length, 0, `${label}: no provider call`);
    assert.equal(store.attempts.size, 0, `${label}: nothing reserved`);
  }
});

test("invalid text is refused before the store is even asked", async () => {
  for (const text of ["", "   ", "a".repeat(501), "a\rb", "😀".repeat(126)]) {
    const store = world();
    await refuses(publishThreadsTextNow(deps(store, scriptedFetch({}).fetch), CALLER, input({ text })), "TEXT_INVALID");
    assert.deepEqual(store.log, []);
  }
});

// --- Idempotency and concurrency -----------------------------------------------------------------------

test("a double tap (same key, same text) returns the same attempt and calls the provider once", async () => {
  const store = world();
  const provider = scriptedFetch(golden());
  const first = await publishThreadsTextNow(deps(store, provider.fetch), CALLER, input());
  const second = await publishThreadsTextNow(deps(store, provider.fetch), CALLER, input());
  assert.equal(second.attemptId, first.attemptId);
  assert.equal(second.replayed, true);
  assert.equal(second.status, "published");
  assert.equal(provider.calls.filter((c) => c.step === "publish").length, 1);
});

test("two simultaneous requests with the same key: one drives, the other only reports", async () => {
  const store = world();
  const provider = scriptedFetch(golden());
  const [a, b] = await Promise.all([
    publishThreadsTextNow(deps(store, provider.fetch), CALLER, input()),
    publishThreadsTextNow(deps(store, provider.fetch), CALLER, input()),
  ]);
  assert.equal(a.attemptId, b.attemptId);
  assert.equal([a, b].filter((x) => x.replayed).length, 1);
  assert.equal(provider.calls.filter((c) => c.step === "create").length, 1);
  assert.equal(provider.calls.filter((c) => c.step === "publish").length, 1);
});

test("the same key with different text is a conflict; another key while one is open is refused", async () => {
  const store = world();
  const slow = scriptedFetch({ create: [ok({ id: CONTAINER })], status: [status("IN_PROGRESS"), status("IN_PROGRESS"), status("IN_PROGRESS")] });
  const open = await publishThreadsTextNow(deps(store, slow.fetch), CALLER, input());
  assert.equal(open.status, "container_created");
  await refuses(publishThreadsTextNow(deps(store, slow.fetch), CALLER, input({ text: `${TEXT}!` })), "IDEMPOTENCY_CONFLICT");
  await refuses(publishThreadsTextNow(deps(store, slow.fetch), CALLER, input({ idempotencyKey: KEY2 })), "PUBLISH_IN_PROGRESS");
  assert.equal(slow.calls.filter((c) => c.step === "publish").length, 0);
});

test("a write step's claim is a compare-and-set: a second claim of the same step is stale", async () => {
  const store = world();
  const attempt = await store.begin(CALLER, input());
  await store.claim(CALLER, { attemptId: attempt.attemptId, step: "create_container" });
  await refuses(store.claim(CALLER, { attemptId: attempt.attemptId, step: "create_container" }), "STALE_STEP");
  await refuses(store.claim(CALLER, { attemptId: attempt.attemptId, step: "publish" }), "STALE_STEP");
});

// --- Grants ----------------------------------------------------------------------------------------------

test("grants are single use, step-bound and short-lived; a result cannot be recorded without one", async () => {
  const store = world();
  const attempt = await store.begin(CALLER, input());
  const { grant } = await store.claim(CALLER, { attemptId: attempt.attemptId, step: "create_container" });
  await refuses(store.redeem({ attemptId: attempt.attemptId, step: "publish", grant }), "GRANT_INVALID");
  await refuses(store.redeem({ attemptId: attempt.attemptId, step: "create_container", grant: `${grant}x` }), "GRANT_INVALID");
  await refuses(store.record({ attemptId: attempt.attemptId, step: "create_container", grant, result: { to: "container_created", containerId: CONTAINER } }), "GRANT_INVALID");
  const redeemed = await store.redeem({ attemptId: attempt.attemptId, step: "create_container", grant });
  assert.equal(redeemed.text, TEXT);
  await refuses(store.redeem({ attemptId: attempt.attemptId, step: "create_container", grant }), "GRANT_INVALID");
  // Recording a result the transition table does not allow is refused.
  await refuses(store.record({ attemptId: attempt.attemptId, step: "create_container", grant, result: { to: "published", providerPostId: MEDIA, permalink: PERMALINK } }), "STALE_STEP");
  await store.record({ attemptId: attempt.attemptId, step: "create_container", grant, result: { to: "container_created", containerId: CONTAINER } });
  await refuses(store.record({ attemptId: attempt.attemptId, step: "create_container", grant, result: { to: "failed", errorCode: "THREADS_UNAVAILABLE" } }), "GRANT_INVALID");
  // An expired grant buys nothing.
  const late = await store.claim(CALLER, { attemptId: attempt.attemptId, step: "check_container" });
  store.clock += GRANT_TTL_MS + 1;
  await refuses(store.redeem({ attemptId: attempt.attemptId, step: "check_container", grant: late.grant }), "GRANT_INVALID");
});

// --- Every write is re-authorized ------------------------------------------------------------------------

test("each provider write gets a fresh authorization: a permission revoked after the container blocks the publish", async () => {
  for (const [label, revoke, code] of [
    ["permission revoked", (s: FakeThreadsPublishStore) => s.permissions.clear(), "MANUAL_PUBLISH_NOT_PERMITTED"],
    ["service ended", (s: FakeThreadsPublishStore) => s.services.set(OWNER, "ended"), "SERVICE_NOT_ACTIVE"],
    ["deletion started", (s: FakeThreadsPublishStore) => s.services.set(OWNER, "deleting"), "ACCOUNT_LIFECYCLE_BLOCKED"],
    ["demoted to member", (s: FakeThreadsPublishStore) => s.memberships.set(`u_owner|${OWNER}`, "member"), "PUBLISH_FORBIDDEN"],
    ["disconnected", (s: FakeThreadsPublishStore) => { s.accounts.get(ACCOUNT)!.connection = "failed"; }, "CONNECTION_NOT_VERIFIED"],
  ] as const) {
    const store = world();
    store.afterRecord = (a: ThreadsAttempt) => { if (a.status === "container_created") revoke(store); };
    const provider = scriptedFetch(golden());
    await refuses(publishThreadsTextNow(deps(store, provider.fetch), CALLER, input()), code);
    assert.equal(provider.calls.filter((c) => c.step === "publish").length, 0, label);
    assert.equal([...store.attempts.values()][0].status, "container_created", `${label}: nothing published, nothing pretended`);
  }
});

test("an attempt older than 15 minutes cannot continue to a publish; it is closed as failed", async () => {
  const store = world();
  const provider = scriptedFetch({ create: [ok({ id: CONTAINER })], status: [status("IN_PROGRESS"), status("IN_PROGRESS"), status("IN_PROGRESS"), status("FINISHED")] });
  const waiting = await publishThreadsTextNow(deps(store, provider.fetch), CALLER, input());
  assert.equal(waiting.status, "container_created");
  store.clock += ATTEMPT_MAX_AGE_MS + 1;
  await refuses(resumeThreadsAttempt(deps(store, provider.fetch), CALLER, waiting.attemptId), "ATTEMPT_EXPIRED");
  assert.equal((await store.read(CALLER, waiting.attemptId)).errorCode, "ATTEMPT_EXPIRED");
  assert.equal(provider.calls.filter((c) => c.step === "publish").length, 0);
});

// --- Provider outcomes -------------------------------------------------------------------------------------

test("expired or revoked token at container creation: failed with the token code; nothing published", async () => {
  const store = world();
  const provider = scriptedFetch({ create: [err(400, 190)] });
  const attempt = await publishThreadsTextNow(deps(store, provider.fetch), CALLER, input());
  assert.deepEqual([attempt.status, attempt.errorCode], ["failed", "THREADS_TOKEN_INVALID"]);
  assert.deepEqual(provider.calls.map((c) => c.step), ["create"]);
  noSecrets(attempt);
});

test("a lost container answer is a failure, never a publish (no id, no post possible)", async () => {
  for (const response of [new TypeError("reset"), new Response("{}", { status: 503 }), ok({})]) {
    const store = world();
    const provider = scriptedFetch({ create: [response] });
    const attempt = await publishThreadsTextNow(deps(store, provider.fetch), CALLER, input());
    assert.deepEqual([attempt.status, attempt.errorCode], ["failed", "CONTAINER_OUTCOME_UNKNOWN"]);
    assert.deepEqual(provider.calls.map((c) => c.step), ["create"]);
  }
});

test("container accepted but publish refused (4xx): failed, not uncertain, and never resent", async () => {
  for (const [response, code] of [[err(400, 100), "THREADS_REQUEST_REJECTED"], [new Response("{}", { status: 429 }), "THREADS_RATE_LIMITED"], [err(403, 10), "THREADS_PERMISSION_MISSING"]] as const) {
    const store = world();
    const provider = scriptedFetch({ ...golden(), publish: [response] });
    const attempt = await publishThreadsTextNow(deps(store, provider.fetch), CALLER, input());
    assert.deepEqual([attempt.status, attempt.errorCode], ["failed", code]);
    assert.equal(provider.calls.filter((c) => c.step === "publish").length, 1);
  }
});

test("unknown publish outcome (timeout, 5xx, transient, unreadable): uncertain, and no second publish ever", async () => {
  for (const response of [new DOMException("timeout", "AbortError"), new Response("{}", { status: 500 }), err(400, 2), ok({ nope: true })]) {
    const store = world();
    const provider = scriptedFetch({ ...golden(), publish: [response] });
    const d = deps(store, provider.fetch);
    const attempt = await publishThreadsTextNow(d, CALLER, input());
    assert.equal(attempt.status, "uncertain");
    // Neither a replay, a resume nor a new key publishes again while it is uncertain.
    assert.equal((await publishThreadsTextNow(d, CALLER, input())).status, "uncertain");
    assert.equal((await resumeThreadsAttempt(d, CALLER, attempt.attemptId)).status, "uncertain");
    await refuses(publishThreadsTextNow(d, CALLER, input({ idempotencyKey: KEY2 })), "PUBLISH_IN_PROGRESS");
    assert.equal(provider.calls.filter((c) => c.step === "publish").length, 1);
  }
});

test("reconcile (read-only): PUBLISHED + exactly one exact-text post -> published with its permalink", async () => {
  const store = world();
  const provider = scriptedFetch({
    ...golden(),
    publish: [new Response("{}", { status: 502 })],
    status: [status("FINISHED"), status("PUBLISHED")],
    list: [ok({ data: [{ id: MEDIA, text: TEXT }, { id: "17890000000000009", text: "別の投稿" }] })],
    readback: [readback()],
  });
  const d = deps(store, provider.fetch);
  const uncertain = await publishThreadsTextNow(d, CALLER, input());
  const resolved = await reconcileThreadsAttempt(d, CALLER, uncertain.attemptId);
  assert.deepEqual([resolved.status, resolved.providerPostId, resolved.permalink, resolved.errorCode], ["published", MEDIA, PERMALINK, null]);
  assert.equal(provider.calls.filter((c) => c.step === "publish").length, 1);
});

test("reconcile: ERROR / EXPIRED container -> provably never published; FINISHED -> still uncertain; ambiguous -> unidentified", async () => {
  const run = async (script: Partial<Record<Step, Scripted[]>>) => {
    const store = world();
    const provider = scriptedFetch({ ...golden(), publish: [new TypeError("lost")], ...script, status: [status("FINISHED"), ...(script.status ?? [])] });
    const d = deps(store, provider.fetch);
    const uncertain = await publishThreadsTextNow(d, CALLER, input());
    const result = await reconcileThreadsAttempt(d, CALLER, uncertain.attemptId);
    assert.equal(provider.calls.filter((c) => c.step === "publish").length, 1, "never a second publish");
    return result;
  };
  assert.deepEqual(pick(await run({ status: [status("EXPIRED")] })), ["failed", "CONTAINER_EXPIRED"]);
  assert.deepEqual(pick(await run({ status: [status("ERROR")] })), ["failed", "CONTAINER_ERROR"]);
  assert.deepEqual(pick(await run({ status: [status("FINISHED")] })), ["uncertain", "PUBLISH_OUTCOME_UNKNOWN"]);
  assert.deepEqual(pick(await run({ status: [new Response("{}", { status: 500 })] })), ["uncertain", "THREADS_UNAVAILABLE"]);
  assert.deepEqual(pick(await run({ status: [status("PUBLISHED")], list: [ok({ data: [{ id: "1", text: TEXT }, { id: "2", text: TEXT }] })] })), ["published_unidentified", "PUBLISHED_POST_AMBIGUOUS"]);
  assert.deepEqual(pick(await run({ status: [status("PUBLISHED")], list: [ok({ data: [] })] })), ["published_unidentified", "PUBLISHED_POST_NOT_FOUND"]);
});
const pick = (a: ThreadsAttempt) => [a.status, a.errorCode];

test("container not ready: bounded checks, then the attempt waits; an explicit resume publishes it", async () => {
  const store = world();
  let sleeps = 0;
  const provider = scriptedFetch({ ...golden(), status: [status("IN_PROGRESS"), status("IN_PROGRESS"), status("IN_PROGRESS"), status("FINISHED")] });
  const d = deps(store, provider.fetch, { sleep: () => { sleeps += 1; return Promise.resolve(); } });
  const waiting = await publishThreadsTextNow(d, CALLER, input());
  assert.equal(waiting.status, "container_created");
  assert.equal(sleeps, 2, "3 checks, 2 waits");
  assert.equal(provider.calls.filter((c) => c.step === "publish").length, 0);
  const done = await resumeThreadsAttempt(d, CALLER, waiting.attemptId);
  assert.equal(done.status, "published");
});

test("container ERROR before publish: failed, nothing published", async () => {
  const store = world();
  const provider = scriptedFetch({ ...golden(), status: [status("ERROR")] });
  const attempt = await publishThreadsTextNow(deps(store, provider.fetch), CALLER, input());
  assert.deepEqual([attempt.status, attempt.errorCode], ["failed", "CONTAINER_ERROR"]);
  assert.equal(provider.calls.filter((c) => c.step === "publish").length, 0);
});

test("publish returned an id but the read-back failed: shown as publish_returned (not success) until confirmed", async () => {
  for (const bad of [new Response("{}", { status: 500 }), readback({ id: "1" }), readback({ owner: { id: "999" } }), readback({ permalink: "https://evil.example/x" })]) {
    const store = world();
    const provider = scriptedFetch({ ...golden(), readback: [bad, readback()] });
    const d = deps(store, provider.fetch);
    const attempt = await publishThreadsTextNow(d, CALLER, input());
    assert.deepEqual([attempt.status, attempt.providerPostId, attempt.permalink], ["publish_returned", MEDIA, null]);
    const confirmed = await resumeThreadsAttempt(d, CALLER, attempt.attemptId);
    assert.equal(confirmed.status, "published");
    assert.equal(provider.calls.filter((c) => c.step === "publish").length, 1, "resume only reads back");
  }
});

test("another member cannot resume, reconcile or read someone's attempt in another workspace", async () => {
  const store = world();
  const attempt = await publishThreadsTextNow(deps(store, scriptedFetch(golden()).fetch), CALLER, input());
  const other: VerifiedCaller = { userId: OTHER, bearerToken: OTHER_JWT };
  await refuses(store.read(other, attempt.attemptId), "ATTEMPT_NOT_FOUND");
  await refuses(resumeThreadsAttempt(deps(store, scriptedFetch({}).fetch), other, attempt.attemptId), "ATTEMPT_NOT_FOUND");
  await refuses(reconcileThreadsAttempt(deps(store, scriptedFetch({}).fetch), other, attempt.attemptId), "ATTEMPT_NOT_FOUND");
});

// --- Abandoned steps, workspace state, permission withdrawal ---------------------------------------

test("an abandoned container step is settled as failed (no container id, so no post) by a later reconcile", async () => {
  const store = world();
  const attempt = await store.begin(CALLER, input());
  await store.claim(CALLER, { attemptId: attempt.attemptId, step: "create_container" }); // the server died here
  const d = deps(store, scriptedFetch({}).fetch);
  assert.equal((await reconcileThreadsAttempt(d, CALLER, attempt.attemptId)).status, "creating_container", "not yet stale: untouched");
  store.clock += 121_000;
  const settled = await reconcileThreadsAttempt(d, CALLER, attempt.attemptId);
  assert.deepEqual([settled.status, settled.errorCode], ["failed", "STEP_INTERRUPTED"]);
});

test("an abandoned publish becomes uncertain and is then reconciled read-only from the container status", async () => {
  const store = world();
  const provider = scriptedFetch({ status: [status("PUBLISHED")], list: [ok({ data: [{ id: MEDIA, text: TEXT }] })], readback: [readback()] });
  const d = deps(store, provider.fetch);
  const attempt = await store.begin(CALLER, input());
  // Drive by hand up to the publish claim, then "die" before calling Meta.
  const c = await store.claim(CALLER, { attemptId: attempt.attemptId, step: "create_container" });
  await store.redeem({ attemptId: attempt.attemptId, step: "create_container", grant: c.grant });
  await store.record({ attemptId: attempt.attemptId, step: "create_container", grant: c.grant, result: { to: "container_created", containerId: CONTAINER } });
  await store.claim(CALLER, { attemptId: attempt.attemptId, step: "publish" });
  store.clock += 121_000;
  const resolved = await reconcileThreadsAttempt(d, CALLER, attempt.attemptId);
  assert.equal(resolved.status, "published");
  assert.equal(provider.calls.filter((x) => x.step === "publish").length, 0, "reconcile never publishes");
});

test("a permission withdrawn between claim and credential read: nothing is sent and the attempt is closed as failed", async () => {
  const store = world();
  const attempt = await store.begin(CALLER, input());
  const { grant } = await store.claim(CALLER, { attemptId: attempt.attemptId, step: "create_container" });
  store.permissions.clear();
  await refuses(store.redeem({ attemptId: attempt.attemptId, step: "create_container", grant }), "MANUAL_PUBLISH_NOT_PERMITTED");
  const after = await store.read(CALLER, attempt.attemptId);
  assert.deepEqual([after.status, after.errorCode], ["failed", "AUTHORIZATION_CHANGED"]);
});

test("withdrawing the permission does not stop the person from learning whether an uncertain post went out", async () => {
  const store = world();
  const provider = scriptedFetch({ ...golden(), publish: [new TypeError("lost")], status: [status("FINISHED"), status("EXPIRED")] });
  const d = deps(store, provider.fetch);
  const uncertain = await publishThreadsTextNow(d, CALLER, input());
  store.permissions.clear();
  const resolved = await reconcileThreadsAttempt(d, CALLER, uncertain.attemptId);
  assert.deepEqual([resolved.status, resolved.errorCode], ["failed", "CONTAINER_EXPIRED"]);
});

test("a disabled workspace refuses before anything is reserved", async () => {
  const store = world();
  store.inactiveBrands.add("u_owner");
  const provider = scriptedFetch({});
  await refuses(publishThreadsTextNow(deps(store, provider.fetch), CALLER, input()), "WORKSPACE_INACTIVE");
  assert.equal(provider.calls.length, 0);
});

test("a token whose expiry is unknown, past or within 5 minutes is never used; mid-flow expiry closes the step unsent", async () => {
  for (const expiresAt of [null, Date.parse("2026-10-11T03:04:00Z"), Date.parse("2026-10-10T03:00:00Z")]) {
    const store = world();
    store.accounts.get(ACCOUNT)!.expiresAt = expiresAt;
    const provider = scriptedFetch({});
    await refuses(publishThreadsTextNow(deps(store, provider.fetch), CALLER, input()), "CREDENTIALS_EXPIRED");
    assert.equal(provider.calls.length, 0);
  }
  const store = world();
  const attempt = await store.begin(CALLER, input());
  const { grant } = await store.claim(CALLER, { attemptId: attempt.attemptId, step: "create_container" });
  store.accounts.get(ACCOUNT)!.expiresAt = store.clock + 60_000;
  await refuses(store.redeem({ attemptId: attempt.attemptId, step: "create_container", grant }), "CREDENTIALS_EXPIRED");
  assert.deepEqual(pick(await store.read(CALLER, attempt.attemptId)), ["failed", "AUTHORIZATION_CHANGED"]);
});
