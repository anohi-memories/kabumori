import assert from "node:assert/strict";
import test from "node:test";
import { loadCases } from "./fixtures.ts";
import {
  estimateProductionOnSample,
  isHeadline,
  loadEvalSet,
  loadExpansion,
  loadLabels,
  productionDisagreements,
  summariseEvalSet,
  type EvalCase,
} from "./eval_set.ts";
import { containsContactDetails } from "./sanitize.ts";
import { productionCodeStamp } from "../scripts/eval_manifest.ts";
import { buildReport, TARGET_AREAS } from "../scripts/eval_set_report.ts";
import { domainOf } from "../scripts/build_eval_set.ts";
import { bodyMayBeStored } from "./body_policy.ts";
import { scanJson } from "./secret_scan.ts";

const [labels, expansion, evalSet, original] = await Promise.all([loadLabels(), loadExpansion(), loadEvalSet(), loadCases()]);
const normalise = (title: string) => title.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");

function synthetic(
  id: string,
  expected: "no_post" | "important" | "most_important" | null,
  production: "no_post" | "important" | "most_important",
  options: Partial<EvalCase["label"]> & { sample?: { stratum: string; n: number }; sets?: EvalCase["sets"] } = {},
): EvalCase {
  return {
    caseId: id,
    group: "tdnet_other",
    candidateId: id,
    sets: options.sets ?? (options.sample ? ["sample"] : ["hard"]),
    candidate: {
      sourceType: "tdnet", sourceUrl: "https://example.test", sourceName: "tdnet", title: id, bodySummary: null,
      companyName: null, companyCode: null, entityKey: null, category: "other_corporate_ir", publishedAt: "2026-10-01T00:00:00.000Z",
    },
    recorded: {
      judgement: {
        importance: production, category: "other_corporate_ir", affectedEntities: [], japanMarketRelevance: "low", reason: "", confidence: 0.9,
        needsSol: false, factCheckStatus: "passed", model: "gpt-6-luna", escalatedToSol: false,
      },
      generation: null,
    },
    label: {
      expected, status: options.status ?? "independent_confirmed", rule: options.rule ?? "R-ROUTINE", cluster: options.cluster ?? null,
      headline: options.headline ?? true, keyFacts: [], rationale: "", primarySourceCheck: "stored_extraction_of_official_document", verifier: "none",
    },
    sampling: options.sample ? { stratum: options.sample.stratum, stratumN: options.sample.n, stratumRank: 1 } : null,
  };
}

test("the expansion adds to the 22 original fixtures and leaves them alone", () => {
  assert.equal(original.length, 22);
  const existing = evalSet.filter((c) => c.sets.includes("existing"));
  assert.deepEqual(existing.map((c) => c.caseId).sort(), original.map((c) => c.caseId).sort());
  assert.equal(evalSet.length, 22 + expansion.cases.length);
});

test("no candidate or case appears twice", () => {
  const ids = expansion.cases.map((c) => c.candidateId);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(evalSet.map((c) => c.caseId)).size, evalSet.length);
  const original8 = new Set(original.map((c) => c.caseId.slice(-8)));
  for (const item of expansion.cases) assert.ok(!original8.has(item.candidateId!.slice(0, 8)), `${item.caseId} duplicates an original fixture`);
});

test("every label belongs to an exported row and every row has a label", () => {
  const rows = new Set(expansion.cases.map((c) => c.candidateId!.slice(0, 8)));
  const labelled = new Set(Object.keys(labels.labels));
  assert.deepEqual([...rows].filter((id) => !labelled.has(id)), []);
  assert.deepEqual([...labelled].filter((id) => !rows.has(id)), []);
});

test("label provenance: status, expected value and rule agree", () => {
  for (const item of expansion.cases) {
    const { label } = item;
    if (label.status === "human_review_pending" || label.status === "insufficient_evidence") {
      assert.equal(label.expected, null, `${item.caseId}: undecidable label must have no expected value`);
      assert.equal(label.headline, false, `${item.caseId}: undecidable label must not count toward headline metrics`);
    } else {
      assert.notEqual(label.expected, null, `${item.caseId}: decided label needs an expected value`);
    }
    if (label.status === "human_review_pending") assert.ok(label.reviewReason, `${item.caseId}: pending needs a review reason`);
    if (label.status === "independent_confirmed") {
      assert.ok(label.rule || label.primarySourceCheck.startsWith("corroborated"), `${item.caseId}: independent label needs a rule or a corroborating primary document`);
    }
    if (label.rule) assert.ok(labels.rules[label.rule], `${item.caseId}: unknown rule ${label.rule}`);
    assert.ok(label.rationale.length > 0, `${item.caseId}: no rationale`);
  }
});

