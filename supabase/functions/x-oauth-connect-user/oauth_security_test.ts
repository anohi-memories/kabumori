// G4-05 (Issue #319): the four points G5 raised about this flow (G5 #320 notice, Issue #319 comment 6267736897),
// as executable checks. Offline: every network call is a fake; no --allow-net, no --allow-env.
//   deno test --no-config --cached-only --allow-read=. supabase/functions/x-oauth-connect-user/oauth_security_test.ts
// Before the fix (main 9802f590) these fail; the doc records which and why.
import assert from "node:assert/strict";
import test from "node:test";
import { completeConnection, OAuthConnectUserError, startConnection, X_CONNECT_REGISTERED_REDIRECT_URIS } from "./oauth_logic.ts";

const SUPABASE_URL = "https://example.supabase.co";
const ANON_KEY = "anon-key-fixture";
const CLIENT_ID = "x-client-id-fixture";
const CLIENT_SECRET = "x-client-secret-fixture";
const REDIRECT = "kabumori-social://oauth-callback";
const USER = "0b6a8c1e-2d3f-4a5b-8c7d-9e0f1a2b3c4d";
const OTHER = "7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const BRAND = "u_0b6a8c1e";
const RAW_STATE = "raw-state-value-0123456789abcdef";

type Verdict = Record<string, unknown> | Error | null | string;
function authorization(answers: { begin?: Verdict; pre_exchange?: Verdict } = {}) {
  const asked: string[] = [];
  const port = (req: { phase: string; userId: string; userAccessToken: string; brandId: string | null }) => {
    asked.push(`${req.phase} ${req.userId} ${req.brandId}`);
    const fallback = req.phase === "begin"
      ? { decision: "allow", subjectUserId: USER, brandId: null, ownerEpoch: null }
      : { decision: "allow", subjectUserId: USER, brandId: BRAND, ownerEpoch: "7" };
    const a = req.phase in answers ? answers[req.phase as "begin" | "pre_exchange"] : fallback;
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
  };
  return { port, asked };
}

function backend(over: { begin?: Response; complete?: Response; consumeRedirect?: string; token?: Response; identity?: Response } = {}) {
  const calls: string[] = [];
  const fetchImpl = (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes("begin_social_mobile_x_oauth_connection")) {
      calls.push("begin");
      return Promise.resolve(over.begin ?? Response.json([{ brand_id: BRAND, social_account_id: "sa_x" }]));
    }
    if (url.includes("consume_social_mobile_x_oauth_state")) {
      calls.push("consume");
      return Promise.resolve(Response.json([{ oauth_state_id: "state-1", redirect_uri: over.consumeRedirect ?? REDIRECT, brand_id: BRAND, social_account_id: "sa_x" }]));
    }
    if (url === "https://api.x.com/2/oauth2/token") {
      calls.push("x-token");
      return Promise.resolve(over.token ?? Response.json({ access_token: "x-access", refresh_token: "x-refresh" }));
    }
    if (url === "https://api.x.com/2/users/me") {
      calls.push("x-identity");
      return Promise.resolve(over.identity ?? Response.json({ data: { id: "12345", username: "postona_tester" } }));
    }
    if (url.includes("complete_social_mobile_x_oauth_connection")) {
      calls.push("complete");
      return Promise.resolve(over.complete ?? new Response(null, { status: 204 }));
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  };
  return { fetchImpl, calls };
}

const start = (b: ReturnType<typeof backend>, auth: ReturnType<typeof authorization>["port"] | null, redirectUri = REDIRECT) =>
  startConnection({
    request: { rawState: RAW_STATE, codeChallenge: "challenge", redirectUri },
    userId: USER,
    authorization: auth,
    userAccessToken: "user-jwt",
    supabaseUrl: SUPABASE_URL,
    anonKey: ANON_KEY,
    clientId: CLIENT_ID,
    fetchImpl: b.fetchImpl as typeof fetch,
  });
const callback = (b: ReturnType<typeof backend>, auth: ReturnType<typeof authorization>["port"] | null, redirectUri = REDIRECT) =>
  completeConnection({
    request: { code: "auth-code", state: RAW_STATE, codeVerifier: "verifier", redirectUri },
    userId: USER,
    authorization: auth,
    userAccessToken: "user-jwt",
    supabaseUrl: SUPABASE_URL,
    anonKey: ANON_KEY,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    fetchImpl: b.fetchImpl as typeof fetch,
  });
const rejectsWith = async (promise: Promise<unknown>, code: string, status?: number) => {
  await assert.rejects(promise, (e: unknown) => {
    assert.ok(e instanceof OAuthConnectUserError, String(e));
    assert.equal(e.message, code);
    if (status !== undefined) assert.equal(e.status, status);
    return true;
  });
};

// ---- (1) re-authorization BEFORE the code exchange --------------------------------------------------------------------

