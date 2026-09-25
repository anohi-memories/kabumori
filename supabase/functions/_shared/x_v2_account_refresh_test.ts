// Fake ledger / fake X callbacks are async by contract even when they do not await.
// deno-lint-ignore-file require-await
import assert from "node:assert/strict";
import test from "node:test";
import type { XV2Claim } from "./x_v2_claim_credentials.ts";
import {
  createXAccountRefreshRpcLedger,
  defaultXOAuthClientResolver,
  refreshXAccountPreX,
  xOAuthClientRegistryFromEnv,
  XRefreshLease,
  type XAccountRefreshLedger,
} from "./x_v2_account_refresh.ts";

const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("REAL_FETCH_FORBIDDEN_IN_TESTS"); }) as typeof fetch;
addEventListener("unload", () => { globalThis.fetch = realFetch; });

const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const CLIENT = { clientId: "cid", clientSecret: "csecret" };
const resolveClient = (ref: string) => (ref === "default" ? CLIENT : null);

type Account = { brand: string; access: string; refresh: string | null; state: "idle" | "refreshing" | "uncertain" | "reauth_required"; lease: string | null; generation: number };

/** In-memory mirror of begin/commit/release_x_account_refresh_v2. */
class FakeRefreshDb implements XAccountRefreshLedger {
  accounts: Record<string, Account> = {
    acct_a: { brand: "brand_a", access: "tok_A_old", refresh: "rt_A_1", state: "idle", lease: null, generation: 0 },
    acct_b: { brand: "brand_b", access: "tok_B_old", refresh: "rt_B_1", state: "idle", lease: null, generation: 0 },
  };
  claims: Record<string, { token: string; account: string; brand: string; preX: boolean }> = {
    att_a: { token: "ct_a", account: "acct_a", brand: "brand_a", preX: true },
    att_a2: { token: "ct_a2", account: "acct_a", brand: "brand_a", preX: true },
    att_b: { token: "ct_b", account: "acct_b", brand: "brand_b", preX: true },
  };
  failCommit = false;
  failRelease = false;
  commitReply: string | null = null;
  calls: string[] = [];
  private n = 0;

  async begin(claim: XV2Claim): Promise<XRefreshLease> {
    this.calls.push(`begin:${claim.attemptId}`);
    const c = this.claims[claim.attemptId];
    if (!c || c.token !== claim.claimToken || !c.preX) throw new Error("X_REFRESH_CLAIM_NOT_PRE_X");
    if (c.account !== claim.socialAccountId || c.brand !== claim.brandId) throw new Error("X_REFRESH_ACCOUNT_MISMATCH");
    const a = this.accounts[c.account];
    if (!a.refresh) throw new Error("X_REFRESH_CREDENTIAL_NOT_CONFIGURED");
    if (a.state === "refreshing") throw new Error("X_REFRESH_IN_PROGRESS");
    if (a.state === "uncertain") throw new Error("X_REFRESH_BLOCKED_UNCERTAIN");
    if (a.state === "reauth_required") throw new Error("X_REFRESH_REAUTH_REQUIRED");
    a.state = "refreshing";
    a.lease = `lease_${++this.n}`;
    return new XRefreshLease(a.lease, "default", a.refresh);
  }
  async commit(lease: XRefreshLease, accountId: string, access: string, refresh: string | null) {
    this.calls.push(`commit:${accountId}:${refresh === null ? "access_only" : "rotated"}`);
    if (this.failCommit) throw new Error("X_REFRESH_PERSIST_FAILED");
    if (this.commitReply) return this.commitReply;
    const a = this.accounts[accountId];
    if (!a || a.state !== "refreshing" || a.lease !== lease.leaseToken) return "lease_lost";
    a.access = access;
    if (refresh !== null) a.refresh = refresh;
    a.state = "idle"; a.lease = null; a.generation += 1;
    return "committed";
  }
  async release(lease: XRefreshLease, accountId: string, outcome: "not_rotated" | "reauth_required" | "uncertain", code: string) {
    this.calls.push(`release:${accountId}:${outcome}:${code}`);
    if (this.failRelease) throw new Error("X_REFRESH_UNAVAILABLE");
    const a = this.accounts[accountId];
    if (!a || a.state !== "refreshing" || a.lease !== lease.leaseToken) return "lease_lost";
    a.state = outcome === "not_rotated" ? "idle" : outcome;
    a.lease = null;
    return a.state;
  }
}

