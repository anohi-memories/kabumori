import assert from "node:assert/strict";
import test from "node:test";
import { buildTdnetBodySummary } from "./official_source_fetchers.ts";
import {
  DEFAULT_IMPORTANT_NEWS_SETTINGS,
  createImportantNewsContentHash,
  findNewsDuplicate,
  isImportantNewsImportance,
  isImportantNewsStatus,
  prepareNewsCandidate,
  type DuplicateComparable,
  type IncomingNewsCandidate,
} from "./news_candidate_logic.ts";

const input = (overrides: Partial<IncomingNewsCandidate> = {}): IncomingNewsCandidate => ({
  sourceType: "company_ir", sourceUrl: "https://example.co.jp/ir/1?utm_source=x",
  sourceName: "company_ir", title: "通期業績予想を上方修正",
  bodySummary: "営業利益予想を修正", companyCode: "1234", entityKey: "company:1234",
  category: "earnings_revision_up", publishedAt: "2026-08-31T06:00:00.000Z", ...overrides,
});

test("content hash is stable and changes with material content", async () => {
  const first = await createImportantNewsContentHash(input());
  const same = await createImportantNewsContentHash(input({ title: "通期業績予想を上方修正  " }));
  const changed = await createImportantNewsContentHash(input({ bodySummary: "純利益予想を修正" }));
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, same);
  assert.notEqual(first, changed);
});

test("exact content hash is detected as duplicate", async () => {
  const candidate = await prepareNewsCandidate(input());
  const existing: DuplicateComparable[] = [{
    id: "existing", sourceUrl: "https://other.example/ir", normalizedTitle: "別タイトル",
    contentHash: candidate.contentHash, companyCode: "1234", entityKey: "company:1234",
    publishedAt: candidate.publishedAt,
  }];
  assert.equal(findNewsDuplicate(candidate, existing)?.id, "existing");
});

test("canonical source URL is detected as duplicate", async () => {
  const candidate = await prepareNewsCandidate(input());
  const existing: DuplicateComparable[] = [{
    id: "existing", sourceUrl: candidate.sourceUrl, normalizedTitle: "別タイトル",
    contentHash: "0".repeat(64), companyCode: null, entityKey: null,
    publishedAt: candidate.publishedAt,
  }];
  assert.equal(findNewsDuplicate(candidate, existing)?.id, "existing");
});

test("the same verified breaking event is deduplicated across sources with different headlines", async () => {
  const candidate = await prepareNewsCandidate(input({
    sourceType: "breaking_market",
    sourceName: "breaking_market",
    sourceUrl: "https://apnews.com/article/jobs-follow-up",
    title: "Markets react after US payrolls decline",
    bodySummary: "A follow-up report on the same payroll release.",
    companyCode: null,
    entityKey: "breaking:event:us_payrolls:2026-09-04T12:30Z",
    category: "us_government_policy",
    publishedAt: "2026-09-04T13:00:00.000Z",
  }));
  const existing: DuplicateComparable[] = [{
    id: "bls-primary",
    sourceUrl: "https://www.bls.gov/news.release/empsit.nr0.htm",
    normalizedTitle: "employment situation released",
    contentHash: "0".repeat(64),
    companyCode: null,
    entityKey: "breaking:event:us_payrolls:2026-09-04T12:30Z",
    publishedAt: "2026-09-04T12:35:00.000Z",
  }];
  assert.equal(findNewsDuplicate(candidate, existing)?.id, "bls-primary");
});

test("different verified event timestamps are not merged merely because kind and date match", async () => {
  const candidate = await prepareNewsCandidate(input({
    sourceType: "breaking_market",
    sourceName: "breaking_market",
    sourceUrl: "https://www.reuters.com/world/second-fed-event",
    title: "Fed announces a second emergency action",
    bodySummary: "A separate policy action later the same day.",
    companyCode: null,
    entityKey: "breaking:event:fed_policy:2026-09-04T18:00Z",
    category: "frb",
    publishedAt: "2026-09-04T18:05:00.000Z",
  }));
  const existing: DuplicateComparable[] = [{
    id: "first-fed-event",
    sourceUrl: "https://www.federalreserve.gov/newsevents/pressreleases/first.htm",
    normalizedTitle: "fed announces first emergency action",
    contentHash: "0".repeat(64),
    companyCode: null,
    entityKey: "breaking:event:fed_policy:2026-09-04T12:00Z",
    publishedAt: "2026-09-04T12:05:00.000Z",
  }];
  assert.equal(findNewsDuplicate(candidate, existing), null);
});

test("initial settings keep monitoring and publication off", () => {
  assert.equal(DEFAULT_IMPORTANT_NEWS_SETTINGS.isActive, false);
  assert.equal(DEFAULT_IMPORTANT_NEWS_SETTINGS.autoPublish, false);
  assert.equal(DEFAULT_IMPORTANT_NEWS_SETTINGS.intervalMinutes, 20);
});

test("importance and status accept only declared values", () => {
  assert.equal(isImportantNewsImportance("most_important"), true);
  assert.equal(isImportantNewsImportance("urgent"), false);
  assert.equal(isImportantNewsStatus("pending_judgement"), true);
  assert.equal(isImportantNewsStatus("posting"), false);
});

