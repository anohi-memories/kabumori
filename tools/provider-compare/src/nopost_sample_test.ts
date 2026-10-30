import assert from "node:assert/strict";
import test from "node:test";
import { loadEvalSet, loadLabels } from "./eval_set.ts";
import {
  attachBodies,
  blindView,
  clopperPearsonUpper,
  estimateNopostMissRate,
  type NopostCase,
} from "./nopost_sample.ts";
import { bodyMayBeStored } from "./body_policy.ts";
import { scanJson } from "./secret_scan.ts";
import { buildNopostCase, buildNopostSample, expandLabel } from "../scripts/build_nopost_sample.ts";
import { buildNopostReport, loadNopostSample } from "../scripts/nopost_report.ts";
import { sha256Hex } from "../scripts/eval_manifest.ts";

const [sample, evalSet, mainLabels] = await Promise.all([loadNopostSample(), loadEvalSet(), loadLabels()]);

function row(id: string, source: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `${id}-0000-4000-8000-000000000000`,
    source_name: source,
    source_type: source === "tdnet" ? "tdnet" : "breaking_market",
    source_url: source === "tdnet" ? "https://www.release.tdnet.info/inbs/x.pdf" : "https://www.boj.or.jp/a.pdf",
    title: `title ${id}`,
    body_summary: "本文",
    company_name: null,
    company_code: null,
    category: "other_corporate_ir",
    published_at: "2026-10-01T00:00:00Z",
    importance: "no_post",
    judgement_model: "gpt-6-sol",
    confidence: 0.9,
    escalated_to_sol: true,
    judgement_reason: "r",
    gate_suppressed: false,
    cell_n: 10,
    cell_sampled: 2,
    cell_rank: 1,
    ...overrides,
  };
}

const synthetic = (id: string, layer: "gate_suppressed" | "not_gated", source: string, expected: "no_post" | "important" | null, n: number, sampled: number): NopostCase => ({
  caseId: id, candidateId: id, sourceName: source, sourceUrl: "https://example.test", title: id, companyName: null, companyCode: null,
  category: "other_corporate_ir", publishedAt: "2026-10-01T00:00:00.000Z", bodyStored: false, bodySummary: null, bodyCharsOriginal: 0, bodySha256: "",
  layer, cell: { n, sampled, rank: 1 },
  recorded: { importance: "no_post", model: "gpt-6-sol", confidence: 0.9, escalatedToSol: true, reason: "", coverageSeverity: null },
  label: {
    expected, status: expected === null ? "insufficient_evidence" : "independent_confirmed", rule: null, cluster: null, headline: expected !== null,
    keyFacts: [], rationale: "", primarySourceCheck: "stored_extraction_of_official_document", verifier: "none", suspected: false,
  },
});

test("exact one-sided upper bounds: zero events, one event, and agreement with the Phase 3 helper", () => {
  assert.ok(Math.abs(clopperPearsonUpper(150, 0)! - 0.0198) < 0.0001);
  assert.ok(Math.abs(clopperPearsonUpper(75, 0)! - 0.0390) < 0.0005);
  assert.ok(Math.abs(clopperPearsonUpper(20, 1)! - 0.2157) < 0.001);
  assert.ok(Math.abs(clopperPearsonUpper(150, 3)! - 0.0505) < 0.002);
  assert.equal(clopperPearsonUpper(0, 0), null);
  assert.equal(clopperPearsonUpper(10, 10), 1);
  assert.ok(clopperPearsonUpper(150, 3, 0.025)! > clopperPearsonUpper(150, 3, 0.05)!, "a higher confidence level gives a wider bound");
});

test("the sample is the size and shape that was designed: two layers of 75, six sources", () => {
  assert.equal(sample.cases.length, 150);
  assert.equal(sample.population.layers.gate_suppressed.sampled, 75);
  assert.equal(sample.population.layers.not_gated.sampled, 75);
  assert.equal(sample.population.excludedCases, 212);
  assert.equal(new Set(sample.cases.map((c) => c.sourceName)).size, 6);
  assert.equal(sample.population.seed, "kabumori-nopost-v4");
});

