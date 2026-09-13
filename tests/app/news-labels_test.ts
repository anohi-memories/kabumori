import assert from "node:assert/strict";
import test from "node:test";

import { categoryLabels, importanceLabel, targetLabel } from "../../src/lib/news-labels.ts";

test("coverage category and severity labels are Japanese", () => {
  assert.deepEqual(categoryLabels(["geopolitics", "disaster", "oil_energy"]), [
    "地政学", "災害", "原油・エネルギー",
  ]);
  assert.deepEqual(importanceLabel({ severity: "emergency", importance: "no_post" }), {
    text: "緊急", subtle: false,
  });
  assert.deepEqual(importanceLabel({ severity: "medium", importance: "no_post" }), {
    text: "注目", subtle: true,
  });
});

test("market emergency has a market label without a tracked sector", () => {
  assert.deepEqual(targetLabel({
    matched_sector: null,
    matched_sectors: null,
    tracking_type: "watch",
    ticker_code: null,
  }), { badge: "市場", detail: "市場全体" });
});
