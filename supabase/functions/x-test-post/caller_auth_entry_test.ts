// Entry-level proof for the x-test-post caller gate (G3 Issue #318 TASK 4/50). DENY-NET / MOCK_ONLY:
// the REAL index.ts handler is captured by stubbing Deno.serve before a dynamic import; every outbound fetch is
// recorded (host + path only, never headers or bodies) and refused. Env values are fake test strings. No database,
// OpenAI, X, Storage or Auth is reached. Run: deno test --no-config --no-check --allow-read --allow-env <this file>
// (--no-check: index.ts carries pre-existing type errors unrelated to this gate).
import assert from "node:assert/strict";

const outbound: string[] = [];
globalThis.fetch = ((input: string | URL | Request) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  outbound.push(`${url.host}${url.pathname}`);
  return Promise.reject(new TypeError("DENY_NET"));
}) as typeof fetch;

const FAKE = {
  SUPABASE_URL: "https://project.example.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key-0123456789",
  SUPABASE_ANON_KEY: "fake-anon-key-0123456789",
  OPENAI_API_KEY: "fake-openai-key-0123456789",
  X_TEST_POST_CRON_SECRET: "fake-cron-secret-0123456789",
  X_OAUTH2_ACCESS_TOKEN: "fake-x-access",
  X_OAUTH2_REFRESH_TOKEN: "fake-x-refresh",
  X_CLIENT_ID: "fake-x-client",
  X_CLIENT_SECRET: "fake-x-client-secret",
};
for (const [k, v] of Object.entries(FAKE)) Deno.env.set(k, v);

