// Article lead for BBC / Al Jazeera trigger candidates (2026-09-28): the first body paragraphs are
// added to the candidate summary as judgement material. Never a gate: a failed or empty fetch keeps the
// RSS-only candidate. Only the extracted text is kept, never the page HTML.
import assert from "node:assert/strict";
import test from "node:test";
import {
  extractArticleLead,
  httpArticleLeadFetcher,
  LEAD_MAX_CHARS,
  LEAD_TARGET_CHARS,
  primaryCandidate,
  primarySourceUrl,
  runHeadlineTriggerLane,
  type ArticleLeadFetcher,
  type TriggerHeadline,
  type TriggerHistory,
} from "./headline_trigger_logic.ts";

const NOW = new Date("2026-09-28T10:05:00Z");
const EMPTY: TriggerHistory = { seenUrls: new Set(), seenTitles: new Set(), deferred: [] };

// Structure of the 2026-09-28 Al Jazeera page (navigation, share buttons, figure, then div.wysiwyg).
const AJ_OIL_PAGE = `<html><body><header><nav><p>play Live Sign up Show navigation menu News Africa Asia US &amp; Canada Latin America Europe</p></nav></header>
<main><div class="article-header"><p>Listen (2 mins)</p><p>Save</p><p>Share</p></div>
<figure><img src="x.jpg"><figcaption><p>Commercial vessels anchored in the Strait of Hormuz off Bandar Abbas, Iran [File: Reuters]</p></figcaption></figure>
<div class="wysiwyg wysiwyg--all-content">
<p>Oil prices have risen sharply following United States President Donald Trump&rsquo;s rejection of an Iranian proposal to reopen the Strait of Hormuz within seven days.</p>
<script>var ad = "<p>advertisement advertisement advertisement advertisement</p>";</script>
<p>Brent crude, the international benchmark, rose more than 3 percent on Monday, nearing $108 a barrel during trading in Asia.</p>
<aside><p>Recommended stories: list of 4 items about the war on Iran and oil markets</p></aside>
<p>Japan and South Korea&#x2019;s benchmark Nikkei 225 and Kospi indexes fell 0.73 percent and 2.70 percent, respectively.</p>
<p>The latest market volatility comes after Trump said on Saturday Tehran&#39;s latest proposal for ending the US-Israel war on Iran was not acceptable.</p>
</div></main><footer><p>About Us Code of Ethics Terms and Conditions Privacy Policy Cookie Policy</p></footer></body></html>`;

const BBC_PAGE = `<html><body><header><p>BBC Homepage Skip to content Accessibility Help Your account Home News Sport</p></header>
<article><h1>Trump rejects Iran's offer to reopen Strait of Hormuz</h1><figure><figcaption><p>Getty Images Commercial ships in the Gulf near the strait</p></figcaption></figure>
<div data-component="text-block"><p>US President Donald Trump has rejected an Iranian proposal to reopen the Strait of Hormuz to commercial shipping within a week.</p></div>
<div data-component="text-block"><p>He told reporters at the White House that Tehran &quot;want to make a deal where they open the Strait immediately&quot;.</p></div>
</article><div><p>Related: more stories you may like from around the BBC network today and this week</p></div></body></html>`;