function tokenEndpoint(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; auth: string | null; redirect: RequestRedirect | undefined; body: URLSearchParams }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input), auth: new Headers(init?.headers).get("Authorization"), redirect: init?.redirect,
      body: new URLSearchParams(String(init?.body)),
    });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra token request");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchImpl, calls };
}
const claimA: XV2Claim = { attemptId: "att_a", claimToken: "ct_a", socialAccountId: "acct_a", brandId: "brand_a" };
const claimB: XV2Claim = { attemptId: "att_b", claimToken: "ct_b", socialAccountId: "acct_b", brandId: "brand_b" };

test("access-only response: one token request with exactly this account's refresh token; only access updated", async () => {
  const db = new FakeRefreshDb();
  const x = tokenEndpoint([Response.json({ token_type: "bearer", access_token: "tok_A_new", expires_in: 7200 })]);
  const r = await refreshXAccountPreX({ claim: claimA, ledger: db, resolveClient }, { fetchImpl: x.fetchImpl });
  assert.deepEqual(r, { kind: "refreshed", postOutcome: "pre_x_retryable", code: "X_ACCESS_TOKEN_REFRESHED_PRE_X", tokenRequests: 1 });
  assert.equal(x.calls.length, 1);
  assert.equal(x.calls[0].url, TOKEN_URL);
  assert.equal(x.calls[0].redirect, "manual");
  assert.equal(x.calls[0].auth, `Basic ${btoa("cid:csecret")}`);
  assert.deepEqual(Object.fromEntries(x.calls[0].body), { grant_type: "refresh_token", refresh_token: "rt_A_1", client_id: "cid" });
  assert.equal(db.accounts.acct_a.access, "tok_A_new");
  assert.equal(db.accounts.acct_a.refresh, "rt_A_1");
  assert.equal(db.accounts.acct_b.access, "tok_B_old");
  assert.deepEqual(db.calls, ["begin:att_a", "commit:acct_a:access_only"]);
});

test("rotated response updates access and refresh of the same account only", async () => {
  const db = new FakeRefreshDb();
  const x = tokenEndpoint([Response.json({ access_token: "tok_B_new", refresh_token: "rt_B_2" })]);
  const r = await refreshXAccountPreX({ claim: claimB, ledger: db, resolveClient }, { fetchImpl: x.fetchImpl });
  assert.equal(r.kind, "refreshed");
  assert.equal(x.calls[0].body.get("refresh_token"), "rt_B_1");
  assert.deepEqual([db.accounts.acct_b.access, db.accounts.acct_b.refresh], ["tok_B_new", "rt_B_2"]);
  assert.deepEqual([db.accounts.acct_a.access, db.accounts.acct_a.refresh], ["tok_A_old", "rt_A_1"]);
});