test("no label is claimed as human-confirmed", () => {
  for (const item of evalSet) assert.equal(item.label.verifier, "none", item.caseId);
  assert.equal(summariseEvalSet(evalSet).humanConfirmed, 0);
});

test("rules that do not apply to a case are not claimed for it", () => {
  for (const item of evalSet) {
    if (item.label.rule === "R-ROUTINE" || item.label.rule === "R-FOLLOWUP" || item.label.rule === "R-NO-SCALE") {
      if (item.label.expected !== null) assert.equal(item.label.expected, "no_post", `${item.caseId}: ${item.label.rule} is a no_post rule`);
    }
    if (item.label.rule === "R-TOB" || item.label.rule === "R-REGULATOR" || item.label.rule === "R-INVESTIGATION" || item.label.rule === "R-EXCHANGE") {
      if (item.label.expected !== null) assert.notEqual(item.label.expected, "no_post", `${item.caseId}: ${item.label.rule} is a post rule`);
    }
  }
});

test("the headline set has no duplicated news: unique titles, one headline per event cluster", () => {
  const families = new Set(labels.families);
  const seenTitles = new Map<string, string>();
  for (const item of evalSet.filter(isHeadline)) {
    // Generic titles ("自己株式の取得状況に関するお知らせ") are shared by many issuers; the same news is title + issuer + day.
    const who = item.candidate.companyCode ?? item.candidate.companyName ?? item.candidate.sourceName;
    const key = `${normalise(item.candidate.title)}|${who}|${item.candidate.publishedAt.slice(0, 10)}`;
    assert.ok(!seenTitles.has(key), `${item.caseId} and ${seenTitles.get(key)} share a title, issuer and day`);
    seenTitles.set(key, item.caseId);
  }
  const perCluster = new Map<string, string[]>();
  for (const item of evalSet.filter(isHeadline)) {
    const cluster = item.label.cluster;
    if (!cluster || families.has(cluster)) continue;
    perCluster.set(cluster, [...(perCluster.get(cluster) ?? []), item.caseId]);
  }
  for (const [cluster, ids] of perCluster) assert.ok(ids.length <= 1, `${cluster}: ${ids.join(", ")}`);
});

test("the representative sample carries its design: strata add up and weights cover the population", () => {
  const sample = expansion.cases.filter((c) => c.sets.includes("sample"));
  assert.ok(sample.length >= 30);
  for (const item of sample) assert.ok(item.sampling, `${item.caseId}: sample member without sampling info`);
  for (const item of expansion.cases.filter((c) => !c.sets.includes("sample"))) assert.equal(item.sampling, null, item.caseId);
  const strata = expansion.population.sample.strata;
  for (const [stratum, { n, sampled }] of Object.entries(strata)) {
    const members = sample.filter((c) => c.sampling!.stratum === stratum);
    assert.equal(members.length, sampled, stratum);
    for (const member of members) assert.equal(member.sampling!.stratumN, n, member.caseId);
    assert.ok(sampled <= n, stratum);
  }
  const weightSum = sample.reduce((sum, c) => {
    const { stratum, stratumN } = c.sampling!;
    return sum + stratumN / strata[stratum].sampled;
  }, 0);
  const populationSize = Object.values(strata).reduce((sum, { n }) => sum + n, 0);
  assert.ok(Math.abs(weightSum - populationSize) < 1e-6, `${weightSum} vs ${populationSize}`);
});

test("the sample is a separate population: hand-picked cases are not presented as representative", () => {
  const hardOnly = expansion.cases.filter((c) => c.sets.includes("hard") && !c.sets.includes("sample"));
  for (const item of hardOnly) assert.equal(item.sampling, null, item.caseId);
  const estimate = estimateProductionOnSample(evalSet);
  const sampleMembers = evalSet.filter((c) => c.sets.includes("sample")).length;
  assert.equal(estimate.used + estimate.nonResponse, sampleMembers);
});

