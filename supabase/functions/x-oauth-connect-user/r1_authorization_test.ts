// G4-06: denial-first checks of the R1 adapter, then the flow through it with a fake R1 and a fake X. Offline: no
// --allow-net, no --allow-env (read only, for the wiring/isolation scan).
//   deno test --no-config --cached-only --allow-read=. supabase/functions/x-oauth-connect-user/r1_authorization_test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { completeConnection, OAuthConnectUserError, startConnection } from "./oauth_logic.ts";
import {
  createXConnectR1AuthorizationPort,
  decodeR1Answer,
  ownerEpochFromToken,
  type R1Question,
  type R1Transport,
  type R1TransportResult,
  X_CONNECT_R1_ADAPTER_WIRED,
} from "./r1_authorization.ts";

const USER = "0b6a8c1e-2d3f-4a5b-8c7d-9e0f1a2b3c4d";
const OTHER = "7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const BRAND = "u_0b6a8c1e2d3f4a5b8c7d9e0f";
const REDIRECT = "kabumori-social://oauth-callback";
const REF = `s:${"ab".repeat(16)}`;

/** The R1 answer exactly as G5-03's SQL builds it for an allow. */
const allowWire = (over: Record<string, unknown> = {}) => ({
  v: 1,
  decision: "allow",
  reason: null,
  scope: { app: "postona", feature: "x_connect", brand_slug: BRAND },
  subject: { kind: "user", user_id: USER },
  session: { state: "active", ref: REF },
  owner_epoch: "g5oe:7:3",
  entitlements: ["postona:x_autopost"],
  ...over,
});
const denyWire = (reason: string, over: Record<string, unknown> = {}) => ({
  ...allowWire(),
  decision: "deny",
  reason,
  session: null,
  owner_epoch: null,
  entitlements: [],
  ...over,
});
const ok = (body: unknown): R1TransportResult => ({ status: 200, body });
const decode = (result: unknown) => decodeR1Answer(result, { userId: USER, brandId: BRAND });
const UNKNOWN = { decision: "unknown", subjectUserId: null, brandId: BRAND, ownerEpoch: null };

// ---- the wire ---------------------------------------------------------------------------------------------------------

test("the adapter is not wired; index.ts still passes no authorization port", async () => {
  assert.equal(X_CONNECT_R1_ADAPTER_WIRED, false);
  const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert.equal(/r1_authorization/u.test(index), false);
  const wired = [...index.replace(/^\s*\/\/.*$/gmu, "").matchAll(/\bauthorization:\s*([^\s,}]+)/gu)].map((m) => m[1]);
  assert.deepEqual(wired, ["null", "null"]);
});

test("allow: exactly G5's wire for this person, brand and feature -> the epoch's decimal text", () => {
  assert.deepEqual(decode(ok(allowWire())), { decision: "allow", subjectUserId: USER, brandId: BRAND, ownerEpoch: "7" });
  assert.deepEqual(decode(ok(allowWire({ owner_epoch: "g5oe:9223372036854775807:9223372036854775807" }))).ownerEpoch, "9223372036854775807");
});

test("owner epoch: only the string token within bigint; never a JS number, never rounded", () => {
  for (const bad of [7, 7.0, "7", "g5oe:7", "g5oe:0:1", "g5oe:7:0", "g5oe:07:1", "g5oe:-7:1", "g5oe:7:3:1", "G5OE:7:3", " g5oe:7:3",
    "g5oe:9223372036854775808:1", "g5oe:1:9223372036854775808", "g5oe:99999999999999999999:1", null]) {
    assert.equal(ownerEpochFromToken(bad), null, JSON.stringify(bad));
    assert.deepEqual(decode(ok(allowWire({ owner_epoch: bad }))), UNKNOWN, JSON.stringify(bad));
  }
  assert.equal(ownerEpochFromToken("g5oe:9007199254740993:1"), "9007199254740993"); // above 2^53: kept exact
});