test("(1) the person lost the workspace after begin: refused before the X code exchange (exchange 0, complete 0)", async () => {
  const b = backend({ complete: Response.json({ message: "SOCIAL_MOBILE_ACCOUNT_NOT_OWNED" }, { status: 400 }) });
  const a = authorization({ pre_exchange: { decision: "deny", subjectUserId: USER, brandId: BRAND, ownerEpoch: "8" } });
  await rejectsWith(callback(b, a.port), "X_CONNECT_NOT_AUTHORIZED", 403);
  assert.deepEqual(b.calls, ["consume"]);
  assert.deepEqual(a.asked, [`pre_exchange ${USER} ${BRAND}`]);
});

test("(1) no authorization port wired (G5 R1 does not exist yet): no RPC, no exchange", async () => {
  const b = backend();
  await rejectsWith(callback(b, null), "X_CONNECT_AUTHORIZATION_UNAVAILABLE", 503);
  await rejectsWith(start(b, null), "X_CONNECT_AUTHORIZATION_UNAVAILABLE", 503);
  assert.deepEqual(b.calls, []);
});

test("(1) an unknown, malformed, foreign or failing verdict never opens the exchange", async () => {
  const cases: [Verdict, string][] = [
    [{ decision: "unknown", subjectUserId: USER, brandId: BRAND, ownerEpoch: "7" }, "X_CONNECT_AUTHORIZATION_UNKNOWN"],
    [{ decision: "ALLOW", subjectUserId: USER, brandId: BRAND, ownerEpoch: "7" }, "X_CONNECT_AUTHORIZATION_UNKNOWN"],
    [{ decision: "allow", subjectUserId: OTHER, brandId: BRAND, ownerEpoch: "7" }, "X_CONNECT_AUTHORIZATION_UNKNOWN"],
    [{ decision: "allow", subjectUserId: USER, brandId: "u_other", ownerEpoch: "7" }, "X_CONNECT_AUTHORIZATION_UNKNOWN"],
    [{ decision: "allow", subjectUserId: USER, brandId: BRAND, ownerEpoch: null }, "X_CONNECT_AUTHORIZATION_UNKNOWN"],
    [{ decision: "allow", subjectUserId: USER, brandId: BRAND, ownerEpoch: "0" }, "X_CONNECT_AUTHORIZATION_UNKNOWN"],
    [{ decision: "allow", subjectUserId: USER, brandId: BRAND, ownerEpoch: "7x" }, "X_CONNECT_AUTHORIZATION_UNKNOWN"],
    [{ decision: "allow", subjectUserId: USER, brandId: BRAND, ownerEpoch: 7.5 }, "X_CONNECT_AUTHORIZATION_UNKNOWN"],
    [{ decision: "allow" }, "X_CONNECT_AUTHORIZATION_UNKNOWN"],
    ["allow", "X_CONNECT_AUTHORIZATION_UNKNOWN"],
    [null, "X_CONNECT_AUTHORIZATION_UNKNOWN"],
    [new Error(`rpc down ${USER}`), "X_CONNECT_AUTHORIZATION_UNAVAILABLE"],
  ];
  for (const [verdict, code] of cases) {
    const b = backend();
    await rejectsWith(callback(b, authorization({ pre_exchange: verdict }).port), code);
    assert.deepEqual(b.calls, ["consume"], JSON.stringify(verdict));
  }
});

test("(1) allowed: a fresh verdict per callback (never cached), then exactly one exchange; a numeric epoch is accepted", async () => {
  const a = authorization({ pre_exchange: { decision: "allow", subjectUserId: USER, brandId: BRAND, ownerEpoch: 7 } });
  for (let i = 0; i < 2; i += 1) {
    const b = backend();
    const result = await callback(b, a.port);
    assert.equal(result.connectionStatus, "identity_verified");
    assert.deepEqual(b.calls, ["consume", "x-token", "x-identity", "complete"]);
  }
  assert.deepEqual(a.asked, [`pre_exchange ${USER} ${BRAND}`, `pre_exchange ${USER} ${BRAND}`]);
});

test("(1) an expired / used / foreign state is refused by consume before any verdict or exchange", async () => {
  const b = backend();
  const fetchImpl = (input: RequestInfo | URL) =>
    String(input).includes("consume_social_mobile_x_oauth_state")
      ? Promise.resolve(Response.json({ message: "OAUTH_STATE_NOT_CONSUMABLE" }, { status: 400 }))
      : b.fetchImpl(input);
  const a = authorization();
  await rejectsWith(
    completeConnection({
      request: { code: "c", state: RAW_STATE, codeVerifier: "v", redirectUri: REDIRECT },
      userId: USER,
      authorization: a.port,
      userAccessToken: "user-jwt",
      supabaseUrl: SUPABASE_URL,
      anonKey: ANON_KEY,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetchImpl: fetchImpl as typeof fetch,
    }),
    "OAUTH_STATE_NOT_CONSUMABLE",
  );
  assert.deepEqual(a.asked, []);
  assert.deepEqual(b.calls, []);
});

