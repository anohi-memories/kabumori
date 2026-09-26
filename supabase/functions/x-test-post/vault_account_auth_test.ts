// Fake DB / fake X callbacks are async by contract even when they do not await.
// deno-lint-ignore-file require-await
import assert from "node:assert/strict";
import test from "node:test";
import {
  createVaultAccountCredentialRpc,
  type VaultAccountCredentialRpc,
  type VaultAccountRef,
  VaultAccountXAuth,
  type XRequestResult,
} from "./vault_account_auth.ts";
import { XRefreshLease, xOAuthClientRegistryFromEnv } from "../_shared/x_v2_account_refresh.ts";

const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("REAL_FETCH_FORBIDDEN_IN_TESTS"); }) as typeof fetch;
addEventListener("unload", () => { globalThis.fetch = realFetch; });

const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const ENV: Record<string, string> = {
  X_CLIENT_ID: "cid", X_CLIENT_SECRET: "csecret",
  X_OAUTH_CLIENT_PARTNER_ID: "pid", X_OAUTH_CLIENT_PARTNER_SECRET: "psecret",
};
const registry = xOAuthClientRegistryFromEnv((k) => ENV[k]);

type Account = {
  brand: string; clientRef: string; access: string; refresh: string; expiresAt: string | null;
  state: "idle" | "refreshing" | "uncertain" | "reauth_required"; lease: string | null;
  connection: "identity_verified" | "failed"; errorCode: string | null; publish: boolean;
  /** Stage 3A rollout authority; anything but null refuses begin before any Vault read. */
  rolloutRefusal: string | null;
};

/**
 * In-memory mirror of the core RPCs (read / begin / commit / release /
 * record*). Each brand has exactly one X account; the post is the authority.
 */
class FakeCoreDb implements VaultAccountCredentialRpc {
  accounts: Record<string, Account> = {
    ai_salaryman_lab_x: {
      brand: "ai_salaryman_lab", clientRef: "default", access: "tok_AI_expired", refresh: "rt_AI_1", expiresAt: null,
      state: "idle", lease: null, connection: "identity_verified", errorCode: null, publish: true,
      rolloutRefusal: null,
    },
    acct_future: {
      brand: "brand_future", clientRef: "partner", access: "tok_F_expired", refresh: "rt_F_1", expiresAt: null,
      state: "idle", lease: null, connection: "identity_verified", errorCode: null, publish: true,
      rolloutRefusal: null,
    },
  };
  /** Kabumori's legacy store: must never be read or written by this path. */
  kabumoriStore = { access: "tok_KABUMORI", refresh: "rt_KABUMORI" };
  posts: Record<string, { brand: string; running: boolean; attempt: number }> = {
    post_ai: { brand: "ai_salaryman_lab", running: true, attempt: 1 },
    post_future: { brand: "brand_future", running: true, attempt: 1 },
  };
  refreshedFor = new Map<string, string>();
  commitReply: string | null = null;
  failCommit = false;
  calls: string[] = [];
  private n = 0;

