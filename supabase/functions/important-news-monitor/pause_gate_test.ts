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

test("guard: with an explicit positive TTL a flip is honoured after the cache expires; refusals are never cached", async () => {
  const OPT_IN_TTL = 1_000; // the production default is 0 (PAUSE_RECHECK_TTL_MS); a positive TTL is an explicit opt-in
  assert.equal(PAUSE_RECHECK_TTL_MS, 0);
  const h = guardHarness(true, OPT_IN_TTL);
  assert.equal((await h.guarded("https://api.openai.com/v1/responses", { method: "POST" })).ok, true);
  h.set(false);
  // still inside the cache window: the previous 'running' answer is used (documented bound of the opt-in cache)
  h.tick(OPT_IN_TTL - 1);
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

// ------------------------------------------------------------------------------------------------ J2-R1: out-of-order reads

type PendingRead = { resolve: (value: unknown) => void; settled: boolean };

/** a fetch whose settings reads stay pending until the test resolves them (and that honours AbortSignal like the real one) */
function deferredHarness(options: { ttlMs?: number; readTimeoutMs?: number; ignoreAbort?: boolean } = {}) {
  const reads: PendingRead[] = [];
  const sent: string[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("important_news_monitor_settings")) {
      return new Promise<Response>((resolve, reject) => {
        const read: PendingRead = {
          settled: false,
          resolve: (value) => {
            if (read.settled) return;
            read.settled = true;
            resolve(json([{ is_active: value }]));
          },
        };
        reads.push(read);
        if (!options.ignoreAbort) {
          init?.signal?.addEventListener("abort", () => {
            if (!read.settled) {
              read.settled = true;
              reject(new DOMException("aborted", "AbortError"));
            }
          });
        }
      });
    }
    sent.push(`${init?.method ?? "GET"} ${url}`);
    return Promise.resolve(json({ ok: true }));
  }) as typeof fetch;
  const guarded = createPauseGuardedFetch({
    fetchImpl, config: () => ({ supabaseUrl: BASE, serviceRoleKey: "k" }), ttlMs: options.ttlMs ?? 0, readTimeoutMs: options.readTimeoutMs ?? 5_000,
  });
  return { guarded, reads, sent };
}
const send = (guarded: typeof fetch, what = "https://api.x.com/2/tweets") => guarded(what, { method: "POST" });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settled = async (promise: Promise<unknown>): Promise<"ok" | "refused"> =>
  promise.then(() => "ok" as const, (error) => { if (error instanceof NewsPausedError) return "refused" as const; throw error; });

test("J2-R1: a stale 'true' that returns after a newer stop observation is refused, and cannot revive anything", async () => {
  for (const ttlMs of [0, 1_000]) {
    const h = deferredHarness({ ttlMs });
    const a = settled(send(h.guarded));            // read 1 starts (will say true, but late)
    await tick();
    const b = settled(send(h.guarded));            // read 2 starts after the OFF commit
    await tick();
    h.reads[1].resolve(false);                      // newer read observes the stop first
    assert.equal(await b, "refused");
    h.reads[0].resolve(true);                       // the old true arrives afterwards
    assert.equal(await a, "refused", `ttl ${ttlMs}: the stale true must not authorise a send`);
    const c = settled(send(h.guarded));             // a new call after both
    await tick();
    h.reads[2]?.resolve(false);
    assert.equal(await c, "refused", `ttl ${ttlMs}: a stale true must not leave a running cache`);
    assert.deepEqual(h.sent, [], `ttl ${ttlMs}: nothing may have been sent`);
  }
});

