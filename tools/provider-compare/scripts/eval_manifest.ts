// Builds the news evaluation-set manifest: how each fixture case is classified, which PR #116 hazard types it covers,
// whether the set is big enough to compare recall, and which production source files (by hash) a run was made against.
//   deno run --no-config --allow-read [--allow-write=<out>] tools/provider-compare/scripts/eval_manifest.ts [--out <file>] [--label <text>]
// Pure and deterministic: the same fixtures and sources give the same manifest. No network, no key, no production access.
import { loadCases, type CaseFixture, type Importance } from "../src/fixtures.ts";
import { buildFactProbes } from "../src/fact_probes.ts";
import { recordedFinalText } from "../src/tasks.ts";

export type Hazard =
  | "foreign_currency"      // 通貨の取り違え
  | "negative_or_loss"      // 負号の消失・方向反転
  | "withdraw_or_cancel"    // 承認・撤回状態の誤り
  | "approval_state"        // 決議・承認の状態
  | "multiple_amounts"      // 指標と金額の交換
  | "unit_conversion"       // 同値単位換算
  | "subject_pair"          // 主体不明瞭（親子・報道主体）
  | "hedge";                // 留保表現

const NORMALISE = (text: string) => text.normalize("NFKC");
const AMOUNT = /\d[\d,]*(?:\.\d+)?(?:億|百万|万|千)?円/g;

const HAZARD_RULES: ReadonlyArray<readonly [Hazard, RegExp]> = [
  ["foreign_currency", /(\d[\d,.]*\s*(?:億|百万|万|千)?\s*(?:(?:米|豪|カナダ|香港)?ドル|ユーロ|ポンド|ウォン|人民元|USD|EUR)|US\$\s?\d|\$\s?\d|€\s?\d)/],
  ["negative_or_loss", /(△|▲|－\d|マイナス|赤字|損失|減益|下方修正|減の)/],
  ["withdraw_or_cancel", /(撤回|中止|延期|否決|取消|解約|解除|見送り)/],
  ["approval_state", /(決議|承認|可決|付議|同意|賛同)/],
  ["unit_conversion", /(百万円|億円|兆円|千円)/],
  ["subject_pair", /(子会社|親会社|傘下|完全子会社)/],
  ["hedge", /(とみられ|可能性|意向|検討|予定|見込|疑い|報道|暫定|示唆)/],
];

export function hazardsOf(text: string): Hazard[] {
  const normalised = NORMALISE(text);
  const found = HAZARD_RULES.filter(([, pattern]) => pattern.test(normalised)).map(([hazard]) => hazard);
  const amounts = [...new Set([...normalised.matchAll(AMOUNT)].map((m) => m[0]))];
  if (amounts.length >= 2) found.push("multiple_amounts");
  return found;
}

export type CaseClass = {
  caseId: string;
  group: string;
  outcomeKind: string;
  sourceName: string;
  sourceType: string;
  category: string;
  expected: Importance;
  expectedSource: "production_decision" | "human_hint";
  recordedImportance: Importance;
  recordedModel: string;
  escalatedToSol: boolean;
  confidence: number;
  hasStoredPost: boolean;
  factStatus: string | null;
  voiceStatus: string | null;
  bodyChars: number;
  hazards: Hazard[];
};

export function classify(fixture: CaseFixture): CaseClass {
  const post = recordedFinalText(fixture) ?? "";
  const text = [fixture.candidate.title, fixture.candidate.bodySummary ?? "", post].join("\n");
  return {
    caseId: fixture.caseId,
    group: fixture.group,
    outcomeKind: fixture.outcomeKind,
    sourceName: fixture.candidate.sourceName,
    sourceType: fixture.candidate.sourceType,
    category: fixture.candidate.category,
    expected: fixture.expected.importance,
    expectedSource: fixture.expected.source,
    recordedImportance: fixture.recorded.judgement.importance,
    recordedModel: fixture.recorded.judgement.model,
    escalatedToSol: fixture.recorded.judgement.escalatedToSol,
    confidence: fixture.recorded.judgement.confidence,
    hasStoredPost: post.length > 0,
    factStatus: fixture.recorded.generation?.factStatus ?? null,
    voiceStatus: fixture.recorded.generation?.voiceStatus ?? null,
    bodyChars: (fixture.candidate.bodySummary ?? "").length,
    hazards: hazardsOf(text),
  };
}

function tally<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

/** 95% one-sided upper bound on the true miss rate when `misses` of `n` positives were missed (exact, binomial). */
export function missRateUpperBound95(n: number, misses: number): number | null {
  if (n <= 0) return null;
  if (misses === 0) return Math.round((1 - Math.pow(0.05, 1 / n)) * 1000) / 1000;
  // Clopper-Pearson via bisection on the binomial CDF.
  const cdf = (p: number) => {
    let sum = 0;
    let term = Math.pow(1 - p, n);
    for (let k = 0; k <= misses; k += 1) {
      sum += term;
      term = (term * (n - k) * p) / ((k + 1) * (1 - p));
    }
    return sum;
  };
  let lo = misses / n;
  let hi = 1 - 1e-9;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) > 0.05) lo = mid; else hi = mid;
  }
  return Math.round(hi * 1000) / 1000;
}

