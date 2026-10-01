import assert from "node:assert/strict";
import test from "node:test";
import { createHandler } from "./http.ts";

const SUPABASE_URL = "https://project.supabase.test";
const ANON = "anon-key-fixture";
const SERVICE = "service-key-fixture";
const TOKEN = "caller-token-fixture";
const VAULT_ACCESS = "vault-access-secret-uuid-fixture";
const VAULT_REFRESH = "vault-refresh-secret-uuid-fixture";

const env = {
  get: (name: string) => ({ SUPABASE_URL, SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICE } as Record<string, string>)[name],
};

type Call = { url: URL; method: string; headers: Record<string, string>; body: string | null };

function accountRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "acct-1",
    brand_id: "brand-a",
    platform: "x",
    connection_status: "identity_verified",
    platform_user_id: "x-user-1",
    verified_at: "2026-10-01T00:00:00Z",
    last_connection_error_code: null,
    publish_enabled: false,
    vault_access_token_secret_id: VAULT_ACCESS,
    vault_refresh_token_secret_id: VAULT_REFRESH,
    ...overrides,
  };
}

function fakeBackend(options: {
  account?: Record<string, unknown> | null;
  brand?: Record<string, unknown>;
  role?: string | null;
  patchStatus?: number;
  patchBody?: unknown;
} = {}) {
  const calls: Call[] = [];
  const fetchImpl = (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    calls.push({ url, method: init.method ?? "GET", headers, body: typeof init.body === "string" ? init.body : null });
    const json = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }));
    if (url.pathname === "/auth/v1/user") {
      return headers.authorization === `Bearer ${TOKEN}` ? json({ id: "user-1", email: "must-not-leak@example.test" }) : json({}, 401);
    }
    if (url.pathname === "/rest/v1/social_accounts" && (init.method ?? "GET") === "GET") {
      return json(options.account === null ? [] : [options.account ?? accountRow()]);
    }
    if (url.pathname === "/rest/v1/brands") {
      return json([options.brand ?? { id: "brand-a", is_active: true, publish_mode: "live" }]);
    }
    if (url.pathname === "/rest/v1/brand_memberships") {
      return json(options.role === null ? [] : [{ user_id: "user-1", brand_id: "brand-a", role: options.role ?? "owner" }]);
    }
    if (url.pathname === "/rest/v1/social_accounts" && init.method === "PATCH") {
      return json(options.patchBody ?? [{ id: "acct-1", publish_enabled: true }], options.patchStatus ?? 200);
    }
    return json({ error: "unexpected call" }, 500);
  };
  return { calls, fetchImpl };
}

function post(body: unknown, token = TOKEN) {
  return new Request("https://edge.test/social-mobile-publish-setting", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

const ON = { social_account_id: "acct-1", desired_enabled: true, expected_current_enabled: false };
const OFF = { social_account_id: "acct-1", desired_enabled: false, expected_current_enabled: true };

test("enabling issues exactly one PATCH that changes only publish_enabled, guarded by id, brand, expected value and readiness", async () => {
  const { calls, fetchImpl } = fakeBackend();
  const response = await createHandler(env, fetchImpl)(post(ON));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, status: "updated", account: { id: "acct-1", publish_enabled: true } });

  const writes = calls.filter((call) => call.method !== "GET");
  assert.equal(writes.length, 1);
  const [patch] = writes;
  assert.equal(patch.method, "PATCH");
  assert.equal(patch.url.pathname, "/rest/v1/social_accounts");
  assert.deepEqual(JSON.parse(patch.body ?? "null"), { publish_enabled: true });
  const p = patch.url.searchParams;
  assert.equal(p.get("id"), "eq.acct-1");
  assert.equal(p.get("brand_id"), "eq.brand-a");
  assert.equal(p.get("publish_enabled"), "eq.false");
  assert.equal(p.get("platform"), "eq.x");
  assert.equal(p.get("connection_status"), "eq.identity_verified");
  assert.equal(p.get("platform_user_id"), "not.is.null");
  assert.equal(p.get("verified_at"), "not.is.null");
  assert.equal(p.get("vault_access_token_secret_id"), "not.is.null");
  assert.equal(p.get("vault_refresh_token_secret_id"), "not.is.null");
  assert.equal(p.get("last_connection_error_code"), "is.null");
  assert.equal(patch.headers.prefer, "return=representation");
});