test("J2-R1: both response orders — a read that completes true BEFORE the stop observation is a legitimate authorisation", async () => {
  // order 1: older true resolves first (authorised pre-stop), then the newer false
  const one = deferredHarness();
  const a1 = settled(send(one.guarded));
  await tick();
  const b1 = settled(send(one.guarded));
  await tick();
  one.reads[0].resolve(true);
  assert.equal(await a1, "ok");
  one.reads[1].resolve(false);
  assert.equal(await b1, "refused");
  assert.equal(one.sent.length, 1);
  // order 2: newer false first, then the older true -> refused
  const two = deferredHarness();
  const a2 = settled(send(two.guarded));
  await tick();
  const b2 = settled(send(two.guarded));
  await tick();
  two.reads[1].resolve(false);
  assert.equal(await b2, "refused");
  two.reads[0].resolve(true);
  assert.equal(await a2, "refused");
  assert.equal(two.sent.length, 0);
  // after a refusal the very next call needs its own fresh true
  const c = settled(send(two.guarded));
  await tick();
  two.reads[2].resolve(true);
  assert.equal(await c, "ok", "resume: a fresh true authorises again");
});

test("J2-R1: unreadable / timeout newer than a pending true also fences the older read", async () => {
  const h = deferredHarness({ readTimeoutMs: 15 });
  const a = settled(send(h.guarded));              // pending forever (until resolved by the test)
  await tick();
  const b = settled(send(h.guarded));              // times out after 15 ms -> unreadable -> stop observation
  assert.equal(await b, "refused");
  h.reads[0].resolve(true);
  assert.equal(await a, "refused");
  assert.equal(h.sent.length, 0);
});

test("J2-R1: a hard deadline bounds the read even when the transport ignores AbortSignal", async () => {
  const h = deferredHarness({ readTimeoutMs: 20, ignoreAbort: true });
  const outcome = await Promise.race([
    settled(send(h.guarded)),
    new Promise<string>((resolve) => setTimeout(() => resolve("HUNG"), 1_000)),
  ]);
  assert.equal(outcome, "refused");
  assert.equal(h.sent.length, 0);
});

test("J2-R1: property — in a warm isolate, no send is authorised by a read that a later-started stop observation outran", async () => {
  let seed = 20261016;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (let round = 0; round < 150; round += 1) {
    const h = deferredHarness({ ttlMs: random() < 0.5 ? 0 : 1_000 });
    const n = 2 + Math.floor(random() * 5);
    const outcomes: Array<Promise<"ok" | "refused">> = [];
    const values: boolean[] = [];
    for (let i = 0; i < n; i += 1) {
      outcomes.push(settled(send(h.guarded)));
      await tick();
      values.push(random() < 0.5);
    }
    // resolve in a random order with random answers; track the order stops (false) completed relative to starts
    const order = [...Array(n).keys()].sort(() => random() - 0.5);
    const resolvedFalseStartIndexes: number[] = [];
    const authorised: number[] = [];
    for (const index of order) {
      h.reads[index].resolve(values[index]);
      await tick();
      if (!values[index]) resolvedFalseStartIndexes.push(index);
    }
    const results = await Promise.all(outcomes);
    // stop observed by a read that started later than i and completed before i completed (completion order = `order`)
    order.forEach((index, completion) => {
      if (results[index] === "ok") authorised.push(index);
      const outrun = order.slice(0, completion).some((other) => other > index && !values[other]);
      if (outrun) assert.equal(results[index], "refused", `round ${round}: read ${index} was authorised after a later-started stop`);
      if (!values[index]) assert.equal(results[index], "refused");
    });
    assert.equal(h.sent.length, authorised.length);
  }
});

// ------------------------------------------------------------------------------------------------ real handler, mocked network

const SECRET = "A".repeat(42) + "A";
type Counts = { ai: number; x: number; external: number; dbWrite: number; rpc: number; dbRead: number; blocked: number };

