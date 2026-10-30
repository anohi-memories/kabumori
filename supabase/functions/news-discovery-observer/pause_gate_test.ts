// deno-lint-ignore-file require-await
// F8 observer hard pause: gate contract + the real createObserverHandler / index.ts against fully mocked I/O (no network,
// no database, no SDK, no real secrets).
import assert from "node:assert/strict";
import test from "node:test";
import { OBSERVER_SECRET_HEADER } from "./observer_auth.ts";
import { createObserverHandler } from "./observer_handler.ts";
import {
  createPauseCoordinator, createPauseGuardedFetch, enforceNewsPauseEntry, isDatabaseRead, NewsPausedError, PAUSE_READ_TIMEOUT_MS, readNewsPauseState,
} from "./pause_gate.ts";

const SECRET = "A".repeat(42) + "A";
const BASE = "https://db.test";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ------------------------------------------------------------------------------------------------ handler: entry gate

type State = "running" | "paused" | "unreadable";
function harness(pause: () => Promise<State>, secret: string | "none" | "default" = "default") {
  const seen = { rpc: 0, fetch: 0, stocks: 0, search: 0, pauseChecks: 0 };
  const handler = createObserverHandler({
    observerSecret: secret === "default" ? SECRET : secret === "none" ? undefined : secret,
    pauseCheck: async () => {
      seen.pauseChecks += 1;
      return await pause();
    },
    rpc: {
      call: async (fn: string) => {
        seen.rpc += 1;
        switch (fn) {
          case "news_discovery_begin_run": return { run_id: "00000000-0000-4000-8000-000000000001" };
          case "news_discovery_find_duplicates": return [];
          case "news_discovery_insert_signals": return { inserted: [], conflicted: [] };
          case "news_discovery_recent_for_grouping": return [];
          default: return { finished: true };
        }
      },
    } as never,
    loadStocks: async () => {
      seen.stocks += 1;
      return [];
    },
    fetchImpl: ((_url: string) => {
      seen.fetch += 1;
      return Promise.resolve(new Response("<rss><channel></channel></rss>", { status: 200 }));
    }) as never,
    searchProvider: { search: async () => { seen.search += 1; throw new Error("must not be called"); } } as never,
    log: () => {},
  });
  return { handler, seen };
}
const post = (body: unknown, secret: string | null = SECRET, raw?: string) => new Request("http://localhost/observer", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(secret === null ? {} : { [OBSERVER_SECRET_HEADER]: secret }) },
  body: raw ?? JSON.stringify(body),
});
const SHAPES: Array<[string, Request]> = [
  ["default run", post({})],
  ["explicit sources", post({ sources: ["jp_mof_news", "us_fed_press"], trigger_type: "local_validation" })],
  ["scheduled", post({ trigger_type: "scheduled" })],
  ["GDELT", post({ include_gdelt: true })],
  ["web search", post({ search: { enabled: true } })],
  ["web search scheduled + anomalies", post({ search: { enabled: true, scheduled: true, anomalies: [{ instrument: "USDJPY", change_pct: 2 }] } })],
  ["invalid json", post(null, SECRET, "{")],
  ["bogus trigger", post({ trigger_type: "bogus" })],
];

test("paused / unreadable / throwing check: every request shape is refused with 503 before body, run, feeds, RPC, DB read or search", async () => {
  for (const pause of [async () => "paused" as State, async () => "unreadable" as State, async () => { throw new Error("boom"); }]) {
    for (const [name] of SHAPES) {
      const request = SHAPES.find(([n]) => n === name)![1].clone();
      const h = harness(pause as () => Promise<State>);
      const response = await h.handler(request);
      assert.equal(response.status, 503, name);
      const body = await response.json() as { error: string };
      assert.ok(["NEWS_HARD_PAUSED", "NEWS_PAUSE_STATE_UNREADABLE"].includes(body.error), `${name}: ${body.error}`);
      assert.deepEqual([h.seen.rpc, h.seen.fetch, h.seen.stocks, h.seen.search], [0, 0, 0, 0], name);
    }
  }
});

