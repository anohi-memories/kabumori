import assert from "node:assert/strict";
import test from "node:test";
import {
  createThreadsConnectHandler,
  isThreadsAuthorizationUrl,
  isThreadsCallbackUrl,
  THREADS_CONNECT_EDGE_WIRED,
  type ThreadsConnectRuntimePort,
} from "./threads_connect_edge.ts";

// Fake values only. Distinctive so a leak into a response is easy to spot.
const CALLBACK = "https://postona.example/threads/callback";
const STATE = "Zx9_-ab0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabc";
const AUTH_URL = `https://threads.com/oauth/authorize?client_id=990602627938098&redirect_uri=${encodeURIComponent(CALLBACK)}&scope=threads_basic%2Cthreads_content_publish&response_type=code&state=${STATE}`;
const CODE = "AQBfakeAuthorizationCode_0123456789";
const JWT = "caller-jwt-fixture";
const SECRETS = [CODE, STATE, JWT, "fake_app_secret", "THQVJfakeToken"];
const ACCOUNT = "sa_0123456789abcdef01234567";
const soon = (ms: number) => new Date(Date.now() + ms).toISOString();

function runtime(over: Partial<{ start: unknown; callback: unknown; throws: boolean }> = {}) {
  const calls: Array<{ method: string; auth: string | null; url?: string }> = [];
  const port: ThreadsConnectRuntimePort = {
    start: (auth) => {
      calls.push({ method: "start", auth });
      if (over.throws) return Promise.reject(new Error(`boom ${JWT}`));
      return Promise.resolve("start" in over ? over.start : { ok: true, provider: "threads", authorizationUrl: AUTH_URL, expiresAt: soon(9 * 60_000) });
    },
    callback: (auth, url) => {
      calls.push({ method: "callback", auth, url });
      if (over.throws) return Promise.reject(new Error(`boom ${CODE}`));
      return Promise.resolve("callback" in over ? over.callback : { ok: true, status: "connected", provider: "threads", socialAccountId: ACCOUNT, publishEnabled: false, tokenExpiresAt: soon(59 * 86400_000) });
    },
  };
  return { port, calls };
}
const post = (body: unknown, auth: string | null = `Bearer ${JWT}`, raw?: string) =>
  new Request("https://edge.example/functions/v1/threads-oauth-connect-user", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: raw ?? JSON.stringify(body),
  });
const callbackBody = (url = `${CALLBACK}?code=${CODE}&state=${STATE}#_`) => ({ action: "callback", callback_url: url });
async function noSecrets(response: Response) {
  const text = await response.clone().text();
  for (const s of SECRETS) assert.ok(!text.includes(s), `leaked ${s}`);
  return JSON.parse(text);
}

test("not mounted in source", () => {
  assert.equal(THREADS_CONNECT_EDGE_WIRED, false);
});