let handler: ((req: Request) => Promise<Response>) | null = null;
(Deno as unknown as { serve: unknown }).serve = (h: (req: Request) => Promise<Response>) => {
  handler = h;
  return { finished: Promise.resolve(), shutdown: () => Promise.resolve(), ref() {}, unref() {}, addr: { hostname: "x", port: 0, transport: "tcp" } };
};
await import("./index.ts");
assert.ok(handler, "index.ts registered its handler");
const call = async (body: unknown, headers: Record<string, string> = {}) => {
  outbound.length = 0;
  const res = await handler!(new Request("https://fn.example/x-test-post", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json().catch(() => null), outbound: [...outbound] };
};

const PREVIEW_MODES = ["useful_tip_dry_run", "kabumori_voice_dry_run", "morning_report_dry_run", "close_report_dry_run", "us_premarket_report_dry_run",
  "test_morning_greeting_image", "test_morning_greeting_payload"];
const DISPATCH_BODIES: unknown[] = [{}, { mode: "dispatch" }, { mode: "" }, { mode: null }, { mode: 1 }, { post_type: "morning_report" }];
const BAD_CALLERS: [string, Record<string, string>][] = [
  ["no credentials", {}],
  ["anon key as bearer", { Authorization: `Bearer ${FAKE.SUPABASE_ANON_KEY}` }],
  ["forged bearer", { Authorization: "Bearer eyJhbGciOiJub25lIn0.eyJyb2xlIjoic2VydmljZV9yb2xlIn0." }],
  ["wrong cron secret", { "X-Cron-Secret": "fake-cron-secret-WRONG" }],
  ["cron secret in Authorization", { Authorization: `Bearer ${FAKE.X_TEST_POST_CRON_SECRET}` }],
  ["service role in X-Cron-Secret", { "X-Cron-Secret": FAKE.SUPABASE_SERVICE_ROLE_KEY }],
  ["service role with a suffix", { Authorization: `Bearer ${FAKE.SUPABASE_SERVICE_ROLE_KEY}x` }],
  ["spoofed role header", { "x-role": "service_role", "x-client-info": "pg_net" }],
];

Deno.test("A1 scheduled dispatch (no / unknown mode): every unauthenticated or spoofed caller is refused with 401 BEFORE any outbound call", async () => {
  for (const body of DISPATCH_BODIES) {
    for (const [label, headers] of BAD_CALLERS) {
      const r = await call(body, headers);
      assert.deepEqual([r.status, r.outbound], [401, []], `${JSON.stringify(body)} / ${label}: ${JSON.stringify(r)}`);
      assert.equal((r.body as { error?: string } | null)?.error, "X_TEST_POST_CALLER_UNAUTHORIZED");
    }
  }
});

Deno.test("A2 dry-run / test modes (OpenAI text + image, Storage): unauthenticated, forged or non-admin callers are refused BEFORE any outbound call except the admin lookup", async () => {
  for (const mode of PREVIEW_MODES) {
    for (const [label, headers] of BAD_CALLERS) {
      const r = await call({ mode, titles: ["x"], post_type: "useful_tip" }, headers);
      assert.equal(r.status, 401, `${mode} / ${label}: ${JSON.stringify(r)}`);
      // Only the existing admin port may be asked (Auth /auth/v1/user); never OpenAI, REST RPC, Storage or X.
      assert.ok(r.outbound.every((o) => o === "project.example.invalid/auth/v1/user"), `${mode} / ${label}: ${r.outbound.join(",")}`);
    }
  }
});

Deno.test("A3 internal callers pass the gate (cron secret header, or the exact service-role bearer): the dispatch proceeds to its first database call", async () => {
  for (const headers of [{ "X-Cron-Secret": FAKE.X_TEST_POST_CRON_SECRET }, { Authorization: `Bearer ${FAKE.SUPABASE_SERVICE_ROLE_KEY}` }]) {
    const r = await call({}, headers);
    assert.notEqual(r.status, 401, JSON.stringify(r));
    assert.ok(r.outbound.some((o) => o.startsWith("project.example.invalid/rest/v1/")), `reached the store: ${r.outbound.join(",")}`);
  }
});

Deno.test("A4 manual publish keeps its existing admin check and response contract (403, x_api_called 0, nothing but the admin lookup)", async () => {
  const r = await call({ mode: "publish_morning_greeting_manual" }, {});
  assert.equal(r.status, 403);
  assert.equal((r.body as { error?: string }).error, "MORNING_GREETING_MANUAL_PUBLISH_UNAUTHORIZED");
  assert.ok(r.outbound.every((o) => o === "project.example.invalid/auth/v1/user"));
});

Deno.test("A5 the cron secret unset: only the exact service-role bearer is internal; nothing else passes", async () => {
  Deno.env.delete("X_TEST_POST_CRON_SECRET");
  try {
    assert.deepEqual([(await call({}, { "X-Cron-Secret": FAKE.X_TEST_POST_CRON_SECRET })).status, (await call({}, { "X-Cron-Secret": "" })).status], [401, 401]);
    assert.notEqual((await call({}, { Authorization: `Bearer ${FAKE.SUPABASE_SERVICE_ROLE_KEY}` })).status, 401);
  } finally {
    Deno.env.set("X_TEST_POST_CRON_SECRET", FAKE.X_TEST_POST_CRON_SECRET);
  }
});

Deno.test("A6 GET is still 405 before anything", async () => {
  outbound.length = 0;
  const res = await handler!(new Request("https://fn.example/x-test-post", { method: "GET" }));
  assert.deepEqual([res.status, outbound.length], [405, 0]);
});

Deno.test("A7 dry-run modes still work for a verified admin (fake Auth + admin_users answer); a signed-in NON-admin is refused; the scheduled dispatch never accepts an admin", async () => {
  const realFetch = globalThis.fetch;
  const fakeAuth = (admin: boolean) => ((input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    outbound.push(`${url.host}${url.pathname}`);
    if (url.pathname === "/auth/v1/user") return Promise.resolve(Response.json({ id: "11111111-1111-4111-8111-111111111111" }));
    if (url.pathname === "/rest/v1/admin_users") return Promise.resolve(Response.json(admin ? [{ user_id: "11111111-1111-4111-8111-111111111111" }] : []));
    return Promise.reject(new TypeError("DENY_NET"));
  }) as typeof fetch;
  const userToken = { Authorization: "Bearer fake-user-access-token-0123456789" };
  try {
    globalThis.fetch = fakeAuth(true);
    const admin = await call({ mode: "useful_tip_dry_run", titles: ["x"] }, userToken);
    assert.notEqual(admin.status, 401, JSON.stringify(admin));
    assert.ok(admin.outbound.some((o) => o === "project.example.invalid/rest/v1/useful_tips"), `admin reached the preview: ${admin.outbound.join(",")}`);
    const dispatch = await call({}, userToken);
    assert.deepEqual([dispatch.status, dispatch.outbound.filter((o) => o.includes("/rest/v1/") && !o.endsWith("/admin_users"))], [401, []], "an admin never runs the scheduled dispatch");
    globalThis.fetch = fakeAuth(false);
    const user = await call({ mode: "useful_tip_dry_run", titles: ["x"] }, userToken);
    assert.equal(user.status, 401);
    assert.ok(user.outbound.every((o) => o.endsWith("/auth/v1/user") || o.endsWith("/rest/v1/admin_users")), user.outbound.join(","));
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("A8 the gate's restated mode names equal the handler's constants, and the handler branches on exactly those modes", async () => {
  const gate = await import("./caller_auth_logic.ts");
  const image = await import("./morning_greeting_image_logic.ts");
  const payload = await import("./morning_greeting_payload_logic.ts");
  const manual = await import("./morning_greeting_publish_logic.ts");
  assert.deepEqual([gate.GATE_MORNING_GREETING_IMAGE_TEST_MODE, gate.GATE_MORNING_GREETING_PAYLOAD_TEST_MODE, gate.GATE_MORNING_GREETING_MANUAL_PUBLISH_MODE],
    [image.MORNING_GREETING_IMAGE_TEST_MODE, payload.MORNING_GREETING_PAYLOAD_TEST_MODE, manual.MORNING_GREETING_MANUAL_PUBLISH_MODE]);
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const literalModes = [...source.matchAll(/requestBody\.mode === "([a-z_]+)"/gu)].map((m) => m[1]).sort();
  const constModes = [...source.matchAll(/requestBody\.mode === (MORNING_GREETING_[A-Z_]+_MODE)/gu)].map((m) => m[1]).sort();
  assert.deepEqual(literalModes, [...gate.X_TEST_POST_PREVIEW_MODES].filter((m) => !m.startsWith("test_morning_greeting")).sort(), "every literal mode is a gated preview mode");
  assert.deepEqual(constModes, ["MORNING_GREETING_IMAGE_TEST_MODE", "MORNING_GREETING_MANUAL_PUBLISH_MODE", "MORNING_GREETING_PAYLOAD_TEST_MODE"]);
  // The gate runs before the first mode branch and before any secret is read.
  const gateAt = source.indexOf("await authorizeXTestPostCaller(");
  assert.ok(gateAt > 0 && gateAt < source.indexOf("const isUsefulTipDryRun") && gateAt < source.indexOf('Deno.env.get("OPENAI_API_KEY")'));
});

Deno.test("A9 the admin port is closed when its configuration is missing (no anon key): previews are refused, nothing is called", async () => {
  Deno.env.delete("SUPABASE_ANON_KEY");
  try {
    const r = await call({ mode: "useful_tip_dry_run", titles: ["x"] }, { Authorization: "Bearer fake-user-access-token-0123456789" });
    assert.deepEqual([r.status, r.outbound], [401, []]);
  } finally {
    Deno.env.set("SUPABASE_ANON_KEY", FAKE.SUPABASE_ANON_KEY);
  }
});