test("every case is a production no_post and none is already in the evaluation set", () => {
  const known = new Set<string>();
  for (const item of evalSet) known.add((item.candidateId ?? item.caseId.slice(-8)).slice(0, 8));
  const seen = new Set<string>();
  for (const item of sample.cases) {
    assert.equal(item.recorded.importance, "no_post", item.caseId);
    const id8 = item.candidateId.slice(0, 8);
    assert.ok(!known.has(id8), `${item.caseId} is already an evaluation case`);
    assert.ok(!seen.has(item.candidateId), `${item.caseId} appears twice`);
    seen.add(item.candidateId);
  }
});

test("design weights: each cell's weight is N / sampled and the weights of a layer add up to the layer's frame", () => {
  for (const layer of ["gate_suppressed", "not_gated"] as const) {
    const cells = sample.population.cells.filter((c) => c.layer === layer);
    const frame = cells.reduce((sum, c) => sum + c.n, 0);
    assert.equal(sample.population.layers[layer].n, frame);
    const members = sample.cases.filter((c) => c.layer === layer);
    const weightSum = members.reduce((sum, c) => sum + c.cell.n / c.cell.sampled, 0);
    assert.ok(Math.abs(weightSum - frame) < 1e-6, `${layer}: ${weightSum} vs ${frame}`);
    for (const cell of cells) {
      assert.equal(members.filter((c) => c.sourceName === cell.source).length, cell.sampled, `${layer}/${cell.source}`);
      assert.ok(cell.sampled >= 1 && cell.sampled <= cell.n, `${layer}/${cell.source}`);
    }
  }
});

test("the builder is deterministic and rejects an unlabelled row", async () => {
  const labels = { labels: { "00000001": ["n", "I", "R-ROUTINE", "fact", "why"] as [string, string, string | null, string, string] } };
  const rows = [row("00000001", "tdnet")];
  const a = JSON.stringify(await buildNopostSample(rows, labels as never, mainLabels.codeVersions));
  const b = JSON.stringify(await buildNopostSample([...rows].reverse(), labels as never, mainLabels.codeVersions));
  assert.equal(a, b);
  await assert.rejects(() => buildNopostCase(row("00000002", "tdnet"), labels as never), /NO_LABEL/);
});

test("label expansion keeps provenance honest: undecidable labels have no expected value and nobody is human-confirmed", () => {
  const ok = expandLabel(["n", "I", "R-ROUTINE", "f", "r"], "tdnet");
  assert.equal(ok.status, "independent_confirmed");
  assert.equal(ok.verifier, "none");
  assert.equal(ok.headline, true);
  const undecided = expandLabel(["null", "X", null, "f", "r"], "tdnet");
  assert.equal(undecided.expected, null);
  assert.equal(undecided.headline, false);
  assert.throws(() => expandLabel(["null", "I", null, "f", "r"], "tdnet"), /STATUS_EXPECTED_MISMATCH/);
  assert.throws(() => expandLabel(["i", "X", null, "f", "r"], "tdnet"), /STATUS_EXPECTED_MISMATCH/);
  assert.throws(() => expandLabel(["n", "Z", null, "f", "r"], "tdnet"), /UNKNOWN_STATUS/);
  for (const item of sample.cases) {
    assert.equal(item.label.verifier, "none", item.caseId);
    if (item.label.status === "independent_confirmed") assert.notEqual(item.label.rule, null, `${item.caseId}: independent label needs a rule`);
    if (item.label.rule) assert.ok(mainLabels.rules[item.label.rule], `${item.caseId}: unknown rule ${item.label.rule}`);
  }
});

