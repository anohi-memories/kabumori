// かぶモリ休止（F2 2026-10-16, J2-R2）: 生成だけの入口の、呼び出し元の確認と停止の判定を、本物の x-test-post の
// handler で確かめる。サーバーは起動しない（Deno.serve を差し替えて handler を受け取る）。環境変数はメモリ上の偽物、
// 通信はすべて偽物の router（実 HTTP・DB・AI・X・課金なし）。
//   deno test --no-config --no-check --deny-net --deny-env --deny-write --deny-run --allow-read supabase/functions/x-test-post/kabumori_pause_ingress_test.ts
import assert from "node:assert/strict";
import test from "node:test";

const SUPA = "https://project-ref.supabase.co";
const FAKE_ENV = new Map<string, string>([
  ["OPENAI_API_KEY", "openai-NOT-REAL"],
  ["SUPABASE_URL", SUPA],
  ["SUPABASE_SERVICE_ROLE_KEY", "service-NOT-REAL"],
  ["SUPABASE_ANON_KEY", "anon-NOT-REAL"],
  ["X_OAUTH2_ACCESS_TOKEN", "x-NOT-REAL"],
  ["X_OAUTH2_REFRESH_TOKEN", "x-refresh-NOT-REAL"],
  ["X_CLIENT_ID", "x-client-NOT-REAL"],
  ["X_CLIENT_SECRET", "x-secret-NOT-REAL"],
]);
// The environment is an in-memory map: the real process environment is never read (the run denies env access).
const env = Deno.env as unknown as Record<string, unknown>;
env.get = (name: string) => FAKE_ENV.get(name);
env.has = (name: string) => FAKE_ENV.has(name);
env.toObject = () => Object.fromEntries(FAKE_ENV);

let handler: ((req: Request) => Promise<Response>) | null = null;
(Deno as unknown as { serve: unknown }).serve = (fn: (req: Request) => Promise<Response>) => {
  handler = fn;
  return { finished: Promise.resolve(), shutdown: () => Promise.resolve(), ref() {}, unref() {}, addr: { hostname: "fake", port: 0 } };
};

// ---- the fake world ---------------------------------------------------------------------------------------------------

type World = { publishMode: "live" | "dry_run" | "disabled"; isActive: boolean; brandRead: "ok" | "error" };
const counts = { auth: 0, adminLookup: 0, brandRead: 0, ai: 0, x: 0, storageWrite: 0, restWrite: 0, rpc: 0 };
let world: World = { publishMode: "live", isActive: true, brandRead: "ok" };

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const auth = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("Authorization") ?? "";
  if (url.startsWith("https://api.openai.com/")) {
    counts.ai += 1;
    return Promise.resolve(json({ output: [{ content: [{ type: "output_text", text: "{}" }] }], usage: { input_tokens: 1, output_tokens: 1 } }));
  }
  if (url.startsWith("https://api.x.com/") || url.startsWith("https://api.twitter.com/")) {
    counts.x += 1;
    return Promise.resolve(json({ data: { id: "1" } }));
  }
  if (!url.startsWith(SUPA)) return Promise.reject(new Error(`UNEXPECTED_HOST:${url}`));
  const path = url.slice(SUPA.length);
  if (path.startsWith("/auth/v1/user")) {
    counts.auth += 1;
    if (auth === "Bearer admin-token") return Promise.resolve(json({ id: "admin-user" }));
    if (auth === "Bearer user-token") return Promise.resolve(json({ id: "plain-user" }));
    return Promise.resolve(json({ msg: "invalid JWT" }, 401));
  }
  if (path.startsWith("/rest/v1/admin_users")) {
    counts.adminLookup += 1;
    return Promise.resolve(json(path.includes("eq.admin-user") ? [{ user_id: "admin-user" }] : []));
  }
  if (path.startsWith("/rest/v1/brands")) {
    counts.brandRead += 1;
    if (world.brandRead === "error") return Promise.resolve(json({ message: "boom" }, 503));
    return Promise.resolve(json([{ id: "kabumori", display_name: "かぶモリ", is_active: world.isActive, publish_mode: world.publishMode, code_profile_key: "kabumori_v1" }]));
  }
  if (path.startsWith("/rest/v1/social_accounts")) return Promise.resolve(json([]));
  if (path.startsWith("/rest/v1/brand_settings")) {
    return Promise.resolve(json([{ brand_id: "kabumori", fixed_hashtags: [], note_url: null, image_policy: {}, enabled_post_types: [] }]));
  }
  if (path.startsWith("/storage/v1/")) {
    if (method !== "GET" && method !== "HEAD") counts.storageWrite += 1;
    return Promise.resolve(json({ message: "Object not found" }, 400));
  }
  if (path.startsWith("/rest/v1/rpc/")) {
    counts.rpc += 1;
    return Promise.resolve(json([]));
  }
  if (path.startsWith("/rest/v1/tips")) {
    return Promise.resolve(json([{ id: "t1", title: "合成の豆知識", category: "basics", base_text: "合成", image_url: null, last_used_at: null, use_count: 0, difficulty: "初級" }]));
  }
  if (path.startsWith("/rest/v1/")) {
    if (method !== "GET" && method !== "HEAD") counts.restWrite += 1;
    return Promise.resolve(json([]));
  }
  return Promise.reject(new Error(`UNEXPECTED_PATH:${path}`));
};

