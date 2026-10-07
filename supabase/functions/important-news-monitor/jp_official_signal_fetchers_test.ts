import assert from "node:assert/strict";
import test from "node:test";
import { MAX_JP_OFFICIAL_CANDIDATES_PER_FETCH, planSourceFairCandidateBatch } from "./fetch_resource_limit_logic.ts";
import { JP_OFFICIAL_JUDGEMENT_GUIDANCE, jpOfficialJudgementInstructions } from "./importance_judgement_logic.ts";
import {
  fetchJpOfficialSignalRows,
  httpsSourceUrl,
  JP_OFFICIAL_ALLOWED_DOMAINS,
  jpOfficialBodySummary,
  type NewsDiscoverySignalRow,
  selectJpOfficialSignals,
  signalPublishedAt,
  toJpOfficialIncomingCandidate,
} from "./jp_official_signal_fetchers.ts";

const NOW = new Date("2026-10-06T03:00:00.000Z");
let seq = 0;
const row = (over: Partial<NewsDiscoverySignalRow>): NewsDiscoverySignalRow => {
  seq += 1;
  return {
    id: `id-${seq}`,
    source_id: "jp_mof_news",
    source_url: `https://www.mof.go.jp/news/${seq}.html`,
    canonical_url: null,
    title: "外国為替平衡操作の実施状況",
    summary_hint: null,
    published_at: "2026-10-06T01:00:00.000Z",
    published_date: null,
    source_updated_at: null,
    fetched_at: "2026-10-06T02:00:00.000Z",
    ...over,
  };
};

test("selects fresh themed releases and counts every drop by reason", () => {
  const { selected, drops } = selectJpOfficialSignals([
    row({}),
    row({ title: "10年利付国債の入札結果" }),
    row({ published_at: "2026-10-01T00:00:00.000Z" }),
    row({ published_at: "2026-10-07T00:00:00.000Z" }),
    row({ published_at: null }),
    row({ source_id: "jp_esri", source_url: "https://www.esri.cao.go.jp/a" }),
    row({ source_url: "https://evil.example.com/a" }),
    row({ source_url: "ftp://www.mof.go.jp/a" }),
  ], NOW);
  assert.equal(selected.length, 1);
  assert.deepEqual(drops, { routine: 1, stale: 1, future: 1, no_time: 1, source_not_connected: 1, host_not_allowed: 1, bad_url: 1 });
});

test("duplicate urls inside one read are collapsed; http is upgraded to https", () => {
  const first = row({ source_url: "http://www.mof.go.jp/same.html" });
  const second = row({ source_url: "https://www.mof.go.jp/same.html" });
  const { selected, drops } = selectJpOfficialSignals([first, second], NOW);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].sourceUrl, "https://www.mof.go.jp/same.html");
  assert.equal(drops.duplicate_in_batch, 1);
});

test("published time falls back to updated time, then a JST date", () => {
  assert.equal(signalPublishedAt(row({ published_at: null, source_updated_at: "2026-10-06T00:00:00Z" })), "2026-10-06T00:00:00.000Z");
  assert.equal(signalPublishedAt(row({ published_at: null, published_date: "2026-10-06" })), "2026-10-05T15:00:00.000Z");
  assert.equal(signalPublishedAt(row({ published_at: "garbage" })), null);
  assert.equal(httpsSourceUrl("https://u:p@www.mof.go.jp/a"), null);
});

test("body: enriched text with attribution; title-only hints are not a body; JMA uses the feed hint", () => {
  const [mof] = selectJpOfficialSignals([row({})], NOW).selected;
  assert.match(jpOfficialBodySummary(mof, "実績額は0円です。") ?? "", /^実績額は0円です。\n（出典：財務省ウェブサイト）$/);
  assert.equal(jpOfficialBodySummary(mof, null), null);
  const [jma] = selectJpOfficialSignals([
    row({ source_id: "jp_jma_extra", source_url: "https://www.jma.go.jp/a.xml", title: "大雨特別警報", summary_hint: "大雨特別警報 ○○県" }),
  ], NOW).selected;
  assert.match(jpOfficialBodySummary(jma, null) ?? "", /○○県/);
  const [same] = selectJpOfficialSignals([
    row({ source_id: "jp_jma_extra", source_url: "https://www.jma.go.jp/b.xml", title: "大雨特別警報", summary_hint: "大雨特別警報" }),
  ], NOW).selected;
  assert.equal(jpOfficialBodySummary(same, null), null);
});

test("incoming candidate maps to the legacy market_macro shape under source_name jp_official", () => {
  const [item] = selectJpOfficialSignals([row({})], NOW).selected;
  const candidate = toJpOfficialIncomingCandidate(item, "本文");
  assert.equal(candidate.sourceType, "market_macro");
  assert.equal(candidate.sourceName, "jp_official");
  assert.match(String(candidate.entityKey), /^jp_official:jp_mof_news:\d+$/);
  assert.equal(candidate.category, "fx");
  assert.equal(candidate.companyCode, null);
  assert.ok(JP_OFFICIAL_ALLOWED_DOMAINS.includes("mof.go.jp"));
  assert.equal(JP_OFFICIAL_ALLOWED_DOMAINS.includes("esri.cao.go.jp"), false);
});