test("bodies are stored only where the terms allow it; the rest is represented by length and SHA-256", () => {
  let stored = 0;
  for (const item of expansion.cases) {
    const body = item.candidate.bodySummary ?? "";
    // The sanitiser works line by line (a phone number sits on one line); a table of years can look like a number across lines.
    assert.ok(!body.split("\n").some((line) => containsContactDetails(line)), `${item.caseId}: contact details left in the body`);
    assert.ok(body.length <= 1800, `${item.caseId}: body too long`);
    assert.match(item.candidate.bodySha256 ?? "", /^[0-9a-f]{64}$/, item.caseId);
    assert.ok((item.candidate.bodyCharsOriginal ?? 0) >= body.length, item.caseId);
    const allowed = bodyMayBeStored(item.candidate.sourceUrl);
    assert.equal(item.candidate.bodyStored, allowed, `${item.caseId}: bodyStored flag disagrees with the body policy`);
    if (!allowed) assert.equal(item.candidate.bodySummary, null, `${item.caseId}: a body was stored although its host is not allowed`);
    if (allowed && item.candidate.bodySummary !== null) stored += 1;
  }
  assert.ok(stored > 0, "some official-source bodies are expected to be stored");
});

test("no fixture string looks like a credential, including URLs", () => {
  assert.deepEqual(scanJson(expansion), []);
  assert.deepEqual(scanJson(labels), []);
});

test("every SQL file in the harness is a read-only SELECT", async () => {
  const dir = new URL("../scripts/", import.meta.url);
  let checked = 0;
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.name.endsWith(".sql")) continue;
    const text = await Deno.readTextFile(new URL(entry.name, dir));
    const code = text.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(code, /\bselect\b/i, entry.name);
    assert.doesNotMatch(code, /\b(insert|update|delete|alter|drop|create|truncate|grant|revoke|vacuum|copy)\b/i, entry.name);
    checked += 1;
  }
  assert.ok(checked >= 5, `${checked} SQL files`);
});

test("the evaluated code version is recorded and matches the working tree for the PR #115 base", async () => {
  const [base, head] = expansion.codeVersions;
  assert.equal(base.ref, "8f430557");
  assert.equal(head.ref, "55b69cf7");
  assert.notEqual(
    base.files["supabase/functions/important-news-monitor/post_generation_logic.ts"],
    head.files["supabase/functions/important-news-monitor/post_generation_logic.ts"],
    "PR #116 changes the file, so the two versions must differ",
  );
  const stamp = await productionCodeStamp(new URL("../../../", import.meta.url));
  const live = stamp.find((entry) => entry.path.endsWith("post_generation_logic.ts"))!;
  assert.equal(live.sha256, base.files["supabase/functions/important-news-monitor/post_generation_logic.ts"]);
});

test("summary counts add up and match the file", () => {
  const summary = summariseEvalSet(evalSet);
  assert.equal(summary.total, evalSet.length);
  assert.equal(Object.values(summary.byStatus).reduce((a, b) => a + b, 0), summary.total);
  assert.equal(Object.values(summary.byExpected).reduce((a, b) => a + b, 0), summary.total);
  assert.equal(Object.values(summary.byDomain).reduce((a, b) => a + b, 0), summary.total);
  assert.equal(summary.headline.cases, summary.headline.positives + summary.headline.negatives);
  assert.equal(summary.headline.positives, summary.headline.independentPositives + summary.headline.provisionalPositives);
  assert.equal(summary.headline.negatives, summary.headline.independentNegatives + summary.headline.provisionalNegatives);
  assert.equal(summary.humanReview.cases, summary.byStatus["human_review_pending"] ?? 0);
  assert.equal(summary.humanReview.questions.reduce((a, q) => a + q.cases, 0), summary.humanReview.cases);
  assert.equal(summary.insufficientEvidence, summary.byStatus["insufficient_evidence"] ?? 0);
});