async function callHandler(
  request: Record<string, unknown>,
  options: {
    isActive: unknown; readFails?: boolean; flipAfterOutward?: number; flipTo?: unknown; onFlip?: () => void;
    /** the setting reads false from the (n+1)-th settings read on (read 1 is the entry gate) */
    flipAfterSettingsReads?: number;
  },
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
  let settingsReads = 0;
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
      settingsReads += 1;
      if (options.flipAfterSettingsReads !== undefined && settingsReads > options.flipAfterSettingsReads) isActive = options.flipTo ?? false;
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

test("handler: pause set mid-request — every outward request after the flip is refused (no cache window by default)", async () => {
  const flipped = await callHandler({ mode: "generate_ready" }, { isActive: true, flipAfterOutward: 1, flipTo: false });
  assert.equal(flipped.afterFlip, 0, `outward requests after the flip: ${JSON.stringify(flipped.counts)}`);
  const normal = await callHandler({ mode: "generate_ready" }, { isActive: true });
  assert.ok(total(normal.counts) > total(flipped.counts), "the unflipped run does more work than the paused one");
});

test("handler: final side effects — OFF between the entry gate and the X post / the claim / the AI call / the push enqueue", async () => {
  // entry gate = settings read 1 (running); every later read says paused
  const x = await callHandler({ mode: "publish_ready" }, { isActive: true, flipAfterSettingsReads: 1 });
  assert.deepEqual([x.counts.x, x.counts.ai, x.counts.rpc, x.counts.dbWrite], [0, 0, 0, 0], `publish_ready: ${JSON.stringify(x.counts)}`);
  const generate = await callHandler({ mode: "generate_ready" }, { isActive: true, flipAfterSettingsReads: 1 });
  assert.deepEqual([generate.counts.ai, generate.counts.rpc, generate.counts.dbWrite], [0, 0, 0], `generate_ready: ${JSON.stringify(generate.counts)}`);
  const judge = await callHandler({ mode: "judge_pending", limit: 2 }, { isActive: true, flipAfterSettingsReads: 1 });
  assert.deepEqual([judge.counts.ai, judge.counts.dbWrite], [0, 0], `judge_pending: ${JSON.stringify(judge.counts)}`);
  const collect = await callHandler({ fetchSources: true }, { isActive: true, flipAfterSettingsReads: 1 });
  assert.deepEqual([collect.counts.external, collect.counts.ai, collect.counts.dbWrite], [0, 0, 0], `collect: ${JSON.stringify(collect.counts)}`);
  // resume: a fresh true is honoured at the very next request
  const resumed = await callHandler({ mode: "judge_pending", limit: 1 }, { isActive: true });
  assert.ok(resumed.counts.ai > 0);
});

// ------------------------------------------------------------------------------------------------ J2-R1 residual: entry vs egress

/**
 * One imported handler (= one warm isolate, one guard, one shared stop-observation state). Settings reads can be held
 * pending by their ordinal number and released later; everything below the guard is counted.
 */
async function warmIsolate(options: { hold: number[]; initial?: unknown; unreadableReads?: number[] }) {
  let handler: ((req: Request) => Promise<Response>) | null = null;
  const realServe = Deno.serve;
  const realFetch = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  (Deno as any).serve = (h: (req: Request) => Promise<Response>) => { handler = h; return { finished: Promise.resolve() }; };
  const keep: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries({
    IMPORTANT_NEWS_CRON_SECRET: SECRET, SUPABASE_URL: BASE, SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
    OPENAI_API_KEY: "sk-test-not-real", X_OAUTH2_ACCESS_TOKEN: "t", X_OAUTH2_REFRESH_TOKEN: "r", X_CLIENT_ID: "c", X_CLIENT_SECRET: "s",
  })) {
    keep[name] = Deno.env.get(name);
    Deno.env.set(name, value);
  }
  let isActive: unknown = options.initial ?? true;
  let readNumber = 0;
  const held = new Map<number, () => void>();
  const counts: Counts = { ai: 0, x: 0, external: 0, dbWrite: 0, rpc: 0, dbRead: 0, blocked: 0 };
  let firstOutwardAfterRead = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (!(method === "GET" && url.startsWith(BASE)) && firstOutwardAfterRead === 0) firstOutwardAfterRead = readNumber;
    if (url.startsWith(`${BASE}/rest/v1/important_news_monitor_settings`) && method === "GET") {
      readNumber += 1;
      const mine = readNumber;
      const answer = () => options.unreadableReads?.includes(mine)
        ? new Response("down", { status: 500 })
        : json([{ is_active: isActive, luna_enabled: true, sol_escalation_enabled: false, auto_publish: true, updated_at: "2026-10-01T00:00:00Z" }]);
      if (options.hold.includes(mine)) {
        // the value is captured NOW (the old answer), delivered later
        const frozen = options.unreadableReads?.includes(mine) ? answer() : json([{ is_active: isActive, auto_publish: true, updated_at: "2026-10-01T00:00:00Z", luna_enabled: true }]);
        return await new Promise<Response>((resolve) => { held.set(mine, () => resolve(frozen)); });
      }
      return answer();
    }
    if (url.startsWith(BASE)) {
      if (method === "GET") {
        return json([{
          id: "00000000-0000-0000-0000-000000000001", source_type: "market_macro", source_url: "https://example.test/1", source_name: "jp_official",
          title: "テスト", body_summary: "本文", category: "fx", published_at: new Date().toISOString(), status: "ready_for_publish",
          importance: "important", generated_text: "x", generation_fact_status: "passed", generation_voice_status: "passed",
          content_hash: "a".repeat(64), generated_at: new Date().toISOString(),
        }]);
      }
      if (url.includes("/rest/v1/rpc/")) counts.rpc += 1;
      else counts.dbWrite += 1;
      return json([{ id: "00000000-0000-0000-0000-000000000001" }]);
    }
    if (url.includes("openai.com")) counts.ai += 1;
    else if (url.includes("x.com") || url.includes("twitter.com")) counts.x += 1;
    else counts.external += 1;
    return new Response("offline", { status: 503 });
  }) as typeof fetch;
  await import(`./index.ts?pause-gate-warm-${crypto.randomUUID()}`);
  assert.ok(handler);
  const call = (request: Record<string, unknown>) => (handler as (req: Request) => Promise<Response>)(new Request("https://fn.test/", {
    method: "POST", headers: { "x-important-news-cron-secret": SECRET, "content-type": "application/json" }, body: JSON.stringify(request),
  }));
  return {
    call,
    counts,
    setActive: (value: unknown) => { isActive = value; },
    release: (n: number) => held.get(n)?.(),
    isHeld: (n: number) => held.has(n),
    firstOutwardAfterRead: () => firstOutwardAfterRead,
    outward: () => counts.ai + counts.x + counts.external + counts.dbWrite + counts.rpc,
    close: () => {
      globalThis.fetch = realFetch;
      // deno-lint-ignore no-explicit-any
      (Deno as any).serve = realServe;
      for (const [name, value] of Object.entries(keep)) {
        if (value === undefined) Deno.env.delete(name);
        else Deno.env.set(name, value);
      }
    },
  };
}
const until = async (condition: () => boolean) => { for (let i = 0; i < 200 && !condition(); i += 1) await tick(); };

