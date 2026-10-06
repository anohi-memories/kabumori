// deno-lint-ignore-file require-await
import assert from "node:assert/strict";
import test from "node:test";
import { classifyEnrichmentFailure, isUnreadableOfficialUrl, type EnrichmentResult } from "./jp_official_enrichment.ts";
import {
  collapseSameEventItems,
  createPermanentFailureMemory,
  JP_OFFICIAL_SAME_EVENT_WINDOW_MS,
  runJpOfficialFill,
  type JpLaneDeps,
} from "./jp_official_lane_logic.ts";
import {
  type JpOfficialSelected,
  type NewsDiscoverySignalRow,
  selectJpOfficialSignals,
  toJpOfficialIncomingCandidate,
} from "./jp_official_signal_fetchers.ts";

const NOW = new Date("2026-10-06T03:00:00.000Z");
let seq = 0;
function item(over: Partial<NewsDiscoverySignalRow> = {}): JpOfficialSelected {
  seq += 1;
  const row: NewsDiscoverySignalRow = {
    id: `id-${seq}`, source_id: "jp_kantei_news", source_url: `https://www.kantei.go.jp/jp/105/discourse/${seq}.html`, canonical_url: null,
    title: "高市総理は北朝鮮からの弾道ミサイルの可能性があるものの発射に関する総理指示を行いました", summary_hint: null,
    published_at: "2026-10-06T01:00:00.000Z", published_date: null, source_updated_at: null, fetched_at: "2026-10-06T02:00:00.000Z", ...over,
  };
  const { selected } = selectJpOfficialSignals([row], NOW);
  assert.equal(selected.length, 1, JSON.stringify(row));
  return selected[0];
}
const minutes = (n: number) => new Date(Date.parse("2026-10-06T01:00:00.000Z") + n * 60_000).toISOString();

// ------------------------------------------------------------ hardening 1

test("same source + same title published within 30 minutes (two URLs) collapse to the earliest one", () => {
  const first = item({ published_at: minutes(0) });
  const second = item({ published_at: minutes(10) });
  const { kept, collapsed } = collapseSameEventItems([second, first]);
  assert.equal(collapsed, 1);
  assert.deepEqual(kept.map((i) => i.sourceUrl), [first.sourceUrl]);
});

test("same title but a genuinely separate event (3h apart, the 15:06 / 18:01 missile directives) is kept", () => {
  const a = item({ published_at: minutes(0) });
  const b = item({ published_at: minutes(175) });
  assert.equal(collapseSameEventItems([a, b]).kept.length, 2);
  const edge = item({ published_at: minutes(JP_OFFICIAL_SAME_EVENT_WINDOW_MS / 60_000 + 1) });
  assert.equal(collapseSameEventItems([a, edge]).kept.length, 2, "just beyond the window is separate");
});

test("same title from a different source, and different titles from one source, are never collapsed", () => {
  const a = item({ title: "総合経済対策について", published_at: minutes(0) });
  const other = item({ source_id: "jp_mof_news", source_url: "https://www.mof.go.jp/a.html", title: "総合経済対策について ", published_at: minutes(5) });
  assert.equal(other.sourceId, "jp_mof_news");
  assert.equal(collapseSameEventItems([a, other]).kept.length, 2);
  const differentTitle = item({ title: "弾道ミサイル発射に関する総理指示（第2報）", published_at: minutes(5) });
  assert.equal(collapseSameEventItems([item({ published_at: minutes(0) }), differentTitle]).kept.length, 2);
});

test("same URL twice in one read is already dropped at selection (existing rule), different URL needs the collapse", () => {
  const row = (url: string, at: string) => ({
    id: url, source_id: "jp_kantei_news", source_url: url, canonical_url: null, title: "経済財政諮問会議", summary_hint: null,
    published_at: at, published_date: null, source_updated_at: null, fetched_at: "2026-10-06T02:00:00.000Z",
  });
  const { selected, drops } = selectJpOfficialSignals([row("https://www.kantei.go.jp/a.html", minutes(0)), row("https://www.kantei.go.jp/a.html", minutes(1)), row("https://www.kantei.go.jp/b.html", minutes(2))], NOW);
  assert.equal(drops.duplicate_in_batch, 1);
  assert.equal(collapseSameEventItems(selected).kept.length, 1);
});

