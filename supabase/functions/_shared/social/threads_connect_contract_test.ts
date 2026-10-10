import assert from "node:assert/strict";
import test from "node:test";
import {
  buildThreadsAuthorizeUrl,
  completeThreadsConnectExchange,
  exchangeThreadsCode,
  exchangeThreadsLongLived,
  type FetchLike,
  fetchThreadsProfile,
  hashThreadsState,
  isAcceptableThreadsRedirectUri,
  isWellFormedThreadsState,
  parseThreadsCallback,
  readThreadsConnectConfig,
  THREADS_CONNECT_ENDPOINTS,
  THREADS_CONNECT_ERROR_CODES,
  THREADS_CONNECT_PREREQUISITES,
  THREADS_CONNECT_PREREQUISITES_MET,
  THREADS_CONNECT_SCOPES,
  type ThreadsConnectConfig,
  ThreadsConnectError,
  validateThreadsConnectEnv,
} from "./threads_connect_contract.ts";

// Fake values only. The secret and tokens are long enough to be recognised in any leaked text.
const APP_ID = "990602627938098";
const APP_SECRET = "fake_app_secret_0123456789abcdef";
const REDIRECT = "https://postona.example/oauth/threads";
const STATE = "Zx9_-ab0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabc"; // 46 base64url chars
const CODE = "AQBx-hBsH3fakeAuthorizationCode";
const SHORT_TOKEN = "THQVJfakeShortLivedToken0123456789";
const LONG_TOKEN = "THQVJfakeLongLivedToken9876543210ab";
const BIG_ODD_ID = "17841405793187219"; // > 2^53 and odd: a JSON number parse rounds it
const ENABLED: ThreadsConnectConfig = { status: "enabled", settings: { appId: APP_ID, appSecret: APP_SECRET, redirectUri: REDIRECT } };
const DISABLED: ThreadsConnectConfig = { status: "disabled", reasons: ["THREADS_CONNECT_PREREQUISITES_NOT_MET"] };
const SENSITIVE = [APP_SECRET, CODE, SHORT_TOKEN, LONG_TOKEN];

type Call = { url: string; init?: RequestInit };
function fakeFetch(responses: Array<Response | Error>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected call");
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return { fetch, calls };
}
const json = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "application/json" } });
const codeOk = (userId = BIG_ODD_ID) => json(`{"access_token":"${SHORT_TOKEN}","token_type":"bearer","user_id":${userId}}`);
const longOk = () => json(`{"access_token":"${LONG_TOKEN}","token_type":"bearer","expires_in":5183944}`);
const profileOk = (id = BIG_ODD_ID, username = "postona_tester") => json(`{"id":"${id}","username":"${username}"}`);

async function refusedWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ThreadsConnectError);
    assert.equal(error.code, code);
    for (const secret of SENSITIVE) assert.ok(!String(error.message).includes(secret) && !String(error.stack ?? "").includes(secret));
    return true;
  });
}

test("the contract is the official one (re-read 2026-10-10)", () => {
  assert.deepEqual(THREADS_CONNECT_ENDPOINTS, {
    authorize: "https://threads.com/oauth/authorize",
    codeExchange: "https://graph.threads.com/oauth/access_token",
    longLivedExchange: "https://graph.threads.net/access_token",
    profile: "https://graph.threads.net/v1.0/me",
  });
  assert.deepEqual([...THREADS_CONNECT_SCOPES], ["threads_basic", "threads_content_publish"]);
  assert.ok(Object.isFrozen(THREADS_CONNECT_ENDPOINTS) && Object.isFrozen(THREADS_CONNECT_SCOPES));
});

test("connecting stays disabled: the static gate is closed and the environment cannot open it", () => {
  assert.equal(THREADS_CONNECT_PREREQUISITES_MET, false);
  assert.deepEqual([...THREADS_CONNECT_PREREQUISITES], [
    "PHASE_2A2_MIGRATION_APPLIED",
    "COMMON_ACCOUNT_WRITER_FENCE",
    "CONNECT_RPC_REVIEWED",
    "PROVIDER_AWARE_DELETION",
    "META_APP_CONFIGURED",
  ]);
  const fullEnv = new Map([
    ["THREADS_CONNECT_ENABLED", "true"],
    ["THREADS_APP_ID", APP_ID],
    ["THREADS_APP_SECRET", APP_SECRET],
    ["THREADS_REDIRECT_URI", REDIRECT],
  ]);
  assert.equal(validateThreadsConnectEnv((name) => fullEnv.get(name)).ok, true);
  assert.deepEqual(readThreadsConnectConfig((name) => fullEnv.get(name)), DISABLED);
});

