import assert from "node:assert/strict";
import test from "node:test";
import { createHandler, parseDecision, PUBLISH_SETTING_RPC } from "./http.ts";

const SUPABASE_URL = "https://project.supabase.test";
const ANON = "anon-key-fixture";
const SERVICE = "service-key-fixture-must-never-be-used";
const TOKEN = "caller-token-fixture";
const RPC_PATH = `/rest/v1/rpc/${PUBLISH_SETTING_RPC}`;

function environment() {
  const read: string[] = [];
  const values: Record<string, string> = { SUPABASE_URL, SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICE };
  return { read, env: { get: (name: string) => (read.push(name), values[name]) } };
}

type Call = { url: URL; method: string; headers: Record<string, string>; body: string | null; redirect: string | undefined };

function fakeBackend(options: { rpcStatus?: number; rpcBody?: unknown; rpc?: (body: Record<string, unknown>) => unknown } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = typeof init.body === "string" ? init.body : null;
    calls.push({ url, method: init.method ?? "GET", headers, body, redirect: init.redirect });
    const json = (value: unknown, status = 200) => Promise.resolve(Response.json(value, { status }));
    if (url.pathname === "/auth/v1/user") {
      return headers.authorization === `Bearer ${TOKEN}` ? json({ id: "user-1", email: "must-not-leak@example.test" }) : json({}, 401);
    }
    if (url.pathname === RPC_PATH && init.method === "POST") {
      if (options.rpc) return json(options.rpc(JSON.parse(body ?? "{}")));
      return json("rpcBody" in options ? options.rpcBody : { status: "updated", publish_enabled: true }, options.rpcStatus ?? 200);
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

test("ON is exactly two calls: the Auth check and ONE database decision, both with the caller's token", async () => {
  const { calls, fetchImpl } = fakeBackend();
  const { env } = environment();
  const response = await createHandler(env, fetchImpl)(post(ON));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, status: "updated", account: { id: "acct-1", publish_enabled: true } });

  assert.deepEqual(calls.map((call) => `${call.method} ${call.url.pathname}`), ["GET /auth/v1/user", `POST ${RPC_PATH}`]);
  const [auth, rpc] = calls;
  for (const call of calls) {
    assert.equal(call.url.origin, SUPABASE_URL);
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`, "the caller's own JWT");
    assert.equal(call.headers.apikey, ANON, "the public anon key");
    assert.equal(call.redirect, "manual");
    assert.equal(call.url.search, "", "no query string");
  }
  assert.equal(auth.body, null);
  assert.deepEqual(JSON.parse(rpc.body ?? "null"), {
    p_social_account_id: "acct-1",
    p_desired_enabled: true,
    p_expected_current_enabled: false,
  });
});

test("OFF is the same single decision call; no brand state, connection state or credential is read by this function", async () => {
  const { calls, fetchImpl } = fakeBackend({ rpcBody: { status: "updated", publish_enabled: false } });
  const response = await createHandler(environment().env, fetchImpl)(post(OFF));
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url.pathname}`), ["GET /auth/v1/user", `POST ${RPC_PATH}`]);
  assert.deepEqual(JSON.parse(calls[1].body ?? "null"), {
    p_social_account_id: "acct-1",
    p_desired_enabled: false,
    p_expected_current_enabled: true,
  });
});

test("no service-role key: it is neither read from the environment nor sent anywhere", async () => {
  const { calls, fetchImpl } = fakeBackend();
  const { env, read } = environment();
  await createHandler(env, fetchImpl)(post(ON));
  await createHandler(env, fetchImpl)(post(OFF));
  assert.deepEqual([...new Set(read)].sort(), ["SUPABASE_ANON_KEY", "SUPABASE_URL"]);
  for (const call of calls) {
    assert.doesNotMatch(JSON.stringify([call.url.toString(), call.headers, call.body]), new RegExp(SERVICE, "u"));
  }
});

test("no user id and no brand id is ever sent: the database derives both from the caller's JWT and the account", async () => {
  const { calls, fetchImpl } = fakeBackend();
  await createHandler(environment().env, fetchImpl)(post(ON));
  const sent = JSON.parse(calls[1].body ?? "null") as Record<string, unknown>;
  assert.deepEqual(Object.keys(sent).sort(), ["p_desired_enabled", "p_expected_current_enabled", "p_social_account_id"]);
  assert.doesNotMatch(calls[1].body ?? "", /user-1|brand/u);
});