test("aggregation on a hand-built set: counts, disagreements and the weighted sample estimate", () => {
  const cases = [
    synthetic("a", "important", "important"),
    synthetic("b", "important", "no_post"),
    synthetic("c", "no_post", "important"),
    synthetic("d", "no_post", "no_post"),
    synthetic("e", null, "important", { status: "human_review_pending" }),
    synthetic("f", "important", "important", { headline: false, cluster: "same-event" }),
  ];
  const summary = summariseEvalSet(cases);
  assert.equal(summary.headline.cases, 4);
  assert.equal(summary.headline.positives, 2);
  assert.equal(summary.headline.independentPositives, 2);
  assert.equal(summary.humanReview.cases, 1);
  const disagreements = productionDisagreements(cases);
  assert.deepEqual(disagreements.map((d) => [d.caseId, d.kind]), [["b", "production_miss"], ["c", "production_overcall"]]);

  // Two strata: 100 candidates (sampled 2), 10 candidates (sampled 1). Weights are 50 and 10.
  const sample = [
    synthetic("s1", "important", "important", { sample: { stratum: "tdnet", n: 100 } }),
    synthetic("s2", "no_post", "no_post", { sample: { stratum: "tdnet", n: 100 } }),
    synthetic("s3", "important", "no_post", { sample: { stratum: "jp_official", n: 10 } }),
    synthetic("s4", null, "important", { sample: { stratum: "jp_official", n: 10 }, status: "insufficient_evidence", headline: false }),
  ];
  // jp_official has two sampled members (s3, s4) so its weight is 10 / 2 = 5; tdnet weight is 100 / 2 = 50.
  const estimate = estimateProductionOnSample(sample);
  assert.deepEqual(estimate.unweighted, { tp: 1, fn: 1, fp: 0, tn: 1 });
  assert.deepEqual(estimate.weighted, { tp: 50, fn: 5, fp: 0, tn: 50 });
  assert.equal(estimate.nonResponse, 1);
  assert.equal(estimate.populationSize, 110);
  assert.equal(estimate.recall, 0.909);
  assert.equal(estimate.precision, 1);
  assert.equal(estimate.missRateUpperBound95! > 0.5, true);
});

test("an estimate with no positives refuses to produce a recall", () => {
  const estimate = estimateProductionOnSample([
    synthetic("s1", "no_post", "no_post", { sample: { stratum: "tdnet", n: 100 } }),
  ]);
  assert.equal(estimate.recall, null);
  assert.equal(estimate.missRateUpperBound95, null);
});

test("domain assignment is deterministic and uses the declared rule first", () => {
  assert.equal(domainOf("tdnet", "other_corporate_ir", "R-TOB"), "tdnet_ma_tob");
  assert.equal(domainOf("tdnet", "other_corporate_ir", "R-ROUTINE"), "tdnet_routine_followup");
  assert.equal(domainOf("tdnet", "ma", null), "tdnet_ma_tob");
  assert.equal(domainOf("jp_official", "disaster", null), "official_jp");
  assert.equal(domainOf("al_jazeera", "tariffs", null), "us_policy_trade_sanctions");
  assert.equal(domainOf("breaking_market", "fx", null), "macro_fx_rates");
});

test("the report names every target area, and the coverage counts are consistent with the set", () => {
  const report = buildReport(evalSet);
  assert.deepEqual(report.coverage.map((c) => c.area), TARGET_AREAS.map((t) => t.area));
  for (const row of report.coverage) {
    assert.ok(row.positives <= row.headlineCases, row.area);
    assert.ok(row.independent <= row.headlineCases, row.area);
  }
  assert.equal(report.summary.headline.cases, evalSet.filter(isHeadline).length);
  assert.equal(report.positives, report.summary.headline.positives);
  assert.equal(report.productionDisagreements.total, report.productionDisagreements.misses + report.productionDisagreements.overcalls);
});

test("the set is large enough for what it claims: independent positives for the miss analysis, not for ranking recall", () => {
  const report = buildReport(evalSet);
  assert.ok(report.independentPositives >= 20, `${report.independentPositives} independent positives`);
  assert.ok(report.summary.headline.negatives >= 40);
  // The representative sample yields too few positives to estimate recall: that limit must be visible in the report.
  const sampleEstimate = report.representativeSample;
  assert.ok(sampleEstimate.unweighted.tp + sampleEstimate.unweighted.fn < report.positivesNeededFor10pct);
});
