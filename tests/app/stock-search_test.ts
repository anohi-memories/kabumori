import assert from "node:assert/strict";
import test from "node:test";

import { stockScreenMode } from "../../src/lib/stock-search.ts";

test("empty stock query keeps the registered list visible", () => {
  assert.equal(stockScreenMode(""), "list");
  assert.equal(stockScreenMode("   "), "list");
});

test("a non-empty stock query switches the stocks screen to search", () => {
  assert.equal(stockScreenMode("8136"), "search");
  assert.equal(stockScreenMode(" サンリオ "), "search");
});