test("a disabled configuration makes no request and builds nothing", async () => {
  const { fetch, calls } = fakeFetch([]);
  assert.throws(() => buildThreadsAuthorizeUrl(DISABLED, STATE), (e: unknown) => e instanceof ThreadsConnectError && e.code === "THREADS_CONNECT_DISABLED");
  await refusedWith(completeThreadsConnectExchange(fetch, DISABLED, CODE), "THREADS_CONNECT_DISABLED");
  await refusedWith(exchangeThreadsCode(fetch, DISABLED, CODE), "THREADS_CONNECT_DISABLED");
  await refusedWith(exchangeThreadsLongLived(fetch, DISABLED, SHORT_TOKEN), "THREADS_CONNECT_DISABLED");
  assert.equal(calls.length, 0);
});

test("environment validation names what is wrong, never the secret", () => {
  const check = (env: Record<string, string>) => validateThreadsConnectEnv((name) => env[name]);
  const good = { THREADS_CONNECT_ENABLED: "true", THREADS_APP_ID: APP_ID, THREADS_APP_SECRET: APP_SECRET, THREADS_REDIRECT_URI: REDIRECT };
  for (
    const [label, env, reason] of [
      ["flag missing", { ...good, THREADS_CONNECT_ENABLED: "" }, "THREADS_CONNECT_ENABLED_NOT_TRUE"],
      ["flag not exactly true", { ...good, THREADS_CONNECT_ENABLED: "TRUE" }, "THREADS_CONNECT_ENABLED_NOT_TRUE"],
      ["app id not numeric", { ...good, THREADS_APP_ID: "abc" }, "THREADS_APP_ID_INVALID"],
      ["secret too short", { ...good, THREADS_APP_SECRET: "short" }, "THREADS_APP_SECRET_INVALID"],
      ["secret with whitespace", { ...good, THREADS_APP_SECRET: `${APP_SECRET} x` }, "THREADS_APP_SECRET_INVALID"],
      ["redirect http", { ...good, THREADS_REDIRECT_URI: "http://postona.example/oauth/threads" }, "THREADS_REDIRECT_URI_INVALID"],
      ["redirect custom scheme", { ...good, THREADS_REDIRECT_URI: "kabumori-social://oauth-callback" }, "THREADS_REDIRECT_URI_INVALID"],
    ] as Array<[string, Record<string, string>, string]>
  ) {
    const result = check(env);
    assert.equal(result.ok, false, label);
    if (!result.ok) {
      assert.ok(result.reasons.includes(reason), `${label}: ${result.reasons.join(",")}`);
      assert.ok(!result.reasons.join(",").includes(APP_SECRET), label);
    }
  }
});

test("redirect URIs: exact https only", () => {
  assert.equal(isAcceptableThreadsRedirectUri(REDIRECT), true);
  for (
    const bad of [
      "http://postona.example/oauth/threads",
      "kabumori-social://oauth-callback",
      "https://postona.example/oauth/threads#frag",
      "https://user:pw@postona.example/oauth/threads",
      "https://*.postona.example/oauth/threads",
      "https://postona.example", // normalises to a trailing slash: not the exact registered value
      "not a url",
      "",
    ]
  ) assert.equal(isAcceptableThreadsRedirectUri(bad), false, bad);
});

test("the authorization URL carries exactly the documented parameters and no secret", () => {
  const url = new URL(buildThreadsAuthorizeUrl(ENABLED, STATE));
  assert.equal(url.origin + url.pathname, "https://threads.com/oauth/authorize");
  assert.deepEqual(
    [...url.searchParams.entries()],
    [["client_id", APP_ID], ["redirect_uri", REDIRECT], ["scope", "threads_basic,threads_content_publish"], ["response_type", "code"], ["state", STATE]],
  );
  assert.ok(!url.href.includes(APP_SECRET));
  for (const bad of ["", "short", "x".repeat(42), `${STATE}!`, "a".repeat(129)]) {
    assert.throws(() => buildThreadsAuthorizeUrl(ENABLED, bad), (e: unknown) => e instanceof ThreadsConnectError && e.code === "THREADS_STATE_MALFORMED");
  }
});

