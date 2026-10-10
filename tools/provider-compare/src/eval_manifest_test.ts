import assert from "node:assert/strict";
import test from "node:test";
import { loadCases } from "./fixtures.ts";
import {
  buildManifest,
  classify,
  hazardsOf,
  markdownSummary,
  missRateUpperBound95,
  positivesNeeded,
  productionCodeStamp,
  sha256Hex,
} from "../scripts/eval_manifest.ts";

const cases = await loadCases();
const STAMP = [{ path: "x.ts", sha256: "0".repeat(64) }];
const manifest = buildManifest(cases, { label: "test", productionCode: STAMP });

test("sha256 is the standard digest", async () => {
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("the production code stamp hashes the real source files the harness reads", async () => {
  const stamp = await productionCodeStamp(new URL("../../../", import.meta.url));
  assert.equal(stamp.length, 5);
  for (const entry of stamp) assert.match(entry.sha256, /^[0-9a-f]{64}$/);
  assert.ok(stamp.some((entry) => entry.path.endsWith("post_generation_logic.ts")));
});

test("zero observed misses: the exact 95% upper bound, and how many positives each target needs", () => {
  assert.equal(missRateUpperBound95(20, 0), 0.139);
  assert.equal(missRateUpperBound95(59, 0), 0.05);
  assert.equal(positivesNeeded(0.05), 59);
  assert.equal(positivesNeeded(0.1), 29);
  assert.equal(missRateUpperBound95(0, 0), null);
});

test("with observed misses the bound is the exact binomial (Clopper-Pearson) bound", () => {
  assert.equal(missRateUpperBound95(20, 1), 0.216);
  const higher = missRateUpperBound95(20, 3)!;
  assert.ok(higher > 0.216 && higher < 0.4, String(higher));
});

test("hazard detection finds each PR #116 hazard type and ignores plain text", () => {
  assert.deepEqual(hazardsOf("通常のニュースです。"), []);
  assert.ok(hazardsOf("買収額は1.2億ドルです").includes("foreign_currency"));
  assert.ok(hazardsOf("営業損失を計上しました").includes("negative_or_loss"));
  assert.ok(hazardsOf("提携を撤回しました").includes("withdraw_or_cancel"));
  assert.ok(hazardsOf("株主総会で承認されました").includes("approval_state"));
  assert.ok(hazardsOf("営業利益は100億円、純利益は80億円です").includes("multiple_amounts"));
  assert.ok(hazardsOf("取得価額は147百万円です").includes("unit_conversion"));
  assert.ok(hazardsOf("傘下の子会社が").includes("subject_pair"));
  assert.ok(hazardsOf("とみられています").includes("hedge"));
  assert.ok(!hazardsOf("100億円です").includes("multiple_amounts"), "one amount is not a pair");
});

test("full-width characters are normalised before hazard detection", () => {
  assert.ok(hazardsOf("営業利益は１００億円、純利益は８０億円").includes("multiple_amounts"));
});

test("manifest totals match the fixture file", () => {
  assert.equal(manifest.totals.cases, 22);
  assert.equal(manifest.sufficiency.positives + manifest.sufficiency.negatives, 22);
  assert.equal(Object.values(manifest.totals.byOutcomeKind).reduce((a, b) => a + b, 0), 22);
  assert.equal(manifest.cases.length, 22);
  assert.equal(manifest.labelQuality.productionDecision + manifest.labelQuality.humanHint, 22);
});

test("the manifest is deterministic and sorted", () => {
  const again = buildManifest([...cases].reverse(), { label: "test", productionCode: STAMP });
  assert.equal(JSON.stringify(again), JSON.stringify(manifest));
  assert.deepEqual(manifest.cases.map((c) => c.caseId), manifest.cases.map((c) => c.caseId).sort());
});

test("22 cases are reported as NOT sufficient for ranking recall, with the reasons as gaps", () => {
  assert.match(manifest.sufficiency.verdict, /NOT sufficient/);
  const kinds = new Set(manifest.gaps.map((gap) => gap.kind));
  for (const kind of ["negatives_and_borderline", "independent_positives_missed_by_production", "foreign_currency_amounts", "withdrawn_cancelled_postponed"]) {
    assert.ok(kinds.has(kind), kind);
  }
  for (const gap of manifest.gaps) assert.ok(gap.have < gap.want, `${gap.kind}: have ${gap.have} want ${gap.want}`);
});

test("only the official-notice miss is a label independent of production", () => {
  assert.equal(manifest.labelQuality.independentOfProduction, 1);
  const independent = manifest.cases.filter((c) => c.expectedSource === "human_hint");
  assert.equal(independent.length, 1);
  assert.equal(independent[0].outcomeKind, "miss");
});

test("per-case classification is internally consistent", () => {
  for (const item of manifest.cases) {
    assert.ok(["no_post", "important", "most_important"].includes(item.expected));
    if (item.outcomeKind === "negative_control") assert.equal(item.expected, "no_post");
    if (item.outcomeKind === "generation_failure") assert.equal(item.hasStoredPost, true);
  }
  const fixture = cases.find((c) => c.outcomeKind === "miss")!;
  assert.equal(classify(fixture).recordedImportance, "no_post");
  assert.equal(classify(fixture).expected, "important");
});

test("fact probes are counted by mutation and split into headline and exploratory", () => {
  assert.equal(manifest.factProbes.total, manifest.factProbes.headline + manifest.factProbes.exploratory);
  assert.ok(manifest.factProbes.total >= 20);
  assert.ok(manifest.factProbes.byMutation["currency_swap"] >= 1);
});

test("the markdown summary mentions every gap and hazard", () => {
  const text = markdownSummary(manifest);
  for (const gap of manifest.gaps) assert.ok(text.includes(gap.kind), gap.kind);
  for (const hazard of Object.keys(manifest.hazardCoverage)) assert.ok(text.includes(hazard), hazard);
});