test("labels with no decisive evidence are excluded from the estimate, and the bound is reported both ways", () => {
  const cases = [
    synthetic("g1", "gate_suppressed", "tdnet", "no_post", 40, 4),
    synthetic("g2", "gate_suppressed", "tdnet", "no_post", 40, 4),
    synthetic("g3", "gate_suppressed", "tdnet", "important", 40, 4),
    synthetic("g4", "gate_suppressed", "tdnet", null, 40, 4),
    synthetic("n1", "not_gated", "tdnet", "no_post", 100, 2),
    synthetic("n2", "not_gated", "tdnet", "no_post", 100, 2),
  ];
  const estimate = estimateNopostMissRate(cases);
  const gated = estimate.layers.find((l) => l.layer === "gate_suppressed")!;
  assert.equal(gated.frame, 40);
  assert.equal(gated.misses, 1);
  assert.equal(gated.undetermined, 1);
  assert.equal(gated.missShare, 0.25);
  assert.ok(gated.upperBoundConservative! > gated.upperBoundOptimistic!);
  const open = estimate.layers.find((l) => l.layer === "not_gated")!;
  assert.equal(open.misses, 0);
  assert.equal(open.missShare, 0);
  assert.equal(estimate.frame, 140);
  assert.equal(estimate.overall.estimatedMisses, 10);
  assert.ok(estimate.overall.upperBoundMissesConservative! >= estimate.overall.upperBoundMissesOptimistic!);
});

test("the real sample: counts add up and the estimate does not claim a recall", () => {
  const report = buildNopostReport(sample.cases);
  assert.equal(Object.values(report.byStatus).reduce((a, b) => a + b, 0), 150);
  assert.equal(Object.values(report.byExpected).reduce((a, b) => a + b, 0), 150);
  const { estimate } = report;
  assert.equal(estimate.sampled, 150);
  assert.equal(estimate.frame, 1706);
  assert.equal(estimate.layers.reduce((s, l) => s + l.sampled, 0), 150);
  assert.equal(estimate.layers.reduce((s, l) => s + l.misses, 0), (report.byExpected["important"] ?? 0) + (report.byExpected["most_important"] ?? 0));
  assert.equal(estimate.layers.reduce((s, l) => s + l.undetermined, 0), report.byExpected["null"]);
  assert.ok(!("recall" in estimate.overall), "a no_post-layer estimate must not be presented as a recall");
  assert.equal(report.byLayer["gate_suppressed"], 75);
});

test("the review list contains every suspected, important-labelled and policy-pending case", () => {
  const report = buildNopostReport(sample.cases);
  const listed = new Set(report.priorityReview.map((p) => p.caseId));
  for (const item of sample.cases) {
    const should = item.label.suspected || item.label.expected === "important" || item.label.expected === "most_important" ||
      item.label.status === "human_review_pending";
    assert.equal(listed.has(item.caseId), should, item.caseId);
  }
});

test("a blind view carries nothing of production's decision", () => {
  const item = sample.cases[0];
  const view = blindView(item);
  const keys = Object.keys(view);
  for (const forbidden of ["importance", "confidence", "reason", "recorded", "layer", "status", "label", "model", "gate_suppressed", "escalatedToSol"]) {
    assert.ok(!keys.includes(forbidden), forbidden);
  }
  assert.ok(!JSON.stringify(view).includes(item.recorded.reason) || item.recorded.reason === "");
});

test("bodies: only allowed hosts are stored, the others are re-attached from a local export and verified by hash", async () => {
  for (const item of sample.cases) {
    assert.equal(item.bodyStored, bodyMayBeStored(item.sourceUrl), item.caseId);
    if (!item.bodyStored) assert.equal(item.bodySummary, null, item.caseId);
    assert.match(item.bodySha256, /^[0-9a-f]{64}$/, item.caseId);
  }
  const body = "ローカルでだけ読み出した本文";
  const item = { candidateId: "id-1", candidate: { bodySummary: null as string | null, bodyStored: false, bodySha256: await sha256Hex(body) } };
  const ok = await attachBodies([item], new Map([["id-1", body]]));
  assert.equal(ok.attached, 1);
  assert.equal(ok.cases[0].candidate.bodySummary, body);
  const changed = await attachBodies([item], new Map([["id-1", body + "（変更）"]]));
  assert.deepEqual(changed.changed, ["id-1"]);
  assert.equal(changed.cases[0].candidate.bodySummary, null);
  const missing = await attachBodies([item], new Map());
  assert.deepEqual(missing.missing, ["id-1"]);
});

test("no credential-shaped string anywhere in the sample", () => {
  assert.deepEqual(scanJson(sample), []);
});
