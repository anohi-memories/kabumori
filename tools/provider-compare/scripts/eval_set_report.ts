// Prints (and optionally writes) the Phase 3 evaluation-set report: composition, label provenance, the headline sets the
// future comparison will score, production's own disagreements with the labels, and the representative-sample estimate.
//   deno run --no-config --allow-read [--allow-write=<out>] tools/provider-compare/scripts/eval_set_report.ts [--out <file.json>]
import {
  estimateProductionOnSample,
  isHeadline,
  isPositive,
  loadEvalSet,
  productionDisagreements,
  summariseEvalSet,
  type EvalCase,
} from "../src/eval_set.ts";
import { hazardsOf, missRateUpperBound95, positivesNeeded } from "./eval_manifest.ts";

/** Hazard types PR #116 targets, plus consolidated-vs-standalone which the manifest's detector does not cover. */
const CONSOLIDATED_STANDALONE = /(連結.*個別|個別.*連結|単体|非連結|個別業績)/;

export function hazardCoverage(cases: readonly EvalCase[]): Record<string, { cases: number; independent: number }> {
  const out: Record<string, { cases: number; independent: number }> = {};
  const add = (hazard: string, item: EvalCase) => {
    out[hazard] ??= { cases: 0, independent: 0 };
    out[hazard].cases += 1;
    if (item.label.status === "independent_confirmed") out[hazard].independent += 1;
  };
  for (const item of cases.filter(isHeadline)) {
    const post = item.recorded.generation?.text ?? "";
    const text = [item.candidate.title, item.candidate.bodySummary ?? "", post].join("\n").normalize("NFKC");
    for (const hazard of hazardsOf(text)) add(hazard, item);
    if (CONSOLIDATED_STANDALONE.test(text)) add("consolidated_vs_standalone", item);
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** Target areas from the Phase 3 brief mapped to the domains the builder assigns. */
export const TARGET_AREAS: ReadonlyArray<{ area: string; domains: string[]; want: number }> = [
  { area: "国内企業の重要IR・TDnet（決算・配当・自社株買い）", domains: ["tdnet_earnings_capital"], want: 8 },
  { area: "訴訟・行政処分・不祥事", domains: ["tdnet_misconduct_regulatory"], want: 8 },
  { area: "大型M&A・TOB", domains: ["tdnet_ma_tob"], want: 6 },
  { area: "金融システム・上場（取引所措置）", domains: ["tdnet_listing_exchange"], want: 4 },
  { area: "日銀・金融庁・公的機関", domains: ["official_boj_frb", "official_jp"], want: 6 },
  { area: "地政学", domains: ["geopolitics"], want: 8 },
  { area: "米国政策・関税・制裁", domains: ["us_policy_trade_sanctions"], want: 6 },
  { area: "国内災害・インフラ・災害", domains: ["disaster"], want: 4 },
  { area: "AI・半導体", domains: ["ai_semiconductor"], want: 3 },
  { area: "為替・金利・マクロ", domains: ["macro_fx_rates"], want: 3 },
];

export type Report = ReturnType<typeof buildReport>;

export function buildReport(cases: readonly EvalCase[]) {
  const summary = summariseEvalSet(cases);
  const headline = cases.filter(isHeadline);
  const hard = headline.filter((c) => c.sets.includes("hard") || c.sets.includes("existing"));
  const independentPositives = headline.filter((c) => c.label.status === "independent_confirmed" && isPositive(c.label.expected!));
  const positives = headline.filter((c) => isPositive(c.label.expected!));
  const disagreements = productionDisagreements(cases);
  const independentMisses = disagreements.filter((d) => d.kind === "production_miss" && d.status === "independent_confirmed");
  const coverage = TARGET_AREAS.map((target) => {
    const inArea = headline.filter((c) => target.domains.includes(c.group));
    return {
      area: target.area,
      want: target.want,
      headlineCases: inArea.length,
      positives: inArea.filter((c) => isPositive(c.label.expected!)).length,
      independent: inArea.filter((c) => c.label.status === "independent_confirmed").length,
    };
  });
  return {
    summary,
    hardHeadlineCases: hard.length,
    positives: positives.length,
    independentPositives: independentPositives.length,
    missRateUpperBound95IfNoMiss: missRateUpperBound95(independentPositives.length, 0),
    positivesNeededFor5pct: positivesNeeded(0.05),
    positivesNeededFor10pct: positivesNeeded(0.1),
    productionDisagreements: {
      total: disagreements.length,
      misses: disagreements.filter((d) => d.kind === "production_miss").length,
      overcalls: disagreements.filter((d) => d.kind === "production_overcall").length,
      independentMisses: independentMisses.length,
      list: disagreements,
    },
    representativeSample: estimateProductionOnSample(cases),
    coverage,
    hazardCoverage: hazardCoverage(cases),
  };
}

export function markdown(report: Report): string {
  const s = report.summary;
  const lines: string[] = [];
  lines.push("# 評価セット レポート", "");
  lines.push(`ケース ${s.total} 件（集合: ${JSON.stringify(s.bySet)}）`, "");
  lines.push("| 確認状態 | 件数 |", "|---|---|");
  for (const [k, v] of Object.entries(s.byStatus)) lines.push(`| ${k} | ${v} |`);
  lines.push("", `headline に数えるケース ${s.headline.cases} 件（正例 ${s.headline.positives} / 負例 ${s.headline.negatives}）`);
  lines.push(`- 独立確認済み: 正例 ${s.headline.independentPositives} / 負例 ${s.headline.independentNegatives}`);
  lines.push(`- AI暫定: 正例 ${s.headline.provisionalPositives} / 負例 ${s.headline.provisionalNegatives}`);
  lines.push(`- 人手確認待ち ${s.humanReview.cases} 件（質問 ${s.humanReview.questions.length} 件）／根拠不足 ${s.insufficientEvidence} 件／人が確認済み ${s.humanConfirmed} 件`, "");
  lines.push("| 領域 | 目標 | headline | うち正例 | うち独立確認 |", "|---|---|---|---|---|");
  for (const c of report.coverage) lines.push(`| ${c.area} | ${c.want} | ${c.headlineCases} | ${c.positives} | ${c.independent} |`);
  return lines.join("\n") + "\n";
}

if (import.meta.main) {
  const cases = await loadEvalSet();
  const report = buildReport(cases);
  console.log(markdown(report));
  const outIndex = Deno.args.indexOf("--out");
  if (outIndex >= 0 && Deno.args[outIndex + 1]) {
    await Deno.writeTextFile(Deno.args[outIndex + 1], JSON.stringify(report, null, 2) + "\n");
  }
}
