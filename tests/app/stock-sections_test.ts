import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultStockSection,
  partitionTrackedStocks,
  stockSectionEmptyMessage,
} from "../../src/lib/stock-sections.ts";
import type { TrackedStock } from "../../src/lib/stocks.ts";

function tracked(id: string, tracking_type: TrackedStock["tracking_type"]): TrackedStock {
  return {
    id,
    user_id: "user",
    stock_id: `stock-${id}`,
    tracking_type,
    quantity: null,
    average_price: null,
    position_type: null,
    side: null,
    target_buy_price: null,
    target_sell_price: null,
    memo: null,
    stocks_master: { id: `stock-${id}`, ticker_code: id, company_name: id, market: "東P" },
  };
}

test("tracked stocks are partitioned without mixing holding and watch", () => {
  const split = partitionTrackedStocks([tracked("8136", "holding"), tracked("7203", "watch")]);
  assert.deepEqual(split.holding.map((item) => item.id), ["8136"]);
  assert.deepEqual(split.watch.map((item) => item.id), ["7203"]);
});

test("default section prefers holdings and falls back to watch", () => {
  assert.equal(defaultStockSection([tracked("7203", "watch")]), "watch");
  assert.equal(defaultStockSection([tracked("8136", "holding"), tracked("7203", "watch")]), "holding");
  assert.equal(defaultStockSection([]), "watch");
});

test("section-specific empty messages stay beginner-friendly", () => {
  assert.equal(stockSectionEmptyMessage("holding"), "保有銘柄はまだありません。上の検索から登録できます。");
  assert.equal(stockSectionEmptyMessage("watch"), "監視銘柄はまだありません。上の検索から登録できます。");
});