test("disabling carries no readiness filters, so a degraded connection never blocks switching OFF", async () => {
  const { calls, fetchImpl } = fakeBackend({
    account: accountRow({ publish_enabled: true, connection_status: "failed", vault_access_token_secret_id: null, vault_refresh_token_secret_id: null }),
    brand: { id: "brand-a", is_active: false, publish_mode: "disabled" },
    patchBody: [{ id: "acct-1", publish_enabled: false }],
  });
  const response = await createHandler(env, fetchImpl)(post(OFF));
  assert.equal(response.status, 200);
  const patch = calls.find((call) => call.method === "PATCH");
  assert.ok(patch);
  assert.deepEqual(JSON.parse(patch.body ?? "null"), { publish_enabled: false });
  assert.deepEqual([...patch.url.searchParams.keys()].sort(), ["brand_id", "id", "publish_enabled", "select"]);
  assert.equal(patch.url.searchParams.get("publish_enabled"), "eq.true");
});

test("only the allowed endpoints are called: no X API, no Vault, no other table, no RPC, no other write", async () => {
  const { calls, fetchImpl } = fakeBackend();
  await createHandler(env, fetchImpl)(post(ON));
  const allowed = new Set([
    "GET /auth/v1/user",
    "GET /rest/v1/social_accounts",
    "GET /rest/v1/brands",
    "GET /rest/v1/brand_memberships",
    "PATCH /rest/v1/social_accounts",
  ]);
  for (const call of calls) {
    assert.equal(call.url.origin, SUPABASE_URL);
    assert.ok(allowed.has(`${call.method} ${call.url.pathname}`), `${call.method} ${call.url.pathname}`);
  }
  // Vault *reference* columns appear only as filters/columns on social_accounts; no vault schema or RPC is called.
  assert.ok(!calls.some((call) => /vault|rpc|x\.com|twitter/iu.test(`${call.url.host}${call.url.pathname}`)));
});

test("Vault reference columns are read only as presence flags and never appear in the response", async () => {
  const { fetchImpl } = fakeBackend();
  const response = await createHandler(env, fetchImpl)(post(ON));
  const text = JSON.stringify(await response.json());
  assert.doesNotMatch(text, new RegExp(`${VAULT_ACCESS}|${VAULT_REFRESH}|must-not-leak|${TOKEN}|${SERVICE}|${ANON}`, "u"));

  const missing = fakeBackend({ account: accountRow({ vault_refresh_token_secret_id: null }) });
  const blocked = await createHandler(env, missing.fetchImpl)(post(ON));
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json() as { error: string }).error, "CREDENTIALS_MISSING");
  assert.equal(missing.calls.filter((call) => call.method === "PATCH").length, 0);
});

