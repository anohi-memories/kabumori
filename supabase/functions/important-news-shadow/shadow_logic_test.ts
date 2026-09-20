import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalUrl,
  decideConditionalSearch,
  dedupeKey,
  estimateCostUsd,
  hasValidCronSecret,
  type LiveCandidate,
  matchLiveCandidate,
  normalizeText,
  runSlot,
  type ShadowCandidate,
} from "./shadow_logic.ts";

const candidate = (
  overrides: Partial<ShadowCandidate> = {},
): ShadowCandidate => ({
  sourceName: "boj",
  sourceUrl: "https://www.boj.or.jp/a?utm_source=test",
  topic: "macro:boj",
  category: "boj",
  headline: "Bank of Japan emergency statement",
  bodySummary: null,
  publishedAt: "2026-09-20T00:00:00.000Z",
  ...overrides,
});

test("normalization and dedupe remove tracking noise deterministically", async () => {
  assert.equal(normalizeText("  ＢＯＪ—Statement! "), "boj statement");
  assert.equal(
    canonicalUrl("https://www.boj.or.jp/a/?utm_source=x#top"),
    "https://boj.or.jp/a",
  );
  assert.equal(
    await dedupeKey(candidate()),
    await dedupeKey(candidate({ sourceUrl: "https://boj.or.jp/a" })),
  );
});

test("live matching prefers canonical URL and retains real live evidence", () => {
  const live: LiveCandidate = {
    id: "11111111-1111-1111-1111-111111111111",
    source_url: "https://boj.or.jp/a",
    title: "別タイトル",
    normalized_title: "別タイトル",
    entity_key: "macro:boj",
    category: "boj",
    published_at: "2026-09-20T00:00:00Z",
    fetched_at: "2026-09-20T00:10:00Z",
    importance: "important",
    content_hash: "a".repeat(64),
  };
  assert.equal(matchLiveCandidate(candidate(), [live])?.id, live.id);
});

test("unrelated live candidate remains unknown instead of forced matching", () => {
  const live: LiveCandidate = {
    id: "1",
    source_url: "https://example.com/unrelated",
    title: "Sports result",
    normalized_title: "sports result",
    entity_key: "sports",
    category: "geopolitics",
    published_at: "2026-09-20T00:00:00Z",
    fetched_at: "2026-09-20T00:10:00Z",
    importance: "no_post",
    content_hash: "b".repeat(64),
  };
  assert.equal(matchLiveCandidate(candidate(), [live]), null);
});

test("conditional search is sparse/high-signal only and obeys duplicate/cooldown", () => {
  assert.deepEqual(
    decideConditionalSearch(candidate(), {
      isNew: true,
      topicCoolingDown: false,
      degradedSourceCount: 0,
    }),
    { shouldSearch: true, reason: "new_high_signal_sparse" },
  );
  assert.equal(
    decideConditionalSearch(candidate(), {
      isNew: false,
      topicCoolingDown: false,
      degradedSourceCount: 3,
    }).shouldSearch,
    false,
  );
  assert.equal(
    decideConditionalSearch(candidate(), {
      isNew: true,
      topicCoolingDown: true,
      degradedSourceCount: 3,
    }).reason,
    "topic_cooldown",
  );
  assert.equal(
    decideConditionalSearch(
      candidate({
        headline: "Routine monthly bulletin",
        bodySummary: "x".repeat(120),
      }),
      { isNew: true, topicCoolingDown: false, degradedSourceCount: 0 },
    ).shouldSearch,
    false,
  );
});

test("a bootstrap caller can suppress paid search by treating backlog as not new", () => {
  assert.deepEqual(
    decideConditionalSearch(candidate(), {
      isNew: false,
      topicCoolingDown: false,
      degradedSourceCount: 4,
    }),
    { shouldSearch: false, reason: "duplicate" },
  );
});

test("cron authentication accepts only the dedicated header and fails closed", () => {
  const expected = "dedicated-random-secret";
  assert.equal(
    hasValidCronSecret(
      new Request("https://example.test", {
        headers: { "X-Cron-Secret": expected },
      }),
      expected,
    ),
    true,
  );
  assert.equal(
    hasValidCronSecret(
      new Request("https://example.test", {
        headers: { "X-Cron-Secret": "wrong" },
      }),
      expected,
    ),
    false,
  );
  assert.equal(
    hasValidCronSecret(
      new Request("https://example.test", {
        headers: { Authorization: `Bearer ${expected}` },
      }),
      expected,
    ),
    false,
  );
  assert.equal(
    hasValidCronSecret(new Request("https://example.test"), ""),
    false,
  );
});

test("run idempotency slots retain distinct 10-minute cadence slots", () => {
  assert.equal(
    runSlot(new Date("2026-09-20T02:39:59.000Z")),
    "2026-09-20T02:30:00.000Z",
  );
  assert.equal(
    runSlot(new Date("2026-09-20T02:40:00.000Z")),
    "2026-09-20T02:40:00.000Z",
  );
});

test("cost estimate includes raw token rates and actual web search calls", () => {
  assert.equal(estimateCostUsd(100_000, 1_000, 1), 0.0312);
  assert.equal(estimateCostUsd(0, 0, 0), 0);
});
