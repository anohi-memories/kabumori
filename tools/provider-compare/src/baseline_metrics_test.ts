import assert from "node:assert/strict";
import test from "node:test";
import { costBaseline, deliveryFailureRate, METRIC_DEFINITIONS, runBaseline, sampleSizePerGroup, stageFunnel } from "./baseline_metrics.ts";
import { loadLedgerSnapshot } from "./ledger_snapshot.ts";

const report = JSON.parse(await Deno.readTextFile(new URL("../../../docs/model-optimization/phase5_report_2026-10-10.json", import.meta.url)));
const ledger = await loadLedgerSnapshot();

test("the delivery-failure rate refuses a no_post row: all-judged can never be its denominator", () => {
  assert.deepEqual(
    deliveryFailureRate([
      { importance: "important", status: "published" },
      { importance: "most_important", status: "generation_failed" },
      { importance: "important", status: "generation_failed" },
      { importance: "important", status: "published" },
    ]),
    { failed: 2, denominator: 4, rate: 0.5 },
  );
  assert.throws(() => deliveryFailureRate([{ importance: "important", status: "published" }, { importance: "no_post", status: "rejected" }]), /DENOMINATOR_INCLUDES_NO_POST/);
  assert.deepEqual(deliveryFailureRate([]), { failed: 0, denominator: 0, rate: null });
});

test("the definitions name what each metric is not, and keep the two failure quantities apart", () => {
  for (const d of Object.values(METRIC_DEFINITIONS)) {
    assert.ok(d.numerator.length > 0 && d.denominator.length > 0 && d.notThis.length > 0, d.id);
  }
  assert.notEqual(METRIC_DEFINITIONS.deliveryFailureRate.denominator, METRIC_DEFINITIONS.failureShareOfAllJudged.denominator);
  assert.match(METRIC_DEFINITIONS.deliveryFailureRate.denominator, /no_post is never/);
});

test("the stage funnel accounts for every judged candidate exactly once", () => {
  const f = stageFunnel(report);
  const generation = f.stoppedAtGeneration.fact + f.stoppedAtGeneration.voice + f.stoppedAtGeneration.local + f.stoppedAtGeneration.api;
  assert.equal(f.stoppedBefore.judgementModelNoPost + f.stoppedBefore.judgementGate + f.importantPlus, f.judged);
  assert.equal(generation + f.reachedX + f.other, f.importantPlus);
  assert.equal(generation, report.generation.failed);
  assert.equal(f.judged, 2213);
  assert.equal(f.stoppedBefore.judgementGate, 402);
});

test("the baseline keeps the 30-day and the 7-day failure rates apart and says PR #116 is unobserved", () => {
  const b = runBaseline(ledger, report);
  assert.equal(b.deliveryFailure.last30Days.rate, 0.484);
  assert.equal(b.deliveryFailure.last7Days.rate, 0.231);
  assert.notEqual(b.deliveryFailure.last30Days.window, b.deliveryFailure.last7Days.window);
  assert.equal(b.pr116.observed, false);
  assert.deepEqual(b.pr116.expectedAmongLast7DayFailures, { not_addressed: 26, expected_to_improve: 6, partly: 7 });
  assert.equal(Object.values(b.pr116.expectedAmongLast7DayFailures).reduce((a, c) => a + c, 0), 39);
  assert.equal(b.comparisonPlan.beforeRate, 0.231);
});

test("cost: per-feature figures come from the ledger, the totals add up, and both volume views are given", () => {
  const c = costBaseline(ledger, report);
  const sum = Object.values(c.perFeature).reduce((a, f) => a + f.usd, 0);
  assert.ok(Math.abs(c.newsPipelineUsdPer30Days - Math.round(((sum * 30) / ledger.window.days) * 100) / 100) < 0.011);
  assert.ok(c.attributable.gateAfterSolUsd > 0 && c.attributable.failedGenerationUsd > 0);
  assert.ok(c.attributable.gateAfterSolUsdPer30DaysAtCurrentVolume! > c.attributable.gateAfterSolUsd, "the current volume is higher than the 30-day window's");
  assert.ok(c.attributable.failedGenerationUsdPer30DaysAtCurrentVolume! < 1, "failed generation costs cents: the loss is reach, not API spend");
  assert.match(c.note, /not an invoice/);
});

test("sample size for a before/after comparison of two proportions", () => {
  // 23.1% -> 15%: about 370 candidates per group; 23.1% -> 10%: about 130.
  assert.ok(Math.abs(sampleSizePerGroup(0.231, 0.15) - 369) <= 2);
  assert.ok(Math.abs(sampleSizePerGroup(0.231, 0.1) - 127) <= 2);
  assert.ok(sampleSizePerGroup(0.231, 0.2) > sampleSizePerGroup(0.231, 0.1), "a smaller effect needs more data");
  assert.throws(() => sampleSizePerGroup(0.2, 0.2), /NO_EFFECT_TO_DETECT/);
});

test("the committed baseline equals what the code derives from the committed inputs, and holds no credential-shaped string", async () => {
  const committed = JSON.parse(await Deno.readTextFile(new URL("../../../docs/model-optimization/baseline_2026-10-11.json", import.meta.url)));
  assert.equal(JSON.stringify(committed), JSON.stringify(runBaseline(ledger, report)));
  const { scanJson } = await import("./secret_scan.ts");
  assert.deepEqual(scanJson(committed), []);
});

test("the posted-side sample plan: 100 cases in two layers, the same 212 exclusions as the no_post sample, SELECT only", async () => {
  const sql = await Deno.readTextFile(new URL("../scripts/export_eval_posted_sample.sql", import.meta.url));
  const quotaBlock = sql.slice(sql.indexOf("quota(layer"), sql.indexOf("select id::text"));
  const quotas = [...quotaBlock.matchAll(/\('(published|failed)', '([a-z_]+)', (\d+)\)/g)].map((m) => ({ layer: m[1], n: Number(m[3]) }));
  assert.equal(quotas.reduce((a, q) => a + q.n, 0), 100);
  assert.equal(quotas.filter((q) => q.layer === "published").reduce((a, q) => a + q.n, 0), 53);
  assert.equal(quotas.filter((q) => q.layer === "failed").reduce((a, q) => a + q.n, 0), 47);
  const excluded = [...new Set([...sql.matchAll(/'([0-9a-f]{8})'/g)].map((m) => m[1]))];
  assert.equal(excluded.length, 212);
  const selection = JSON.parse(await Deno.readTextFile(new URL("../fixtures/eval_selection.json", import.meta.url)));
  const original = JSON.parse(await Deno.readTextFile(new URL("../fixtures/cases.json", import.meta.url))).cases.map((c: { caseId: string }) => c.caseId.slice(-8));
  assert.deepEqual([...excluded].sort(), [...new Set([...selection.hard, ...selection.sample, ...original])].sort());
  assert.match(sql, /kabumori-posted-v5/);
  assert.match(sql, /NOT EXECUTED YET/);
});