test("anything but exactly the wire is unknown (never an allow)", () => {
  const { v: _v, ...noV } = allowWire();
  const cases: unknown[] = [
    ok({ ...allowWire(), extra: 1 }),
    ok(noV),
    ok(allowWire({ v: 2 })),
    ok(allowWire({ decision: "ALLOW" })),
    ok(allowWire({ decision: "pending", reason: "SERVICE_PROVISIONING" })),
    ok(allowWire({ decision: "unknown", reason: "OWNER_EPOCH_UNAVAILABLE" })),
    ok(allowWire({ reason: "OK" })),
    ok(allowWire({ scope: { app: "kabumori", feature: "x_connect", brand_slug: BRAND } })),
    ok(allowWire({ scope: { app: "postona", feature: "threads_connect", brand_slug: BRAND } })),
    ok(allowWire({ scope: { app: "postona", feature: "x_connect", brand_slug: "u_other" } })),
    ok(allowWire({ scope: { app: "postona", feature: "x_connect", brand_slug: BRAND, extra: 1 } })),
    ok(allowWire({ subject: { kind: "user", user_id: OTHER } })),
    ok(allowWire({ subject: { kind: "system" } })),
    ok(allowWire({ subject: { kind: "user", user_id: USER, admin: true } })),
    ok(allowWire({ session: null })),
    ok(allowWire({ session: { state: "revoked", ref: REF } })),
    ok(allowWire({ session: { state: "active", ref: "s:short" } })),
    ok(allowWire({ entitlements: [] })),
    ok(allowWire({ entitlements: ["postona:x_autopost", "kabumori:app"] })),
    ok(allowWire({ entitlements: ["postona:threads"] })),
    ok(allowWire({ entitlements: "postona:x_autopost" })),
    ok("allow"),
    ok(null),
    { status: 200 },
    { status: "200", body: allowWire() },
    null,
  ];
  for (const c of cases) assert.deepEqual(decode(c), UNKNOWN, JSON.stringify(c));
});

test("deny about this person stays deny; deny about nobody or with an odd reason is unknown", () => {
  for (const reason of ["ACCOUNT_DELETION_IN_PROGRESS", "SERVICE_SUSPENDED", "SERVICE_NOT_ACTIVE", "SESSION_EXPIRED", "SESSION_REVOKED", "ROLE_NOT_ALLOWED", "BRAND_ACCESS_DENIED"]) {
    assert.deepEqual(decode(ok(denyWire(reason))), { decision: "deny", subjectUserId: USER, brandId: BRAND, ownerEpoch: null }, reason);
  }
  assert.deepEqual(decode(ok(denyWire("AUTH_REQUIRED", { subject: { kind: "system" } }))), UNKNOWN);
  assert.deepEqual(decode(ok(denyWire("relation \"x\" does not exist"))), UNKNOWN);
  assert.deepEqual(decode(ok(denyWire("ACCOUNT_LOCKED", { subject: { kind: "user", user_id: OTHER } }))), UNKNOWN);
});

test("HTTP: 401/403 deny; 404, 5xx, 3xx, 400 unknown (G5-02 §3.8)", () => {
  for (const status of [401, 403]) assert.equal(decode({ status, body: { message: "JWT expired" } }).decision, "deny");
  for (const status of [404, 500, 502, 302, 400, 204]) assert.deepEqual(decode({ status, body: allowWire() }), UNKNOWN, String(status));
});

// ---- the port -----------------------------------------------------------------------------------------------------------

function r1(answers: Array<R1TransportResult | Error | "hang">) {
  const asked: R1Question[] = [];
  const tokens: string[] = [];
  const transport: R1Transport = (question, token) => {
    asked.push(question);
    tokens.push(token);
    const a = answers.shift() ?? new Error("no answer");
    if (a === "hang") return new Promise<never>(() => {});
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
  };
  return { transport, asked, tokens };
}

test("port: begin never asks R1 (it needs the workspace begin creates) and answers unknown", async () => {
  const f = r1([ok(allowWire())]);
  const port = createXConnectR1AuthorizationPort({ transport: f.transport });
  assert.deepEqual(await port({ phase: "begin", userId: USER, userAccessToken: "jwt", brandId: null }), { decision: "unknown", subjectUserId: null, brandId: null, ownerEpoch: null });
  assert.deepEqual(f.asked, []);
});

