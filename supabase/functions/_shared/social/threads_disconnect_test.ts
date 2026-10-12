import assert from "node:assert/strict";
import test from "node:test";
import {
  createThreadsDisconnectRpc,
  gatedThreadsDisconnectHandler,
  handleThreadsDisconnect,
  parseThreadsDisconnectAnswer,
  THREADS_DISCONNECT_REFUSALS,
  THREADS_DISCONNECT_SERVER_ENABLED,
  type ThreadsDisconnectDeps,
} from "./threads_disconnect.ts";

const TOKEN = "offline_dummy_caller_jwt";
const BODY = { action: "disconnect", social_account_id: "sa_th_alice", expected_handle: "@alice" };
const answer = (status: string, code: string, extra: Record<string, unknown> = {}) => ({
  status, code, publish_permission: "withdrawn",
  local_credentials: status === "disconnected" ? "removed" : status === "stopped" ? "kept" : "none",
  remote_access: "not_revoked_by_app", ...extra,
});

const harness = (over: Partial<{ user: { id: string } | null; userThrows: boolean; db: unknown; dbThrows: unknown }> = {}) => {
  const calls: string[] = [];
  const deps: ThreadsDisconnectDeps = {
    getUser: (token) => {
      calls.push(`user:${token}`);
      return over.userThrows ? Promise.reject(new Error("auth down")) : Promise.resolve("user" in over ? over.user! : { id: "00000000-0000-4000-8000-0000000000a1" });
    },
    disconnect: (token, id, handle) => {
      calls.push(`db:${token}:${id}:${handle}`);
      return "dbThrows" in over ? Promise.reject(over.dbThrows) : Promise.resolve("db" in over ? over.db : answer("disconnected", "LOCAL_REMOVED"));
    },
  };
  return { deps, calls };
};
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://edge.example/social-mobile-threads-disconnect", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("the server gate ships closed: nothing is read, verified or called", async () => {
  assert.equal(THREADS_DISCONNECT_SERVER_ENABLED, false);
  const h = harness();
  const gated = gatedThreadsDisconnectHandler(THREADS_DISCONNECT_SERVER_ENABLED, (request) => handleThreadsDisconnect(request, h.deps));
  const response = await gated(post(BODY));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "THREADS_DISCONNECT_DISABLED" });
  assert.deepEqual(h.calls, []);
  assert.equal((await gated(new Request("https://edge.example", { method: "OPTIONS" }))).status, 204);
});

test("disconnect: Auth verifies the caller now, the database gets the caller's own token and the confirmed account", async () => {
  const h = harness();
  const response = await handleThreadsDisconnect(post(BODY), h.deps);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), {
    ok: true, status: "disconnected", code: "LOCAL_REMOVED", publish_permission: "withdrawn",
    local_credentials: "removed", remote_access: "not_revoked_by_app",
  });
  assert.deepEqual(h.calls, [`user:${TOKEN}`, `db:${TOKEN}:sa_th_alice:@alice`], "verified first, then one database call");
});

test("the local and the remote result stay separate; stopped keeps the credential; not_connected is a clean repeat", async () => {
  for (const [status, code] of [["stopped", "PUBLISH_IN_FLIGHT"], ["stopped", "SECRET_SHARED"], ["stopped", "DISCONNECT_FAILED"]]) {
    const body = await (await handleThreadsDisconnect(post(BODY), harness({ db: answer(status, code) }).deps)).json();
    assert.deepEqual(body, { ok: true, status, code, publish_permission: "withdrawn", local_credentials: "kept", remote_access: "not_revoked_by_app" });
  }
  const again = await (await handleThreadsDisconnect(post(BODY), harness({ db: answer("not_connected", "ALREADY_REMOVED", { publish_permission: "already_off" }) }).deps)).json();
  assert.deepEqual(again, { ok: true, status: "not_connected", code: "ALREADY_REMOVED", publish_permission: "already_off", local_credentials: "none", remote_access: "not_revoked_by_app" });
});

