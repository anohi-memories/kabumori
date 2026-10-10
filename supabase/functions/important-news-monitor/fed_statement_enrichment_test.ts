// deno-lint-ignore-file require-await
// Phase 7: FOMC statement enrichment of the Federal Reserve feed. Synthetic HTML only; fetch is always injected.
import assert from "node:assert/strict";
import test from "node:test";
import { enrichFedStatementCandidates, fetchFedHtml, FED_STATEMENT_LIMITS } from "./fed_statement_enrichment.ts";
import type { IncomingNewsCandidate } from "./news_candidate_logic.ts";

const STATEMENT_HTML = (decision: string) =>
  `<html><body><div id="article"><p class="article__time">September 16, 2026</p><h3>Federal Reserve issues FOMC statement</h3><p>${decision}</p><p>The action was approved by a 12 – 0 vote.</p></div><div id="footer">Last Update: September 16, 2026</div></body></html>`;
const RAISE = STATEMENT_HTML("The Committee decided to raise the target range for the federal funds rate by 1/4 percentage point to 3-3/4 to 4 percent.");
const URL_OK = "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm";

const candidate = (title: string, sourceUrl = URL_OK): IncomingNewsCandidate => ({
  sourceType: "market_macro", sourceUrl, sourceName: "market_macro", title, bodySummary: null, category: "frb", publishedAt: "2026-09-16T18:00:00Z",
});

const htmlResponse = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...headers } });

test("statement item is replaced by the official facts; the original title and url are kept", async () => {
  const calls: string[] = [];
  const out = await enrichFedStatementCandidates([candidate("Federal Reserve issues FOMC statement")], async (url) => {
    calls.push(url);
    return htmlResponse(RAISE);
  });
  assert.equal(out.enriched, 1);
  assert.equal(out.withheld, 0);
  assert.deepEqual(calls, [URL_OK]);
  const item = out.candidates[0];
  assert.equal(item.title, "Federal Reserve issues FOMC statement");
  assert.equal(item.sourceUrl, URL_OK);
  assert.match(item.bodySummary ?? "", /3\.75〜4%（引き上げ、25bp引き上げ）/);
  assert.match(item.bodySummary ?? "", /賛成12・反対0/);
});

test("minutes, projections and other items pass through untouched and trigger no fetch", async () => {
  const items = [
    candidate("Minutes of the Federal Open Market Committee, September 15-16, 2026"),
    candidate("Federal Reserve Board and FOMC release economic projections"),
    candidate("Federal Reserve Board announces something else"),
  ];
  let called = 0;
  const out = await enrichFedStatementCandidates(items, async () => {
    called += 1;
    return htmlResponse(RAISE);
  });
  assert.equal(called, 0);
  assert.deepEqual(out.candidates, items);
});

test("a statement that cannot be read is withheld, never emitted as a title-only candidate", async () => {
  const noDecision = await enrichFedStatementCandidates([candidate("Federal Reserve issues FOMC statement")], async () =>
    htmlResponse(STATEMENT_HTML("Economic activity is expanding.")));
  assert.equal(noDecision.candidates.length, 0);
  assert.equal(noDecision.withheld, 1);
  assert.match(noDecision.errors[0], /^fed_statement:facts_/);

  const failed = await enrichFedStatementCandidates([candidate("Federal Reserve issues FOMC statement")], async () => {
    throw new Error("boom");
  });
  assert.equal(failed.candidates.length, 0);
  assert.deepEqual(failed.errors, ["fed_statement:network_error"]);
});

test("per-fetch cap: statements beyond the cap are withheld without fetching", async () => {
  let called = 0;
  const items = [1, 2, 3].map((n) => candidate("Federal Reserve issues FOMC statement", `${URL_OK}?n=${n}`));
  const out = await enrichFedStatementCandidates(items, async () => {
    called += 1;
    return htmlResponse(RAISE);
  });
  assert.equal(called, FED_STATEMENT_LIMITS.maxPerFetch);
  assert.equal(out.enriched, FED_STATEMENT_LIMITS.maxPerFetch);
  assert.equal(out.withheld, 1);
});

