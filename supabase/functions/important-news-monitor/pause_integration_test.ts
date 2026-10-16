// deno-lint-ignore-file require-await
// F8 integration candidate (PR #164 -> PR #129 -> PR #212, fixture-only adaptations): the three changes must coexist.
// Real index.ts handler, fully mocked network below the guard; nothing leaves the process.
import assert from "node:assert/strict";
import test from "node:test";

const SECRET = "A".repeat(42) + "A";
const BASE = "https://db.test";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const FED_RSS = `<?xml version="1.0"?><rss><channel><item><title>Federal Reserve issues FOMC statement</title><link>https://www.federalreserve.gov/newsevents/pressreleases/monetary20261009a.htm</link><pubDate>Fri, 09 Oct 2026 18:00:00 GMT</pubDate><description></description></item></channel></rss>`;
const STATEMENT = `<html><head><title>Federal Reserve Board - Federal Reserve issues FOMC statement</title></head><body><div id="article"><p class="article__time">October 9, 2026</p><h3>Federal Reserve issues FOMC statement</h3><p>The Committee decided to maintain the target range for the federal funds rate at 4-1/4 to 4-1/2 percent. The action was approved by a 12 – 0 vote.</p></div><div id="footer">Last Update: October 9, 2026</div></body></html>`;

async function cycle(options: { isActive: unknown; flipAfterSettingsReads?: number }) {
  let handler: ((req: Request) => Promise<Response>) | null = null;
  const realServe = Deno.serve;
  const realFetch = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  (Deno as any).serve = (h: (req: Request) => Promise<Response>) => { handler = h; return { finished: Promise.resolve() }; };
  const keep: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries({
    IMPORTANT_NEWS_CRON_SECRET: SECRET, SUPABASE_URL: BASE, SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
    IMPORTANT_NEWS_FED_STATEMENT_BODY_ENRICHMENT: "enabled", IMPORTANT_NEWS_TDNET_KESSAN_FACTS: "enabled",
    IMPORTANT_NEWS_JP_OFFICIAL_LANE: "enabled", OPENAI_API_KEY: undefined as string | undefined,
  })) {
    keep[name] = Deno.env.get(name);
    if (value === undefined) Deno.env.delete(name);
    else Deno.env.set(name, value);
  }
  let isActive: unknown = options.isActive;
  let settingsReads = 0;
  const out = { external: 0, fedPage: 0, dbWrite: 0, diagnosticsPatch: 0, inserted: [] as Array<Record<string, unknown>> };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.origin === BASE) {
      const table = url.pathname.split("/").pop();
      if (table === "important_news_monitor_settings") {
        settingsReads += 1;
        if (options.flipAfterSettingsReads !== undefined && settingsReads > options.flipAfterSettingsReads) isActive = false;
        return json([{ is_active: isActive, luna_enabled: true, auto_publish: false, updated_at: "2026-10-01T00:00:00Z" }]);
      }
      if (method === "GET") return json([]);
      out.dbWrite += 1;
      if (table === "important_news_candidates" && method === "POST") {
        out.inserted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json([{ id: `new-${out.inserted.length}` }], 201);
      }
      if (table === "important_news_monitor_runs") {
        if (method === "POST") return json([{ id: "run-1" }], 201);
        if ("diagnostics" in (JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>)) out.diagnosticsPatch += 1;
        return new Response(null, { status: 204 });
      }
      return json([]);
    }
    out.external += 1;
    if (url.pathname === "/feeds/press_all.xml") return new Response(FED_RSS, { status: 200, headers: { "content-type": "application/rss+xml" } });
    if (url.pathname.includes("/monetary20261009a.htm")) {
      out.fedPage += 1;
      return new Response(STATEMENT, { status: 200, headers: { "content-type": "text/html" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    await import(`./index.ts?pause-integration-${crypto.randomUUID()}`);
    assert.ok(handler);
    const response = await (handler as (req: Request) => Promise<Response>)(new Request("https://fn.test/", {
      method: "POST", headers: { "x-important-news-cron-secret": SECRET, "content-type": "application/json" },
      body: JSON.stringify({ trigger: "manual", fetchSources: true }),
    }));
    return { status: response.status, out };
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

test("integration: paused with every PR #129 / #164 flag enabled — no feed, no statement page, no write, no diagnostics", async () => {
  const r = await cycle({ isActive: false });
  assert.equal(r.status, 503);
  assert.deepEqual([r.out.external, r.out.fedPage, r.out.dbWrite, r.out.diagnosticsPatch, r.out.inserted.length], [0, 0, 0, 0, 0]);
});

test("integration: running — the Fed statement enrichment (PR #129), the run diagnostics (PR #164) and the gate (PR #212) coexist", async () => {
  const r = await cycle({ isActive: true });
  assert.equal(r.status, 200);
  assert.equal(r.out.fedPage, 1, "the official statement page was read");
  const statement = r.out.inserted.find((row) => String(row.source_url).includes("monetary20261009a"));
  assert.match(String(statement?.body_summary), /4\.25〜4\.5%（据え置き、変更なし）/u);
  assert.ok(r.out.diagnosticsPatch >= 1, "jp_official diagnostics were persisted in the run row");
});

test("integration: OFF between the entry gate and the lanes — nothing leaves the process after the stop", async () => {
  const r = await cycle({ isActive: true, flipAfterSettingsReads: 1 });
  assert.deepEqual([r.out.external, r.out.fedPage, r.out.dbWrite, r.out.diagnosticsPatch, r.out.inserted.length], [0, 0, 0, 0, 0], JSON.stringify(r.out));
});