test("no table endpoint, no other RPC, no Vault, no X API: for every outcome", async () => {
  const outcomes: unknown[] = [
    { status: "updated", publish_enabled: true },
    { status: "stale", publish_enabled: true },
    { status: "blocked", reason: "BRAND_INACTIVE" },
    { status: "not_found" },
    { status: "forbidden" },
    { status: "busy" },
  ];
  for (const rpcBody of outcomes) {
    const { calls, fetchImpl } = fakeBackend({ rpcBody });
    await createHandler(environment().env, fetchImpl)(post(ON));
    assert.equal(calls.length, 2, JSON.stringify(rpcBody));
    assert.equal(calls.filter((call) => call.url.pathname === RPC_PATH).length, 1, "one decision, no reread or retry");
    assert.ok(!calls.some((call) => /social_accounts|brands|brand_memberships|vault|x\.com|twitter/iu.test(call.url.toString())));
  }
});

// H1 R1 / R3 on the reviewed head (a59a89e9): this function read the membership, then wrote with the
// service key, then re-read with the service key. A membership that ended in between still got the
// write, and a moved account's state was returned to a caller with no right to it. Here the fake
// database evaluates membership INSIDE the one decision call, as the real function does; there is no
// later privileged step in this function for an earlier answer to be replayed through.
test("R1/R3 schedule: authority that ends after the Auth check and before the decision changes nothing and leaks nothing", async () => {
  const db = { member: true, role: "owner", brand: "brand-a", accountBrand: "brand-a", enabled: false };
  let authChecked = false;
  const fetchImpl = (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") {
      authChecked = true;
      return Promise.resolve(Response.json({ id: "user-1" }));
    }
    assert.equal(url.pathname, RPC_PATH);
    assert.ok(authChecked);
    const args = JSON.parse(String(init.body)) as { p_desired_enabled: boolean; p_expected_current_enabled: boolean };
    // The decision transaction: current membership for the account's CURRENT brand, then the write.
    if (!db.member || db.accountBrand !== db.brand) return Promise.resolve(Response.json({ status: "not_found" }));
    if (db.role !== "owner" && db.role !== "admin") return Promise.resolve(Response.json({ status: "forbidden" }));
    if (db.enabled !== args.p_expected_current_enabled) return Promise.resolve(Response.json({ status: "stale", publish_enabled: db.enabled }));
    db.enabled = args.p_desired_enabled;
    return Promise.resolve(Response.json({ status: "updated", publish_enabled: db.enabled }));
  };
  const handler = createHandler(environment().env, fetchImpl);

  db.member = false; // removed
  let response = await handler(post(ON));
  assert.deepEqual([response.status, await response.json()], [404, { success: false, error: "ACCOUNT_NOT_FOUND" }]);
  assert.equal(db.enabled, false);

  db.member = true;
  db.role = "viewer"; // demoted
  response = await handler(post(ON));
  assert.equal(response.status, 403);
  assert.equal(db.enabled, false);

  db.role = "owner";
  db.accountBrand = "brand-b"; // moved to a foreign brand, where it is ON
  db.enabled = true;
  response = await handler(post(ON));
  const body = await response.json();
  assert.deepEqual([response.status, body], [404, { success: false, error: "ACCOUNT_NOT_FOUND" }]);
  assert.ok(!("current_enabled" in body), "no foreign state");
});

test("the Data API refusing the token (expired) is AUTH_REQUIRED", async () => {
  const { fetchImpl } = fakeBackend({ rpcStatus: 401, rpcBody: { code: "PGRST301", message: "JWT expired" } });
  const response = await createHandler(environment().env, fetchImpl)(post(ON));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { success: false, error: "AUTH_REQUIRED" });
});

test("an invalid token is rejected with 401 and the database is never asked", async () => {
  const { calls, fetchImpl } = fakeBackend();
  const response = await createHandler(environment().env, fetchImpl)(post(ON, "wrong-token"));
  assert.equal(response.status, 401);
  assert.equal(calls.length, 1);
});