test("start: the caller's own Authorization is passed through; the answer is the validated URL only", async () => {
  const r = runtime();
  const handler = createThreadsConnectHandler(r.port, { registeredCallback: CALLBACK });
  const response = await handler(post({ action: "start" }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ["authorization_url", "expires_at", "ok", "provider"]);
  assert.equal(body.authorization_url, AUTH_URL);
  assert.deepEqual(r.calls, [{ method: "start", auth: `Bearer ${JWT}` }]);
});

test("start: an authorization URL that is not exactly the official one is never handed to the app", async () => {
  const bad = [
    AUTH_URL.replace("https://threads.com", "https://evil.example"),
    AUTH_URL.replace("https://", "http://"),
    AUTH_URL.replace("/oauth/authorize", "/oauth/authorize/x"),
    AUTH_URL.replace(encodeURIComponent(CALLBACK), encodeURIComponent("https://evil.example/cb")),
    AUTH_URL.replace("threads_basic%2Cthreads_content_publish", "threads_basic"),
    AUTH_URL.replace("response_type=code", "response_type=token"),
    `${AUTH_URL}&prompt=none`,
    `${AUTH_URL}#frag`,
    AUTH_URL.replace(STATE, "short"),
  ];
  for (const url of bad) {
    assert.equal(isThreadsAuthorizationUrl(url, CALLBACK), false, url);
    const handler = createThreadsConnectHandler(runtime({ start: { ok: true, provider: "threads", authorizationUrl: url, expiresAt: soon(60_000) } }).port, { registeredCallback: CALLBACK });
    const response = await handler(post({ action: "start" }));
    assert.equal(response.status, 503);
    assert.deepEqual(await noSecrets(response), { ok: false, error: "THREADS_CONNECT_RUNTIME_UNAVAILABLE" });
  }
  // Off-contract shapes and stale / far expiries are refused too.
  for (const start of [
    { ok: true, provider: "x", authorizationUrl: AUTH_URL, expiresAt: soon(60_000) },
    { ok: true, provider: "threads", authorizationUrl: AUTH_URL, expiresAt: soon(-1) },
    { ok: true, provider: "threads", authorizationUrl: AUTH_URL, expiresAt: soon(3600_000) },
    { ok: true, provider: "threads", authorizationUrl: AUTH_URL, expiresAt: soon(60_000), state: STATE },
    null, "ok",
  ]) {
    const response = await createThreadsConnectHandler(runtime({ start }).port, { registeredCallback: CALLBACK })(post({ action: "start" }));
    assert.equal(response.status, 503, JSON.stringify(start));
  }
});

test("start refused by the runtime: a fixed code, restart required", async () => {
  const handler = createThreadsConnectHandler(runtime({ start: { ok: false, error: "START_REFUSED", restartRequired: true } }).port, { registeredCallback: CALLBACK });
  const response = await handler(post({ action: "start" }));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { ok: false, error: "START_REFUSED", restart_required: true });
});

test("callback: only the exact registered callback is forwarded; success is the verified receipt, nothing more", async () => {
  const r = runtime();
  const handler = createThreadsConnectHandler(r.port, { registeredCallback: CALLBACK });
  const response = await handler(post(callbackBody()));
  assert.equal(response.status, 200);
  const body = await noSecrets(response);
  assert.deepEqual(Object.keys(body).sort(), ["ok", "provider", "publish_enabled", "social_account_id", "status", "token_expires_at"]);
  assert.equal(body.publish_enabled, false);
  assert.equal(r.calls[0].url, `${CALLBACK}?code=${CODE}&state=${STATE}#_`, "forwarded byte for byte");
  for (const url of [
    `https://evil.example/threads/callback?code=a&state=b`,
    `${CALLBACK}/x?code=a&state=b`,
    `${CALLBACK}?code=a&state=b&next=https://evil.example`,
    `${CALLBACK}?code=a&code=b&state=c`,
    `${CALLBACK}?code=a&state=b#access_token=x`,
    `postona-social://threads/callback?code=a&state=b`,
    CALLBACK,
  ]) {
    assert.equal(isThreadsCallbackUrl(url, CALLBACK), false, url);
    const rr = runtime();
    const res = await createThreadsConnectHandler(rr.port, { registeredCallback: CALLBACK })(post(callbackBody(url)));
    assert.equal(res.status, 400, url);
    assert.deepEqual(await res.json(), { ok: false, error: "CALLBACK_INVALID" });
    assert.equal(rr.calls.length, 0, "the runtime is not called for an invalid callback");
  }
});

