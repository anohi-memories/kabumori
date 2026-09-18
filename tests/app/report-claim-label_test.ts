// K1 review 2026-09-18: the app label for consistent_with must stay true when
// the claim pairs different sessions (US 9/17 vs Tokyo 9/18).
import assert from "node:assert/strict";
import test from "node:test";
import { CLAIM_TYPE_LABEL } from "../../src/lib/report-presentation.ts";

const generated = JSON.parse(await Deno.readTextFile(new URL(
  "../../supabase/functions/market-report-analysis/fixtures/close_2026-09-18_generated_report.json",
  import.meta.url,
)));

/** How src/app/reports/[id].tsx renders one claim line. */
function renderClaim(claim: { text_ja: string; claim_type: string }): string {
  const label = CLAIM_TYPE_LABEL[claim.claim_type];
  return label ? `${claim.text_ja}（${label}）` : claim.text_ja;
}

test("consistent_with is labelled date-neutrally as 同時期に確認", () => {
  assert.equal(CLAIM_TYPE_LABEL.consistent_with, "同時期に確認");
  for (const label of Object.values(CLAIM_TYPE_LABEL)) {
    assert.ok(!/同日|同じ日/.test(label), `label must not assert the same date: ${label}`);
  }
});

test("a 9/17 US vs 9/18 Tokyo claim does not render 「同日に確認」", () => {
  const line = renderClaim({
    text_ja: "9月17日の米国市場ではSOXが前日比+3.14%でした。9月18日の東京市場への影響は、それぞれ日付が異なるため参考情報です。",
    claim_type: "consistent_with",
  });
  assert.ok(!line.includes("同日に確認"));
  assert.ok(line.endsWith("（同時期に確認）"));
});

test("the 2026-09-18 production packet's cross-date claim renders without a same-day label", () => {
  const crossDate = generated.payload.claims.find((claim: { claim_id: string }) => claim.claim_id === "c5");
  assert.equal(crossDate.claim_type, "consistent_with");
  assert.ok(crossDate.text_ja.includes("9月17日の米国市場"));
  const rendered = generated.payload.claims.map(renderClaim).join("\n");
  assert.ok(!rendered.includes("同日に確認"));
  assert.ok(renderClaim(crossDate).endsWith("（同時期に確認）"));
});