test("authentication is unchanged and runs BEFORE the pause check (no setting read for unauthenticated callers)", async () => {
  const wrong = harness(async () => "paused");
  assert.equal((await wrong.handler(post({}, "B".repeat(43)))).status, 401);
  assert.equal((await wrong.handler(post({}, null))).status, 401);
  assert.equal((await wrong.handler(new Request("http://localhost/x"))).status, 405);
  assert.equal(wrong.seen.pauseChecks, 0);
  const noSecret = harness(async () => "running", "none");
  assert.equal((await noSecret.handler(post({}))).status, 503);
  assert.equal(noSecret.seen.pauseChecks, 0);
});

test("running: a valid request still starts a run and fetches (the gate does not change normal operation)", async () => {
  const h = harness(async () => "running");
  const response = await h.handler(post({ sources: ["jp_mof_news"], trigger_type: "local_validation" }));
  assert.equal(response.status, 200);
  assert.ok(h.seen.rpc > 0 && h.seen.fetch > 0 && h.seen.stocks > 0, JSON.stringify(h.seen));
});

test("repeated paused invocations add nothing (Cron / retry)", async () => {
  const h = harness(async () => "paused");
  for (let i = 0; i < 50; i += 1) await h.handler(post({}));
  assert.deepEqual([h.seen.rpc, h.seen.fetch, h.seen.stocks, h.seen.search], [0, 0, 0, 0]);
});

// ------------------------------------------------------------------------------------------------ guard contract (same as PR #212)

function deferred(options: { readTimeoutMs?: number } = {}) {
  const reads: Array<(value: unknown) => void> = [];
  const sent: string[] = [];
  const coordinator = createPauseCoordinator();
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("important_news_monitor_settings")) {
      return new Promise<Response>((resolve, reject) => {
        reads.push((value) => resolve(json([{ is_active: value }])));
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    sent.push(`${init?.method ?? "GET"} ${url}`);
    return Promise.resolve(json({ ok: true }));
  }) as typeof fetch;
  const guarded = createPauseGuardedFetch({
    fetchImpl, config: () => ({ supabaseUrl: BASE, serviceRoleKey: "k" }), readTimeoutMs: options.readTimeoutMs ?? 5_000, coordinator,
  });
  const entry = () => enforceNewsPauseEntry(BASE, "k", fetchImpl, coordinator, options.readTimeoutMs ?? 5_000);
  return { guarded, reads, sent, entry };
}
const settle = (p: Promise<unknown>) => p.then(() => "ok" as const, (e) => { if (e instanceof NewsPausedError) return "refused" as const; throw e; });

test("guard: an OFF seen at the ENTRY gate fences an older pending egress authorisation (stale true is refused)", async () => {
  const h = deferred();
  const a = settle(h.guarded("https://feed.example/rss", { method: "GET" })); // egress read 1 (pending)
  await tick();
  const b = h.entry();                                                       // entry read 2 observes OFF
  await tick();
  h.reads[1](false);
  assert.equal(await b, "paused");
  h.reads[0](true);                                                          // the old true arrives
  assert.equal(await a, "refused");
  assert.equal(h.sent.length, 0);
});

test("guard: reverse order — a true completed before the stop observation is a legitimate authorisation", async () => {
  const h = deferred();
  const a = settle(h.guarded("https://feed.example/rss", { method: "GET" }));
  await tick();
  h.reads[0](true);
  assert.equal(await a, "ok");
  const b = h.entry();
  await tick();
  h.reads[1](false);
  assert.equal(await b, "paused");
  assert.equal(h.sent.length, 1);
});

test("guard: DB reads pass, every other outward call needs its own authoritative read; timeout = refused", async () => {
  const h = deferred({ readTimeoutMs: 15 });
  assert.equal((await h.guarded(`${BASE}/rest/v1/stocks_master?select=ticker_code`)).ok, true);
  for (const [url, init] of [[`${BASE}/rest/v1/rpc/news_discovery_begin_run`, { method: "POST" }], ["https://api.openai.com/v1/responses", { method: "POST" }], ["https://feed.example/rss", undefined]] as const) {
    assert.equal(await settle(h.guarded(url, init as RequestInit | undefined)), "refused", url); // read never answers -> deadline
  }
  assert.deepEqual(h.sent, [`GET ${BASE}/rest/v1/stocks_master?select=ticker_code`], "only the database read left the process");
  assert.ok(PAUSE_READ_TIMEOUT_MS === 3_000);
});