/** which settings read authorises the first outward effect of this request when nothing is held (a probe run) */
async function egressReadOf(request: Record<string, unknown>): Promise<number> {
  const probe = await warmIsolate({ hold: [] });
  try {
    await (await probe.call(request)).text();
    const n = probe.firstOutwardAfterRead();
    assert.ok(n >= 2 && probe.outward() > 0, `probe: the request must reach an outward effect (read ${n}, ${JSON.stringify(probe.counts)})`);
    return n;
  } finally {
    probe.close();
  }
}
const A_REQUEST = { mode: "judge_pending", limit: 1 };

test("J2-R1 residual: A's pending egress 'true' is refused after request B observed OFF at the ENTRY gate (real handler, one warm isolate)", async () => {
  const egress = await egressReadOf(A_REQUEST);
  const w = await warmIsolate({ hold: [egress] });
  try {
    const a = w.call(A_REQUEST);
    await until(() => w.isHeld(egress));
    assert.ok(w.isHeld(egress), "A is waiting on its egress authorisation read");
    w.setActive(false);                               // OFF commits
    const b = await w.call({ mode: "generate_ready" });
    assert.equal(b.status, 503);                      // B observes OFF at the entry gate
    w.release(egress);                                // the OLD true arrives for A
    await a.then((r) => r.text()).catch(() => "");
    assert.equal(w.outward(), 0, `A made new outward requests after B's 503: ${JSON.stringify(w.counts)}`);
  } finally {
    w.close();
  }
});

