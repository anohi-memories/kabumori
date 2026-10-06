import assert from "node:assert/strict";
import test from "node:test";

import { splitHomeNewsSections } from "../../src/lib/home-news-sections.ts";
import type { ImportantStockNews } from "../../src/lib/important-news.ts";

function item(overrides: Partial<ImportantStockNews> & { news_id: string; tracking_type: ImportantStockNews["tracking_type"] }): ImportantStockNews {
  return {
    news_id: overrides.news_id,
    ticker_code: overrides.ticker_code ?? null,
    company_name: overrides.company_name ?? "テスト株式会社",
    tracking_type: overrides.tracking_type,
    title: overrides.title ?? "title",
    summary: overrides.summary ?? null,
    importance: overrides.importance ?? "important",
    news_time: overrides.news_time ?? "2026-09-28T00:00:00Z",
    source_url: overrides.source_url ?? null,
  };
}

test("splits market and holding items from the same feed, dropping watch", () => {
  const feed = [
    item({ news_id: "m1", tracking_type: "market" }),
    item({ news_id: "w1", tracking_type: "watch" }),
    item({ news_id: "h1", tracking_type: "holding" }),
    item({ news_id: "m2", tracking_type: "market" }),
  ];
  const result = splitHomeNewsSections(feed);
  assert.deepEqual(result.market.map((i) => i.news_id), ["m1", "m2"]);
  assert.deepEqual(result.holding.map((i) => i.news_id), ["h1"]);
});

test("caps each section at 3 and preserves the feed's existing order", () => {
  const feed = [1, 2, 3, 4, 5].map((n) => item({ news_id: `m${n}`, tracking_type: "market" }));
  const result = splitHomeNewsSections(feed);
  assert.deepEqual(result.market.map((i) => i.news_id), ["m1", "m2", "m3"]);
});

test("empty feed yields empty sections, not an error", () => {
  assert.deepEqual(splitHomeNewsSections([]), { market: [], holding: [] });
});