  #account(ref: VaultAccountRef): Account {
    const post = this.posts[ref.scheduledPostId];
    if (!post || !post.running || post.brand !== ref.brandId) throw new Error("X_LEGACY_POST_NOT_RUNNING");
    const owner = Object.entries(this.accounts).filter(([, a]) => a.brand === post.brand);
    if (owner.length !== 1) throw new Error("X_ACCOUNT_NOT_UNIQUE_FOR_BRAND");
    if (owner[0][0] !== ref.socialAccountId) throw new Error("X_CLAIM_ACCOUNT_MISMATCH");
    const a = owner[0][1];
    if (a.connection !== "identity_verified") throw new Error("X_ACCOUNT_NOT_VERIFIED");
    if (!a.publish) throw new Error("X_ACCOUNT_PUBLISH_DISABLED");
    return a;
  }
  async read(ref: VaultAccountRef) {
    this.calls.push("read");
    const a = this.#account(ref);
    if (a.state === "refreshing") throw new Error("X_REFRESH_IN_PROGRESS");
    if (a.state === "uncertain") throw new Error("X_REFRESH_BLOCKED_UNCERTAIN");
    if (a.state === "reauth_required") throw new Error("X_REFRESH_REAUTH_REQUIRED");
    return { accessToken: a.access, accessExpiresAt: a.expiresAt };
  }
  async begin(ref: VaultAccountRef) {
    this.calls.push("begin");
    const a = this.#account(ref);
    if (a.state === "refreshing") throw new Error("X_REFRESH_IN_PROGRESS");
    if (a.state === "uncertain") throw new Error("X_REFRESH_BLOCKED_UNCERTAIN");
    if (a.state === "reauth_required") throw new Error("X_REFRESH_REAUTH_REQUIRED");
    if (a.rolloutRefusal) throw new Error(a.rolloutRefusal);
    const key = `${ref.scheduledPostId}:${this.posts[ref.scheduledPostId].attempt}`;
    if (this.refreshedFor.get(ref.socialAccountId) === key) throw new Error("X_REFRESH_ALREADY_USED_FOR_ATTEMPT");
    this.refreshedFor.set(ref.socialAccountId, key);
    a.state = "refreshing";
    a.lease = `lease_${++this.n}`;
    return new XRefreshLease(a.lease, a.clientRef, a.refresh);
  }
  async commit(lease: XRefreshLease, ref: VaultAccountRef, access: string, refresh: string | null, expiresIn: number | null) {
    this.calls.push(`commit:${ref.socialAccountId}:${refresh === null ? "access_only" : "rotated"}:${expiresIn}`);
    if (this.failCommit) throw new Error("X_REFRESH_PERSIST_FAILED");
    const a = this.accounts[ref.socialAccountId];
    if (!a || a.state !== "refreshing" || a.lease !== lease.leaseToken) return "lease_lost";
    if (this.commitReply === "account_changed") {
      a.state = "uncertain"; a.lease = null; a.errorCode = "X_REFRESH_ACCOUNT_CHANGED";
      return "account_changed";
    }
    a.access = access;
    if (refresh !== null) a.refresh = refresh;
    a.expiresAt = expiresIn === null ? null : new Date(Date.now() + expiresIn * 1000).toISOString();
    a.state = "idle"; a.lease = null; a.errorCode = null;
    return "committed";
  }
  async release(lease: XRefreshLease, ref: VaultAccountRef, outcome: "not_rotated" | "reauth_required" | "uncertain", code: string) {
    this.calls.push(`release:${outcome}:${code}`);
    const a = this.accounts[ref.socialAccountId];
    if (!a || a.state !== "refreshing" || a.lease !== lease.leaseToken) return "lease_lost";
    a.state = outcome === "not_rotated" ? "idle" : outcome;
    a.lease = null;
    a.errorCode = code;
    if (outcome === "reauth_required") a.connection = "failed";
    return a.state;
  }
  async recordRejectedAfterRefresh(ref: VaultAccountRef) {
    this.calls.push("rejected_after_refresh");
    const a = this.#account(ref);
    a.state = "reauth_required"; a.connection = "failed"; a.errorCode = "X_ACCESS_TOKEN_REJECTED_AFTER_REFRESH";
    return "reauth_required";
  }
  async recordAccessUnauthorized(ref: VaultAccountRef) {
    this.calls.push("access_unauthorized");
    const a = this.#account(ref);
    if (a.state === "idle") a.errorCode = "X_ACCESS_TOKEN_UNAUTHORIZED";
    return "recorded";
  }
}

const AI: VaultAccountRef = { scheduledPostId: "post_ai", socialAccountId: "ai_salaryman_lab_x", brandId: "ai_salaryman_lab" };
const FUTURE: VaultAccountRef = { scheduledPostId: "post_future", socialAccountId: "acct_future", brandId: "brand_future" };

/** Fake X: token endpoint responses + create-post responses keyed by bearer token. */
function fakeX(tokenResponses: Array<Response | Error>, validTokens: Set<string>) {
  const tokenCalls: Array<{ auth: string | null; redirect: RequestRedirect | undefined; body: URLSearchParams }> = [];
  const creates: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(String(input), TOKEN_URL);
    tokenCalls.push({ auth: new Headers(init?.headers).get("Authorization"), redirect: init?.redirect, body: new URLSearchParams(String(init?.body)) });
    const next = tokenResponses.shift();
    if (!next) throw new Error("unexpected extra token request");
    if (next instanceof Error) throw next;
    return next;
  };
  const request = async (accessToken: string): Promise<XRequestResult> => {
    creates.push(accessToken);
    return validTokens.has(accessToken) ? { status: 201, body: { data: { id: `x_${creates.length}` } } } : { status: 401, body: {} };
  };
  return { fetchImpl, request, tokenCalls, creates };
}