test("callback: a receipt that claims publishing, another provider or a malformed account is refused", async () => {
  for (const callback of [
    { ok: true, status: "connected", provider: "threads", socialAccountId: ACCOUNT, publishEnabled: true, tokenExpiresAt: soon(86400_000) },
    { ok: true, status: "connected", provider: "x", socialAccountId: ACCOUNT, publishEnabled: false, tokenExpiresAt: soon(86400_000) },
    { ok: true, status: "connected", provider: "threads", socialAccountId: "sa_x", publishEnabled: false, tokenExpiresAt: soon(86400_000) },
    { ok: true, status: "connected", provider: "threads", socialAccountId: ACCOUNT, publishEnabled: false, tokenExpiresAt: soon(90 * 86400_000) },
    { ok: true, status: "connected", provider: "threads", socialAccountId: ACCOUNT, publishEnabled: false, tokenExpiresAt: soon(86400_000), accessToken: "THQVJfakeToken0123" },
  ]) {
    const response = await createThreadsConnectHandler(runtime({ callback }).port, { registeredCallback: CALLBACK })(post(callbackBody()));
    assert.equal(response.status, 503, JSON.stringify(callback));
    await noSecrets(response);
  }
});

test("callback failures keep their meaning: refused = restart; uncertain / unknown = reconcile, never resend", async () => {
  const cases: Array<[unknown, number, Record<string, unknown>]> = [
    [{ ok: false, error: "CALLBACK_REFUSED", reconciliationRequired: false, restartRequired: true }, 409, { ok: false, error: "CALLBACK_REFUSED", restart_required: true, reconciliation_required: false }],
    [{ ok: false, error: "EXCHANGE_OUTCOME_UNCERTAIN", reconciliationRequired: true, restartRequired: true }, 409, { ok: false, error: "EXCHANGE_OUTCOME_UNCERTAIN", restart_required: true, reconciliation_required: true }],
    [{ ok: false, error: "COMPLETE_OUTCOME_UNKNOWN", reconciliationRequired: true, restartRequired: true }, 409, { ok: false, error: "COMPLETE_OUTCOME_UNKNOWN", restart_required: true, reconciliation_required: true }],
    [{ ok: false, error: "COMPLETE_OUTCOME_UNKNOWN", reconciliationRequired: false, restartRequired: true }, 503, { ok: false, error: "THREADS_CONNECT_RUNTIME_UNAVAILABLE" }],
    [{ ok: false, error: "SOMETHING_NEW", reconciliationRequired: true, restartRequired: true }, 503, { ok: false, error: "THREADS_CONNECT_RUNTIME_UNAVAILABLE" }],
  ];
  for (const [callback, status, expected] of cases) {
    const response = await createThreadsConnectHandler(runtime({ callback }).port, { registeredCallback: CALLBACK })(post(callbackBody()));
    assert.equal(response.status, status, JSON.stringify(callback));
    assert.deepEqual(await response.json(), expected);
  }
});

test("no bearer, bad body, no runtime, a throwing runtime: fixed codes, runtime not reached where it must not be", async () => {
  const r = runtime();
  const handler = createThreadsConnectHandler(r.port, { registeredCallback: CALLBACK });
  for (const auth of [null, "Basic abc", "Bearer "]) {
    assert.equal((await handler(post({ action: "start" }, auth))).status, 401);
  }
  for (const raw of [`{"action":"start","extra":1}`, `{"action":"start","action":"callback"}`, `{"action":"callback"}`, `{"action":"delete"}`, "[]", ""]) {
    assert.equal((await handler(post(null, `Bearer ${JWT}`, raw))).status, 400, raw);
  }
  assert.equal((await handler(new Request("https://edge.example", { method: "GET" }))).status, 405);
  assert.equal(r.calls.length, 0);
  const unwired = await createThreadsConnectHandler(null, { registeredCallback: CALLBACK })(post({ action: "start" }));
  assert.deepEqual([unwired.status, await unwired.json()], [503, { ok: false, error: "THREADS_CONNECT_RUNTIME_UNAVAILABLE" }]);
  const badConfig = await createThreadsConnectHandler(r.port, { registeredCallback: "http://postona.example/cb" })(post({ action: "start" }));
  assert.equal(badConfig.status, 503);
  for (const body of [{ action: "start" }, callbackBody()]) {
    const thrown = await createThreadsConnectHandler(runtime({ throws: true }).port, { registeredCallback: CALLBACK })(post(body));
    assert.equal(thrown.status, 503);
    await noSecrets(thrown);
  }
});
