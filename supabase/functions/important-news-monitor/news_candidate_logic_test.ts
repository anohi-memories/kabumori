import assert from "node:assert/strict";
import test from "node:test";
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