test("readNewsPauseState: only exactly one row with is_active === true is running; failures and timeouts are not", async () => {
  const state = (rows: unknown, status = 200) => readNewsPauseState(BASE, "k", async () => json(rows, status));
  assert.equal(await state([{ is_active: true }]), "running");
  for (const rows of [[{ is_active: false }], [{}], [{ is_active: null }], [{ is_active: "true" }], [{ is_active: 1 }], [], [{ is_active: true }, { is_active: true }], {}]) {
    assert.notEqual(await state(rows), "running", JSON.stringify(rows));
  }
  assert.equal(await state({ message: "x" }, 500), "unreadable");
  assert.equal(await readNewsPauseState(BASE, "k", async () => { throw new Error("net"); }), "unreadable");
  // a transport that ignores AbortSignal and never answers is cut by the hard deadline
  const hung = readNewsPauseState(BASE, "k", () => new Promise<Response>(() => {}), 20);
  assert.equal(await Promise.race([hung, new Promise<string>((resolve) => setTimeout(() => resolve("HUNG"), 1_000))]), "unreadable");
});

test("guard: an unreadable setting refuses outward calls; database reads and look-alike hosts are classified correctly", async () => {
  const guarded = createPauseGuardedFetch({
    fetchImpl: (async (input: string | URL | Request) => {
      if (String(input).includes("important_news_monitor_settings")) throw new Error("db down");
      return json({ ok: true });
    }) as typeof fetch,
    config: () => ({ supabaseUrl: BASE, serviceRoleKey: "k" }),
  });
  await assert.rejects(guarded("https://api.openai.com/v1/responses", { method: "POST" }), NewsPausedError);
  assert.equal((await guarded(`${BASE}/rest/v1/stocks_master?select=x`)).ok, true);
  assert.equal(isDatabaseRead(`${BASE}.evil/rest/v1/x`, "GET", BASE), false);
  assert.equal(isDatabaseRead(`${BASE}/rest/v1/rpc/news_discovery_begin_run`, "POST", BASE), false);
});

// ------------------------------------------------------------------------------------------------ real index.ts