test("port: pre-exchange asks R1 once per call with the exact question and the caller's own token; bad inputs ask nothing", async () => {
  const f = r1([ok(allowWire()), ok(allowWire())]);
  const port = createXConnectR1AuthorizationPort({ transport: f.transport });
  const req = { phase: "pre_exchange" as const, userId: USER, userAccessToken: "user-jwt", brandId: BRAND };
  assert.equal(((await port(req)) as { decision: string }).decision, "allow");
  assert.equal(((await port(req)) as { decision: string }).decision, "allow");
  assert.deepEqual(f.asked, [{ p_app: "postona", p_feature: "x_connect", p_brand_id: BRAND }, { p_app: "postona", p_feature: "x_connect", p_brand_id: BRAND }]);
  assert.deepEqual(f.tokens, ["user-jwt", "user-jwt"]);
  for (const bad of [{ ...req, brandId: "U_BAD" }, { ...req, brandId: "" }, { ...req, userId: "not-a-uuid" }]) {
    assert.equal(((await port(bad)) as { decision: string }).decision, "unknown");
  }
  assert.equal(f.asked.length, 2);
});

test("port: a failing or slow R1 throws (upstream: unavailable), never answers allow", async () => {
  const failing = createXConnectR1AuthorizationPort({ transport: r1([new Error("connect ECONNREFUSED")]).transport });
  await assert.rejects(failing({ phase: "pre_exchange", userId: USER, userAccessToken: "jwt", brandId: BRAND }));
  const slow = createXConnectR1AuthorizationPort({ transport: r1(["hang"]).transport, timeoutMs: 20 });
  await assert.rejects(slow({ phase: "pre_exchange", userId: USER, userAccessToken: "jwt", brandId: BRAND }));
});

// ---- the flow through the adapter (fake R1, fake Supabase, fake X) -------------------------------------------------------

function backend() {
  const calls: string[] = [];
  const fetchImpl = (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes("begin_social_mobile_x_oauth_connection")) return (calls.push("begin"), Promise.resolve(Response.json([{ brand_id: BRAND, social_account_id: "sa_x" }])));
    if (url.includes("consume_social_mobile_x_oauth_state")) {
      calls.push("consume");
      return Promise.resolve(Response.json([{ oauth_state_id: "state-1", redirect_uri: REDIRECT, brand_id: BRAND, social_account_id: "sa_x" }]));
    }
    if (url === "https://api.x.com/2/oauth2/token") return (calls.push("x-token"), Promise.resolve(Response.json({ access_token: "a", refresh_token: "r" })));
    if (url === "https://api.x.com/2/users/me") return (calls.push("x-identity"), Promise.resolve(Response.json({ data: { id: "12345", username: "postona_tester" } })));
    if (url.includes("complete_social_mobile_x_oauth_connection")) return (calls.push("complete"), Promise.resolve(new Response(null, { status: 204 })));
    return Promise.reject(new Error(`unexpected ${url}`));
  };
  return { fetchImpl: fetchImpl as typeof fetch, calls };
}
const common = { userAccessToken: "user-jwt", supabaseUrl: "https://example.supabase.co", anonKey: "anon", clientId: "cid", clientSecret: "secret" };
const callback = (port: ReturnType<typeof createXConnectR1AuthorizationPort>, b: ReturnType<typeof backend>, redirectUri = REDIRECT) =>
  completeConnection({
    ...common,
    request: { code: "auth-code", state: "raw-state-value-0123456789abcdef", codeVerifier: "v", redirectUri },
    userId: USER,
    authorization: port,
    fetchImpl: b.fetchImpl,
  });
const rejectsWith = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => e instanceof OAuthConnectUserError && e.message === code);

test("flow, success path (fake X): one fresh R1 allow right before one exchange", async () => {
  const f = r1([ok(allowWire())]);
  const b = backend();
  const result = await callback(createXConnectR1AuthorizationPort({ transport: f.transport }), b);
  assert.equal(result.connectionStatus, "identity_verified");
  assert.deepEqual(b.calls, ["consume", "x-token", "x-identity", "complete"]);
  assert.equal(f.asked.length, 1);
});