// ------------------------------------------------------------ NUL (U+0000) sanitation at the storage boundary

const NUL = String.fromCharCode(0);
const nulBase = {
  sourceType: "tdnet" as const, sourceName: "tdnet", sourceUrl: "https://www.release.tdnet.info/inbs/a.pdf",
  title: "業績予想の修正に関するお知らせ", bodySummary: "売上高 1,200億円（前期比 +12.5%）\n営業利益 300億円", companyName: "テスト株式会社",
  companyCode: "1234", entityKey: "company:1234", category: "earnings_revision_up" as const, publishedAt: "2026-10-06T01:00:00.000Z",
};

test("NUL in bodySummary, title, companyName and entityKey is removed before storage", async () => {
  const prepared = await prepareNewsCandidate({
    ...nulBase,
    title: `業績予想${NUL}の修正に関するお知らせ`,
    bodySummary: `売上高${NUL} 1,200億円${NUL}（前期比 +12.5%）\n営業利益 300億円`,
    companyName: `テスト${NUL}株式会社`,
    entityKey: `company:${NUL}1234`,
  });
  for (const value of [prepared.title, prepared.bodySummary, prepared.companyName, prepared.entityKey, prepared.normalizedTitle]) {
    assert.equal(String(value).includes(NUL), false);
  }
  assert.equal(prepared.title, "業績予想の修正に関するお知らせ");
  assert.equal(prepared.bodySummary, "売上高 1,200億円（前期比 +12.5%）\n営業利益 300億円");
  assert.equal(prepared.companyName, "テスト株式会社");
  assert.equal(prepared.entityKey, "company:1234");
});

test("a candidate with and without NUL has the same stored text and the same content hash", async () => {
  const clean = await prepareNewsCandidate(nulBase);
  const dirty = await prepareNewsCandidate({
    ...nulBase,
    title: `${NUL}${nulBase.title}`,
    bodySummary: `${nulBase.bodySummary.slice(0, 5)}${NUL}${nulBase.bodySummary.slice(5)}${NUL}`,
  });
  assert.equal(dirty.contentHash, clean.contentHash);
  assert.equal(dirty.normalizedTitle, clean.normalizedTitle);
  assert.equal(dirty.bodySummary, clean.bodySummary);
});

test("candidates without NUL are unchanged (Japanese, digits, units, symbols, newlines, comparison marks are kept)", async () => {
  const text = "売上高 1,200億円（前期比 +12.5%）\n営業利益 ≧ 300億円 → 上方修正 ▲5.0% 〜";
  const prepared = await prepareNewsCandidate({ ...nulBase, bodySummary: text });
  assert.equal(prepared.bodySummary, text);
  assert.equal(prepared.title, nulBase.title);
  assert.equal(prepared.sourceType, "tdnet");
  assert.equal(prepared.sourceName, "tdnet");
  assert.equal(prepared.category, "earnings_revision_up");
  assert.equal(prepared.sourceUrl, "https://www.release.tdnet.info/inbs/a.pdf");
  assert.equal(prepared.bodySummary === null, false);
  const nullBody = await prepareNewsCandidate({ ...nulBase, bodySummary: null, companyName: null, entityKey: null });
  assert.equal(nullBody.bodySummary, null);
  assert.equal(nullBody.companyName, null);
});

test("TDnet PDF fixture: text extracted with NULs becomes a NUL-free summary and a candidate that matches its clean twin", async () => {
  const pdfText = `業績予想の修正${NUL}\n修正前 売上高 1,000億円\n修正後${NUL} 売上高 1,200億円\n増減率 +20.0%${NUL}`;
  const summary = buildTdnetBodySummary(pdfText);
  const prepared = await prepareNewsCandidate({ ...nulBase, bodySummary: summary });
  assert.equal(String(prepared.bodySummary).includes(NUL), false);
  assert.match(String(prepared.bodySummary), /修正後 売上高 1,200億円/);
  const clean = await prepareNewsCandidate({ ...nulBase, bodySummary: buildTdnetBodySummary(pdfText.replaceAll(NUL, "")) });
  assert.equal(prepared.contentHash, clean.contentHash);
  // the value that reaches PostgREST must be representable as JSON text without a \u0000 escape
  assert.equal(JSON.stringify(prepared).includes("\\u0000"), false);
});

test("duplicate detection still works across NUL / clean versions of the same disclosure", async () => {
  const clean = await prepareNewsCandidate(nulBase);
  const dirty = await prepareNewsCandidate({ ...nulBase, sourceUrl: "https://www.release.tdnet.info/inbs/b.pdf", title: `${NUL}${nulBase.title}` });
  const found = findNewsDuplicate(dirty, [{ id: "1", sourceUrl: clean.sourceUrl, normalizedTitle: clean.normalizedTitle, contentHash: clean.contentHash, companyCode: clean.companyCode ?? null, entityKey: clean.entityKey ?? null, publishedAt: clean.publishedAt }]);
  assert.equal(found?.id, "1");
});