test("the membership read uses the caller's JWT and the anon key (RLS applies); service key is used only for the account, brand and write", async () => {
  const { calls, fetchImpl } = fakeBackend();
  await createHandler(env, fetchImpl)(post(ON));
  const membership = calls.find((call) => call.url.pathname === "/rest/v1/brand_memberships");
  assert.ok(membership);
  assert.equal(membership.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(membership.headers.apikey, ANON);
  assert.equal(membership.url.searchParams.get("user_id"), "eq.user-1");
  assert.equal(membership.url.searchParams.get("brand_id"), "eq.brand-a");
  const auth = calls.find((call) => call.url.pathname === "/auth/v1/user");
  assert.equal(auth?.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(auth?.headers.apikey, ANON);
  for (const call of calls.filter((c) => c.url.pathname !== "/rest/v1/brand_memberships" && c.url.pathname !== "/auth/v1/user")) {
    assert.equal(call.headers.authorization, `Bearer ${SERVICE}`);
  }
});

test("an invalid token is rejected with 401 and nothing else is called", async () => {
  const { calls, fetchImpl } = fakeBackend();
  const response = await createHandler(env, fetchImpl)(post(ON, "wrong-token"));
  assert.equal(response.status, 401);
  assert.equal(calls.length, 1);
});

test("viewer role over HTTP: 403 and no write", async () => {
  const { calls, fetchImpl } = fakeBackend({ role: "viewer" });
  const response = await createHandler(env, fetchImpl)(post(ON));
  assert.equal(response.status, 403);
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 0);
});

test("no membership row over HTTP: 404 not-found shape", async () => {
  const { fetchImpl } = fakeBackend({ role: null });
  const response = await createHandler(env, fetchImpl)(post(ON));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { success: false, error: "ACCOUNT_NOT_FOUND" });
});

test("a PATCH matching zero rows is a conflict, not a success", async () => {
  // First account read says OFF; the guarded PATCH matches nothing; the re-read says it is now ON.
  let reads = 0;
  const base = fakeBackend({ patchBody: [] });
  const fetchImpl = (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.pathname === "/rest/v1/social_accounts" && (init?.method ?? "GET") === "GET") {
      reads += 1;
      return Promise.resolve(Response.json([accountRow({ publish_enabled: reads > 1 })]));
    }
    return base.fetchImpl(input, init);
  };
  const response = await createHandler(env, fetchImpl)(post(ON));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { success: false, error: "STALE_STATE", current_enabled: true });
});

test("the deletion-guard trigger error maps to ACCOUNT_BUSY", async () => {
  const { fetchImpl } = fakeBackend({ patchStatus: 400, patchBody: { message: "SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS" } });
  const response = await createHandler(env, fetchImpl)(post(ON));
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { error: string }).error, "ACCOUNT_BUSY");
});

test("backend failures return a bounded 503 and do not echo backend text", async () => {
  const { fetchImpl } = fakeBackend({ patchStatus: 500, patchBody: { message: "password authentication failed for user postgres" } });
  const response = await createHandler(env, fetchImpl)(post(ON));
  assert.equal(response.status, 503);
  const text = JSON.stringify(await response.json());
  assert.equal(text, JSON.stringify({ success: false, error: "PUBLISH_SETTING_UNAVAILABLE" }));

  const down = createHandler(env, () => Promise.reject(new Error("connect ECONNREFUSED 10.1.2.3")));
  const res2 = await down(post(ON));
  assert.equal(res2.status, 503);
  assert.doesNotMatch(JSON.stringify(await res2.json()), /ECONNREFUSED|10\.1\.2\.3/u);
});

test("missing environment is a generic 503 that does not name the missing value", async () => {
  const { calls, fetchImpl } = fakeBackend();
  const bare = createHandler({ get: () => undefined }, fetchImpl);
  const response = await bare(post(ON));
  assert.equal(response.status, 503);
  assert.equal(JSON.stringify(await response.json()), JSON.stringify({ success: false, error: "PUBLISH_SETTING_UNAVAILABLE" }));
  assert.equal(calls.length, 0);
});

test("no secret, token or key is written to the console during a request", async () => {
  const lines: string[] = [];
  const originals = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  console.log = console.error = console.warn = console.info = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    const { fetchImpl } = fakeBackend();
    await createHandler(env, fetchImpl)(post(ON));
    const failing = fakeBackend({ patchStatus: 500, patchBody: { message: "boom" } });
    await createHandler(env, failing.fetchImpl)(post(ON));
  } finally {
    Object.assign(console, originals);
  }
  assert.doesNotMatch(lines.join("\n"), new RegExp(`${TOKEN}|${SERVICE}|${ANON}|${VAULT_ACCESS}|${VAULT_REFRESH}`, "u"));
});