async function load(db: FakeCoreDb, ref: VaultAccountRef, fetchImpl: typeof fetch, refreshEnabled = true, now?: () => number) {
  return await VaultAccountXAuth.load(ref, db, { resolveClient: registry, refreshEnabled, fetchImpl, now });
}
const rejects = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => e instanceof Error && e.message === code);

test("AI Lab incident: expired Vault access token -> 401 -> one refresh -> same account committed -> exact request retried once", async () => {
  const db = new FakeCoreDb();
  const x = fakeX([Response.json({ access_token: "tok_AI_new", refresh_token: "rt_AI_2", expires_in: 7200, token_type: "bearer" })], new Set(["tok_AI_new"]));
  const auth = await load(db, AI, x.fetchImpl);
  const result = await auth.send(x.request);
  assert.equal(result.status, 201);
  assert.deepEqual(x.creates, ["tok_AI_expired", "tok_AI_new"]);
  assert.equal(x.tokenCalls.length, 1);
  assert.equal(x.tokenCalls[0].body.get("refresh_token"), "rt_AI_1");
  assert.equal(x.tokenCalls[0].body.get("grant_type"), "refresh_token");
  assert.equal(x.tokenCalls[0].auth, `Basic ${btoa("cid:csecret")}`);
  assert.equal(x.tokenCalls[0].redirect, "manual");
  assert.deepEqual(db.calls, ["read", "begin", "commit:ai_salaryman_lab_x:rotated:7200", "read"]);
  assert.equal(db.accounts.ai_salaryman_lab_x.access, "tok_AI_new");
  assert.equal(db.accounts.ai_salaryman_lab_x.refresh, "rt_AI_2");
  assert.equal(db.accounts.ai_salaryman_lab_x.state, "idle");
  assert.equal(auth.refreshExecuted, true);
  // Other accounts and Kabumori's legacy store untouched.
  assert.equal(db.accounts.acct_future.access, "tok_F_expired");
  assert.deepEqual(db.kabumoriStore, { access: "tok_KABUMORI", refresh: "rt_KABUMORI" });
});

test("future account: another brand uses the same generic path with its own client ref and refs", async () => {
  const db = new FakeCoreDb();
  const x = fakeX([Response.json({ access_token: "tok_F_new", expires_in: 7200 })], new Set(["tok_F_new"]));
  const auth = await load(db, FUTURE, x.fetchImpl);
  assert.equal((await auth.send(x.request)).status, 201);
  assert.equal(x.tokenCalls[0].auth, `Basic ${btoa("pid:psecret")}`);
  assert.equal(x.tokenCalls[0].body.get("refresh_token"), "rt_F_1");
  assert.equal(db.accounts.acct_future.access, "tok_F_new");
  assert.equal(db.accounts.acct_future.refresh, "rt_F_1", "omitted refresh_token keeps the stored one");
  assert.equal(db.accounts.ai_salaryman_lab_x.access, "tok_AI_expired");
});

test("unknown oauth_client_ref fails closed with zero token requests and the lease released", async () => {
  const db = new FakeCoreDb();
  db.accounts.acct_future.clientRef = "unapproved";
  const x = fakeX([], new Set());
  const auth = await load(db, FUTURE, x.fetchImpl);
  await rejects(auth.send(x.request), "X_REFRESH_CLIENT_NOT_CONFIGURED");
  assert.equal(x.tokenCalls.length, 0);
  assert.deepEqual(x.creates, ["tok_F_expired"]);
  assert.equal(db.accounts.acct_future.state, "idle");
});

test("cross-account authority: wrong account, brand mismatch and unknown post fail before any X call", async () => {
  const db = new FakeCoreDb();
  const x = fakeX([], new Set());
  await rejects(load(db, { ...AI, socialAccountId: "acct_future" }, x.fetchImpl), "X_CLAIM_ACCOUNT_MISMATCH");
  await rejects(load(db, { ...AI, brandId: "brand_future" }, x.fetchImpl), "X_LEGACY_POST_NOT_RUNNING");
  await rejects(load(db, { ...AI, scheduledPostId: "post_future" }, x.fetchImpl), "X_LEGACY_POST_NOT_RUNNING");
  await rejects(load(db, { ...AI, socialAccountId: " " }, x.fetchImpl), "X_CREDENTIAL_REQUEST_INVALID");
  db.accounts.acct_other = { ...db.accounts.acct_future, brand: "ai_salaryman_lab" };
  await rejects(load(db, AI, x.fetchImpl), "X_ACCOUNT_NOT_UNIQUE_FOR_BRAND");
  assert.equal(x.creates.length + x.tokenCalls.length, 0);
});