test("database errors (including the function not being deployed yet) are a bounded 503 with no backend text", async () => {
  const failures: Array<[number, unknown]> = [
    [400, { code: "P0001", message: "PUBLISH_SETTING_UNAVAILABLE" }],
    [404, { code: "PGRST202", message: "Could not find the function public.set_social_account_publish_enabled" }],
    [403, { code: "42501", message: "permission denied for function set_social_account_publish_enabled" }],
    [500, { message: "password authentication failed for user postgres" }],
    [200, "not an object"],
    [200, null],
  ];
  for (const [rpcStatus, rpcBody] of failures) {
    const { fetchImpl } = fakeBackend({ rpcStatus, rpcBody });
    const response = await createHandler(environment().env, fetchImpl)(post(ON));
    assert.equal(response.status, 503, JSON.stringify(rpcBody));
    assert.equal(JSON.stringify(await response.json()), JSON.stringify({ success: false, error: "PUBLISH_SETTING_UNAVAILABLE" }));
  }
  const down = createHandler(environment().env, () => Promise.reject(new Error("connect ECONNREFUSED 10.1.2.3")));
  const response = await down(post(ON));
  assert.equal(response.status, 503);
  assert.doesNotMatch(JSON.stringify(await response.json()), /ECONNREFUSED|10\.1\.2\.3/u);
});

test("only the documented decision shapes are accepted; anything else is unavailable", () => {
  assert.deepEqual(parseDecision({ status: "updated", publish_enabled: true }), { status: "updated", publishEnabled: true });
  assert.deepEqual(parseDecision({ status: "stale", publish_enabled: false }), { status: "stale", publishEnabled: false });
  assert.deepEqual(parseDecision({ status: "blocked", reason: "CREDENTIALS_INVALID" }), { status: "blocked", reason: "CREDENTIALS_INVALID" });
  assert.deepEqual(parseDecision({ status: "busy" }), { status: "busy" });
  const bad: unknown[] = [
    null, [], "updated", {},
    { status: "updated" },
    { status: "updated", publish_enabled: "true" },
    { status: "updated", publish_enabled: true, brand_id: "x" },
    { status: "blocked" },
    { status: "blocked", reason: "SOMETHING_ELSE" },
    { status: "blocked", reason: "BRAND_INACTIVE", detail: "x" },
    { status: "not_found", publish_enabled: true },
    { status: "ok" },
    { status: 1 },
  ];
  for (const body of bad) assert.throws(() => parseDecision(body), /PUBLISH_SETTING_UNAVAILABLE/u, JSON.stringify(body));
});

test("blocked reasons pass through as bounded codes; nothing else from the database answer is echoed", async () => {
  const { fetchImpl } = fakeBackend({ rpcBody: { status: "blocked", reason: "CREDENTIALS_MISSING" } });
  const response = await createHandler(environment().env, fetchImpl)(post(ON));
  assert.equal(response.status, 409);
  const text = JSON.stringify(await response.json());
  assert.equal(text, JSON.stringify({ success: false, error: "CREDENTIALS_MISSING", reconnect_recommended: true }));
  assert.doesNotMatch(text, new RegExp(`must-not-leak|${TOKEN}|${ANON}`, "u"));
});

test("missing environment is a generic 503 that does not name the missing value", async () => {
  const { calls, fetchImpl } = fakeBackend();
  const bare = createHandler({ get: () => undefined }, fetchImpl);
  const response = await bare(post(ON));
  assert.equal(response.status, 503);
  assert.equal(JSON.stringify(await response.json()), JSON.stringify({ success: false, error: "PUBLISH_SETTING_UNAVAILABLE" }));
  assert.equal(calls.length, 0);
});

test("nothing is written to the console during a request", async () => {
  const lines: string[] = [];
  const originals = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  console.log = console.error = console.warn = console.info = console.debug = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    await createHandler(environment().env, fakeBackend().fetchImpl)(post(ON));
    await createHandler(environment().env, fakeBackend({ rpcStatus: 500, rpcBody: { message: "boom" } }).fetchImpl)(post(ON));
  } finally {
    Object.assign(console, originals);
  }
  assert.deepEqual(lines, []);
});

test("source: no service-role key, no table access, no X or Vault reference in the function's runtime files", async () => {
  for (const file of ["index.ts", "logic.ts", "http.ts"]) {
    const source = await Deno.readTextFile(new URL(file, import.meta.url));
    const code = source.split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*")).join("\n");
    assert.doesNotMatch(code, /SERVICE_ROLE|serviceKey|service_role/u, file);
    assert.doesNotMatch(code, /rest\/v1\/(?!rpc\/\$\{PUBLISH_SETTING_RPC\})/u, file);
    assert.doesNotMatch(code, /api\.x\.com|twitter|vault|decrypted_secret/iu, file);
    assert.doesNotMatch(code, /console\./u, file);
  }
});
