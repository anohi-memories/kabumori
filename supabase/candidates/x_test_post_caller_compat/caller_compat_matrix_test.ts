// x-test-post caller compatibility matrix (G3 Issue #318 TASK 5/50). DENY-NET / MOCK_ONLY, run by caller_compat_run.sh
// once per handler version: XTP_INDEX = a copy of index.ts at main (before) or at PR #349 (after), XTP_VERSION = main |
// pr349. The REAL handler is captured by stubbing Deno.serve; every outbound request is recorded as host+path only and
// refused (Auth / admin lookups get scripted fake answers). Env values are fake strings. No database, OpenAI, X,
// Storage or Auth is reached. Each cell is also checked against rollout_model.ts, so the model the rollout plan relies on
// is the handler's real behaviour.
import assert from "node:assert/strict";
import { type CronProfile, dispatchRuns } from "./rollout_model.ts";

const INDEX = Deno.env.get("XTP_INDEX")!;
const VERSION = Deno.env.get("XTP_VERSION") as "main" | "pr349";
assert.ok(INDEX && (VERSION === "main" || VERSION === "pr349"), "set by caller_compat_run.sh");

const FAKE = {
  SUPABASE_URL: "https://project.example.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "eyJfake.legacy-service-role-jwt.0123456789",
  SUPABASE_ANON_KEY: "eyJfake.anon-jwt.0123456789",
  OPENAI_API_KEY: "fake-openai-key-0123456789",
  X_TEST_POST_CRON_SECRET: "fake-cron-secret-0123456789",
  X_OAUTH2_ACCESS_TOKEN: "fake-x-access", X_OAUTH2_REFRESH_TOKEN: "fake-x-refresh", X_CLIENT_ID: "fake-x-client", X_CLIENT_SECRET: "fake-x-client-secret",
};
const NEW_SECRET_KEY = "sb_secret_fake0123456789";
for (const [k, v] of Object.entries(FAKE)) Deno.env.set(k, v);

type AuthScript = "none" | "admin" | "user" | "expired";
let authScript: AuthScript = "none";
const outbound: string[] = [];
globalThis.fetch = ((input: string | URL | Request) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  outbound.push(`${url.host}${url.pathname}`);
  if (url.pathname === "/auth/v1/user") {
    if (authScript === "admin" || authScript === "user") return Promise.resolve(Response.json({ id: "11111111-1111-4111-8111-111111111111" }));
    if (authScript === "expired") return Promise.resolve(Response.json({ msg: "JWT expired" }, { status: 401 }));
  }
  if (url.pathname === "/rest/v1/admin_users" && authScript === "admin") return Promise.resolve(Response.json([{ user_id: "11111111-1111-4111-8111-111111111111" }]));
  if (url.pathname === "/rest/v1/admin_users") return Promise.resolve(Response.json([]));
  return Promise.reject(new TypeError("DENY_NET"));
}) as typeof fetch;

let handler: ((req: Request) => Promise<Response>) | null = null;
(Deno as unknown as { serve: unknown }).serve = (h: (req: Request) => Promise<Response>) => {
  handler = h;
  return { finished: Promise.resolve(), shutdown: () => Promise.resolve(), ref() {}, unref() {}, addr: { hostname: "x", port: 0, transport: "tcp" } };
};
await import(new URL(`file://${INDEX}`).href);
assert.ok(handler, "the handler registered");

const SIDE_EFFECT = (o: string) => o.includes("/rest/v1/") && !o.endsWith("/admin_users") || o.includes("openai") || o.includes("/storage/v1/") || o.includes("x.com") || o.includes("twitter");
async function call(body: unknown, headers: Record<string, string>, script: AuthScript = "none") {
  authScript = script;
  outbound.length = 0;
  const res = await handler!(new Request("https://fn.example/x-test-post", { method: "POST", headers: { "content-type": "application/json", "user-agent": "pg_net/0.20.4", ...headers }, body: JSON.stringify(body) }));
  return { status: res.status, sideEffects: outbound.filter(SIDE_EFFECT), outbound: [...outbound] };
}

const CRON_PROFILES: Record<Exclude<CronProfile, "unknown">, Record<string, string>> = {
  service_role_bearer: { Authorization: `Bearer ${FAKE.SUPABASE_SERVICE_ROLE_KEY}` },
  x_cron_secret: { "X-Cron-Secret": FAKE.X_TEST_POST_CRON_SECRET },
  anon_bearer: { Authorization: `Bearer ${FAKE.SUPABASE_ANON_KEY}`, apikey: FAKE.SUPABASE_ANON_KEY },
  new_secret_key_bearer: { Authorization: `Bearer ${NEW_SECRET_KEY}`, apikey: NEW_SECRET_KEY },
  apikey_only: { apikey: FAKE.SUPABASE_SERVICE_ROLE_KEY },
  no_auth: {},
};
const matrix: Record<string, unknown>[] = [];