test("state: shape and the stored hash (sha256 hex, as the X flow)", async () => {
  assert.equal(isWellFormedThreadsState(STATE), true);
  assert.equal(isWellFormedThreadsState(42), false);
  const hash = await hashThreadsState(STATE);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, await hashThreadsState(STATE));
  assert.notEqual(hash, await hashThreadsState(`${STATE.slice(0, -1)}d`));
  await refusedWith(hashThreadsState("short"), "THREADS_STATE_MALFORMED");
});

test("callback parsing: code (with the appended #_ removed), denial, and every malformed shape", () => {
  const parse = (query: string) => parseThreadsCallback(new URLSearchParams(query));
  assert.deepEqual(parse(`code=${CODE}%23_&state=${STATE}`), { kind: "code", code: CODE, state: STATE });
  assert.deepEqual(parse(`code=${CODE}&state=${STATE}`), { kind: "code", code: CODE, state: STATE });
  assert.deepEqual(parse("error=access_denied&error_reason=user_denied&error_description=The+user+denied+your+request"), { kind: "denied" });
  assert.deepEqual(parse("error=server_error"), { kind: "invalid", reason: "AUTHORIZATION_ERROR" });
  assert.deepEqual(parse(`error=access_denied&code=${CODE}&state=${STATE}`), { kind: "invalid", reason: "AUTHORIZATION_ERROR" });
  assert.deepEqual(parse(`code=${CODE}`), { kind: "invalid", reason: "STATE_MISSING" });
  assert.deepEqual(parse(`code=${CODE}&state=`), { kind: "invalid", reason: "STATE_MISSING" });
  assert.deepEqual(parse(`code=${CODE}&state=abc`), { kind: "invalid", reason: "STATE_MALFORMED" });
  assert.deepEqual(parse(`state=${STATE}`), { kind: "invalid", reason: "CODE_MISSING" });
  assert.deepEqual(parse(`code=a%20b&state=${STATE}`), { kind: "invalid", reason: "CODE_MALFORMED" });
  assert.deepEqual(parse(`code=${"a".repeat(2049)}&state=${STATE}`), { kind: "invalid", reason: "CODE_MALFORMED" });
  assert.deepEqual(parse(`code=${CODE}&code=other&state=${STATE}`), { kind: "invalid", reason: "PARAMETER_REPEATED" });
  assert.deepEqual(parse(`code=${CODE}&state=${STATE}&state=${STATE}`), { kind: "invalid", reason: "PARAMETER_REPEATED" });
});