test("refusals before the lease make zero token requests", async () => {
  const cases: Array<[XV2Claim, (db: FakeRefreshDb) => void, string, string]> = [
    [{ ...claimA, claimToken: "wrong" }, () => {}, "X_REFRESH_CLAIM_NOT_PRE_X", "pre_x_terminal"],
    [{ ...claimA, socialAccountId: "acct_b", brandId: "brand_b" }, () => {}, "X_REFRESH_ACCOUNT_MISMATCH", "pre_x_terminal"],
    [claimA, (db) => { db.claims.att_a.preX = false; }, "X_REFRESH_CLAIM_NOT_PRE_X", "pre_x_terminal"],
    [claimA, (db) => { db.accounts.acct_a.refresh = null; }, "X_REFRESH_CREDENTIAL_NOT_CONFIGURED", "pre_x_terminal"],
    [claimA, (db) => { db.accounts.acct_a.state = "refreshing"; }, "X_REFRESH_IN_PROGRESS", "pre_x_retryable"],
    [claimA, (db) => { db.accounts.acct_a.state = "uncertain"; }, "X_REFRESH_BLOCKED_UNCERTAIN", "pre_x_terminal"],
    [claimA, (db) => { db.accounts.acct_a.state = "reauth_required"; }, "X_REFRESH_REAUTH_REQUIRED", "pre_x_terminal"],
    [{ ...claimA, attemptId: " " }, () => {}, "X_REFRESH_REQUEST_INVALID", "pre_x_terminal"],
  ];
  for (const [claim, arrange, code, postOutcome] of cases) {
    const db = new FakeRefreshDb();
    arrange(db);
    const x = tokenEndpoint([]);
    const r = await refreshXAccountPreX({ claim, ledger: db, resolveClient }, { fetchImpl: x.fetchImpl });
    assert.deepEqual(r, { kind: "not_started", postOutcome, code, tokenRequests: 0 }, code);
    assert.equal(x.calls.length, 0, code);
    assert.equal(db.accounts.acct_a.access, "tok_A_old", code);
  }
});

test("unknown OAuth client releases the lease untouched with zero token requests", async () => {
  const db = new FakeRefreshDb();
  const x = tokenEndpoint([]);
  const r = await refreshXAccountPreX({ claim: claimA, ledger: db, resolveClient: () => null }, { fetchImpl: x.fetchImpl });
  assert.deepEqual(r, { kind: "not_started", postOutcome: "pre_x_terminal", code: "X_REFRESH_CLIENT_NOT_CONFIGURED", tokenRequests: 0 });
  assert.equal(db.accounts.acct_a.state, "idle");
  assert.equal(x.calls.length, 0);
  const thrower = await refreshXAccountPreX({ claim: claimA, ledger: db, resolveClient: () => { throw new Error("env"); } }, { fetchImpl: x.fetchImpl });
  assert.equal(thrower.code, "X_REFRESH_CLIENT_NOT_CONFIGURED");
});

test("uncertain outcomes block the account and are never retried in the same run", async () => {
  const cases: Array<[Response | Error, string]> = [
    [new TypeError("reset"), "X_REFRESH_NETWORK_UNCERTAIN"],
    [new DOMException("timeout", "TimeoutError"), "X_REFRESH_NETWORK_UNCERTAIN"],
    [Response.json({}, { status: 503 }), "X_REFRESH_HTTP_503"],
    [Response.json({}, { status: 408 }), "X_REFRESH_HTTP_408"],
    [new Response(null, { status: 307, headers: { Location: "https://evil.example/token" } }), "X_REFRESH_HTTP_307"],
    [Response.json({ refresh_token: "rt_new_but_no_access" }), "X_REFRESH_RESPONSE_INVALID"],
    [new Response("<html>ok</html>", { status: 200 }), "X_REFRESH_RESPONSE_INVALID"],
    [Response.json({ access_token: "a", refresh_token: "" }), "X_REFRESH_RESPONSE_INVALID"],
    [Response.json({ access_token: "a", token_type: "mac" }), "X_REFRESH_RESPONSE_INVALID"],
  ];
  for (const [response, code] of cases) {
    const db = new FakeRefreshDb();
    const x = tokenEndpoint([response]);
    const r = await refreshXAccountPreX({ claim: claimA, ledger: db, resolveClient }, { fetchImpl: x.fetchImpl });
    assert.deepEqual(r, { kind: "uncertain", postOutcome: "pre_x_terminal", code, tokenRequests: 1 }, code);
    assert.equal(x.calls.length, 1, code);
    assert.equal(db.accounts.acct_a.state, "uncertain", code);
    assert.deepEqual([db.accounts.acct_a.access, db.accounts.acct_a.refresh], ["tok_A_old", "rt_A_1"], code);
    // A later run is refused before any token request: no blind replay.
    const again = await refreshXAccountPreX({ claim: { ...claimA, attemptId: "att_a2", claimToken: "ct_a2" }, ledger: db, resolveClient }, { fetchImpl: x.fetchImpl });
    assert.equal(again.code, "X_REFRESH_BLOCKED_UNCERTAIN", code);
    assert.equal(x.calls.length, 1, code);
  }
});