test("account changed / stale lease / Vault write failure during refresh: no retry of the X request", async () => {
  for (const [setup, code] of [
    [(db: FakeCoreDb) => { db.commitReply = "account_changed"; }, "X_REFRESH_ACCOUNT_CHANGED"],
    [(db: FakeCoreDb) => { db.accounts.ai_salaryman_lab_x.lease = "stolen"; }, "X_REFRESH_LEASE_LOST"],
    [(db: FakeCoreDb) => { db.failCommit = true; }, "X_REFRESH_PERSIST_FAILED"],
  ] as const) {
    const db = new FakeCoreDb();
    const x = fakeX([Response.json({ access_token: "tok_AI_new", refresh_token: "rt_AI_2" })], new Set(["tok_AI_new"]));
    const auth = await load(db, AI, x.fetchImpl);
    const original = db.begin.bind(db);
    db.begin = async (ref) => { const lease = await original(ref); setup(db); return lease; };
    await rejects(auth.send(x.request), code);
    assert.deepEqual(x.creates, ["tok_AI_expired"], code);
    assert.equal(db.accounts.ai_salaryman_lab_x.access, "tok_AI_expired", code);
    assert.notEqual(db.accounts.ai_salaryman_lab_x.state, "idle", code);
  }
});

test("provider semantics: invalid_grant -> reauth; network/timeout/5xx/3xx/malformed -> uncertain; 429 not rotated", async () => {
  const cases: Array<[Response | Error, string, string]> = [
    [Response.json({ error: "invalid_grant" }, { status: 400 }), "X_REFRESH_GRANT_REJECTED", "reauth_required"],
    [new TypeError("network down"), "X_REFRESH_NETWORK_UNCERTAIN", "uncertain"],
    [new DOMException("timed out", "TimeoutError"), "X_REFRESH_NETWORK_UNCERTAIN", "uncertain"],
    [new Response("oops", { status: 503 }), "X_REFRESH_HTTP_503", "uncertain"],
    [new Response(null, { status: 302, headers: { Location: "https://evil.example/" } }), "X_REFRESH_HTTP_302", "uncertain"],
    [new Response("<html>", { status: 200 }), "X_REFRESH_RESPONSE_INVALID", "uncertain"],
    [Response.json({ refresh_token: "rt_only" }), "X_REFRESH_RESPONSE_INVALID", "uncertain"],
    [Response.json({ error: "slow down" }, { status: 429 }), "X_REFRESH_RATE_LIMITED", "idle"],
  ];
  for (const [response, code, state] of cases) {
    const db = new FakeCoreDb();
    const x = fakeX([response], new Set());
    const auth = await load(db, AI, x.fetchImpl);
    await rejects(auth.send(x.request), code);
    assert.equal(x.tokenCalls.length, 1, code);
    assert.deepEqual(x.creates, ["tok_AI_expired"], `${code}: no replay`);
    assert.equal(db.accounts.ai_salaryman_lab_x.state, state, code);
    assert.equal(db.accounts.ai_salaryman_lab_x.refresh, "rt_AI_1", code);
    if (state === "reauth_required") assert.equal(db.accounts.ai_salaryman_lab_x.connection, "failed");
  }
});

test("second 401 after one refresh marks re-authorization and stops; no second refresh, no third request", async () => {
  const db = new FakeCoreDb();
  const x = fakeX([Response.json({ access_token: "tok_AI_new" })], new Set());
  const auth = await load(db, AI, x.fetchImpl);
  await rejects(auth.send(x.request), "X_ACCESS_TOKEN_REJECTED_AFTER_REFRESH");
  assert.deepEqual(x.creates, ["tok_AI_expired", "tok_AI_new"]);
  assert.equal(x.tokenCalls.length, 1);
  assert.equal(db.accounts.ai_salaryman_lab_x.state, "reauth_required");
  assert.equal(db.accounts.ai_salaryman_lab_x.connection, "failed");
  // A later request in the same attempt never refreshes again.
  await rejects(auth.send(x.request), "X_ACCESS_TOKEN_REJECTED_AFTER_REFRESH");
  assert.equal(x.tokenCalls.length, 1);
  // The next scheduled job fails closed before generation / X.
  await rejects(load(db, AI, x.fetchImpl), "X_ACCOUNT_NOT_VERIFIED");
  assert.equal(x.creates.length, 3);
});

