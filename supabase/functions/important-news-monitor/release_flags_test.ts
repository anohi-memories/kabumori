// deno-lint-ignore-file require-await
// PR #129 R5: the two new behaviours are default-OFF, separate switches. OFF = the pre-PR129 path; ON = the PR129 path.
import assert from "node:assert/strict";
import test from "node:test";
import { buildTdnetBodySummary, composeTdnetPdfBody, fetchTdnetPdfBodySummary, tdnetKessanFactsEnabled } from "./official_source_fetchers.ts";

const SECRET = "A".repeat(42) + "A";
const BASE = "https://db.test";
const TDNET_FLAG = "IMPORTANT_NEWS_TDNET_KESSAN_FACTS";
const FED_FLAG = "IMPORTANT_NEWS_FED_STATEMENT_BODY_ENRICHMENT";

async function withEnv<T>(name: string, value: string | undefined, run: () => Promise<T>): Promise<T> {
  const before = Deno.env.get(name);
  if (value === undefined) Deno.env.delete(name);
  else Deno.env.set(name, value);
  try {
    return await run();
  } finally {
    if (before === undefined) Deno.env.delete(name);
    else Deno.env.set(name, before);
  }
}

// ------------------------------------------------------------------ TDnet 決算短信 facts

const KESSAN = [
  "2026年3月期 第１四半期決算短信〔日本基準〕(連結)", "(百万円未満切捨て)",
  "（１）連結経営成績(累計) (％表示は、対前年同四半期増減率)",
  "売上高 営業利益 経常利益 親会社株主に帰属", "する四半期純利益", "百万円 ％ 百万円 ％ 百万円 ％ 百万円 ％",
  "2026年3月期第１四半期 5,000 10.0 △100 － 300 5.0 200 4.0",
  "2025年3月期第１四半期 4,545 1.0 120 2.0 290 3.0 190 4.0",
].join("\n");

const pdfResponse = () => new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]), { status: 200, headers: { "content-type": "application/pdf" } });

test("TDnet flag: only the exact value 'enabled' turns the facts on", async () => {
  for (const [value, expected] of [[undefined, false], ["", false], ["true", false], ["ENABLED", false], ["enabled ", false], ["disabled", false], ["enabled", true]] as const) {
    assert.equal(await withEnv(TDNET_FLAG, value, async () => tdnetKessanFactsEnabled()), expected, String(value));
  }
});

test("TDnet flag OFF: the body is exactly the previous keyword summary; ON: the facts-first body", async () => {
  const previous = buildTdnetBodySummary(KESSAN) ?? "";
  const off = await withEnv(TDNET_FLAG, undefined, () =>
    fetchTdnetPdfBodySummary("https://www.release.tdnet.info/inbs/x.pdf", { fetcher: async () => pdfResponse(), extractor: async () => KESSAN }));
  assert.equal(off, previous);
  assert.doesNotMatch(off, /【決算短信 数値/u);
  const on = await withEnv(TDNET_FLAG, "enabled", () =>
    fetchTdnetPdfBodySummary("https://www.release.tdnet.info/inbs/x.pdf", { fetcher: async () => pdfResponse(), extractor: async () => KESSAN }));
  assert.match(on, /【決算短信 数値（表から抽出）】/u);
  assert.match(on, /営業利益-100百万円/u);
  assert.equal(composeTdnetPdfBody(KESSAN, previous).body, on);
});

test("TDnet flag OFF keeps PDF fetch limits and failures unchanged", async () => {
  await withEnv(TDNET_FLAG, undefined, async () => {
    await assert.rejects(fetchTdnetPdfBodySummary("https://www.release.tdnet.info/x.pdf", { fetcher: async () => new Response("no", { status: 404 }) }), /TDNET_PDF_FETCH_FAILED:404/u);
    await assert.rejects(fetchTdnetPdfBodySummary("https://www.release.tdnet.info/x.pdf", {
      fetcher: async () => new Response(new Uint8Array([0x00, 0x01]), { status: 200 }),
    }), /TDNET_PDF_INVALID/u);
    await assert.rejects(fetchTdnetPdfBodySummary("https://www.release.tdnet.info/x.pdf", {
      fetcher: async () => pdfResponse(), extractor: async () => "",
    }), /TDNET_PDF_TEXT_EMPTY/u);
  });
});

test("TDnet flag OFF: non-決算短信 disclosures are unchanged in both modes", async () => {
  const text = "通期業績予想の修正に関するお知らせ\n売上高 15,000 百万円\n営業利益 2,000 百万円";
  for (const value of [undefined, "enabled"]) {
    const body = await withEnv(TDNET_FLAG, value, () =>
      fetchTdnetPdfBodySummary("https://www.release.tdnet.info/x.pdf", { fetcher: async () => pdfResponse(), extractor: async () => text }));
    assert.equal(body, buildTdnetBodySummary(text));
  }
});

// ------------------------------------------------------------------ Fed statement body (real index.ts handler)