test("flow, every refusal: the X exchange count stays 0", async () => {
  const cases: [R1TransportResult | Error | "hang", string][] = [
    [ok(denyWire("ACCOUNT_DELETION_IN_PROGRESS")), "X_CONNECT_NOT_AUTHORIZED"],
    [ok(denyWire("SESSION_EXPIRED")), "X_CONNECT_NOT_AUTHORIZED"], // the person's authorization has expired
    [{ status: 401, body: {} }, "X_CONNECT_NOT_AUTHORIZED"],
    [ok(allowWire({ decision: "unknown", reason: "OWNER_EPOCH_UNAVAILABLE", session: null, owner_epoch: null, entitlements: [] })), "X_CONNECT_AUTHORIZATION_UNKNOWN"],
    [ok(allowWire({ subject: { kind: "user", user_id: OTHER } })), "X_CONNECT_AUTHORIZATION_UNKNOWN"], // wrong actor
    [ok(allowWire({ scope: { app: "postona", feature: "x_connect", brand_slug: "u_other" } })), "X_CONNECT_AUTHORIZATION_UNKNOWN"], // wrong brand
    [ok(allowWire({ owner_epoch: null })), "X_CONNECT_AUTHORIZATION_UNKNOWN"], // missing epoch
    [ok(allowWire({ owner_epoch: "g5oe:99999999999999999999:1" })), "X_CONNECT_AUTHORIZATION_UNKNOWN"], // huge epoch
    [ok(allowWire({ owner_epoch: 7 })), "X_CONNECT_AUTHORIZATION_UNKNOWN"], // a number: never rounded
    [{ status: 404, body: { message: "Could not find the function public.common_account_authorization_verdict" } }, "X_CONNECT_AUTHORIZATION_UNKNOWN"],
    [{ status: 500, body: { message: "permission denied for table brand_memberships" } }, "X_CONNECT_AUTHORIZATION_UNKNOWN"], // raw SQL error
    [new Error("ECONNRESET"), "X_CONNECT_AUTHORIZATION_UNAVAILABLE"],
    ["hang", "X_CONNECT_AUTHORIZATION_UNAVAILABLE"], // timeout
  ];
  for (const [answer, code] of cases) {
    const b = backend();
    await rejectsWith(callback(createXConnectR1AuthorizationPort({ transport: r1([answer]).transport, timeoutMs: 20 }), b), code);
    assert.deepEqual(b.calls, ["consume"], code);
  }
});

test("flow, replay: a second callback asks R1 again; once R1 denies, nothing is exchanged", async () => {
  const f = r1([ok(allowWire()), ok(denyWire("SERVICE_NOT_ACTIVE"))]);
  const port = createXConnectR1AuthorizationPort({ transport: f.transport });
  await callback(port, backend());
  const b = backend();
  await rejectsWith(callback(port, b), "X_CONNECT_NOT_AUTHORIZED");
  assert.deepEqual(b.calls, ["consume"]);
  assert.equal(f.asked.length, 2);
});

test("flow, unsafe redirect: refused before R1 and before any RPC", async () => {
  const f = r1([ok(allowWire())]);
  const b = backend();
  await rejectsWith(callback(createXConnectR1AuthorizationPort({ transport: f.transport }), b, "https://evil.example/cb"), "OAUTH_REDIRECT_URI_NOT_ALLOWED");
  assert.deepEqual(b.calls, []);
  assert.deepEqual(f.asked, []);
});

test("flow, begin through this adapter is refused (G5 gap): begin RPC 0, R1 0", async () => {
  const f = r1([ok(allowWire())]);
  const b = backend();
  await rejectsWith(
    startConnection({
      ...common,
      request: { rawState: "raw-state-value-0123456789abcdef", codeChallenge: "c", redirectUri: REDIRECT },
      userId: USER,
      authorization: createXConnectR1AuthorizationPort({ transport: f.transport }),
      fetchImpl: b.fetchImpl,
    }),
    "X_CONNECT_AUTHORIZATION_UNKNOWN",
  );
  assert.deepEqual(b.calls, []);
  assert.deepEqual(f.asked, []);
});

test("isolation: the adapter imports only G4-05's types; nothing but its test imports it", async () => {
  const source = await Deno.readTextFile(new URL("./r1_authorization.ts", import.meta.url));
  assert.deepEqual([...source.matchAll(/from "([^"]+)"/gu)].map((m) => m[1]), ["./oauth_logic.ts"]);
  assert.match(source, /^import type \{ XConnectAuthorizationPort, XConnectAuthorizationRequest \} from "\.\/oauth_logic\.ts";$/mu);
  assert.equal(/\b(fetch\(|Deno\.|console\.)/u.test(source.replace(/^\s*\/\/.*$/gmu, "")), false);
  const importers: string[] = [];
  for await (const entry of Deno.readDir(new URL("./", import.meta.url))) {
    if (entry.isFile && entry.name.endsWith(".ts") && /(?:from|import\()\s*["']\.\/r1_authorization\.ts["']/u.test(await Deno.readTextFile(new URL(entry.name, import.meta.url)))) {
      importers.push(entry.name);
    }
  }
  assert.deepEqual(importers, ["r1_authorization_test.ts"]);
});