test("after an accepted X write in the attempt (thread), a 401 never refreshes", async () => {
  const db = new FakeCoreDb();
  db.accounts.ai_salaryman_lab_x.access = "tok_AI_valid";
  let n = 0;
  const x = fakeX([], new Set());
  const request = async (token: string): Promise<XRequestResult> => {
    x.creates.push(token);
    return ++n === 1 ? { status: 201, body: {} } : { status: 401, body: {} };
  };
  const auth = await load(db, AI, x.fetchImpl);
  assert.equal((await auth.send(request)).status, 201);
  await rejects(auth.send(request), "X_ACCESS_TOKEN_UNAUTHORIZED");
  assert.equal(x.tokenCalls.length, 0);
  assert.ok(db.calls.includes("access_unauthorized"));
  assert.equal(db.accounts.ai_salaryman_lab_x.errorCode, "X_ACCESS_TOKEN_UNAUTHORIZED");
});

test("gate off: 401 is recorded as unauthorized with no token endpoint call", async () => {
  const db = new FakeCoreDb();
  const x = fakeX([], new Set());
  const auth = await load(db, AI, x.fetchImpl, false);
  await rejects(auth.send(x.request), "X_ACCESS_TOKEN_UNAUTHORIZED");
  assert.equal(x.tokenCalls.length, 0);
  assert.deepEqual(x.creates, ["tok_AI_expired"]);
  assert.equal(db.accounts.ai_salaryman_lab_x.errorCode, "X_ACCESS_TOKEN_UNAUTHORIZED");
  assert.equal(db.accounts.ai_salaryman_lab_x.connection, "identity_verified");
  assert.equal(db.accounts.ai_salaryman_lab_x.refresh, "rt_AI_1");
});

test("proactive refresh from the stored expiry, then one request; one refresh per attempt", async () => {
  const db = new FakeCoreDb();
  const now = Date.parse("2026-09-25T00:00:00Z");
  db.accounts.ai_salaryman_lab_x.expiresAt = new Date(now + 60_000).toISOString();
  const x = fakeX([Response.json({ access_token: "tok_AI_new", expires_in: 7200 })], new Set(["tok_AI_new"]));
  const auth = await load(db, AI, x.fetchImpl, true, () => now);
  assert.equal((await auth.send(x.request)).status, 201);
  assert.deepEqual(x.creates, ["tok_AI_new"]);
  assert.equal(x.tokenCalls.length, 1);
  // Not near expiry -> no proactive refresh.
  const db2 = new FakeCoreDb();
  db2.accounts.ai_salaryman_lab_x.access = "tok_AI_valid";
  db2.accounts.ai_salaryman_lab_x.expiresAt = new Date(now + 3_600_000).toISOString();
  const x2 = fakeX([], new Set(["tok_AI_valid"]));
  assert.equal((await (await load(db2, AI, x2.fetchImpl, true, () => now)).send(x2.request)).status, 201);
  assert.equal(x2.tokenCalls.length, 0);
});

test("the same post attempt cannot refresh twice even across auth instances", async () => {
  const db = new FakeCoreDb();
  const x = fakeX([Response.json({ access_token: "tok_AI_new" })], new Set());
  await rejects((await load(db, AI, x.fetchImpl)).send(x.request), "X_ACCESS_TOKEN_REJECTED_AFTER_REFRESH");
  db.accounts.ai_salaryman_lab_x.state = "idle";  // operator reset without reconnect
  db.accounts.ai_salaryman_lab_x.connection = "identity_verified";
  await rejects((await load(db, AI, x.fetchImpl)).send(x.request), "X_REFRESH_ALREADY_USED_FOR_ATTEMPT");
  assert.equal(x.tokenCalls.length, 1);
});

