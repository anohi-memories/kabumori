// deno-lint-ignore-file require-await
// F8 hard pause: unit tests of the guard + the REAL index.ts handler against a fully mocked network (no real HTTP, DB, SDK,
// environment secrets or paid APIs). Every outward request is classified and counted; paused states must count zero.
import assert from "node:assert/strict";
import test from "node:test";
import {
  createPauseGuardedFetch, isDatabaseRead, NewsPausedError, PAUSE_RECHECK_TTL_MS, readNewsPauseState,
} from "./pause_gate.ts";

const BASE = "https://db.test";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

// ------------------------------------------------------------------------------------------------ unit: reading the state

test("readNewsPauseState: only an exact single row with is_active === true is running", async () => {
  const state = (rows: unknown, status = 200) => readNewsPauseState(BASE, "k", async () => json(rows, status));
  assert.equal(await state([{ is_active: true }]), "running");
  for (const rows of [[{ is_active: false }], [{}], [{ is_active: null }], [{ is_active: "true" }], [{ is_active: 1 }], [], [{ is_active: true }, { is_active: true }], {}]) {
    assert.notEqual(await state(rows), "running", JSON.stringify(rows));
  }
  assert.equal(await state({ message: "x" }, 500), "unreadable");
  assert.equal(await readNewsPauseState(BASE, "k", async () => { throw new Error("net"); }), "unreadable");
});

test("isDatabaseRead: only GET/HEAD on this project's PostgREST is open while paused", () => {
  assert.equal(isDatabaseRead(`${BASE}/rest/v1/important_news_candidates?x=1`, "GET", BASE), true);
  assert.equal(isDatabaseRead(`${BASE}/rest/v1/important_news_candidates`, "HEAD", BASE), true);
  for (const [url, method] of [
    [`${BASE}/rest/v1/important_news_candidates`, "POST"], [`${BASE}/rest/v1/important_news_candidates?id=eq.1`, "PATCH"],
    [`${BASE}/rest/v1/rpc/enqueue_important_news_notifications`, "POST"], [`${BASE}/rest/v1/x`, "DELETE"],
    [`${BASE}/functions/v1/other`, "GET"], ["https://api.openai.com/v1/responses", "POST"], ["https://api.x.com/2/tweets", "POST"],
    ["https://www.release.tdnet.info/inbs/I_list.html", "GET"], [`${BASE}.evil/rest/v1/x`, "GET"],
  ] as const) assert.equal(isDatabaseRead(url, method, BASE), false, `${method} ${url}`);
});

// ------------------------------------------------------------------------------------------------ unit: the guard

function guardHarness(initial: unknown, ttlMs = 0) {
  let setting: unknown = initial;
  let clock = 0;
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("important_news_monitor_settings")) return json(setting === "FAIL" ? { e: 1 } : [{ is_active: setting }], setting === "FAIL" ? 500 : 200);
    return json({ ok: true });
  }) as typeof fetch;
  const guarded = createPauseGuardedFetch({ fetchImpl, config: () => ({ supabaseUrl: BASE, serviceRoleKey: "k" }), ttlMs, now: () => clock });
  return { guarded, calls, set: (v: unknown) => { setting = v; }, tick: (ms: number) => { clock += ms; }, outward: () => calls.filter((c) => !c.includes("important_news_monitor_settings") && !c.startsWith("GET " + BASE + "/rest/v1/")) };
}

test("guard: paused refuses every outward call and lets database reads through", async () => {
  const h = guardHarness(false);
  for (const [url, init] of [
    ["https://api.openai.com/v1/responses", { method: "POST" }], ["https://api.x.com/2/tweets", { method: "POST" }],
    ["https://www.release.tdnet.info/x", undefined], [`${BASE}/rest/v1/important_news_candidates`, { method: "POST" }],
    [`${BASE}/rest/v1/important_news_candidates?id=eq.1`, { method: "PATCH" }], [`${BASE}/rest/v1/rpc/enqueue_important_news_notifications`, { method: "POST" }],
  ] as const) await assert.rejects(h.guarded(url, init), (error: unknown) => error instanceof NewsPausedError);
  assert.equal(h.outward().length, 0);
  assert.equal((await h.guarded(`${BASE}/rest/v1/important_news_candidates?select=id`)).ok, true);
});