test("J2-R1 residual: reverse order — A's true completes BEFORE B's stop observation, so A was legitimately authorised", async () => {
  const egress = await egressReadOf(A_REQUEST);
  const w = await warmIsolate({ hold: [egress] });
  try {
    const a = w.call(A_REQUEST);
    await until(() => w.isHeld(egress));
    w.release(egress);                                // A's read completes true first
    await a.then((r) => r.text()).catch(() => "");
    assert.ok(w.outward() > 0, `A should have proceeded: ${JSON.stringify(w.counts)}`);
    w.setActive(false);
    const b = await w.call({ mode: "generate_ready" });
    assert.equal(b.status, 503);
  } finally {
    w.close();
  }
});

test("J2-R1 residual: B's entry read unreadable / failing also fences A's older pending true", async () => {
  const egress = await egressReadOf(A_REQUEST);
  // B's entry gate is the next settings read after A's last one before the hold; make the read number right after A's
  // pending read fail (A's own flow performs no further settings read while it waits on its held read)
  const w = await warmIsolate({ hold: [egress], unreadableReads: [egress + 1] });
  try {
    const a = w.call(A_REQUEST);
    await until(() => w.isHeld(egress));
    const b = await w.call({ mode: "generate_ready" });
    assert.equal(b.status, 503);
    assert.equal((await b.json() as { error: string }).error, "NEWS_PAUSE_STATE_UNREADABLE");
    w.release(egress);
    await a.then((r) => r.text()).catch(() => "");
    assert.equal(w.outward(), 0, JSON.stringify(w.counts));
  } finally {
    w.close();
  }
});

test("J2-R1 residual: several warm requests pending at once are all fenced by one entry-gate stop; resume needs a fresh true", async () => {
  const egress = await egressReadOf(A_REQUEST);
  // A1 holds read `egress`; A2 starts afterwards: its entry read is egress+1 and its own egress read is the next after that
  const w = await warmIsolate({ hold: [egress, egress + 1 + (egress - 1)] });
  try {
    const a1 = w.call(A_REQUEST);
    await until(() => w.isHeld(egress));
    const a2 = w.call(A_REQUEST);
    await until(() => w.isHeld(egress + egress));
    w.setActive(false);
    const b = await w.call({ mode: "generate_ready" });
    assert.equal(b.status, 503);
    w.release(egress);
    w.release(egress + egress);
    await Promise.all([a1, a2].map((p) => p.then((r) => r.text()).catch(() => "")));
    assert.equal(w.outward(), 0, JSON.stringify(w.counts));
    // resume: the next request must authorise itself with a fresh true read
    w.setActive(true);
    const c = await w.call(A_REQUEST);
    assert.notEqual(c.status, 503);
    assert.ok(w.counts.ai > 0, "resumed request reached the AI lane");
  } finally {
    w.close();
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
  const gate = index.indexOf("enforceNewsPauseEntry(supabaseUrl, serviceRoleKey, fetch)", serve);
  const parse = index.indexOf("await req.json()", serve);
  assert.ok(serve > 0 && auth > serve && gate > auth && parse > gate, "order: serve < auth < gate < body parse");
  assert.ok(index.indexOf("installNewsPauseGuard();") > 0 && index.indexOf("installNewsPauseGuard();") < serve);
});