test("blocked accounts fail at load, before generation and X", async () => {
  for (const [state, code] of [["refreshing", "X_REFRESH_IN_PROGRESS"], ["uncertain", "X_REFRESH_BLOCKED_UNCERTAIN"], ["reauth_required", "X_REFRESH_REAUTH_REQUIRED"]] as const) {
    const db = new FakeCoreDb();
    db.accounts.ai_salaryman_lab_x.state = state;
    await rejects(load(db, AI, fakeX([], new Set()).fetchImpl), code);
  }
  const db = new FakeCoreDb();
  db.accounts.ai_salaryman_lab_x.publish = false;
  await rejects(load(db, AI, fakeX([], new Set()).fetchImpl), "X_ACCOUNT_PUBLISH_DISABLED");
});

test("no token, refresh token, lease, body or client secret reaches errors, JSON or logs", async () => {
  const logged: unknown[] = [];
  const saved = { error: console.error, log: console.log, warn: console.warn, info: console.info };
  console.error = console.log = console.warn = console.info = (...args: unknown[]) => { logged.push(args); };
  const outputs: unknown[] = [];
  try {
    for (const response of [
      Response.json({ access_token: "tok_SECRET_new", refresh_token: "rt_SECRET_new" }),
      Response.json({ error: "invalid_grant", error_description: "rt_AI_1 revoked" }, { status: 400 }),
      new Response("tok_SECRET_body", { status: 500 }),
    ]) {
      const db = new FakeCoreDb();
      const x = fakeX([response], new Set());
      const auth = await load(db, AI, x.fetchImpl);
      outputs.push(JSON.stringify(auth), String(auth));
      try {
        await auth.send(x.request);
      } catch (error) {
        outputs.push(error instanceof Error ? `${error.message} ${error.stack}` : String(error));
      }
      outputs.push(JSON.stringify(auth), Deno.inspect(auth));
    }
  } finally {
    Object.assign(console, saved);
  }
  const text = JSON.stringify(outputs);
  for (const secret of ["tok_SECRET_new", "rt_SECRET_new", "rt_AI_1", "tok_AI_expired", "lease_1", "csecret", "tok_SECRET_body"]) {
    assert.ok(!text.includes(secret), secret);
  }
  assert.equal(logged.length, 0);
});

test("RPC adapter: exact post/account/brand parameters, no secret ids, manual redirects, fixed codes", async () => {
  const sent: Array<{ name: string; body: Record<string, unknown>; redirect: RequestRedirect | undefined }> = [];
  const replies: Record<string, unknown> = {
    read_x_publish_credential_for_legacy_post: [{ social_account_id: "ai_salaryman_lab_x", brand_id: "ai_salaryman_lab", platform_user_id: "x1", access_token: "tok", access_expires_at: null }],
    begin_x_account_refresh_legacy_post: [{ lease_token: "L1", oauth_client_ref: "default", refresh_token: "rt" }],
    commit_x_account_refresh_legacy_post: "committed",
    release_x_account_refresh_v2: "idle",
    record_x_account_rejected_after_refresh: "reauth_required",
    record_x_account_access_unauthorized: "recorded",
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const name = String(input).replace("https://e.supabase.co/rest/v1/rpc/", "");
    sent.push({ name, body: JSON.parse(String(init?.body)), redirect: init?.redirect });
    return Response.json(replies[name]);
  };
  const rpc = createVaultAccountCredentialRpc({ supabaseUrl: "https://e.supabase.co/", serviceRoleKey: "srk", fetchImpl });
  assert.deepEqual(await rpc.read(AI), { accessToken: "tok", accessExpiresAt: null });
  const lease = await rpc.begin(AI);
  assert.equal(await rpc.commit(lease, AI, "tok2", null, 7200), "committed");
  assert.equal(await rpc.release(lease, AI, "uncertain", "X_REFRESH_NETWORK_UNCERTAIN"), "idle");
  assert.equal(await rpc.recordRejectedAfterRefresh(AI), "reauth_required");
  assert.equal(await rpc.recordAccessUnauthorized(AI), "recorded");
  const post = { p_scheduled_post_id: "post_ai", p_social_account_id: "ai_salaryman_lab_x", p_brand_id: "ai_salaryman_lab" };
  assert.deepEqual(sent.map((s) => [s.name, s.body]), [
    ["read_x_publish_credential_for_legacy_post", post],
    ["begin_x_account_refresh_legacy_post", post],
    ["commit_x_account_refresh_legacy_post", { p_lease_token: "L1", p_social_account_id: "ai_salaryman_lab_x", p_access_token: "tok2", p_refresh_token: null, p_expires_in: 7200 }],
    ["release_x_account_refresh_v2", { p_lease_token: "L1", p_social_account_id: "ai_salaryman_lab_x", p_outcome: "uncertain", p_error_code: "X_REFRESH_NETWORK_UNCERTAIN" }],
    ["record_x_account_rejected_after_refresh", post],
    ["record_x_account_access_unauthorized", post],
  ]);
  assert.ok(sent.every((s) => s.redirect === "manual"));
  assert.ok(sent.every((s) => !JSON.stringify(s.body).includes("secret")));
  // Another account's row, unknown errors and malformed rows fail closed with fixed codes.
  const other = createVaultAccountCredentialRpc({ supabaseUrl: "https://e", serviceRoleKey: "k",
    fetchImpl: async () => Response.json([{ social_account_id: "acct_future", brand_id: "ai_salaryman_lab", access_token: "tok", access_expires_at: null }]) });
  await rejects(other.read(AI), "X_CREDENTIAL_UNAVAILABLE");
  const leaky = createVaultAccountCredentialRpc({ supabaseUrl: "https://e", serviceRoleKey: "k",
    fetchImpl: async () => Response.json({ message: "permission denied tok_leak" }, { status: 500 }) });
  await rejects(leaky.read(AI), "X_CREDENTIAL_UNAVAILABLE");
  await rejects(leaky.begin(AI), "X_REFRESH_UNAVAILABLE");
  await rejects(leaky.commit(new XRefreshLease("L", "default", "rt"), AI, "t", null, null), "X_REFRESH_PERSIST_FAILED");
  const known = createVaultAccountCredentialRpc({ supabaseUrl: "https://e", serviceRoleKey: "k",
    fetchImpl: async () => Response.json({ message: "X_REFRESH_REAUTH_REQUIRED" }, { status: 400 }) });
  await rejects(known.read(AI), "X_REFRESH_REAUTH_REQUIRED");
});

