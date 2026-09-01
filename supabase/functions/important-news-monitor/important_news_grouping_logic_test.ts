import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateImportantNewsGroup,
  belongsToSameImportantNewsEvent,
  groupImportantNewsCandidates,
} from "./important_news_grouping_logic.ts";
import { prepareNewsCandidate, type IncomingNewsCandidate } from "./news_candidate_logic.ts";

const input = (overrides: Partial<IncomingNewsCandidate> = {}): IncomingNewsCandidate => ({
  sourceType: "tdnet",
  sourceUrl: "https://www.release.tdnet.info/inbs/1.pdf",
  sourceName: "tdnet",
  title: "2026年3月期 決算短信",
  bodySummary: "決算内容",
  companyName: "テスト株式会社",
  companyCode: "1234",
  entityKey: "company:1234",
  category: "earnings",
  publishedAt: "2026-08-31T06:00:00.000Z",
  ...overrides,
});

async function prepared(overrides: Partial<IncomingNewsCandidate> = {}) {
  return await prepareNewsCandidate(input(overrides));
}

test("earnings, forecast revision, and dividend revision within five minutes form one group", async () => {
  const candidates = await Promise.all([
    prepared(),
    prepared({ sourceUrl: "https://www.release.tdnet.info/inbs/2.pdf", title: "業績予想の修正", category: "earnings_revision_up", publishedAt: "2026-08-31T06:01:00Z" }),
    prepared({ sourceUrl: "https://www.release.tdnet.info/inbs/3.pdf", title: "配当予想の修正", category: "dividend_increase", publishedAt: "2026-08-31T06:02:00Z" }),
  ]);
  assert.equal(groupImportantNewsCandidates(candidates).length, 1);
  assert.equal(groupImportantNewsCandidates(candidates)[0].members.length, 3);
});

test("exactly five minutes is included but more than five minutes is separate", async () => {
  const base = await prepared();
  const atBoundary = await prepared({ sourceUrl: "https://www.release.tdnet.info/inbs/2.pdf", title: "業績予想修正", category: "earnings_revision_down", publishedAt: "2026-08-31T06:05:00Z" });
  const outside = await prepared({ sourceUrl: "https://www.release.tdnet.info/inbs/3.pdf", title: "配当修正", category: "dividend_decrease", publishedAt: "2026-08-31T06:05:00.001Z" });
  assert.equal(groupImportantNewsCandidates([base, atBoundary]).length, 1);
  assert.equal(groupImportantNewsCandidates([base, outside]).length, 2);
});

test("different issuers remain separate even within one minute", async () => {
  const candidates = await Promise.all([
    prepared(),
    prepared({ companyCode: "5678", entityKey: "company:5678", companyName: "別会社", sourceUrl: "https://www.release.tdnet.info/inbs/2.pdf", publishedAt: "2026-08-31T06:01:00Z" }),
  ]);
  assert.equal(groupImportantNewsCandidates(candidates).length, 2);
});

test("clearly separate event families for the same issuer remain separate", async () => {
  const earnings = await prepared();
  const order = await prepared({ sourceUrl: "https://www.release.tdnet.info/inbs/2.pdf", title: "大型受注のお知らせ", category: "large_order", publishedAt: "2026-08-31T06:01:00Z" });
  assert.equal(belongsToSameImportantNewsEvent(earnings, order), false);
  assert.equal(groupImportantNewsCandidates([earnings, order]).length, 2);
});

test("related M&A disclosures require the same issuer and a shared event anchor", async () => {
  const tob = await prepared({ title: "SBIによる公開買付けへの賛同", bodySummary: "SBIの完全子会社が買付者", category: "tob" });
  const alliance = await prepared({ sourceUrl: "https://www.release.tdnet.info/inbs/2.pdf", title: "SBIとの資本業務提携", bodySummary: "SBIと資本業務提携契約", category: "capital_alliance", publishedAt: "2026-08-31T06:02:00Z" });
  const unrelated = await prepared({ sourceUrl: "https://www.release.tdnet.info/inbs/3.pdf", title: "別事業者との業務提携", bodySummary: "別事業者と提携", category: "business_alliance", publishedAt: "2026-08-31T06:03:00Z" });
  assert.equal(belongsToSameImportantNewsEvent(tob, alliance), true);
  assert.equal(belongsToSameImportantNewsEvent(tob, unrelated), false);
});

test("a single disclosure remains a one-member group unchanged", async () => {
  const candidate = await prepared();
  const group = groupImportantNewsCandidates([candidate])[0];
  assert.equal(group.members.length, 1);
  assert.equal(await aggregateImportantNewsGroup(group), candidate);
});

test("group aggregate carries every disclosure and source to downstream judgement", async () => {
  const candidates = await Promise.all([
    prepared(),
    prepared({ sourceUrl: "https://www.release.tdnet.info/inbs/2.pdf", title: "業績予想修正", bodySummary: "営業利益予想を上方修正", category: "earnings_revision_up", publishedAt: "2026-08-31T06:01:00Z" }),
  ]);
  const aggregate = await aggregateImportantNewsGroup(groupImportantNewsCandidates(candidates)[0]);
  assert.match(aggregate.title, /決算短信.*業績予想修正/);
  assert.match(aggregate.bodySummary ?? "", /営業利益予想を上方修正/);
  assert.match(aggregate.bodySummary ?? "", /https:\/\/www\.release\.tdnet\.info\/inbs\/2\.pdf/);
});