test("the stored title-duplicate identity is bucketed by time: same release collides, a later repeat of the title does not", () => {
  const key = (i: JpOfficialSelected) => toJpOfficialIncomingCandidate(i, "b").entityKey;
  assert.equal(key(item({ published_at: "2026-10-06T01:00:00.000Z" })), key(item({ published_at: "2026-10-06T01:20:00.000Z" })));
  assert.notEqual(key(item({ published_at: "2026-10-06T01:00:00.000Z" })), key(item({ published_at: "2026-10-06T04:00:00.000Z" })));
  assert.match(String(key(item())), /^jp_official:jp_kantei_news:\d+$/);
});

// ------------------------------------------------------------ hardening 2

test("failure classes: temporary vs permanent", () => {
  assert.equal(classifyEnrichmentFailure({ reason: "timeout" }), "temporary");
  assert.equal(classifyEnrichmentFailure({ reason: "network_error" }), "temporary");
  assert.equal(classifyEnrichmentFailure({ reason: "http_error", status: 503 }), "temporary");
  assert.equal(classifyEnrichmentFailure({ reason: "http_error", status: 429 }), "temporary");
  for (const status of [404, 410, 403, 401]) assert.equal(classifyEnrichmentFailure({ reason: "http_error", status }), "permanent", String(status));
  for (const reason of ["invalid_url", "host_not_allowed", "unsupported_content", "too_large", "empty_text", "too_many_redirects"] as const) {
    assert.equal(classifyEnrichmentFailure({ reason }), "permanent", reason);
  }
  assert.equal(classifyEnrichmentFailure({ reason: "http_error" }), "permanent");
});

test("PDF / XML / spreadsheet links are dropped at selection for enriched sources, with no HTTP", () => {
  const row = (url: string) => ({
    id: url, source_id: "jp_mof_news", source_url: url, canonical_url: null, title: "外国為替平衡操作の実施状況", summary_hint: null,
    published_at: minutes(0), published_date: null, source_updated_at: null, fetched_at: "2026-10-06T02:00:00.000Z",
  });
  const { selected, drops } = selectJpOfficialSignals([row("https://www.mof.go.jp/a.pdf"), row("https://www.mof.go.jp/b.xls"), row("https://www.mof.go.jp/c.html")], NOW);
  assert.equal(selected.length, 1);
  assert.equal(drops.unsupported_url, 2);
  assert.equal(isUnreadableOfficialUrl("not a url"), true);
});

function laneDeps(over: Partial<JpLaneDeps> & { enrichResults?: Map<string, EnrichmentResult> } = {}) {
  const calls: string[] = [];
  const inserted: string[] = [];
  const stored = new Set<string>();
  const deps: JpLaneDeps = {
    enrich: async (i) => { calls.push(i.sourceUrl); return over.enrichResults?.get(i.sourceUrl) ?? { ok: true, text: "本文です。十分な長さがあります。", finalUrl: i.sourceUrl }; },
    isStored: async (i) => stored.has(i.sourceUrl),
    insert: async (i) => { inserted.push(i.sourceUrl); return { status: "pending_judgement", id: `id-${inserted.length}`, duplicateOf: null }; },
    now: () => 0,
    memory: createPermanentFailureMemory(),
    ...over,
  };
  return { deps, calls, inserted, stored };
}
const safe = (e: unknown) => (e instanceof Error ? e.message : "ERR");

test("a permanently failing item at the head of a source does not use a slot or block the items behind it", async () => {
  const items = Array.from({ length: 8 }, (_, i) => item({ title: `経済財政諮問会議${i}`, published_at: minutes(i * 5) }));
  const enrichResults = new Map<string, EnrichmentResult>(items.slice(0, 3).map((i) => [i.sourceUrl, { ok: false, reason: "http_error", status: 404 }]));
  const { deps, inserted } = laneDeps({ enrichResults });
  const outcome = await runJpOfficialFill(new Map([["jp_kantei_news", items]]), 4, 25_000, deps, safe);
  assert.equal(outcome.inserted, 4, "the quota is filled with stored candidates");
  assert.deepEqual(inserted, items.slice(3, 7).map((i) => i.sourceUrl));
  assert.equal(outcome.skipped.enrich_permanent_http_error, 3);
  assert.equal(outcome.deferred, 1);
});