test("answered rejections: rate limit retryable, invalid_grant needs re-auth, others terminal; tokens untouched", async () => {
  const cases: Array<[Response, string, string, string]> = [
    [Response.json({ error: "rate" }, { status: 429 }), "not_rotated", "X_REFRESH_RATE_LIMITED", "pre_x_retryable"],
    [Response.json({ error: "invalid_grant", error_description: "rt_A_1 is invalid" }, { status: 400 }), "reauth_required", "X_REFRESH_GRANT_REJECTED", "pre_x_terminal"],
    [Response.json({ error: "invalid_request" }, { status: 400 }), "not_rotated", "X_REFRESH_REQUEST_REJECTED_400", "pre_x_terminal"],
    [Response.json({ error: "invalid_client" }, { status: 401 }), "not_rotated", "X_REFRESH_CLIENT_REJECTED_401", "pre_x_terminal"],
    [Response.json({}, { status: 404 }), "not_rotated", "X_REFRESH_REJECTED_404", "pre_x_terminal"],
  ];
  for (const [response, kind, code, postOutcome] of cases) {
    const db = new FakeRefreshDb();
    const x = tokenEndpoint([response]);
    const r = await refreshXAccountPreX({ claim: claimA, ledger: db, resolveClient }, { fetchImpl: x.fetchImpl });
    assert.deepEqual(r, { kind, postOutcome, code, tokenRequests: 1 }, code);
    assert.equal(db.accounts.acct_a.state, kind === "not_rotated" ? "idle" : "reauth_required", code);
    assert.equal(db.accounts.acct_a.refresh, "rt_A_1", code);
    assert.ok(!JSON.stringify(r).includes("rt_A_1"), code);
  }
});

test("writer failure never reports success; lost lease and account change are uncertain", async () => {
  const db = new FakeRefreshDb();
  db.failCommit = true;
  const r = await refreshXAccountPreX({ claim: claimA, ledger: db, resolveClient }, { fetchImpl: tokenEndpoint([Response.json({ access_token: "tok_new", refresh_token: "rt_new" })]).fetchImpl });
  assert.deepEqual(r, { kind: "uncertain", postOutcome: "pre_x_terminal", code: "X_REFRESH_PERSIST_FAILED", tokenRequests: 1 });
  assert.equal(db.accounts.acct_a.state, "uncertain");
  assert.equal(db.accounts.acct_a.access, "tok_A_old");
  for (const reply of ["lease_lost", "account_changed"]) {
    const d = new FakeRefreshDb();
    d.commitReply = reply;
    const out = await refreshXAccountPreX({ claim: claimA, ledger: d, resolveClient }, { fetchImpl: tokenEndpoint([Response.json({ access_token: "t" })]).fetchImpl });
    assert.equal(out.kind, "uncertain");
    assert.equal(out.code, reply === "lease_lost" ? "X_REFRESH_LEASE_LOST" : "X_REFRESH_ACCOUNT_CHANGED");
  }
  const d2 = new FakeRefreshDb();
  d2.failRelease = true;
  const out2 = await refreshXAccountPreX({ claim: claimA, ledger: d2, resolveClient }, { fetchImpl: tokenEndpoint([Response.json({}, { status: 503 })]).fetchImpl });
  assert.equal(out2.kind, "uncertain");
  assert.equal(d2.accounts.acct_a.state, "refreshing"); // stays leased: still blocks refresh and provider start
});