test("source: no Kabumori store/env tokens, no console, no loops, one token request site", async () => {
  const source = (await Deno.readTextFile(new URL("./vault_account_auth.ts", import.meta.url))).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, "");
  assert.doesNotMatch(source, /oauth_token_store|X_OAUTH2_ACCESS_TOKEN|X_OAUTH2_REFRESH_TOKEN|Deno\.env|console\.|ai_salaryman_lab|kabumori/iu);
  assert.doesNotMatch(source, /(^|[^.\w])(while|for)\s*\(/mu);
  assert.doesNotMatch(source, /secret_id|p_vault|vault\./u);
  assert.doesNotMatch(source, /api\.x\.com/u, "the only token request lives in the shared refresh core");
  assert.equal((source.match(/runXTokenRefresh\(/gu) ?? []).length, 1);
});

test("Stage 3A rollout off: 401 -> zero token requests, 401 recorded, fixed rollout code; other account unaffected", async () => {
  const db = new FakeCoreDb();
  db.accounts.ai_salaryman_lab_x.rolloutRefusal = "X_REFRESH_ROLLOUT_OFF";
  const x = fakeX([], new Set());
  await rejects((await load(db, AI, x.fetchImpl)).send(x.request), "X_REFRESH_ROLLOUT_OFF");
  assert.equal(x.tokenCalls.length, 0);
  assert.deepEqual(x.creates, ["tok_AI_expired"]);
  assert.equal(db.accounts.ai_salaryman_lab_x.errorCode, "X_ACCESS_TOKEN_UNAUTHORIZED");
  assert.equal(db.accounts.ai_salaryman_lab_x.state, "idle");
  assert.equal(db.accounts.ai_salaryman_lab_x.refresh, "rt_AI_1");
  // Account B (enabled) refreshes normally in the same process.
  const xb = fakeX([Response.json({ access_token: "tok_F_new" })], new Set(["tok_F_new"]));
  assert.equal((await (await load(db, FUTURE, xb.fetchImpl)).send(xb.request)).status, 201);
  assert.equal(xb.tokenCalls.length, 1);
  assert.equal(db.accounts.ai_salaryman_lab_x.access, "tok_AI_expired", "A never inherits B's refresh");
});

test("Stage 3A pilot refusals behave like off: no token request, no retry", async () => {
  for (const code of ["X_REFRESH_PILOT_LIMIT_REACHED", "X_REFRESH_PILOT_EXPIRED", "X_REFRESH_PILOT_BLOCKED_BY_ERROR"]) {
    const db = new FakeCoreDb();
    db.accounts.ai_salaryman_lab_x.rolloutRefusal = code;
    const x = fakeX([], new Set());
    await rejects((await load(db, AI, x.fetchImpl)).send(x.request), code);
    assert.equal(x.tokenCalls.length, 0, code);
    assert.equal(x.creates.length, 1, code);
    assert.ok(db.calls.includes("access_unauthorized"), code);
  }
});

test("proactive refresh refused before any token request keeps the current token (budget untouched)", async () => {
  const now = Date.parse("2026-09-25T00:00:00Z");
  // Still-valid token near expiry, rollout off: post goes through with it.
  const db = new FakeCoreDb();
  db.accounts.ai_salaryman_lab_x.access = "tok_AI_valid";
  db.accounts.ai_salaryman_lab_x.expiresAt = new Date(now + 60_000).toISOString();
  db.accounts.ai_salaryman_lab_x.rolloutRefusal = "X_REFRESH_ROLLOUT_OFF";
  const x = fakeX([], new Set(["tok_AI_valid"]));
  assert.equal((await (await load(db, AI, x.fetchImpl, true, () => now)).send(x.request)).status, 201);
  assert.equal(x.tokenCalls.length, 0);
  assert.ok(!db.calls.includes("access_unauthorized"));
  // Proactive refused, token actually expired: reactive begin is refused too -> fixed code, still no token request.
  const db2 = new FakeCoreDb();
  db2.accounts.ai_salaryman_lab_x.expiresAt = new Date(now + 60_000).toISOString();
  db2.accounts.ai_salaryman_lab_x.rolloutRefusal = "X_REFRESH_ROLLOUT_OFF";
  const x2 = fakeX([], new Set());
  await rejects((await load(db2, AI, x2.fetchImpl, true, () => now)).send(x2.request), "X_REFRESH_ROLLOUT_OFF");
  assert.equal(x2.tokenCalls.length, 0);
  assert.equal(x2.creates.length, 1);
  // Proactive that did reach X keeps the one-refresh budget: a later 401 never refreshes again.
  const db3 = new FakeCoreDb();
  db3.accounts.ai_salaryman_lab_x.expiresAt = new Date(now + 60_000).toISOString();
  const x3 = fakeX([Response.json({ access_token: "tok_AI_new", expires_in: 7200 })], new Set());
  await rejects((await load(db3, AI, x3.fetchImpl, true, () => now)).send(x3.request), "X_ACCESS_TOKEN_REJECTED_AFTER_REFRESH");
  assert.equal(x3.tokenCalls.length, 1);
});

test("unexpected proactive begin failure does not send an X write with the stale credential", async () => {
  const now = Date.parse("2026-09-25T00:00:00Z");
  for (const code of ["X_REFRESH_UNAVAILABLE", "X_CLAIM_ACCOUNT_MISMATCH"]) {
    const db = new FakeCoreDb();
    db.accounts.ai_salaryman_lab_x.access = "tok_AI_still_valid";
    db.accounts.ai_salaryman_lab_x.expiresAt = new Date(now + 60_000).toISOString();
    db.accounts.ai_salaryman_lab_x.rolloutRefusal = code;
    const x = fakeX([], new Set(["tok_AI_still_valid"]));
    await rejects((await load(db, AI, x.fetchImpl, true, () => now)).send(x.request), code);
    assert.deepEqual(x.creates, [], code);
    assert.equal(x.tokenCalls.length, 0, code);
  }
});

test("expected concurrent-refresh refusal may use a still-valid credential", async () => {
  const now = Date.parse("2026-09-25T00:00:00Z");
  const db = new FakeCoreDb();
  db.accounts.ai_salaryman_lab_x.access = "tok_AI_still_valid";
  db.accounts.ai_salaryman_lab_x.expiresAt = new Date(now + 60_000).toISOString();
  db.accounts.ai_salaryman_lab_x.rolloutRefusal = "X_REFRESH_IN_PROGRESS";
  const x = fakeX([], new Set(["tok_AI_still_valid"]));
  assert.equal((await (await load(db, AI, x.fetchImpl, true, () => now)).send(x.request)).status, 201);
  assert.deepEqual(x.creates, ["tok_AI_still_valid"]);
  assert.equal(x.tokenCalls.length, 0);
});