test("a permanent failure is remembered (no second HTTP in a warm isolate); a temporary one is retried", async () => {
  const [bad, flaky] = [item({ title: "経済財政諮問会議A", published_at: minutes(0) }), item({ title: "経済財政諮問会議B", published_at: minutes(60) })];
  const enrichResults = new Map<string, EnrichmentResult>([
    [bad.sourceUrl, { ok: false, reason: "unsupported_content" }],
    [flaky.sourceUrl, { ok: false, reason: "timeout" }],
  ]);
  const memory = createPermanentFailureMemory();
  const first = laneDeps({ enrichResults, memory });
  await runJpOfficialFill(new Map([["jp_kantei_news", [bad, flaky]]]), 4, 25_000, first.deps, safe);
  assert.equal(first.calls.length, 2);
  const second = laneDeps({ enrichResults, memory });
  const outcome = await runJpOfficialFill(new Map([["jp_kantei_news", [bad, flaky]]]), 4, 25_000, second.deps, safe);
  assert.deepEqual(second.calls, [flaky.sourceUrl], "only the temporary failure is tried again");
  assert.equal(outcome.skipped.known_permanent_failure, 1);
  assert.equal(outcome.skipped.enrich_temporary_timeout, 1);
});

test("round-robin across sources is kept: a source full of failures cannot starve the other source", async () => {
  const kantei = Array.from({ length: 5 }, (_, i) => item({ title: `経済財政諮問会議${i}`, published_at: minutes(i * 5) }));
  const mof = [1, 2, 3].map((i) => item({ source_id: "jp_mof_news", source_url: `https://www.mof.go.jp/p${i}.html`, title: `外国為替平衡操作の実施状況${i}`, published_at: minutes(i * 5) }));
  const enrichResults = new Map<string, EnrichmentResult>(kantei.map((i) => [i.sourceUrl, { ok: false, reason: "http_error", status: 404 }]));
  const { deps, inserted } = laneDeps({ enrichResults });
  const outcome = await runJpOfficialFill(new Map([["jp_kantei_news", kantei], ["jp_mof_news", mof]]), 6, 25_000, deps, safe);
  assert.equal(outcome.inserted, 3);
  assert.deepEqual(inserted, mof.map((i) => i.sourceUrl));
});

test("stored recheck right before the insert: a same-event item stored earlier in the run is not inserted twice", async () => {
  const a = item({ published_at: minutes(0) });
  const b = item({ published_at: minutes(5) });
  const { deps, inserted } = laneDeps();
  deps.isStored = async () => inserted.length > 0; // the second item sees the first one already stored
  const outcome = await runJpOfficialFill(new Map([["jp_kantei_news", [a, b]]]), 6, 25_000, deps, safe);
  assert.equal(inserted.length, 1);
  assert.equal(outcome.alreadyKnown, 1);
});

test("an unexpected error in one item is isolated; the next item is still processed; time budget stops drawing", async () => {
  const items = [0, 1, 2].map((i) => item({ title: `経済財政諮問会議${i}`, published_at: minutes(i * 5) }));
  const { deps, inserted } = laneDeps();
  let n = 0;
  deps.insert = async (i) => { n += 1; if (n === 1) throw new Error("NEWS_CANDIDATE_INSERT_FAILED"); inserted.push(i.sourceUrl); return { status: "pending_judgement", id: "x", duplicateOf: null }; };
  const outcome = await runJpOfficialFill(new Map([["jp_kantei_news", items]]), 6, 25_000, deps, safe);
  assert.equal(outcome.errors.length, 1);
  assert.equal(inserted.length, 2);
  let clock = 0;
  const timed = laneDeps({ now: () => (clock += 20_000) });
  const late = await runJpOfficialFill(new Map([["jp_kantei_news", items]]), 6, 25_000, timed.deps, safe);
  assert.ok((late.skipped.time_budget ?? 0) >= 1);
});

test("a title-only hint (no body) is a permanent skip for non-enriched sources", async () => {
  const jma = item({ source_id: "jp_jma_extra", source_url: "https://www.jma.go.jp/a.xml", title: "大雨特別警報", summary_hint: "大雨特別警報" });
  const { deps, inserted } = laneDeps();
  const outcome = await runJpOfficialFill(new Map([["jp_jma_extra", [jma]]]), 6, 25_000, deps, safe);
  assert.equal(inserted.length, 0);
  assert.equal(outcome.skipped.no_body, 1);
});