test("unsafe urls are rejected before any request", async () => {
  const unsafe = [
    "http://www.federalreserve.gov/a.htm",
    "https://user:pw@www.federalreserve.gov/a.htm",
    "https://evil.example/www.federalreserve.gov/a.htm",
    "https://federalreserve.gov.evil.example/a.htm",
    "https://notfederalreserve.gov/a.htm",
    "ftp://www.federalreserve.gov/a.htm",
    "not a url",
    "https://www.federalreserve.gov:8443/a.htm",
  ];
  for (const url of unsafe) {
    let called = 0;
    const result = await fetchFedHtml(url, async () => {
      called += 1;
      return htmlResponse(RAISE);
    });
    assert.equal(result.ok, false, url);
    assert.equal(called, 0, url);
  }
});

test("redirects are re-validated and capped; foreign hosts and downgrades stop the fetch", async () => {
  const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
  const toForeign = await fetchFedHtml(URL_OK, async () => redirect("https://evil.example/x"));
  assert.deepEqual(toForeign, { ok: false, reason: "host_not_allowed" });
  const toHttp = await fetchFedHtml(URL_OK, async () => redirect("http://www.federalreserve.gov/x"));
  assert.deepEqual(toHttp, { ok: false, reason: "host_not_allowed" });
  let hops = 0;
  const loop = await fetchFedHtml(URL_OK, async () => {
    hops += 1;
    return redirect("/loop");
  });
  assert.deepEqual(loop, { ok: false, reason: "too_many_redirects" });
  assert.equal(hops, FED_STATEMENT_LIMITS.maxRedirects + 1);
  let n = 0;
  const followed = await fetchFedHtml(URL_OK, async () => (n++ === 0 ? redirect("/newsevents/pressreleases/moved.htm") : htmlResponse(RAISE)));
  assert.equal(followed.ok, true);
  if (followed.ok) assert.equal(followed.finalUrl, "https://www.federalreserve.gov/newsevents/pressreleases/moved.htm");
});

test("size cap (declared and streamed), content type and http errors stop safely", async () => {
  const declared = await fetchFedHtml(URL_OK, async () => htmlResponse("x", { "content-length": String(FED_STATEMENT_LIMITS.maxBytes + 1) }));
  assert.deepEqual(declared, { ok: false, reason: "too_large" });
  const streamed = await fetchFedHtml(URL_OK, async () => htmlResponse("a".repeat(FED_STATEMENT_LIMITS.maxBytes + 10)));
  assert.deepEqual(streamed, { ok: false, reason: "too_large" });
  const pdf = await fetchFedHtml(URL_OK, async () => new Response("%PDF", { status: 200, headers: { "content-type": "application/pdf" } }));
  assert.deepEqual(pdf, { ok: false, reason: "unsupported_content" });
  const notFound = await fetchFedHtml(URL_OK, async () => new Response("no", { status: 404, headers: { "content-type": "text/html" } }));
  assert.deepEqual(notFound, { ok: false, reason: "http_error" });
  const timeout = await fetchFedHtml(URL_OK, async () => {
    throw new DOMException("t", "TimeoutError");
  });
  assert.deepEqual(timeout, { ok: false, reason: "timeout" });
});

test("wiring: only the fed market_macro source is enriched in index.ts and BOJ has no new fetch path", async () => {
  const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert.match(index, /if \(source\.key === "fed"\) \{[^}]*enrichFedStatementCandidates\(candidates\)/u);
  assert.equal(index.match(/enrichFedStatementCandidates\(/gu)?.length, 1);
  assert.equal(/boj_document_text/u.test(index), false);
  const fetchers = await Deno.readTextFile(new URL("./official_source_fetchers.ts", import.meta.url));
  assert.equal(/boj_document_text/u.test(fetchers), false);
  const enrichment = await Deno.readTextFile(new URL("./fed_statement_enrichment.ts", import.meta.url));
  assert.equal(/boj_document_text|boj\.or\.jp/u.test(enrichment), false);
});