// ---- (2) no database or provider detail reaches the client ------------------------------------------------------------

test("(2) a raw database error never becomes the client's error code; the RPCs' own fixed codes still do", async () => {
  const raw = 'duplicate key value violates unique constraint "social_accounts_pkey" DETAIL: Key (id)=(sa_secret) already exists.';
  const leaky = backend({ begin: Response.json({ message: raw, details: "Key (vault_access_token_secret_id)=(...)" }, { status: 409 }) });
  await rejectsWith(start(leaky, authorization().port), "SOCIAL_MOBILE_OAUTH_DB_CALL_FAILED", 400);
  const vault = backend({ complete: Response.json({ message: "permission denied for function create_secret" }, { status: 403 }) });
  await rejectsWith(callback(vault, authorization().port), "SOCIAL_MOBILE_OAUTH_DB_CALL_FAILED", 403);
  const known = backend({ complete: Response.json({ message: "X_ACCOUNT_ALREADY_CONNECTED" }, { status: 400 }) });
  await rejectsWith(callback(known, authorization().port), "X_ACCOUNT_ALREADY_CONNECTED", 400);
});

test("(2) X failures carry a fixed code without the provider's status or body", async () => {
  await rejectsWith(callback(backend({ token: new Response("invalid_grant: code abc", { status: 400 }) }), authorization().port), "X_TOKEN_EXCHANGE_FAILED", 502);
  await rejectsWith(callback(backend({ identity: new Response("nope", { status: 401 }) }), authorization().port), "X_IDENTITY_READ_FAILED", 502);
});

// ---- (3) redirect_uri: the registered value, exactly ------------------------------------------------------------------

test("(3) only the registered redirect URI, compared exactly: no request leaves for anything else", async () => {
  assert.deepEqual([...X_CONNECT_REGISTERED_REDIRECT_URIS], [REDIRECT]);
  for (const redirectUri of [
    "https://evil.example/cb",
    "kabumori-social://oauth-callback/",
    "KABUMORI-SOCIAL://oauth-callback",
    "kabumori-social://oauth-callback?next=https://evil.example",
    "kabumori-social://oauth-callback#x",
    " kabumori-social://oauth-callback",
    "kabumori-social://OAUTH-CALLBACK",
    "kabumori-social:/oauth-callback",
    "app://cb",
  ]) {
    const b = backend();
    const a = authorization();
    await rejectsWith(start(b, a.port, redirectUri), "OAUTH_REDIRECT_URI_NOT_ALLOWED", 400);
    await rejectsWith(callback(b, a.port, redirectUri), "OAUTH_REDIRECT_URI_NOT_ALLOWED", 400);
    assert.deepEqual(b.calls, [], redirectUri);
    assert.deepEqual(a.asked, [], redirectUri);
  }
  const ok = backend();
  const started = await start(ok, authorization().port);
  assert.equal(new URL(started.authorizationUrl).searchParams.get("redirect_uri"), REDIRECT);
});

// ---- (4) begin while the account is being deleted / the service is stopped ----------------------------------------------

test("(4) begin refuses a person G5 does not allow (deletion in progress, service ended, frozen): begin RPC 0", async () => {
  for (const verdict of [
    { decision: "deny", subjectUserId: USER, brandId: null, ownerEpoch: null, reason: "ACCOUNT_DELETION_IN_PROGRESS" },
    { decision: "deny", subjectUserId: USER, brandId: null, ownerEpoch: null, reason: "SERVICE_NOT_ACTIVE" },
  ]) {
    const b = backend();
    await rejectsWith(start(b, authorization({ begin: verdict }).port), "X_CONNECT_NOT_AUTHORIZED", 403);
    assert.deepEqual(b.calls, []);
  }
  for (const verdict of [{ decision: "unknown", subjectUserId: USER, brandId: null, ownerEpoch: null }, { decision: "allow", subjectUserId: OTHER, brandId: null, ownerEpoch: null }]) {
    const b = backend();
    await rejectsWith(start(b, authorization({ begin: verdict }).port), "X_CONNECT_AUTHORIZATION_UNKNOWN", 503);
    assert.deepEqual(b.calls, []);
  }
  const b = backend();
  const a = authorization();
  await start(b, a.port);
  assert.deepEqual(a.asked, [`begin ${USER} null`]);
  assert.deepEqual(b.calls, ["begin"]);
});

// ---- the deployable entry ---------------------------------------------------------------------------------------------

test("index.ts wires no authorization port (G5 R1 is not implemented): the deployed flow would refuse, never open", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const wired = [...source.replace(/^\s*\/\/.*$/gmu, "").matchAll(/\bauthorization:\s*([^\s,}]+)/gu)].map((m) => m[1]);
  assert.deepEqual(wired, ["null", "null"]);
  assert.equal((source.match(/userId: user\.userId/gu) ?? []).length, 2);
});