test("not signed in, or signed out since: 401 before the database; Auth unreachable: 503", async () => {
  for (const headers of [{ Authorization: "" }, { Authorization: "Basic abc" }, { Authorization: "Bearer " }, { Authorization: "Bearer a b" }]) {
    const h = harness();
    const response = await handleThreadsDisconnect(post(BODY, headers), h.deps);
    assert.equal(response.status, 401, JSON.stringify(headers));
    assert.deepEqual(h.calls, []);
  }
  const signedOut = harness({ user: null });
  assert.deepEqual(await (await handleThreadsDisconnect(post(BODY), signedOut.deps)).json(), { ok: false, error: "AUTH_REQUIRED" });
  assert.deepEqual(signedOut.calls, [`user:${TOKEN}`]);
  const down = harness({ userThrows: true });
  const response = await handleThreadsDisconnect(post(BODY), down.deps);
  assert.equal(response.status, 503);
  assert.deepEqual(down.calls, [`user:${TOKEN}`], "the database is not called");
});

test("only the exact request shape; nothing else reaches Auth or the database", async () => {
  const bad: unknown[] = [
    { ...BODY, action: "delete" }, { ...BODY, extra: "x" }, { action: "disconnect", social_account_id: "sa_th_alice" },
    { ...BODY, social_account_id: "SA_TH" }, { ...BODY, social_account_id: "sa th" }, { ...BODY, expected_handle: "" },
    { ...BODY, expected_handle: "al ice" }, { ...BODY, expected_handle: "a".repeat(64) }, { ...BODY, expected_handle: "@@alice" },
    { ...BODY, expected_handle: true }, { ...BODY, user_id: "00000000-0000-4000-8000-0000000000b1" },
    '{"action":"disconnect","action":"disconnect","social_account_id":"sa_th_alice","expected_handle":"alice"}',
    '{"action":"disconnect","social_account_id":{"id":"sa_th_alice"},"expected_handle":"alice"}', "[]", "", "x".repeat(3000),
  ];
  for (const body of bad) {
    const h = harness();
    const response = await handleThreadsDisconnect(post(body), h.deps);
    assert.equal(response.status, 400, String(JSON.stringify(body)).slice(0, 80));
    assert.deepEqual(h.calls, []);
  }
  const h = harness();
  assert.equal((await handleThreadsDisconnect(post(BODY, { "Content-Type": "text/plain" }), h.deps)).status, 400);
  assert.equal((await handleThreadsDisconnect(new Request("https://edge.example", { method: "GET" }), h.deps)).status, 405);
  assert.deepEqual(h.calls, []);
});

test("every database refusal maps to its fixed code; anything unknown or off-contract is 503, never a success", async () => {
  const statuses: Record<string, number> = {
    DISCONNECT_DISABLED: 503, AUTH_REQUIRED: 401, REQUEST_INVALID: 400, SERVICE_NOT_ACTIVE: 409, ACCOUNT_LIFECYCLE_BLOCKED: 409,
    BUSY: 409, ACCOUNT_NOT_FOUND: 404, ACCOUNT_CHANGED: 409, DISCONNECT_FORBIDDEN: 403,
  };
  assert.deepEqual([...THREADS_DISCONNECT_REFUSALS].sort(), Object.keys(statuses).sort());
  for (const code of THREADS_DISCONNECT_REFUSALS) {
    const response = await handleThreadsDisconnect(post(BODY), harness({ db: { status: "refused", code } }).deps);
    assert.equal(response.status, statuses[code], code);
    assert.deepEqual(await response.json(), { ok: false, error: code });
  }
  const offContract: unknown[] = [
    null, [], "disconnected", { status: "refused", code: "SOMETHING_NEW" }, { status: "refused", code: "BUSY", detail: "x" },
    answer("disconnected", "LOCAL_REMOVED", { local_credentials: "kept" }), answer("stopped", "PUBLISH_IN_FLIGHT", { local_credentials: "removed" }),
    answer("disconnected", "LOCAL_REMOVED", { remote_access: "revoked" }), answer("disconnected", "LOCAL_REMOVED", { remote_access: "confirmed_remote_revoked" }),
    answer("disconnected", "PUBLISH_IN_FLIGHT"), answer("stopped", "LOCAL_REMOVED"), answer("revoked", "LOCAL_REMOVED"),
    answer("not_connected", "ALREADY_REMOVED"), answer("disconnected", "LOCAL_REMOVED", { publish_permission: "on" }),
    { ...answer("disconnected", "LOCAL_REMOVED"), token: "x" },
  ];
  for (const db of offContract) {
    const response = await handleThreadsDisconnect(post(BODY), harness({ db }).deps);
    assert.equal(response.status, 503, JSON.stringify(db));
    assert.deepEqual(await response.json(), { ok: false, error: "STORE_UNAVAILABLE" });
  }
  // A lost answer (the transaction may have committed): 503 once, never retried here.
  const lost = harness({ dbThrows: new Error("network") });
  assert.equal((await handleThreadsDisconnect(post(BODY), lost.deps)).status, 503);
  assert.equal(lost.calls.filter((c) => c.startsWith("db:")).length, 1);
  assert.throws(() => parseThreadsDisconnectAnswer({ status: "refused", code: "BUSY" }), /BUSY/);
});