const FED_RSS = `<?xml version="1.0"?><rss><channel>
<item><title>Federal Reserve issues FOMC statement</title><link>https://www.federalreserve.gov/newsevents/pressreleases/monetary20261009a.htm</link><pubDate>Fri, 09 Oct 2026 18:00:00 GMT</pubDate><description></description></item>
<item><title>Minutes of the Federal Open Market Committee, September 15-16, 2026</title><link>https://www.federalreserve.gov/monetarypolicy/fomcminutes20260916.htm</link><pubDate>Fri, 09 Oct 2026 18:00:00 GMT</pubDate><description></description></item>
</channel></rss>`;
const STATEMENT_PAGE = `<html><head><title>Federal Reserve Board - Federal Reserve issues FOMC statement</title></head><body><div id="article"><p class="article__time">October 9, 2026</p><h3>Federal Reserve issues FOMC statement</h3><p>The Committee decided to maintain the target range for the federal funds rate at 4-1/4 to 4-1/2 percent. The action was approved by a 12 – 0 vote.</p></div><div id="footer">Last Update: October 9, 2026</div></body></html>`;

async function runFetchCycle(flag: string | undefined) {
  let handler: ((req: Request) => Promise<Response>) | null = null;
  const realServe = Deno.serve;
  const realFetch = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  (Deno as any).serve = (h: (req: Request) => Promise<Response>) => { handler = h; return { finished: Promise.resolve() }; };
  Deno.env.set("IMPORTANT_NEWS_CRON_SECRET", SECRET);
  Deno.env.set("SUPABASE_URL", BASE);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-test");
  Deno.env.delete("OPENAI_API_KEY");
  const outbound: string[] = [];
  const inserted: Array<Record<string, unknown>> = [];
  const patches: string[] = [];
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.origin === BASE) {
      const table = url.pathname.split("/").pop();
      if (table === "important_news_candidates") {
        if (method === "POST") {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          inserted.push(body);
          return json([{ id: `new-${inserted.length}` }], 201);
        }
        if (method === "PATCH") patches.push(url.search);
        return json([]);
      }
      if (table === "important_news_monitor_runs") return method === "POST" ? json([{ id: "run-1" }], 201) : new Response(null, { status: 204 });
      return json([]);
    }
    outbound.push(`${url.hostname}${url.pathname}`);
    if (url.hostname === "www.federalreserve.gov" && url.pathname === "/feeds/press_all.xml") {
      return new Response(FED_RSS, { status: 200, headers: { "content-type": "application/rss+xml" } });
    }
    if (url.pathname === "/newsevents/pressreleases/monetary20261009a.htm") {
      return new Response(STATEMENT_PAGE, { status: 200, headers: { "content-type": "text/html" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    await withEnv(FED_FLAG, flag, async () => {
      await import(`./index.ts?release-flags-${crypto.randomUUID()}`);
    });
    assert.ok(handler);
    await withEnv(FED_FLAG, flag, async () => {
      await (handler as (req: Request) => Promise<Response>)(new Request("https://fn.test/", {
        method: "POST",
        headers: { "x-important-news-cron-secret": SECRET, "content-type": "application/json" },
        body: JSON.stringify({ trigger: "manual", fetchSources: true }),
      }));
    });
    return { outbound, inserted, patches };
  } finally {
    globalThis.fetch = realFetch;
    // deno-lint-ignore no-explicit-any
    (Deno as any).serve = realServe;
  }
}

test("Fed flag OFF (unset / typo): the feed is processed as before — no statement page read and no body update", async () => {
  for (const flag of [undefined, "", "true", "Enabled", "disabled"]) {
    const { outbound, inserted, patches } = await runFetchCycle(flag);
    assert.equal(outbound.some((entry) => entry.includes("/newsevents/pressreleases/monetary")), false, String(flag));
    assert.ok(outbound.includes("www.federalreserve.gov/feeds/press_all.xml"), "the RSS itself is still read");
    const fed = inserted.filter((row) => String(row.source_url).includes("federalreserve.gov"));
    assert.equal(fed.length, 2, "statement and minutes both stored as before (title only)");
    assert.ok(fed.every((row) => row.body_summary === null));
    assert.deepEqual(patches, []);
  }
});

test("Fed flag ON: only the statement item reads its official page and is stored with the facts; minutes are untouched", async () => {
  const { outbound, inserted } = await runFetchCycle("enabled");
  const pages = outbound.filter((entry) => entry.includes("federalreserve.gov/newsevents/pressreleases") || entry.includes("fomcminutes"));
  assert.deepEqual(pages, ["www.federalreserve.gov/newsevents/pressreleases/monetary20261009a.htm"]);
  const statement = inserted.find((row) => String(row.source_url).includes("monetary20261009a"));
  assert.match(String(statement?.body_summary), /4\.25〜4\.5%（据え置き、変更なし）/u);
  const minutes = inserted.find((row) => String(row.source_url).includes("fomcminutes"));
  assert.equal(minutes?.body_summary, null);
});

test("Fed flag name is distinct from the TDnet flag and the JP official lane flag", async () => {
  const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const fetchers = await Deno.readTextFile(new URL("./official_source_fetchers.ts", import.meta.url));
  assert.match(index, /IMPORTANT_NEWS_FED_STATEMENT_BODY_ENRICHMENT/u);
  assert.equal(/IMPORTANT_NEWS_TDNET_KESSAN_FACTS/u.test(index), false);
  assert.match(fetchers, /IMPORTANT_NEWS_TDNET_KESSAN_FACTS/u);
  assert.equal(/IMPORTANT_NEWS_FED_STATEMENT_BODY_ENRICHMENT/u.test(fetchers), false);
});