test("guard: running passes through; a flip is honoured after the cache expires, never later than the TTL", async () => {
  const h = guardHarness(true, PAUSE_RECHECK_TTL_MS);
  assert.equal((await h.guarded("https://api.openai.com/v1/responses", { method: "POST" })).ok, true);
  h.set(false);
  // still inside the cache window: the previous 'running' answer is used (documented bound)
  h.tick(PAUSE_RECHECK_TTL_MS - 1);
  assert.equal((await h.guarded("https://api.openai.com/v1/responses", { method: "POST" })).ok, true);
  h.tick(2);
  await assert.rejects(h.guarded("https://api.openai.com/v1/responses", { method: "POST" }), NewsPausedError);
  // a refusal is never cached: resuming is picked up at the next call
  h.set(true);
  assert.equal((await h.guarded("https://api.openai.com/v1/responses", { method: "POST" })).ok, true);
});

test("guard: ttl 0 re-reads the setting before every outward call (strict mode)", async () => {
  const h = guardHarness(true, 0);
  await h.guarded("https://api.openai.com/v1/responses", { method: "POST" });
  h.set(false);
  await assert.rejects(h.guarded("https://api.x.com/2/tweets", { method: "POST" }), NewsPausedError);
});

test("guard: unreadable / malformed settings and missing configuration refuse outward calls", async () => {
  for (const value of ["FAIL", null, undefined, "true", 1]) {
    const h = guardHarness(value);
    await assert.rejects(h.guarded("https://api.openai.com/v1/responses", { method: "POST" }), NewsPausedError, String(value));
    assert.equal(h.outward().length, 0);
  }
  const noConfig = createPauseGuardedFetch({ fetchImpl: (async () => json({})) as typeof fetch, config: () => null });
  await assert.rejects(noConfig("https://api.openai.com/v1/responses", { method: "POST" }), NewsPausedError);
});

// ------------------------------------------------------------------------------------------------ real handler, mocked network

const SECRET = "A".repeat(42) + "A";
type Counts = { ai: number; x: number; external: number; dbWrite: number; rpc: number; dbRead: number; blocked: number };