test("parity: the exact answers the PostgreSQL proof asserts (postona_threads_disconnect_behavior.sql) parse as intended", () => {
  const sql = [
    ['{"code": "PUBLISH_IN_FLIGHT", "status": "stopped", "remote_access": "not_revoked_by_app", "local_credentials": "kept", "publish_permission": "withdrawn"}', "stopped"],
    ['{"code": "PUBLISH_IN_FLIGHT", "status": "stopped", "remote_access": "not_revoked_by_app", "local_credentials": "kept", "publish_permission": "already_off"}', "stopped"],
    ['{"code": "LOCAL_REMOVED", "status": "disconnected", "remote_access": "not_revoked_by_app", "local_credentials": "removed", "publish_permission": "already_off"}', "disconnected"],
    ['{"code": "ALREADY_REMOVED", "status": "not_connected", "remote_access": "not_revoked_by_app", "local_credentials": "none", "publish_permission": "already_off"}', "not_connected"],
  ] as const;
  for (const [text, status] of sql) assert.equal(parseThreadsDisconnectAnswer(JSON.parse(text)).status, status, text);
  assert.throws(() => parseThreadsDisconnectAnswer(JSON.parse('{"code": "DISCONNECT_DISABLED", "status": "refused"}')), /DISCONNECT_DISABLED/);
});

test("the RPC call: the caller's token and the anon key only, the two arguments only; HTTP failures fail closed", async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const rpc = createThreadsDisconnectRpc({ supabaseUrl: "https://p.example", anonKey: "anon_public_key" }, (url, init) => {
    seen.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify({ status: "refused", code: "DISCONNECT_DISABLED" }), { status: 200 }));
  });
  assert.deepEqual(await rpc(TOKEN, "sa_th_alice", "alice"), { status: "refused", code: "DISCONNECT_DISABLED" });
  assert.equal(seen[0].url, "https://p.example/rest/v1/rpc/disconnect_threads_account");
  assert.deepEqual(JSON.parse(String(seen[0].init?.body)), { p_social_account_id: "sa_th_alice", p_expected_handle: "alice" });
  const headers = new Headers(seen[0].init?.headers);
  assert.equal(headers.get("Authorization"), `Bearer ${TOKEN}`);
  assert.equal(headers.get("apikey"), "anon_public_key");
  assert.equal(seen[0].init?.redirect, "manual");
  const status = (code: number) => createThreadsDisconnectRpc({ supabaseUrl: "https://p.example", anonKey: "k" }, () => Promise.resolve(new Response("{}", { status: code })));
  await assert.rejects(status(401)(TOKEN, "sa_th_alice", "alice"), /AUTH_REQUIRED/);
  await assert.rejects(status(500)(TOKEN, "sa_th_alice", "alice"), /STORE_UNAVAILABLE/);
  await assert.rejects(createThreadsDisconnectRpc({ supabaseUrl: "https://p.example", anonKey: "k" }, () => Promise.reject(new Error("dns")))(TOKEN, "sa_th_alice", "alice"), /STORE_UNAVAILABLE/);
  await assert.rejects(createThreadsDisconnectRpc({ supabaseUrl: "https://p.example", anonKey: "k" }, () => Promise.resolve(new Response("not json", { status: 200 })))(TOKEN, "sa_th_alice", "alice"), /STORE_UNAVAILABLE/);
});

test("nothing is logged and no answer carries the token", async () => {
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  const logged: unknown[] = [];
  for (const k of Object.keys(original) as (keyof typeof original)[]) console[k] = (...args: unknown[]) => logged.push(args);
  try {
    const bodies: string[] = [];
    for (const over of [{}, { user: null }, { userThrows: true }, { dbThrows: new Error(TOKEN) }, { db: { status: "refused", code: "BUSY" } }, { db: null }]) {
      bodies.push(await (await handleThreadsDisconnect(post(BODY), harness(over).deps)).text());
    }
    assert.ok(bodies.every((b) => !b.includes(TOKEN)));
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual(logged, []);
});
