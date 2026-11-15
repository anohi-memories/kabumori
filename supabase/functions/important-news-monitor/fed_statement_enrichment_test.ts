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

test("per-fetch cap is kept and the over-cap statement is reported as deferred, not silently lost", async () => {
  let called = 0;
  const items = ["a", "b", "c"].map((n) => candidate("Federal Reserve issues FOMC statement", URL_OK.replace("0916a", `0916${n}`)));
  const out = await enrichFedStatementCandidates(items, async () => {
    called += 1;
    return htmlResponse(RAISE);
  });
  assert.equal(called, FED_STATEMENT_LIMITS.maxPerFetch);
  assert.equal(out.enriched, FED_STATEMENT_LIMITS.maxPerFetch);
  assert.equal(out.deferred, 1);
  assert.ok(out.errors.includes("fed_statement:deferred_over_cap:1"));
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
  assert.match(index, /if \(source\.key === "fed" && fedStatementBodyEnrichmentEnabled\(\)\) \{[\s\S]*?enrichFedStatementCandidates\(candidates, fetch,/u);
  assert.equal(index.match(/enrichFedStatementCandidates\(/gu)?.length, 1);
  assert.equal(/boj_document_text/u.test(index), false);
  const fetchers = await Deno.readTextFile(new URL("./official_source_fetchers.ts", import.meta.url));
  assert.equal(/boj_document_text/u.test(fetchers), false);
  const enrichment = await Deno.readTextFile(new URL("./fed_statement_enrichment.ts", import.meta.url));
  assert.equal(/boj_document_text|boj\.or\.jp/u.test(enrichment), false);
});


// ---- PR #129 R1 / F6, F7, F9 ------------------------------------------------------------------------------------

const MINUTES_HTML =
  `<html><head><title>Federal Reserve Board - Minutes of the Federal Open Market Committee, September 16-17, 2025</title></head><body><div id="article"><p class="article__time">October 8, 2025</p><h3>Minutes of the Federal Open Market Committee</h3><p>At the previous meeting the Committee decided to raise the target range for the federal funds rate by 1/4 percentage point to 3-3/4 to 4 percent. The action was approved by a 12 – 0 vote.</p></div><div id="footer">Last Update: October 8, 2025</div></body></html>`;

test("F6: a statement title that lands on older minutes is rejected, whatever the quoted decision says", async () => {
  const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
  let n = 0;
  const out = await enrichFedStatementCandidates([candidate("Federal Reserve issues FOMC statement")], async () =>
    n++ === 0 ? redirect("/monetarypolicy/fomcminutes20250917.htm") : htmlResponse(MINUTES_HTML));
  assert.equal(out.candidates.length, 0);
  assert.equal(out.enriched, 0);
  assert.deepEqual(out.errors, ["fed_statement:doc_redirected"]);
});

test("F6: minutes content served under the statement address, and a mismatching date, are rejected", async () => {
  const sameAddressMinutes = await enrichFedStatementCandidates([candidate("Federal Reserve issues FOMC statement")], async () => htmlResponse(MINUTES_HTML));
  assert.deepEqual(sameAddressMinutes.errors, ["fed_statement:doc_not_statement"]);
  const old = STATEMENT_HTML("The Committee decided to raise the target range for the federal funds rate by 1/4 percentage point to 3-3/4 to 4 percent.").replace("September 16, 2026", "September 17, 2025");
  const oldDate = await enrichFedStatementCandidates([candidate("Federal Reserve issues FOMC statement")], async () => htmlResponse(old));
  assert.deepEqual(oldDate.errors, ["fed_statement:doc_date_mismatch"]);
  const staleFeed = await enrichFedStatementCandidates([
    { ...candidate("Federal Reserve issues FOMC statement"), publishedAt: "2026-07-01T00:00:00Z" },
  ], async () => htmlResponse(RAISE));
  assert.deepEqual(staleFeed.errors, ["fed_statement:doc_date_vs_feed"]);
  const notStatementPath = await enrichFedStatementCandidates([
    candidate("Federal Reserve issues FOMC statement", "https://www.federalreserve.gov/monetarypolicy/fomcminutes20250917.htm"),
  ], async () => htmlResponse(MINUTES_HTML));
  assert.deepEqual(notStatementPath.errors, ["fed_statement:doc_url_not_statement"]);
});

test("F7: stored statements cost no fetch, so a third item behind two stored ones is reached", async () => {
  const urls = ["a", "b", "c"].map((n) => URL_OK.replace("0916a", `0916${n}`));
  const items = urls.map((url) => candidate("Federal Reserve issues FOMC statement", url));
  const stored = new Map([
    [urls[0], { id: "1", status: "pending_judgement", hasBody: true }],
    [urls[1], { id: "2", status: "no_post", hasBody: true }],
  ]);
  const fetched: string[] = [];
  const out = await enrichFedStatementCandidates(items, async (url) => {
    fetched.push(url);
    return htmlResponse(RAISE);
  }, { stored });
  assert.deepEqual(fetched, [urls[2]]);
  assert.equal(out.enriched, 1);
});

const sUrl = (n: string) => URL_OK.replace("0916a", `0916${n}`);
const statementsOf = (names: string[]) => names.map((n) => candidate("Federal Reserve issues FOMC statement", sUrl(n)));
const down = () => new Response("down", { status: 503, headers: { "content-type": "text/html" } });

test("F7: a statement behind two failing ones is reached on every run, whatever the call interval (cold start each time)", async () => {
  // Reproduction of the reviewed counterexample: 3 statements, cap 2, a call every 60 min used to rotate by
  // floor(now/10min) % 3 and never advance. Intervals are simulated through the injected clock; the result must not depend on it.
  const failing = new Set([sUrl("a"), sUrl("b")]);
  for (const intervalMinutes of [10, 30, 60]) {
    for (let run = 0; run < 6; run += 1) {
      const clock = Date.UTC(2026, 9, 11, 0, 0, 0) + run * intervalMinutes * 60_000;
      const out = await enrichFedStatementCandidates(statementsOf(["a", "b", "c"]), async (url) =>
        failing.has(url) ? down() : htmlResponse(RAISE), { memory: new Map(), random: () => 0.5, now: () => clock });
      assert.equal(out.enriched, 1, `interval ${intervalMinutes} run ${run}`);
      assert.deepEqual(out.candidates.map((item) => item.sourceUrl), [sUrl("c")]);
    }
  }
});

test("F7: failures do not use up the success cap; four statements, cap 2, all reachable in one run when they succeed", async () => {
  const out = await enrichFedStatementCandidates(statementsOf(["a", "b", "c", "d"]), async (url) =>
    url === sUrl("a") ? down() : htmlResponse(RAISE), { memory: new Map(), random: () => 0.5 });
  assert.equal(out.enriched, 2);
  assert.equal(out.withheld, 1);
  assert.equal(out.deferred, 1);
});

test("F7: a warm instance tries the statements that did not fail recently first, so six statements are all reached", async () => {
  const names = ["a", "b", "c", "d", "e", "f"];
  const failing = new Set(["a", "b", "c", "d"].map(sUrl));
  const memory = new Map<string, number>();
  const stored = new Map<string, { id: string; status: string; hasBody: boolean }>();
  const reached = new Set<string>();
  for (let run = 0; run < 3; run += 1) {
    const out = await enrichFedStatementCandidates(statementsOf(names), async (url) => {
      reached.add(url);
      return failing.has(url) ? down() : htmlResponse(RAISE);
    }, { memory, random: () => 0.5, stored });
    for (const item of out.candidates) if (item.bodySummary) stored.set(item.sourceUrl, { id: item.sourceUrl, status: "pending_judgement", hasBody: true });
  }
  assert.equal(reached.size, 6);
});

test("F7: cold start every run with random tie-break still gives every statement a turn over time", async () => {
  // seeded LCG so the run is reproducible; 6 statements, 5 of them always failing, one attempt budget of 4 per run
  let seed = 12345;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const names = ["a", "b", "c", "d", "e", "f"];
  const reached = new Map<string, number>();
  for (let run = 0; run < 24; run += 1) {
    await enrichFedStatementCandidates(statementsOf(names), async (url) => {
      reached.set(url, (reached.get(url) ?? 0) + 1);
      return down();
    }, { memory: new Map(), random });
  }
  assert.equal(reached.size, 6);
  for (const count of reached.values()) assert.ok(count > 0);
});

test("F7: the per-run time budget stops further attempts", async () => {
  let clock = 0;
  const out = await enrichFedStatementCandidates(statementsOf(["a", "b", "c"]), async () => {
    clock += 30_000;
    return down();
  }, { memory: new Map(), random: () => 0.5, now: () => clock });
  assert.equal(out.withheld, 1);
  assert.equal(out.deferred, 2);
});

test("F9: a stored unjudged statement without a body is filled in place; other statuses are never rewritten", async () => {
  const stored = new Map([
    [URL_OK, { id: "row-1", status: "pending_judgement", hasBody: false }],
    [URL_OK.replace("0916a", "0916b"), { id: "row-2", status: "published", hasBody: false }],
    [URL_OK.replace("0916a", "0916c"), { id: "row-3", status: "no_post", hasBody: false }],
  ]);
  const items = [...stored.keys()].map((url) => candidate("Federal Reserve issues FOMC statement", url));
  const out = await enrichFedStatementCandidates(items, async () => htmlResponse(RAISE), { stored });
  assert.equal(out.bodyUpdates.length, 1);
  assert.equal(out.bodyUpdates[0].id, "row-1");
  assert.match(out.bodyUpdates[0].bodySummary, /3\.75〜4%/);
  // the filled one is not emitted again as a new candidate; the others pass through (they stay duplicates)
  assert.equal(out.candidates.length, 2);
  assert.ok(out.errors.includes("fed_statement:stored_without_body:published"));
  assert.ok(out.errors.includes("fed_statement:stored_without_body:no_post"));
});
