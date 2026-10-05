// JP Coverage Phase A (2026-10-06): regression pins for the year rule after ff8cfd30 ("limit MISSING_EXPLICIT_YEAR
// to years the news itself depends on"). 15 of the 36 failures of 9/22-10/05 were MISSING_EXPLICIT_YEAR; the
// offline replay of all 15 (and 86 of 88 over 30 days) is released by that rule, so the rule is not changed here.
// The properties below are what a "supply the year from TDnet's disclosure date" shortcut would break, so they
// are pinned: a year is never invented, a fiscal period is never confused with the publication year, a year the
// headline or labelled event date states stays required, and other sources behave exactly the same.
import assert from "node:assert/strict";
import test from "node:test";
import { explicitYears, type GenerationCandidate, localFactIssues } from "./post_generation_logic.ts";

const TDNET_URL = "https://www.release.tdnet.info/inbs/example.pdf";

function candidateOf(overrides: Partial<GenerationCandidate>): GenerationCandidate {
  return {
    id: "candidate-1",
    sourceType: "tdnet",
    sourceUrl: TDNET_URL,
    sourceName: "tdnet",
    title: "お知らせ",
    bodySummary: null,
    companyName: "テスト",
    companyCode: "12340",
    entityKey: "company:12340",
    category: "other",
    publishedAt: "2026-10-02T00:00:00.000Z",
    importance: "important",
    affectedEntities: [],
    japanMarketRelevance: "low",
    judgementReason: "理由",
    judgementFactStatus: "passed",
    status: "ready_for_generation",
    ...overrides,
  } as unknown as GenerationCandidate;
}

const post = (text: string, sourceUrl = TDNET_URL) => `【重要ニュース】${text}\n出典: ${sourceUrl}`;
const yearIssue = (candidate: GenerationCandidate, text: string) =>
  localFactIssues(candidate, post(text, candidate.sourceUrl)).includes("MISSING_EXPLICIT_YEAR");

test("a year-less headline with only relative wording in the post: no year is required or invented", () => {
  const candidate = candidateOf({
    title: "自己株式の取得結果および取得終了に関するお知らせ",
    judgementReason: "自己株式取得が終了した",
    bodySummary: "取得期間 令和8年9月1日から令和8年9月30日まで\n取得した株式の総数 1,000,000株\n2025年度の取得枠は別に決議済みです。",
  });
  assert.deepEqual(explicitYears(candidate), [], "the publication year (2026) is never added as a required year");
  assert.equal(yearIssue(candidate, "本日、自己株式の取得が終了したと発表しました。取得は今月までに完了しています。"), false);
});

test("the publication date unknown or malformed: still no year is fabricated", () => {
  for (const publishedAt of ["", "unknown", "not-a-date"]) {
    const candidate = candidateOf({ publishedAt, title: "業績予想の修正に関するお知らせ", bodySummary: "売上高は前期比で増加しました。" });
    assert.deepEqual(explicitYears(candidate), [], JSON.stringify(publishedAt));
  }
});

test("a fiscal period is not the publication year: the headline's 2027年 is what the post must state", () => {
  const candidate = candidateOf({
    category: "earnings",
    title: "2027年5月期第1四半期決算短信〔日本基準〕(非連結)",
    bodySummary: "2027年5月期第1四半期の売上高は10億円です。",
  });
  assert.deepEqual(explicitYears(candidate), ["2027"]);
  assert.equal(yearIssue(candidate, "2026年9月に決算を発表しました。売上高は10億円です。"), true, "the publication year 2026 does not stand in for 2027");
  assert.equal(yearIssue(candidate, "2027年5月期の第1四半期決算を発表しました。売上高は10億円です。"), false);
});

test("a year the headline or the judgement reason states stays required", () => {
  const byHeadline = candidateOf({ title: "2026年9月期通期連結業績目標の修正に関するお知らせ" });
  assert.deepEqual(explicitYears(byHeadline), ["2026"]);
  assert.equal(yearIssue(byHeadline, "通期の業績目標を修正しました。"), true);
  const byReason = candidateOf({ title: "お知らせ", judgementReason: "2027年3月期の配当方針に変更があった" });
  assert.deepEqual(explicitYears(byReason), ["2027"]);
  assert.equal(yearIssue(byReason, "配当方針を変更しました。"), true);
});

test("a labelled event date's year stays required; unlabelled and reference years do not", () => {
  const candidate = candidateOf({
    title: "株式分割に関するお知らせ",
    judgementReason: "株式分割を決定した",
    bodySummary: "効力発生日 2026年11月1日\n前期（2025年9月期）の実績は参考値です。",
  });
  assert.deepEqual(explicitYears(candidate), ["2026"]);
  assert.equal(yearIssue(candidate, "11月1日に株式分割の効力が発生します。"), true);
  assert.equal(yearIssue(candidate, "2026年11月1日に株式分割の効力が発生します。"), false);
});

test("other sources behave exactly the same: the year rule has no TDnet-specific branch", () => {
  const base = { title: "2027年1月期の見通しを修正", judgementReason: "見通しを引き上げた", bodySummary: "発表日 2026年10月1日" };
  const tdnet = candidateOf(base);
  const overseas = candidateOf({ ...base, sourceType: "breaking_market", sourceName: "bbc_world", sourceUrl: "https://www.bbc.com/news/example" });
  assert.deepEqual(explicitYears(overseas), explicitYears(tdnet));
  for (const text of ["見通しを修正しました。", "2027年1月期の見通しを修正しました。", "2026年10月1日に発表しました。"]) {
    assert.equal(yearIssue(overseas, text), yearIssue(tdnet, text), text);
  }
});
