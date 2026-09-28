import assert from "node:assert/strict";
import test from "node:test";

import { homeNewsVisual } from "../../src/lib/home-news-visual.ts";

test("prefers a glyph from source_type when known", () => {
  const result = homeNewsVisual({ source_type: "tdnet", coverage_categories: ["earnings"] });
  assert.equal(result.glyph, "◆");
  assert.equal(result.imageUrl, null);
});

test("falls back to a coverage category glyph when source_type is unknown", () => {
  const result = homeNewsVisual({ source_type: "some_future_type", coverage_categories: ["fx"] });
  assert.equal(result.glyph, "◈");
});

test("falls back to a neutral glyph when nothing matches", () => {
  const result = homeNewsVisual({ source_type: null, coverage_categories: null });
  assert.equal(result.glyph, "›");
  assert.equal(result.imageUrl, null);
});
