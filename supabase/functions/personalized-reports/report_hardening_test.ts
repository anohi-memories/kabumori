// Regression tests for the false-reject / false-positive classes left by the production v26 dry-runs:
//   A. 値下がり/値上がり unknown-cause wording (validator vocabulary, fixed in 510acf5; locked here)
//   B. a factual lead clause inside inference_ja (kept rejected; fixed by the generation prompt)
//   C. advisory-sounding morning wording failing the Fact check (fixed by the generation prompt;
//      the Fact checker itself is unchanged)
import assert from "node:assert/strict";
import test from "node:test";
import {
  BENCHMARK_LABEL,
  buildPacket,
  buildSnapshot,
  INFERENCE_FIELD_RULE,
  inferenceIsHedged,
  MORNING_WORDING_RULE,
  REPORT_FACT_INSTRUCTIONS,
  REPORT_LIMITS,
  reportDraftRequestBody,
  reportFactRequestBody,
  type PriceSeries,
  type ReportBody,
} from "./report_logic.ts";

// --- A. unknown-cause movement vocabulary -------------------------------------------------

test("A: 値下がり / 値上がり unknown-cause sentences pass", () => {
  for (const text of [
    "値下がりの要因は特定できません。",
    "当日の値下がり要因は特定できません。",
    "値上がりの理由は判断できません。",
    "当日の値上がりの原因は確認できません。",
  ]) {
    assert.equal(inferenceIsHedged(text), true, text);
  }
});

test("A: the movement prefix stays narrow — no free-text subject, no factual claim", () => {
  for (const text of [
    "急な値下がりの要因は特定できません。",
    "半導体株の値上がり要因は特定できません。",
    "円安による値上がりの要因は特定できません。",
    "値下がりの要因は円高です。",
    "値上がりの理由は好決算です。",
  ]) {
    assert.equal(inferenceIsHedged(text), false, text);
  }
});

test("A: causal assertions cannot be laundered by an unknown-cause clause or a hedge", () => {
  for (const text of [
    "円高が逆風になりましたが、値下がりの要因は特定できません。",
    "円高を受けて下落しましたが値上がりの理由は特定できません。",
    "金利上昇が原因です。値下がりの要因は特定できません。",
    "円高で売られました、値下がりの要因は特定できない可能性があります。",
  ]) {
    assert.equal(inferenceIsHedged(text), false, text);
  }
});

test("A: punctuation / newline variants cannot smuggle an unsafe sentence", () => {
  for (const text of [
    "値下がりの要因は特定できません\n円高が逆風になりました",
    "値下がりの要因は特定できません；金利上昇が原因です",
    "値上がりの理由は判断できません! 円安で買われました",
    "値下がりの要因は特定できません. 円高で売られました",
  ]) {
    assert.equal(inferenceIsHedged(text), false, JSON.stringify(text));
  }
});

// --- B. factual lead clauses stay out of inference_ja ---------------------------------------

test("B: the observed factual-lead inference is still rejected by the validator (not broadened)", () => {
  assert.equal(inferenceIsHedged("小幅高でしたが、指数との比較では相対的に弱く、値動きの要因は特定できません。"), false);
  assert.equal(inferenceIsHedged("前日比で上昇しており、値上がりの要因は特定できません。"), false);
  assert.equal(inferenceIsHedged("小幅高でしたが、円高で売られました。"), false, "factual lead + causal assertion");
  // The bounded sentence the prompt now asks for passes.
  assert.equal(inferenceIsHedged("値動きの要因は特定できません。"), true);
});

function series(closes: Array<[string, number]>): PriceSeries {
  return { bars: closes.map(([date, close]) => ({ date, close })), marketTimeIso: "2026-09-25T06:30:00Z" };
}

const FLAT = series([["2026-09-23", 1000], ["2026-09-24", 1000], ["2026-09-25", 1000]]);

function packetFor(reportType: "morning" | "close") {
  const snapshot = buildSnapshot({
    reportType,
    tradingDate: "2026-09-25",
    tracked: [{
      trackedStockId: "t1", tickerCode: "1111", companyName: "会社1111", sector: "サービス業",
      trackingType: "holding", quantity: 100, averagePrice: 900, positionType: "cash", side: "long",
    }],
    prices: new Map([["1111", FLAT]]),
    indices: [{ label: "日経平均", series: FLAT }, { label: BENCHMARK_LABEL, series: FLAT }],
    news: [],
  });
  return buildPacket(snapshot, []);
}

test("B: the close and morning prompts forbid factual lead clauses in inference_ja", () => {
  for (const reportType of ["close", "morning"] as const) {
    const instructions = String(reportDraftRequestBody(reportType, packetFor(reportType)).instructions);
    assert.ok(instructions.includes(INFERENCE_FIELD_RULE), reportType);
  }
  for (const phrase of ["小幅高でしたが", "指数との比較では相対的に弱く", "前日比で上昇しており", "事実は fact_ja にだけ書きます", "値動きの要因は特定できません。"]) {
    assert.ok(INFERENCE_FIELD_RULE.includes(phrase), phrase);
  }
});

// --- C. neutral morning wording, Fact checker unchanged ------------------------------------

test("C: the morning prompt steers away from advisory wording toward neutral observation", () => {
  const morning = String(reportDraftRequestBody("morning", packetFor("morning")).instructions);
  const close = String(reportDraftRequestBody("close", packetFor("close")).instructions);
  assert.ok(morning.includes(MORNING_WORDING_RULE));
  assert.ok(!close.includes(MORNING_WORDING_RULE), "the morning wording rule is morning-only");
  for (const avoided of ["見守る", "注意が必要", "〜しやすい構成", "影響を受けやすい"]) {
    assert.ok(MORNING_WORDING_RULE.includes(`「${avoided}」`), avoided);
  }
  assert.ok(MORNING_WORDING_RULE.includes("watch_notes の note_ja"), "watch-list notes are also user-visible Fact-checked morning output");
  for (const preferred of ["注目点", "確認ポイント", "値動きを確認します"]) {
    assert.ok(MORNING_WORDING_RULE.includes(preferred), preferred);
  }
});

test("C: the Fact checker instructions are unchanged and still reject advice and unsupported claims", () => {
  assert.ok(REPORT_FACT_INSTRUCTIONS.includes("売買推奨"));
  assert.ok(REPORT_FACT_INSTRUCTIONS.includes("packetに無い数字・日付・固有名詞・事実"));
  assert.ok(REPORT_FACT_INSTRUCTIONS.includes("将来の値動きの断定"));
  assert.ok(!REPORT_FACT_INSTRUCTIONS.includes("見守る"), "no wording exemption was added to the Fact checker");
  const report = {
    title_ja: "t", summary_ja: "s", tone: "neutral", overview_ja: "o", holding_impacts: [], morning_review_ja: "",
    watch_notes: [], risk_notes_ja: [], checkpoints_ja: ["c"],
  } satisfies ReportBody;
  const fact = reportFactRequestBody(packetFor("morning"), report);
  assert.equal(fact.instructions, REPORT_FACT_INSTRUCTIONS, "without MIC the Fact instructions are exactly the base set");
});

test("brief limits stay morning 120 / close 160", () => {
  assert.equal(REPORT_LIMITS.impactBriefMorning, 120);
  assert.equal(REPORT_LIMITS.impactBriefClose, 160);
});