async function importIndex(options: { isActive: unknown; holdSettingsRead?: number }) {
  let handler: ((req: Request) => Promise<Response>) | null = null;
  const realServe = Deno.serve;
  const realFetch = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  (Deno as any).serve = (h: (req: Request) => Promise<Response>) => { handler = h; return { finished: Promise.resolve() }; };
  const keep: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries({
    NEWS_DISCOVERY_OBSERVER_SECRET: SECRET, SUPABASE_URL: BASE, SUPABASE_SERVICE_ROLE_KEY: "service-role-test", OPENAI_API_KEY: "sk-test-not-real",
  })) {
    keep[name] = Deno.env.get(name);
    Deno.env.set(name, value);
  }
  let isActive: unknown = options.isActive;
  let settingsReads = 0;
  let held: (() => void) | null = null;
  const out = { rpc: 0, external: 0, ai: 0, dbRead: 0 };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.startsWith(`${BASE}/rest/v1/important_news_monitor_settings`) && method === "GET") {
      settingsReads += 1;
      const frozen = json([{ is_active: isActive }]);
      if (options.holdSettingsRead === settingsReads) return await new Promise<Response>((resolve) => { held = () => resolve(frozen); });
      return frozen;
    }
    if (url.startsWith(BASE)) {
      if (method === "GET") {
        out.dbRead += 1;
        return json([]);
      }
      out.rpc += 1;
      const fn = url.split("/rpc/")[1] ?? "";
      if (fn === "news_discovery_begin_run") return json({ run_id: "00000000-0000-4000-8000-000000000001" });
      if (fn === "news_discovery_insert_signals") return json({ inserted: [], conflicted: [] });
      if (fn === "news_discovery_find_duplicates" || fn === "news_discovery_recent_for_grouping") return json([]);
      return json({ finished: true });
    }
    if (url.includes("openai.com")) out.ai += 1;
    else out.external += 1;
    return new Response("<rss><channel></channel></rss>", { status: 200 });
  }) as typeof fetch;
  await import(`./index.ts?pause-obs-${crypto.randomUUID()}`);
  assert.ok(handler);
  return {
    call: (body: unknown) => (handler as (req: Request) => Promise<Response>)(post(body)),
    out,
    setActive: (v: unknown) => { isActive = v; },
    release: () => held?.(),
    isHeld: () => held !== null,
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

test("index.ts: paused — a real request makes no RPC, no feed fetch, no OpenAI call (503)", async () => {
  const w = await importIndex({ isActive: false });
  try {
    for (const body of [{}, { include_gdelt: true }, { search: { enabled: true } }, { trigger_type: "scheduled" }]) {
      const response = await w.call(body);
      assert.equal(response.status, 503);
    }
    assert.deepEqual([w.out.rpc, w.out.external, w.out.ai], [0, 0, 0]);
  } finally {
    w.close();
  }
});

test("index.ts: running reaches begin_run and the feeds (positive control)", async () => {
  const running = await importIndex({ isActive: true });
  try {
    const response = await running.call({ sources: ["jp_mof_news"], trigger_type: "local_validation" });
    assert.equal(response.status, 200);
    assert.ok(running.out.rpc > 0 && running.out.external > 0, JSON.stringify(running.out));
  } finally {
    running.close();
  }
});

test("index.ts: B's OFF at the entry gate fences A's pending egress 'true' — A's begin_run is never sent (one warm isolate)", async () => {
  const w = await importIndex({ isActive: true, holdSettingsRead: 2 }); // read 1 = A entry, read 2 = A's egress read for begin_run
  try {
    const a = w.call({ sources: ["jp_mof_news"], trigger_type: "local_validation" });
    for (let i = 0; i < 100 && !w.isHeld(); i += 1) await tick();
    assert.ok(w.isHeld(), "A waits on its egress authorisation read");
    w.setActive(false);
    const b = await w.call({});
    assert.equal(b.status, 503);
    w.release();                                  // the old true arrives
    await a.then((r) => r.text()).catch(() => "");
    assert.equal(w.out.rpc, 0, `A sent an RPC after B's 503: ${JSON.stringify(w.out)}`);
    assert.equal(w.out.external, 0);
  } finally {
    w.close();
  }
});

// ------------------------------------------------------------------------------------------------ static

test("static: the egress guard is installed BEFORE anything captures fetch; the entry gate is wired; auth precedes the gate", async () => {
  const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const install = index.indexOf("installNewsPauseGuard();");
  assert.ok(install > 0);
  assert.ok(install < index.indexOf("postgrestRpcClient(supabaseUrl"), "install before the RPC client is constructed");
  assert.ok(install < index.indexOf("new OpenAiWebSearchProvider("), "install before the search provider is constructed");
  assert.match(index, /pauseCheck: \(\) => enforceNewsPauseEntry\(supabaseUrl, serviceRoleKey, fetch\)/u, "production wiring supplies the entry check");
  const handler = await Deno.readTextFile(new URL("./observer_handler.ts", import.meta.url));
  const auth = handler.indexOf("UNAUTHORIZED");
  const gate = handler.indexOf("await deps.pauseCheck()");
  const body = handler.indexOf("await request.text()");
  assert.ok(auth > 0 && gate > auth && body > gate, "order: auth < pause check < body read");
  for (const file of ["pause_gate.ts", "index.ts", "observer_handler.ts"]) {
    const text = await Deno.readTextFile(new URL(`./${file}`, import.meta.url));
    assert.equal(/^(?:const|let|var)\s+\w+\s*=\s*(?:globalThis\.)?fetch\b/mu.test(text), false, `${file} captures fetch at module level`);
  }
});
