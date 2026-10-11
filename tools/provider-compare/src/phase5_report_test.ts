import assert from "node:assert/strict";
import test from "node:test";
import { type GateRow, gateSummary, generationSummary, tanshinSummary } from "../scripts/phase5_report.ts";
import { scanJson } from "./secret_scan.ts";

const gate = (over: Partial<GateRow>): GateRow => ({
  final_no_post: true, gate_text: false, escalated_to_sol: false, judgement_model: "gpt-6-luna", fact_check_status: "passed",
  sol_escalation_reasons: "", n: 1, ...over,
});

test("gate summary: outcomes add up to the judged rows and the gate share is gate / no_post", () => {
  const s = gateSummary([
    gate({ n: 10 }),
    gate({ n: 3, escalated_to_sol: true, judgement_model: "gpt-6-sol" }),
    gate({ n: 4, gate_text: true, escalated_to_sol: true, judgement_model: "gpt-6-sol", fact_check_status: "needs_review", sol_escalation_reasons: "FACT_NEEDS_REVIEW" }),
    gate({ n: 1, gate_text: true, fact_check_status: "needs_review" }),
    gate({ n: 6, final_no_post: false, escalated_to_sol: true, judgement_model: "gpt-6-sol" }),
  ]);
  assert.deepEqual(s.outcomes, { model_no_post: 13, gate_after_sol: 4, gate_sol_required_not_run: 1, final_positive: 6 });
  assert.equal(s.noPost, 18);
  assert.equal(s.gateShareOfNoPost, 0.278);
  assert.equal(s.solEscalated, 13);
  assert.equal(s.gateShareOfSolEscalated, 0.308);
  assert.deepEqual(s.gateAfterSolByEscalationReasons, { FACT_NEEDS_REVIEW: 4 });
});

test("generation summary: every failed row gets exactly one primary cause and one stage", () => {
  const rows = [
    { status: "generation_failed", created_jst: "2026-09-12 10:00:00", source_name: "tdnet", generation_error: "NEWS_GENERATION_FACT_RETRY_FAILED", generation_fact_status: "failed", generation_voice_status: "not_run", fact_issues: '["MISSING_EXPLICIT_YEAR"]', voice_issues: "" },
    { status: "generation_failed", created_jst: "2026-10-08 10:00:00", source_name: "tdnet", generation_error: "NEWS_GENERATION_FACT_FAILED", generation_fact_status: "failed", generation_voice_status: "not_run", fact_issues: '["累計取得額は上限50億円に達していません"]', voice_issues: "" },
    { status: "generation_failed", created_jst: "2026-10-08 11:00:00", source_name: "al_jazeera", generation_error: "NEWS_GENERATION_VOICE_FAILED", generation_fact_status: "passed", generation_voice_status: "failed", fact_issues: "[]", voice_issues: '["不自然"]' },
    { status: "published", created_jst: "2026-10-08 12:00:00", source_name: "tdnet", generation_error: "", generation_fact_status: "passed", generation_voice_status: "passed", fact_issues: "", voice_issues: "" },
  ];
  const s = generationSummary(rows);
  assert.equal(s.failed, 3);
  assert.equal(Object.values(s.byPrimaryCause).reduce((a, b) => a + b, 0), 3);
  assert.equal(Object.values(s.byStage).reduce((a, b) => a + b, 0), 3);
  assert.equal(Object.values(s.pr116Outlook).reduce((a, b) => a + b, 0), 3);
  assert.deepEqual(s.byPeriod["A 09-10..09-18"], { year_missing: 1 });
  assert.deepEqual(s.byPeriod["C 10-03..10-09"], { rounding: 1, voice: 1 });
  assert.deepEqual(s.pr116Outlook, { not_addressed: 2, expected_to_improve: 1 });
});

test("earnings-report summary counts only operating companies and states the share of the determinable ones", () => {
  const title = "2027年２月期 第２四半期（中間期）決算短信〔日本基準〕（連結）";
  const header = "経営成績（累計） 売上高 営業利益 ";
  const s = tanshinSummary([
    { title, body: `${header} 2026年２月期中間期 100 1.0 5 2.0`, importance: "no_post", gate_suppressed: true, status: "rejected" },
    { title, body: `${header} 2027年２月期中間期 110 10.0 6 20.0`, importance: "important", gate_suppressed: false, status: "published" },
    { title: "2026年7月期 決算短信（ＲＥＩＴ）", body: "x", importance: "no_post", gate_suppressed: false, status: "rejected" },
  ]);
  assert.equal(s.operatingCompanyReports, 2);
  assert.equal(s.excludedFundsAndReits, 1);
  assert.equal(s.priorPeriodOnlyShareOfDeterminable, 0.5);
  assert.deepEqual(s.priorPeriodOnlyByOutcome, { no_post_gated: 1 });
});

test("the committed Phase 5 report is internally consistent and holds no credential-shaped string", async () => {
  const report = JSON.parse(await Deno.readTextFile(new URL("../../../docs/model-optimization/phase5_report_2026-10-10.json", import.meta.url)));
  const outcomes = report.gate.outcomes as Record<string, number>;
  assert.equal(report.gate.noPost, (outcomes.model_no_post ?? 0) + (outcomes.gate_after_sol ?? 0) + (outcomes.gate_sol_required_not_run ?? 0));
  const rateA = report.failureRates.find((r: { name: string }) => r.name.startsWith("A "));
  assert.equal(rateA.numerator, report.generation.failed);
  assert.equal(Object.values(report.generation.byPrimaryCause as Record<string, number>).reduce((a, b) => a + b, 0), report.generation.failed);
  for (const r of report.failureRates) {
    assert.ok(r.numerator <= r.denominator, r.name);
    assert.equal(r.rate, r.denominator === 0 ? null : Math.round((r.numerator / r.denominator) * 1000) / 1000, r.name);
  }
  const last7 = report.failureRates.find((r: { name: string }) => r.name.startsWith("F "));
  assert.ok(last7.rate < rateA.rate, "the recent failure rate must be reported separately from the 30-day rate");
  assert.deepEqual(scanJson(report), []);
});