/** Positives needed so that zero observed misses proves a miss rate below `target` at 95% confidence. */
export function positivesNeeded(target: number): number {
  return Math.ceil(Math.log(0.05) / Math.log(1 - target));
}

export type Gap = { kind: string; why: string; have: number; want: number; sourceHint: string };

export type Manifest = {
  version: 1;
  label: string;
  productionCode: Array<{ path: string; sha256: string }>;
  totals: {
    cases: number;
    byOutcomeKind: Record<string, number>;
    byGroup: Record<string, number>;
    byExpected: Record<string, number>;
    bySource: Record<string, number>;
    labelSources: Record<string, number>;
  };
  labelQuality: { productionDecision: number; humanHint: number; independentOfProduction: number; note: string };
  sufficiency: {
    positives: number;
    negatives: number;
    knownMisses: number;
    missRateUpperBound95: number | null;
    positivesNeededFor5pct: number;
    positivesNeededFor10pct: number;
    verdict: string;
  };
  hazardCoverage: Record<Hazard, number>;
  factProbes: { total: number; byMutation: Record<string, number>; headline: number; exploratory: number };
  gaps: Gap[];
  cases: CaseClass[];
};

const PRODUCTION_FILES = [
  "supabase/functions/important-news-monitor/post_generation_logic.ts",
  "supabase/functions/important-news-monitor/importance_judgement_logic.ts",
  "supabase/functions/important-news-monitor/breaking_market_source_fetchers.ts",
  "supabase/functions/important-news-monitor/breaking_market_daily_schedule.ts",
  "supabase/functions/important-news-monitor/news_candidate_logic.ts",
];

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function productionCodeStamp(root: URL): Promise<Manifest["productionCode"]> {
  const stamp: Manifest["productionCode"] = [];
  for (const path of PRODUCTION_FILES) {
    stamp.push({ path, sha256: await sha256Hex(await Deno.readTextFile(new URL(path, root))) });
  }
  return stamp;
}