test("code exchange: documented request, exact large id, and every failure fails closed without leaking", async () => {
  const { fetch, calls } = fakeFetch([codeOk()]);
  assert.deepEqual(await exchangeThreadsCode(fetch, ENABLED, CODE), { shortLivedToken: SHORT_TOKEN, userId: BIG_ODD_ID });
  assert.equal(String(JSON.parse(`{"n":${BIG_ODD_ID}}`).n) === BIG_ODD_ID, false, "a number parse would have rounded the id");
  assert.equal(calls[0].url, "https://graph.threads.com/oauth/access_token");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(calls[0].init?.redirect, "error");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(calls[0].init?.body))), {
    client_id: APP_ID,
    client_secret: APP_SECRET,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT,
    code: CODE,
  });
  // A string user_id is accepted too.
  assert.equal((await exchangeThreadsCode(fakeFetch([codeOk(`"${BIG_ODD_ID}"`)]).fetch, ENABLED, CODE)).userId, BIG_ODD_ID);
  for (
    const [label, response, code] of [
      ["used or expired code (400)", json('{"error_type":"OAuthException","code":400,"error_message":"Matching code was not found or was already used"}', 400), "THREADS_CODE_EXCHANGE_REJECTED"],
      ["provider error (500)", json("{}", 500), "THREADS_CODE_EXCHANGE_UNAVAILABLE"],
      ["redirect (302)", new Response(null, { status: 302 }), "THREADS_CODE_EXCHANGE_UNAVAILABLE"],
      ["network failure", new Error("connection reset"), "THREADS_CODE_EXCHANGE_UNAVAILABLE"],
      ["not JSON", json("<html>"), "THREADS_CODE_EXCHANGE_MALFORMED"],
      ["form-encoded body carrying a token", json(`access_token=${SHORT_TOKEN}&token_type=bearer`), "THREADS_CODE_EXCHANGE_MALFORMED"],
      ["JSON array", json("[]"), "THREADS_CODE_EXCHANGE_MALFORMED"],
      ["no token", json(`{"token_type":"bearer","user_id":${BIG_ODD_ID}}`), "THREADS_CODE_EXCHANGE_MALFORMED"],
      ["no token_type", json(`{"access_token":"${SHORT_TOKEN}","user_id":${BIG_ODD_ID}}`), "THREADS_CODE_EXCHANGE_MALFORMED"],
      ["other token_type", json(`{"access_token":"${SHORT_TOKEN}","token_type":"mac","user_id":${BIG_ODD_ID}}`), "THREADS_CODE_EXCHANGE_MALFORMED"],
      ["no user_id", json(`{"access_token":"${SHORT_TOKEN}","token_type":"bearer"}`), "THREADS_CODE_EXCHANGE_MALFORMED"],
      ["user_id not digits", json(`{"access_token":"${SHORT_TOKEN}","token_type":"bearer","user_id":"abc"}`), "THREADS_CODE_EXCHANGE_MALFORMED"],
      ["user_id negative", json(`{"access_token":"${SHORT_TOKEN}","token_type":"bearer","user_id":-5}`), "THREADS_CODE_EXCHANGE_MALFORMED"],
      ["user_id exponent", json(`{"access_token":"${SHORT_TOKEN}","token_type":"bearer","user_id":1.7e16}`), "THREADS_CODE_EXCHANGE_MALFORMED"],
    ] as Array<[string, Response | Error, string]>
  ) {
    const single = fakeFetch([response]);
    await refusedWith(exchangeThreadsCode(single.fetch, ENABLED, CODE), code);
    assert.equal(single.calls.length, 1, `${label}: exactly one request, never retried with the single-use code`);
  }
});

test("long-lived exchange: documented request and bounded lifetime", async () => {
  const { fetch, calls } = fakeFetch([longOk()]);
  assert.deepEqual(await exchangeThreadsLongLived(fetch, ENABLED, SHORT_TOKEN), { longLivedToken: LONG_TOKEN, expiresInSeconds: 5183944 });
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, "https://graph.threads.net/access_token");
  assert.deepEqual(Object.fromEntries(url.searchParams), { grant_type: "th_exchange_token", client_secret: APP_SECRET, access_token: SHORT_TOKEN });
  assert.equal(calls[0].init?.method, "GET");
  for (
    const [response, code] of [
      [json(`{"access_token":"${LONG_TOKEN}","token_type":"bearer","expires_in":0}`), "THREADS_LONG_LIVED_EXCHANGE_MALFORMED"],
      [json(`{"access_token":"${LONG_TOKEN}","token_type":"bearer","expires_in":99999999}`), "THREADS_LONG_LIVED_EXCHANGE_MALFORMED"],
      [json(`{"access_token":"${LONG_TOKEN}","token_type":"bearer","expires_in":"5183944"}`), "THREADS_LONG_LIVED_EXCHANGE_MALFORMED"],
      [json(`{"access_token":"${LONG_TOKEN}","token_type":"bearer"}`), "THREADS_LONG_LIVED_EXCHANGE_MALFORMED"],
      [json('{"error":{"message":"expired"}}', 400), "THREADS_LONG_LIVED_EXCHANGE_REJECTED"],
      [json("{}", 503), "THREADS_LONG_LIVED_EXCHANGE_UNAVAILABLE"],
      [new Error("timeout"), "THREADS_LONG_LIVED_EXCHANGE_UNAVAILABLE"],
    ] as Array<[Response | Error, string]>
  ) await refusedWith(exchangeThreadsLongLived(fakeFetch([response]).fetch, ENABLED, SHORT_TOKEN), code);
});