await import("./index.ts");

function reset(next: Partial<World> = {}) {
  for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] = 0;
  world = { publishMode: "live", isActive: true, brandRead: "ok", ...next };
}

async function call(body: Record<string, unknown>, authorization?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  assert.ok(handler, "x-test-post registered its handler");
  const res = await handler!(new Request("https://functions.local/x-test-post", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
}

const MODES = [
  "useful_tip_dry_run", "kabumori_voice_dry_run", "morning_report_dry_run", "close_report_dry_run",
  "us_premarket_report_dry_run", "test_morning_greeting_image", "test_morning_greeting_payload",
];
const zeroEffects = () => ({ ai: counts.ai, x: counts.x, storageWrite: counts.storageWrite, restWrite: counts.restWrite, rpc: counts.rpc });
const ZERO = { ai: 0, x: 0, storageWrite: 0, restWrite: 0, rpc: 0 };

// ---- caller authentication ------------------------------------------------------------------------------------------

test("no credential: every generation-only mode is 401 before the brand is read; model 0, storage write 0, DB write 0, X 0", async () => {
  for (const mode of MODES) {
    reset();
    const res = await call({ mode, post_type: "tip", titles: ["合成の豆知識"] });
    assert.equal(res.status, 401, mode);
    assert.equal(res.body.error, "GENERATION_INGRESS_UNAUTHORIZED", mode);
    assert.deepEqual(zeroEffects(), ZERO, mode);
    assert.equal(counts.brandRead, 0, `${mode}: the brand is not even read`);
  }
});

test("invalid token, a non-admin user, and a missing anon key are all 401 with no effect", async () => {
  reset();
  assert.equal((await call({ mode: "kabumori_voice_dry_run", post_type: "tip" }, "Bearer forged-token")).status, 401);
  assert.deepEqual([counts.auth, counts.adminLookup], [1, 0], "Auth rejected the token; admin_users not consulted");
  assert.deepEqual(zeroEffects(), ZERO);

  reset();
  assert.equal((await call({ mode: "kabumori_voice_dry_run", post_type: "tip" }, "Bearer user-token")).status, 401);
  assert.deepEqual([counts.auth, counts.adminLookup], [1, 1], "a real user who is not an admin");
  assert.deepEqual(zeroEffects(), ZERO);

  reset();
  assert.equal((await call({ mode: "kabumori_voice_dry_run", post_type: "tip" }, "Basic admin-token")).status, 401, "not a bearer token");
  assert.deepEqual(zeroEffects(), ZERO);

  reset();
  FAKE_ENV.delete("SUPABASE_ANON_KEY");
  try {
    assert.equal((await call({ mode: "kabumori_voice_dry_run", post_type: "tip" }, "Bearer admin-token")).status, 401, "fail closed without the anon key");
    assert.deepEqual([counts.auth, ...Object.values(zeroEffects())], [0, 0, 0, 0, 0, 0]);
  } finally {
    FAKE_ENV.set("SUPABASE_ANON_KEY", "anon-NOT-REAL");
  }
});

// ---- authorized caller: the pause gate ------------------------------------------------------------------------------

test("admin caller while Kabumori is paused (disabled / inactive / unreadable): 423, no model call", async () => {
  for (const next of [{ publishMode: "disabled" as const }, { isActive: false }, { brandRead: "error" as const }]) {
    reset(next);
    const res = await call({ mode: "kabumori_voice_dry_run", post_type: "tip" }, "Bearer admin-token");
    assert.equal(res.status, 423, JSON.stringify(next));
    assert.deepEqual(zeroEffects(), ZERO, JSON.stringify(next));
  }
});

test("admin caller with Kabumori live or dry_run: the preview reaches the (fake) model and never X", async () => {
  for (const publishMode of ["live", "dry_run"] as const) {
    reset({ publishMode });
    await call({ mode: "kabumori_voice_dry_run", post_type: "tip" }, "Bearer admin-token");
    assert.ok(counts.ai >= 1, `${publishMode}: model reached`);
    assert.equal(counts.x, 0, `${publishMode}: a preview never posts`);
  }
});

// ---- no bypass ------------------------------------------------------------------------------------------------------

test("no bypass: a case variant or unknown mode is not a generation mode (it goes to the scheduled path, which finds nothing due)", async () => {
  for (const mode of ["Kabumori_Voice_Dry_Run", "kabumori_voice_dry_run ", "dry_run", "retry"]) {
    reset();
    await call({ mode, post_type: "tip" });
    assert.equal(counts.ai, 0, mode);
    assert.equal(counts.x, 0, mode);
  }
});

test("repeating an unauthorized request never accumulates into a model call", async () => {
  reset();
  for (let index = 0; index < 20; index += 1) await call({ mode: "morning_report_dry_run" });
  assert.deepEqual(zeroEffects(), ZERO);
});