test("signal read is a SELECT with a fixed column list and policy filters; failures throw a short code", async () => {
  let requested = "";
  let method = "";
  const rows = await fetchJpOfficialSignalRows({
    supabaseUrl: "https://x.supabase.co",
    serviceRoleKey: "k",
    now: NOW,
    fetchImpl: (url, init) => {
      requested = url;
      method = init?.method ?? "GET";
      return Promise.resolve(Response.json([row({}), { bogus: true }]));
    },
  });
  assert.equal(rows.length, 1);
  assert.equal(method, "GET");
  assert.match(requested, /news_discovery_signals\?/);
  assert.match(requested, /policy=eq\.DIRECT_SOURCE/);
  assert.match(requested, /restricted_publisher=eq\.false/);
  assert.doesNotMatch(requested, /jp_esri|jp_jma_eqvol/);
  await assert.rejects(
    fetchJpOfficialSignalRows({ supabaseUrl: "https://x.supabase.co", serviceRoleKey: "k", now: NOW, fetchImpl: () => Promise.resolve(new Response("no", { status: 500 })) }),
    /JP_OFFICIAL_SIGNALS_LOOKUP_FAILED/,
  );
});

test("lane fairness: the JP quota is its own and is shared round-robin across JP sources", () => {
  const groups = ["jp_mof_news", "jp_fsa_news", "jp_kantei_news"].map((sourceKey) => ({
    sourceKey,
    candidates: Array.from({ length: 10 }, (_, i) => `${sourceKey}-${i}`),
  }));
  const plan = planSourceFairCandidateBatch(groups, MAX_JP_OFFICIAL_CANDIDATES_PER_FETCH);
  assert.equal(plan.selectedCandidates.length, MAX_JP_OFFICIAL_CANDIDATES_PER_FETCH);
  for (const id of ["jp_mof_news", "jp_fsa_news", "jp_kantei_news"]) {
    assert.equal(plan.selectedCandidates.filter((c) => c.startsWith(id)).length, MAX_JP_OFFICIAL_CANDIDATES_PER_FETCH / 3);
  }
  assert.equal(plan.deferredCandidateCount, 30 - MAX_JP_OFFICIAL_CANDIDATES_PER_FETCH);
});

test("judgement guidance is added only for jp_official and does not claim JP implies importance", () => {
  const base = {
    sourceType: "market_macro", sourceUrl: "https://www.mof.go.jp/a", sourceName: "jp_official", title: "t", bodySummary: "b",
    companyName: null, companyCode: null, entityKey: null, category: "fx" as const, publishedAt: NOW.toISOString(),
  };
  assert.deepEqual(jpOfficialJudgementInstructions(base), [JP_OFFICIAL_JUDGEMENT_GUIDANCE]);
  assert.deepEqual(jpOfficialJudgementInstructions({ ...base, sourceName: "boj" }), []);
  assert.deepEqual(jpOfficialJudgementInstructions({ ...base, sourceName: "reuters" }), []);
  assert.match(JP_OFFICIAL_JUDGEMENT_GUIDANCE, /重要度の根拠になりません/);
});

test("flag OFF: the lane's only entry point is behind the env flag and fetchSources (no read, no HTTP, no insert)", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const call = source.indexOf("await fetchJpOfficialSignalRows(");
  assert.ok(call > 0);
  assert.equal(source.indexOf("await fetchJpOfficialSignalRows(", call + 1), -1);
  const guard = source.lastIndexOf('if (body.fetchSources === true && Deno.env.get("IMPORTANT_NEWS_JP_OFFICIAL_LANE") === "enabled")', call);
  assert.ok(guard > 0 && call - guard < 400);
  // Nothing JP-related other than declarations and zeroed counters runs before the guard.
  const beforeGuard = source.slice(0, guard);
  assert.equal(/fetchOfficialPageText\(|selectJpOfficialSignals\(/u.test(beforeGuard.replace(/^import[\s\S]*?;\n/gmu, "")), false);
});

test("source spoof: the URL host must belong to the signal's own source_id (fake go.jp hosts, cross-source URLs, IP hosts)", () => {
  const spoofed = [
    row({ source_url: "https://evil-mof.go.jp/a.html" }),
    row({ source_url: "https://mof.go.jp.evil.com/a.html" }),
    row({ source_url: "https://www.fsa.go.jp/news/a.html" }),
    row({ source_url: "https://169.254.169.254/a.html" }),
    row({ source_url: "https://www.mof.go.jp./a.html" }),
    row({ source_id: "jp_kantei_news", source_url: "https://www.mof.go.jp/a.html", title: "経済財政諮問会議" }),
  ];
  const { selected, drops } = selectJpOfficialSignals(spoofed, NOW);
  assert.equal(selected.length, 0);
  assert.equal(drops.host_not_allowed, spoofed.length);
});