test("concurrent refresh of the same account: one token request, one commit; other accounts independent", async () => {
  const db = new FakeRefreshDb();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const slow: typeof fetch = async (_input, init) => {
    calls.push(new URLSearchParams(String(init?.body)).get("refresh_token")!);
    await gate;
    return Response.json({ access_token: `new_${calls.length}`, refresh_token: `rt_new_${calls.length}` });
  };
  const first = refreshXAccountPreX({ claim: claimA, ledger: db, resolveClient }, { fetchImpl: slow });
  const second = refreshXAccountPreX({ claim: { ...claimA, attemptId: "att_a2", claimToken: "ct_a2" }, ledger: db, resolveClient }, { fetchImpl: slow });
  const other = refreshXAccountPreX({ claim: claimB, ledger: db, resolveClient }, { fetchImpl: slow });
  const secondResult = await second;
  release();
  const [a, b] = await Promise.all([first, other]);
  assert.equal(secondResult.code, "X_REFRESH_IN_PROGRESS");
  assert.equal(secondResult.tokenRequests, 0);
  assert.equal(a.kind, "refreshed");
  assert.equal(b.kind, "refreshed");
  assert.deepEqual(calls.sort(), ["rt_A_1", "rt_B_1"]);
  assert.equal(db.accounts.acct_a.generation, 1);
  assert.equal(db.accounts.acct_b.generation, 1);
});

test("no token, refresh token, lease, body or client secret reaches results, errors or logs", async () => {
  const logged: string[] = [];
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const key of Object.keys(original) as Array<keyof typeof original>) {
    console[key] = (...args: unknown[]) => { logged.push(args.map((a) => Deno.inspect(a)).join(" ")); };
  }
  const outputs: unknown[] = [];
  try {
    for (const response of [
      Response.json({ access_token: "tok_SECRET_new", refresh_token: "rt_SECRET_new" }),
      Response.json({ error: "invalid_grant", error_description: "rt_A_1" }, { status: 400 }),
      Response.json({ echo: "rt_A_1" }, { status: 500 }),
    ]) {
      const db = new FakeRefreshDb();
      outputs.push(await refreshXAccountPreX({ claim: claimA, ledger: db, resolveClient }, { fetchImpl: tokenEndpoint([response]).fetchImpl }));
    }
    const lease = new XRefreshLease("lease_1", "default", "rt_A_1");
    outputs.push(JSON.parse(JSON.stringify({ lease })), String(lease), Deno.inspect(lease));
  } finally {
    Object.assign(console, original);
  }
  const text = JSON.stringify(outputs);
  for (const secret of ["tok_SECRET_new", "rt_SECRET_new", "rt_A_1", "lease_1", "csecret"]) assert.ok(!text.includes(secret), secret);
  assert.equal(logged.length, 0);
});