export function buildManifest(
  cases: readonly CaseFixture[],
  options: { label: string; productionCode: Manifest["productionCode"] },
): Manifest {
  const classes = [...cases].map(classify).sort((a, b) => a.caseId.localeCompare(b.caseId));
  const positives = classes.filter((c) => c.expected !== "no_post");
  const negatives = classes.filter((c) => c.expected === "no_post");
  const knownMisses = classes.filter((c) => c.outcomeKind === "miss").length;
  const hazardNames: Hazard[] = [
    "foreign_currency", "negative_or_loss", "withdraw_or_cancel", "approval_state",
    "multiple_amounts", "unit_conversion", "subject_pair", "hedge",
  ];
  const hazardCoverage = Object.fromEntries(
    hazardNames.map((h) => [h, classes.filter((c) => c.hazards.includes(h)).length]),
  ) as Record<Hazard, number>;
  const probes = buildFactProbes(cases);
  const byMutation = tally(probes, (p) => p.mutation);
  const upper = missRateUpperBound95(positives.length, knownMisses);
  const independent = classes.filter((c) => c.expectedSource === "human_hint").length;

  const gaps: Gap[] = [
    { kind: "negatives_and_borderline", why: "precision / false alarms cannot be measured with 2 negatives", have: negatives.length, want: 40,
      sourceHint: "no_post and low-confidence (<0.7) candidates from market_macro, jp_official, breaking trigger lane and TDnet (see export_gap_candidates.sql)" },
    { kind: "independent_positives_missed_by_production", why: "every non-miss positive was selected BECAUSE production flagged it, so agreement with production is circular", have: knownMisses, want: 20,
      sourceHint: "events production dropped but another source reported as important (same event, different source); needs human labels" },
    { kind: "foreign_currency_amounts", why: "currency mix-ups (PR #116) need posts whose source amounts are in USD / EUR", have: hazardCoverage.foreign_currency, want: 8,
      sourceHint: "TDnet overseas acquisitions / US subsidiaries, BBC / AJ items with dollar figures" },
    { kind: "loss_or_negative_figures", why: "sign loss needs △ / ▲ / 赤字 / 損失 figures in the SOURCE", have: hazardCoverage.negative_or_loss, want: 10,
      sourceHint: "TDnet 業績予想の修正 (下方・赤字転落)、特別損失の計上" },
    { kind: "withdrawn_cancelled_postponed", why: "approval / withdrawal state errors need sources that withdraw, cancel or postpone", have: hazardCoverage.withdraw_or_cancel, want: 8,
      sourceHint: "TDnet 開示事項の中止・撤回・延期、TOB の撤回、提携の解消" },
    { kind: "subject_ambiguity", why: "parent / subsidiary / reporter-vs-actor confusion", have: hazardCoverage.subject_pair, want: 10,
      sourceHint: "TDnet 子会社の異動・グループ内再編、親会社報道、孫会社の債権放棄" },
    { kind: "large_ma_tob", why: "the most important TDnet class has only small or failed examples", have: classes.filter((c) => ["tdnet_capital"].includes(c.group)).length, want: 10,
      sourceHint: "TOB 開始・賛同、大型 M&A、MBO" },
    { kind: "us_policy_tariff_sanctions", why: "no US government / tariff / sanctions case at all", have: classes.filter((c) => ["us_government_policy", "tariffs", "sanctions"].includes(c.category)).length, want: 6,
      sourceHint: "USTR / 商務省 / 財務省制裁 (market_macro) と BBC / AJ の関税・制裁見出し" },
    { kind: "financial_system_and_listing", why: "no bank failure / financial-system / delisting / special-alert case", have: classes.filter((c) => /(上場廃止|特別注意|破綻|取り付け)/.test(c.caseId)).length, want: 6,
      sourceHint: "金融庁・日銀の金融システム関連、東証の特別注意銘柄・整理銘柄" },
    { kind: "domestic_disaster_infrastructure", why: "domestic disaster / infrastructure outage has no case (only overseas floods / hurricane)", have: classes.filter((c) => c.group === "disaster" && c.sourceName === "jma").length, want: 4,
      sourceHint: "気象庁・消防庁・インフラ障害（jp_official / jma_eqvol）" },
  ];

  const enough = positives.length >= positivesNeeded(0.1) && negatives.length >= 40 && independent >= 20;
  return {
    version: 1,
    label: options.label,
    productionCode: options.productionCode,
    totals: {
      cases: classes.length,
      byOutcomeKind: tally(classes, (c) => c.outcomeKind),
      byGroup: tally(classes, (c) => c.group),
      byExpected: tally(classes, (c) => c.expected),
      bySource: tally(classes, (c) => c.sourceName),
      labelSources: tally(classes, (c) => c.expectedSource),
    },
    labelQuality: {
      productionDecision: classes.length - independent,
      humanHint: independent,
      independentOfProduction: independent,
      note: "21 of 22 labels are production's own decision; only the official-notice miss is an independent (human) label",
    },
    sufficiency: {
      positives: positives.length,
      negatives: negatives.length,
      knownMisses,
      missRateUpperBound95: upper,
      positivesNeededFor5pct: positivesNeeded(0.05),
      positivesNeededFor10pct: positivesNeeded(0.1),
      verdict: enough
        ? "sufficient for a first recall comparison"
        : "NOT sufficient: use it to find disagreements for human review, not to rank models on recall",
    },
    hazardCoverage,
    factProbes: {
      total: probes.length,
      byMutation,
      headline: probes.filter((p) => !p.exploratory).length,
      exploratory: probes.filter((p) => p.exploratory).length,
    },
    gaps,
    cases: classes,
  };
}

export function markdownSummary(manifest: Manifest): string {
  const lines: string[] = [];
  lines.push(`# 評価セット マニフェスト (${manifest.label})`);
  lines.push("");
  lines.push(`ケース ${manifest.totals.cases} 件 / 正例 ${manifest.sufficiency.positives} / 負例 ${manifest.sufficiency.negatives} / 既知の取りこぼし ${manifest.sufficiency.knownMisses}`);
  lines.push(`取りこぼし率の95%上限（正例${manifest.sufficiency.positives}件中${manifest.sufficiency.knownMisses}件の取りこぼしから）: ${manifest.sufficiency.missRateUpperBound95}`);
  lines.push(`判定: ${manifest.sufficiency.verdict}`);
  lines.push("");
  lines.push("| 種別 | 件数 |", "|---|---|");
  for (const [kind, count] of Object.entries(manifest.totals.byOutcomeKind)) lines.push(`| ${kind} | ${count} |`);
  lines.push("", "| 危険類型（PR #116） | 含むケース数 |", "|---|---|");
  for (const [hazard, count] of Object.entries(manifest.hazardCoverage)) lines.push(`| ${hazard} | ${count} |`);
  lines.push("", "| 不足 | 現在 | 目標 |", "|---|---|---|");
  for (const gap of manifest.gaps) lines.push(`| ${gap.kind} | ${gap.have} | ${gap.want} |`);
  return lines.join("\n");
}

if (import.meta.main) {
  const args = Deno.args;
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const root = new URL("../../../", import.meta.url);
  const manifest = buildManifest(await loadCases(), {
    label: value("--label") ?? "working-tree",
    productionCode: await productionCodeStamp(root),
  });
  const out = value("--out");
  if (out) await Deno.writeTextFile(out, JSON.stringify(manifest, null, 2) + "\n");
  console.log(markdownSummary(manifest));
}