test("Al Jazeera: body paragraphs only, in order, entities decoded, no nav/buttons/caption/script/aside/footer", () => {
  const lead = extractArticleLead("al_jazeera", AJ_OIL_PAGE)!;
  assert.match(lead, /^Oil prices have risen sharply following United States President Donald Trump’s rejection/);
  assert.match(lead, /Brent crude, the international benchmark, rose more than 3 percent/);
  assert.match(lead, /Nikkei 225 and Kospi indexes fell 0\.73 percent and 2\.70 percent/);
  assert.match(lead, /Tehran's latest proposal/);
  for (const noise of ["navigation", "Listen", "Save", "Commercial vessels", "advertisement", "Recommended", "Cookie"]) {
    assert.ok(!lead.includes(noise), noise);
  }
});

test("BBC: text inside <article> only; headline, captions and outside-article links excluded", () => {
  const lead = extractArticleLead("bbc_world", BBC_PAGE)!;
  assert.equal(lead, 'US President Donald Trump has rejected an Iranian proposal to reopen the Strait of Hormuz to commercial shipping within a week. He told reporters at the White House that Tehran "want to make a deal where they open the Strait immediately".');
});

test("length: stops after the target, never exceeds the max; one huge paragraph is clipped", () => {
  const paragraph = (i: number) => `<p>Paragraph ${i} ${"x".repeat(290)}</p>`;
  const page = `<div class="wysiwyg">${Array.from({ length: 10 }, (_, i) => paragraph(i)).join("")}</div>`;
  const lead = extractArticleLead("al_jazeera", page)!;
  assert.ok(lead.length >= LEAD_TARGET_CHARS && lead.length <= LEAD_MAX_CHARS, String(lead.length));
  const huge = extractArticleLead("al_jazeera", `<div class="wysiwyg"><p>${"y".repeat(5000)}</p></div>`)!;
  assert.equal(huge.length, LEAD_MAX_CHARS);
});

test("no recognised body, other sources and short-only paragraphs give null", () => {
  assert.equal(extractArticleLead("al_jazeera", "<html><p>A paragraph long enough to count as text but outside any body container.</p></html>"), null);
  assert.equal(extractArticleLead("bbc_world", "<html><div>no article</div></html>"), null);
  assert.equal(extractArticleLead("cnn", BBC_PAGE), null);
  assert.equal(extractArticleLead("al_jazeera", '<div class="wysiwyg"><p>Save</p><p>Share</p></div>'), null);
});

test("the HTTP fetcher returns the extracted lead only, and raises on HTTP errors", async () => {
  const ok = httpArticleLeadFetcher(() => Promise.resolve(new Response(AJ_OIL_PAGE, { status: 200 })));
  const lead = await ok("al_jazeera", "https://www.aljazeera.com/economy/2026/9/28/oil");
  assert.ok(lead && !lead.includes("<"));
  const blocked = httpArticleLeadFetcher(() => Promise.resolve(new Response("denied", { status: 403 })));
  await assert.rejects(blocked("bbc_world", "https://www.bbc.co.uk/news/articles/x"), /LEAD_HTTP_403/);
});

const OIL: TriggerHeadline = {
  id: "", source: "al_jazeera",
  title: "Oil prices surge after Trump rejects Iran’s plan to reopen Strait of Hormuz",
  url: "https://www.aljazeera.com/economy/2026/9/28/oil-prices-surge-after-trump-rejects-irans-plan-to-reopen-strait-of-hormuz?traffic_source=rss",
  publishedAt: "2026-09-28T09:40:00Z",
  summary: "Brent crude rises more than 3 percent to top $107 a barrel.",
};

const triage = (headlines: TriggerHeadline[]) => Promise.resolve({
  results: new Map(headlines.map((item) => [item.id, { decision: "verify" as const, category: "war_ceasefire" as const, reason: "r", searchTerms: "" }])),
  inputTokens: 100, outputTokens: 10,
});

test("replay (2026-09-28 oil surge): the candidate now carries the article lead after the unchanged label", async () => {
  const seen: string[] = [];
  const fetchArticleLead: ArticleLeadFetcher = (source, url) => {
    seen.push(url);
    return Promise.resolve(extractArticleLead(source, AJ_OIL_PAGE));
  };
  const result = await runHeadlineTriggerLane({ headlines: [OIL], feeds: {}, history: EMPTY, triage, fetchArticleLead, now: NOW });
  assert.deepEqual(seen, ["https://www.aljazeera.com/economy/2026/9/28/oil-prices-surge-after-trump-rejects-irans-plan-to-reopen-strait-of-hormuz"]);
  const [candidate] = result.candidates;
  assert.equal(candidate.sourceUrl, seen[0], "traffic_source dropped");
  // Before (v78): label + RSS summary only.
  const before = primaryCandidate(OIL, "war_ceasefire", "news");
  assert.equal(before.bodySummary, "[単一ソース: Al Jazeera 記事（RSS見出し・本文要約）] Brent crude rises more than 3 percent to top $107 a barrel.");
  // After: same label and summary, then the lead with the market facts judgement lacked.
  assert.ok(candidate.bodySummary!.startsWith(`${before.bodySummary} 本文冒頭: Oil prices have risen sharply`));
  assert.match(candidate.bodySummary!, /Nikkei 225 and Kospi indexes fell 0\.73 percent/);
  const [item] = result.diagnostics.items;
  assert.equal(item.articleLeadStatus, "ok");
  assert.ok((item.articleLeadChars ?? 0) > 300);
  assert.equal(result.diagnostics.articleLeadOkCount, 1);
  assert.ok(!JSON.stringify(result.diagnostics).includes("<div"), "no HTML in diagnostics");
});

test("a failed or empty lead fetch keeps the RSS-only candidate", async () => {
  const failed = await runHeadlineTriggerLane({
    headlines: [OIL], feeds: {}, history: EMPTY, triage, now: NOW,
    fetchArticleLead: () => Promise.reject(new Error("LEAD_HTTP_403")),
  });
  assert.equal(failed.candidates.length, 1);
  assert.equal(failed.candidates[0].bodySummary, primaryCandidate(OIL, "war_ceasefire", "news").bodySummary);
  assert.equal(failed.diagnostics.items[0].articleLeadStatus, "failed:LEAD_HTTP_403");
  const empty = await runHeadlineTriggerLane({
    headlines: [OIL], feeds: {}, history: EMPTY, triage, now: NOW, fetchArticleLead: () => Promise.resolve(null),
  });
  assert.equal(empty.candidates.length, 1);
  assert.equal(empty.diagnostics.items[0].articleLeadStatus, "empty");
  const none = await runHeadlineTriggerLane({ headlines: [OIL], feeds: {}, history: EMPTY, triage, now: NOW });
  assert.equal(none.diagnostics.items[0].articleLeadStatus, "not_attempted");
});

test("leads are fetched only for created candidates (not for ignore/watch or duplicates)", async () => {
  const fetched: string[] = [];
  await runHeadlineTriggerLane({
    headlines: [OIL, { ...OIL, url: "https://www.aljazeera.com/news/2026/9/28/sport", title: "Football result" }],
    feeds: {}, history: EMPTY, now: NOW,
    triage: (headlines) => Promise.resolve({
      results: new Map(headlines.map((item) => [item.id, {
        decision: item.title === "Football result" ? "ignore" as const : "verify" as const,
        category: "war_ceasefire" as const, reason: "r", searchTerms: "",
      }])),
      inputTokens: 1, outputTokens: 1,
    }),
    fetchArticleLead: (_source, url) => { fetched.push(url); return Promise.resolve(null); },
  });
  assert.equal(fetched.length, 1);
});

test("campaign parameters of both feeds are dropped from the stored URL", () => {
  assert.equal(primarySourceUrl("https://www.bbc.co.uk/news/articles/x?at_medium=RSS&at_campaign=rss"), "https://www.bbc.co.uk/news/articles/x");
  assert.equal(primarySourceUrl("https://www.aljazeera.com/news/2026/9/28/x?traffic_source=rss"), "https://www.aljazeera.com/news/2026/9/28/x");
  assert.equal(primarySourceUrl("https://www.aljazeera.com/news/x?page=2"), "https://www.aljazeera.com/news/x?page=2");
});