test("RPC adapter: exact parameters, no ref ids accepted, manual redirects, fixed error codes", async () => {
  const sent: Array<{ url: string; body: Record<string, unknown>; redirect: RequestRedirect | undefined }> = [];
  const reply = (url: string) => url.endsWith("begin_x_account_refresh_v2")
    ? Response.json([{ lease_token: "L1", oauth_client_ref: "default", refresh_token: "rt_A_1" }])
    : url.endsWith("commit_x_account_refresh_v2") ? Response.json("committed") : Response.json("idle");
  const fetchImpl: typeof fetch = async (input, init) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body)), redirect: init?.redirect });
    return reply(String(input));
  };
  const ledger = createXAccountRefreshRpcLedger({ supabaseUrl: "https://e.supabase.co/", serviceRoleKey: "srk", fetchImpl });
  const lease = await ledger.begin(claimA);
  assert.equal(lease.refreshTokenForRequest(), "rt_A_1");
  assert.equal(await ledger.commit(lease, "acct_a", "tok_new", null), "committed");
  assert.equal(await ledger.release(lease, "acct_a", "not_rotated", "X_REFRESH_RATE_LIMITED"), "idle");
  assert.deepEqual(sent.map((s) => [s.url.replace("https://e.supabase.co/rest/v1/rpc/", ""), s.body]), [
    ["begin_x_account_refresh_v2", { p_attempt_id: "att_a", p_claim_token: "ct_a", p_social_account_id: "acct_a", p_brand_id: "brand_a" }],
    ["commit_x_account_refresh_v2", { p_lease_token: "L1", p_social_account_id: "acct_a", p_access_token: "tok_new", p_refresh_token: null, p_expires_in: null }],
    ["release_x_account_refresh_v2", { p_lease_token: "L1", p_social_account_id: "acct_a", p_outcome: "not_rotated", p_error_code: "X_REFRESH_RATE_LIMITED" }],
  ]);
  assert.ok(sent.every((s) => s.redirect === "manual"));
  const errors = createXAccountRefreshRpcLedger({ supabaseUrl: "https://e", serviceRoleKey: "k",
    fetchImpl: async () => Response.json({ message: "permission denied rt_A_1" }, { status: 500 }) });
  await assert.rejects(errors.begin(claimA), (e: unknown) => e instanceof Error && e.message === "X_REFRESH_UNAVAILABLE");
  const known = createXAccountRefreshRpcLedger({ supabaseUrl: "https://e", serviceRoleKey: "k",
    fetchImpl: async () => Response.json({ message: "X_REFRESH_IN_PROGRESS" }, { status: 400 }) });
  await assert.rejects(known.begin(claimA), (e: unknown) => e instanceof Error && e.message === "X_REFRESH_IN_PROGRESS");
  const malformed = createXAccountRefreshRpcLedger({ supabaseUrl: "https://e", serviceRoleKey: "k",
    fetchImpl: async () => Response.json([{ lease_token: "L", oauth_client_ref: "default" }]) });
  await assert.rejects(malformed.begin(claimA), (e: unknown) => e instanceof Error && e.message === "X_REFRESH_UNAVAILABLE");
});

test("client registry: 'default' and approved server-side refs only; unknown/malformed refs fail closed", () => {
  const env: Record<string, string> = {
    X_CLIENT_ID: "id", X_CLIENT_SECRET: "sec",
    X_OAUTH_CLIENT_PARTNER_ID: "pid", X_OAUTH_CLIENT_PARTNER_SECRET: "psec",
    X_OAUTH_CLIENT_HALF_ID: "hid", SUPABASE_SERVICE_ROLE_KEY: "srk",
  };
  const seen: string[] = [];
  const resolve = xOAuthClientRegistryFromEnv((k) => { seen.push(k); return env[k]; });
  assert.deepEqual(resolve("default"), { clientId: "id", clientSecret: "sec" });
  assert.deepEqual(resolve("partner"), { clientId: "pid", clientSecret: "psec" });
  for (const ref of ["other", "half", "", " default", "DEFAULT", "partner/../x", "a".repeat(41), "supabase_service_role_key"]) {
    assert.equal(resolve(ref), null, ref);
  }
  assert.ok(seen.every((k) => /^X_(CLIENT|OAUTH_CLIENT_[A-Z0-9_]+)_(ID|SECRET)$/u.test(k)), seen.join(","));
  assert.equal(defaultXOAuthClientResolver(() => undefined)("default"), null);
  assert.equal(defaultXOAuthClientResolver, xOAuthClientRegistryFromEnv);
});

test("refresh source: no legacy store, env tokens, console, loops, or ref-id inputs", async () => {
  const source = (await Deno.readTextFile(new URL("./x_v2_account_refresh.ts", import.meta.url))).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, "");
  assert.doesNotMatch(source, /oauth_token_store|X_OAUTH2_ACCESS_TOKEN|X_OAUTH2_REFRESH_TOKEN|Deno\.env|console\.|postToX|requestXWithAuthRefresh/u);
  assert.doesNotMatch(source, /(^|[^.\w])(while|for)\s*\(/mu);
  assert.doesNotMatch(source, /secret_id|p_vault|vault\./u);
  assert.equal((source.match(/fetchImpl\(X_TOKEN_URL/gu) ?? []).length, 1);
});