Deno.test(`[${VERSION}] Cron profiles x the scheduled dispatch: the real handler matches the rollout model`, async () => {
  for (const [profile, headers] of Object.entries(CRON_PROFILES) as [Exclude<CronProfile, "unknown">, Record<string, string>][]) {
    const r = await call({}, headers);
    const reached = r.outbound.some((o) => o.endsWith("/rest/v1/rpc/claim_due_post") || o.endsWith("/rest/v1/scheduled_posts"));
    matrix.push({ version: VERSION, caller: `cron:${profile}`, mode: "(dispatch)", status: r.status, reachedDispatch: reached });
    const expected = dispatchRuns(VERSION, profile, { cronSecretSet: true, serviceRoleKeySet: true });
    assert.equal(reached, expected === true, `${profile}: ${JSON.stringify(r)}`);
    if (expected !== true) assert.deepEqual([r.status, r.sideEffects], [401, []], profile);
  }
});

Deno.test(`[${VERSION}] Function configuration missing: the model and the handler agree (fail closed after PR #349)`, async () => {
  for (const [unset, profile] of [["X_TEST_POST_CRON_SECRET", "x_cron_secret"], ["SUPABASE_SERVICE_ROLE_KEY", "service_role_bearer"]] as const) {
    const saved = Deno.env.get(unset)!;
    Deno.env.delete(unset);
    try {
      const r = await call({}, CRON_PROFILES[profile]);
      const reached = r.outbound.some((o) => o.includes("/rest/v1/"));
      const expected = dispatchRuns(VERSION, profile, { cronSecretSet: unset !== "X_TEST_POST_CRON_SECRET", serviceRoleKeySet: unset !== "SUPABASE_SERVICE_ROLE_KEY" });
      matrix.push({ version: VERSION, caller: `cron:${profile} (${unset} unset)`, mode: "(dispatch)", status: r.status, reachedDispatch: reached });
      if (VERSION === "pr349") assert.deepEqual([expected, r.status, r.sideEffects], [false, 401, []], `${unset}: ${JSON.stringify(r)}`);
      else assert.equal(expected, true);
    } finally {
      Deno.env.set(unset, saved);
    }
  }
});

const PREVIEW_MODES = ["useful_tip_dry_run", "kabumori_voice_dry_run", "morning_report_dry_run", "close_report_dry_run", "us_premarket_report_dry_run",
  "test_morning_greeting_image", "test_morning_greeting_payload"];
const HUMANS: [string, Record<string, string>, AuthScript][] = [
  ["unauthenticated", {}, "none"],
  ["admin (valid JWT)", { Authorization: "Bearer fake-admin-user-jwt-0123456789" }, "admin"],
  ["signed-in non-admin", { Authorization: "Bearer fake-user-jwt-0123456789" }, "user"],
  ["expired JWT", { Authorization: "Bearer fake-expired-jwt-0123456789" }, "expired"],
  ["internal (cron secret)", { "X-Cron-Secret": FAKE.X_TEST_POST_CRON_SECRET }, "none"],
  ["internal (service-role bearer)", { Authorization: `Bearer ${FAKE.SUPABASE_SERVICE_ROLE_KEY}` }, "none"],
];

Deno.test(`[${VERSION}] dry-run / test modes x human and internal callers`, async () => {
  for (const mode of PREVIEW_MODES) {
    for (const [label, headers, script] of HUMANS) {
      const r = await call({ mode, titles: ["x"], post_type: "useful_tip" }, headers, script);
      const passed = r.status !== 401;
      matrix.push({ version: VERSION, caller: label, mode, status: r.status, passedGate: passed });
      const allowedAfter = label.startsWith("admin") || label.startsWith("internal");
      if (VERSION === "pr349") {
        assert.equal(passed, allowedAfter, `${mode} / ${label}: ${JSON.stringify(r)}`);
        if (!allowedAfter) assert.deepEqual(r.sideEffects, [], `${mode} / ${label}: no side effect before refusal`);
      } else {
        assert.equal(passed, true, `${mode} / ${label}: main has no gate`);
      }
    }
  }
});

Deno.test(`[${VERSION}] human callers x the scheduled dispatch: after PR #349 only internal credentials run it (an admin never does)`, async () => {
  for (const [label, headers, script] of HUMANS) {
    const r = await call({}, headers, script);
    const reached = r.outbound.some((o) => o.endsWith("/rest/v1/rpc/claim_due_post") || o.endsWith("/rest/v1/scheduled_posts"));
    matrix.push({ version: VERSION, caller: label, mode: "(dispatch)", status: r.status, reachedDispatch: reached });
    if (VERSION === "pr349") {
      assert.equal(reached, label.startsWith("internal"), `${label}: ${JSON.stringify(r)}`);
      if (!label.startsWith("internal")) assert.deepEqual([r.status, r.sideEffects], [401, []], label);
    } else {
      assert.equal(reached, true, `${label}: main has no gate`);
    }
  }
});

Deno.test(`[${VERSION}] manual publish x callers: unchanged admin-only contract in both versions`, async () => {
  for (const [label, headers, script] of HUMANS) {
    const r = await call({ mode: "publish_morning_greeting_manual" }, headers, script);
    matrix.push({ version: VERSION, caller: label, mode: "publish_morning_greeting_manual", status: r.status });
    if (label.startsWith("admin")) assert.notEqual(r.status, 403, label);
    else assert.equal(r.status, 403, `${label}: ${JSON.stringify(r)}`);
  }
  const out = Deno.env.get("XTP_MATRIX_OUT");
  if (out) await Deno.writeTextFile(out, JSON.stringify(matrix, null, 1));
});
