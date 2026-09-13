import assert from "node:assert/strict";
import test from "node:test";
import { runCrossBrandDedupeProbe } from "./cross_brand_dedupe_probe.ts";

test("exact-match probe reports would_block, and distinct-text probe reports would_allow, for the same candidate text", async () => {
  const result = await runCrossBrandDedupeProbe({
    brandId: "ai_salaryman_lab",
    candidateText: "AIツールで議事録を自動要約すると、確認作業がぐっと楽になります。",
  });
  assert.equal(result.wouldBlockOnExactMatch.blocked, true);
  if (result.wouldBlockOnExactMatch.blocked) {
    assert.equal(result.wouldBlockOnExactMatch.reason, "CROSS_BRAND_EXACT_DUPLICATE");
    assert.equal(result.wouldBlockOnExactMatch.matchedBrandId, "kabumori");
  }
  assert.equal(result.wouldAllowOnDistinctText.blocked, false);
});

test("same-brand candidate text is never reported as blocked, since checkCrossBrandDuplicate only compares across brands", async () => {
  const result = await runCrossBrandDedupeProbe({
    brandId: "kabumori",
    candidateText: "本日のまとめです。",
  });
  assert.equal(result.wouldBlockOnExactMatch.blocked, false);
  assert.equal(result.wouldAllowOnDistinctText.blocked, false);
});