async function callHandler(
  request: Record<string, unknown>,
  options: { isActive: unknown; readFails?: boolean; flipAfterOutward?: number; flipTo?: unknown; onFlip?: () => void },
) {
  let handler: ((req: Request) => Promise<Response>) | null = null;
  const realServe = Deno.serve;
  const realFetch = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  (Deno as any).serve = (h: (req: Request) => Promise<Response>) => { handler = h; return { finished: Promise.resolve() }; };
  const keep: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries({
    IMPORTANT_NEWS_CRON_SECRET: SECRET, SUPABASE_URL: BASE, SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
    OPENAI_API_KEY: "sk-test-not-real", X_OAUTH2_ACCESS_TOKEN: "t", X_OAUTH2_REFRESH_TOKEN: "r", X_CLIENT_ID: "c", X_CLIENT_SECRET: "s",
    IMPORTANT_NEWS_JP_OFFICIAL_LANE: undefined as string | undefined,
  })) {
    keep[name] = Deno.env.get(name);
    if (value === undefined) Deno.env.delete(name);
    else Deno.env.set(name, value);
  }
  const counts: Counts = { ai: 0, x: 0, external: 0, dbWrite: 0, rpc: 0, dbRead: 0, blocked: 0 };
  let outwardSeen = 0;
  let afterFlip = 0;
  let flipped = false;
  let isActive: unknown = options.isActive;
  const maybeFlip = () => {
    if (flipped) { afterFlip += 1; return; }
    if (options.flipAfterOutward !== undefined && outwardSeen >= options.flipAfterOutward) {
      flipped = true;
      isActive = options.flipTo ?? false;
      options.onFlip?.();
    }
  };
  // the mock represents the network below the guard: it counts only what actually left the process
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.startsWith(`${BASE}/rest/v1/important_news_monitor_settings`) && method === "GET") {
      counts.dbRead += 1;
      if (options.readFails) return new Response("down", { status: 500 });
      return json([{ is_active: isActive, luna_enabled: true, sol_escalation_enabled: false, auto_publish: true, updated_at: "2026-10-01T00:00:00Z" }]);
    }
    if (url.startsWith(BASE)) {
      if (method === "GET") {
        counts.dbRead += 1;
        // candidates available to the lanes: one pending, one ready (enough to exercise claim / AI / publish paths)
        return json([{
          id: "00000000-0000-0000-0000-000000000001", source_type: "market_macro", source_url: "https://example.test/1", source_name: "jp_official",
          title: "テスト", body_summary: "本文", category: "fx", published_at: new Date().toISOString(), status: "ready_for_generation",
          importance: "important", generated_text: "x", generation_fact_status: "passed", generation_voice_status: "passed",
          content_hash: "a".repeat(64),
        }]);
      }
      if (url.includes("/rest/v1/rpc/")) counts.rpc += 1;
      else counts.dbWrite += 1;
      outwardSeen += 1;
      maybeFlip();
      return json([{ id: "00000000-0000-0000-0000-000000000001" }], 200);
    }
    if (url.includes("openai.com")) counts.ai += 1;
    else if (url.includes("x.com") || url.includes("twitter.com")) counts.x += 1;
    else counts.external += 1;
    outwardSeen += 1;
    maybeFlip();
    return new Response("not available in the offline test", { status: 503 });
  }) as typeof fetch;
  try {
    await import(`./index.ts?pause-gate-${crypto.randomUUID()}`);
    assert.ok(handler, "index.ts registered its handler");
    const response = await (handler as (req: Request) => Promise<Response>)(new Request("https://fn.test/", {
      method: "POST",
      headers: { "x-important-news-cron-secret": SECRET, "content-type": "application/json" },
      body: JSON.stringify(request),
    }));
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    return { status: response.status, body, counts, afterFlip };
  } finally {
    globalThis.fetch = realFetch;
    // deno-lint-ignore no-explicit-any
    (Deno as any).serve = realServe;
    for (const [name, value] of Object.entries(keep)) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

const REQUESTS: Array<[string, Record<string, unknown>]> = [
  ["unpdf_edge_verification", { mode: "unpdf_edge_verification" }],
  ["app_copy_dry_run", { mode: "app_copy_dry_run", candidateId: "00000000-0000-0000-0000-000000000001" }],
  ["notification_enqueue_dry_run", { mode: "notification_enqueue_dry_run", candidateId: "00000000-0000-0000-0000-000000000001" }],
  ["publish_dry_run", { mode: "publish_dry_run", candidateId: "00000000-0000-0000-0000-000000000001" }],
  ["publish_ready", { mode: "publish_ready" }],
  ["generation_dry_run", { mode: "generation_dry_run", candidateId: "00000000-0000-0000-0000-000000000001" }],
  ["generate_ready", { mode: "generate_ready" }],
  ["judgement_dry_run", { mode: "judgement_dry_run", candidateId: "00000000-0000-0000-0000-000000000001" }],
  ["judge_pending", { mode: "judge_pending", limit: 2 }],
  ["collect scheduled", { trigger: "scheduled", fetchSources: true }],
  ["collect manual", { fetchSources: true }],
  ["collect candidates only", { candidates: [] }],
  ["unknown mode + fetchSources", { mode: "totally_unknown", fetchSources: true }],
  ["mode case variant", { mode: "JUDGE_PENDING", fetchSources: true }],
  ["judge_pending + body override", { mode: "judge_pending", is_active: true, force: true, dry_run: false, trigger: "scheduled" }],
  ["generate_ready + body override", { mode: "generate_ready", bypass_pause: true, is_active: true }],
  ["publish_ready + body override", { mode: "publish_ready", auto_publish: true, trigger: "scheduled", is_active: true }],
];

const total = (c: Counts) => c.ai + c.x + c.external + c.dbWrite + c.rpc;

test("handler: while paused / missing / malformed / unreadable, NO request is made outward — all modes", async () => {
  const states: Array<[string, { isActive: unknown; readFails?: boolean }]> = [
    ["false", { isActive: false }], ["null", { isActive: null }], ["missing", { isActive: undefined }],
    ["malformed 'true'", { isActive: "true" }], ["malformed 1", { isActive: 1 }], ["read fails", { isActive: true, readFails: true }],
  ];
  for (const [state, options] of states) {
    for (const [name, request] of REQUESTS) {
      const r = await callHandler(request, options);
      assert.equal(total(r.counts), 0, `${name} under ${state}: ${JSON.stringify(r.counts)}`);
      assert.equal(r.status, 503, `${name} under ${state} status`);
      assert.ok(["NEWS_HARD_PAUSED", "NEWS_PAUSE_STATE_UNREADABLE"].includes(String(r.body.error)), `${name}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.autoPublish, false);
    }
  }
});

test("handler: authentication is unchanged — a bad secret is refused before the pause setting is even read", async () => {
  let handler: ((req: Request) => Promise<Response>) | null = null;
  const realServe = Deno.serve;
  const realFetch = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  (Deno as any).serve = (h: (req: Request) => Promise<Response>) => { handler = h; return { finished: Promise.resolve() }; };
  Deno.env.set("IMPORTANT_NEWS_CRON_SECRET", SECRET);
  Deno.env.set("SUPABASE_URL", BASE);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "k");
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; return json([{ is_active: true }]); }) as typeof fetch;
  try {
    await import(`./index.ts?pause-gate-auth-${crypto.randomUUID()}`);
    const wrong = await (handler as unknown as (req: Request) => Promise<Response>)(new Request("https://fn.test/", {
      method: "POST", headers: { "x-important-news-cron-secret": "B".repeat(42) + "A" }, body: "{}",
    }));
    assert.equal(wrong.status, 401);
    const get = await (handler as unknown as (req: Request) => Promise<Response>)(new Request("https://fn.test/", { method: "GET" }));
    assert.equal(get.status, 405);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
    // deno-lint-ignore no-explicit-any
    (Deno as any).serve = realServe;
  }
});

test("handler: running — requests still reach their lanes (the gate does not break normal operation)", async () => {
  const judge = await callHandler({ mode: "judge_pending", limit: 1 }, { isActive: true });
  assert.ok(judge.counts.ai > 0, `judge_pending reached AI: ${JSON.stringify(judge.counts)}`);
  const generate = await callHandler({ mode: "generate_ready" }, { isActive: true });
  assert.ok(generate.counts.dbWrite + generate.counts.rpc + generate.counts.ai > 0, JSON.stringify(generate.counts));
  const collect = await callHandler({ fetchSources: true }, { isActive: true });
  assert.ok(collect.counts.external + collect.counts.dbWrite > 0, JSON.stringify(collect.counts));
});

test("handler: 50 retries while paused add no outward request", async () => {
  let sum = 0;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const [, request] = REQUESTS[attempt % REQUESTS.length];
    sum += total((await callHandler(request, { isActive: false })).counts);
  }
  assert.equal(sum, 0);
});

test("handler: pause set mid-request — every outward request after the flip (and after the cache window) is refused", async () => {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    // flip happens right after the first outward request; the clock then moves past the guard's cache window
    const flipped = await callHandler({ mode: "generate_ready" }, {
      isActive: true, flipAfterOutward: 1, flipTo: false,
      onFlip: () => { offset += PAUSE_RECHECK_TTL_MS + 5; },
    });
    assert.equal(flipped.afterFlip, 0, `outward requests after the flip: ${JSON.stringify(flipped.counts)}`);
    const normal = await callHandler({ mode: "generate_ready" }, { isActive: true });
    assert.ok(total(normal.counts) > total(flipped.counts), "the unflipped run does more work than the paused one");
  } finally {
    Date.now = realNow;
  }
});

test("static: no module-level capture of fetch in the lane modules (the guard replaces the global at install time)", async () => {
  const dir = new URL("./", import.meta.url);
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.name.endsWith(".ts") || entry.name.endsWith("_test.ts")) continue;
    const text = await Deno.readTextFile(new URL(entry.name, dir));
    assert.equal(/^(?:const|let|var)\s+\w+\s*=\s*(?:globalThis\.)?fetch\b/mu.test(text), false, `${entry.name} captures fetch at module level`);
  }
});

test("static: index.ts places the entry gate after authentication and before body parsing, and installs the guard", async () => {
  const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const serve = index.indexOf("Deno.serve(async (req) => {");
  const auth = index.indexOf("UNAUTHORIZED", serve);
  const gate = index.indexOf("readNewsPauseState(supabaseUrl, serviceRoleKey, fetch)", serve);
  const parse = index.indexOf("await req.json()", serve);
  assert.ok(serve > 0 && auth > serve && gate > auth && parse > gate, "order: serve < auth < gate < body parse");
  assert.ok(index.indexOf("installNewsPauseGuard();") > 0 && index.indexOf("installNewsPauseGuard();") < serve);
});