test("profile read: documented request, string id kept exact, username shape", async () => {
  const { fetch, calls } = fakeFetch([profileOk()]);
  assert.deepEqual(await fetchThreadsProfile(fetch, LONG_TOKEN), { id: BIG_ODD_ID, username: "postona_tester" });
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, "https://graph.threads.net/v1.0/me");
  assert.deepEqual(Object.fromEntries(url.searchParams), { fields: "id,username", access_token: LONG_TOKEN });
  assert.deepEqual(await fetchThreadsProfile(fakeFetch([json(`{"id":${BIG_ODD_ID}}`)]).fetch, LONG_TOKEN), { id: BIG_ODD_ID, username: null });
  for (
    const [response, code] of [
      [json('{"username":"x"}'), "THREADS_PROFILE_MALFORMED"],
      [json('{"id":"12a"}'), "THREADS_PROFILE_MALFORMED"],
      [json(`{"id":"${BIG_ODD_ID}","username":"bad name!"}`), "THREADS_PROFILE_MALFORMED"],
      [json(`{"id":"${BIG_ODD_ID}","username":7}`), "THREADS_PROFILE_MALFORMED"],
      [json("{}", 401), "THREADS_PROFILE_REJECTED"],
      [json("{}", 500), "THREADS_PROFILE_UNAVAILABLE"],
    ] as Array<[Response, string]>
  ) await refusedWith(fetchThreadsProfile(fakeFetch([response]).fetch, LONG_TOKEN), code);
});

test("complete exchange: the identity the code was issued to must be the identity read back", async () => {
  const ok = fakeFetch([codeOk(), longOk(), profileOk()]);
  const result = await completeThreadsConnectExchange(ok.fetch, ENABLED, CODE);
  assert.deepEqual(result, {
    identity: { provider: "threads", providerAccountId: BIG_ODD_ID, handle: "postona_tester" },
    longLivedToken: LONG_TOKEN,
    expiresInSeconds: 5183944,
  });
  assert.ok(!JSON.stringify(result).includes(SHORT_TOKEN), "the short-lived token never leaves the exchange");
  assert.equal(ok.calls.length, 3);

  // The id a rounded number parse would produce is a different account: refused.
  const rounded = String(Number(BIG_ODD_ID));
  assert.notEqual(rounded, BIG_ODD_ID);
  const mismatch = fakeFetch([codeOk(), longOk(), profileOk(rounded)]);
  await refusedWith(completeThreadsConnectExchange(mismatch.fetch, ENABLED, CODE), "THREADS_IDENTITY_MISMATCH");

  // A failure at any step stops the chain there.
  const stopped = fakeFetch([codeOk(), json("{}", 400)]);
  await refusedWith(completeThreadsConnectExchange(stopped.fetch, ENABLED, CODE), "THREADS_LONG_LIVED_EXCHANGE_REJECTED");
  assert.equal(stopped.calls.length, 2);
});

test("error codes are a closed set and carry only the code", () => {
  assert.equal(new Set(THREADS_CONNECT_ERROR_CODES).size, THREADS_CONNECT_ERROR_CODES.length);
  const error = new ThreadsConnectError("THREADS_IDENTITY_MISMATCH");
  assert.equal(error.message, "THREADS_IDENTITY_MISMATCH");
});

test("isolation: nothing imports the contract, and it imports only the provider-domain types", async () => {
  const self = new URL("./threads_connect_contract.ts", import.meta.url);
  const source = await Deno.readTextFile(self);
  const imports = [...source.matchAll(/^import .+ from "(.+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./provider_domain.ts"]);
  assert.match(source, /^import type \{ ConnectedAccountIdentity \} from "\.\/provider_domain\.ts";$/m);

  const functionsRoot = new URL("../../", import.meta.url);
  const importers: string[] = [];
  const walk = async (dir: URL): Promise<void> => {
    for await (const entry of Deno.readDir(dir)) {
      const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
      if (entry.isDirectory) await walk(child);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry.name) && !entry.name.startsWith("threads_connect_contract")) {
        if ((await Deno.readTextFile(child)).includes("threads_connect_contract")) importers.push(child.pathname);
      }
    }
  };
  await walk(functionsRoot);
  assert.deepEqual(importers, []);
});
