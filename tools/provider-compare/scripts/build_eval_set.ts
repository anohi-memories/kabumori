// Builds fixtures/eval_expansion.json from the read-only exports (export_eval_rows.sql, export_eval_sample.sql), the
// selection (fixtures/eval_selection.json) and the labels (fixtures/eval_labels.json).
//   deno run --no-config --allow-read --allow-write tools/provider-compare/scripts/build_eval_set.ts <rows.jsonl> <sample.jsonl> [out.json]
// Deterministic: the same inputs give the same file. Bodies are sanitised (contact details removed, 1,800 characters at most)
// and the wire-service bodies (BBC, Al Jazeera) are cut to a short lead so no article text is republished.
import type { ImportantNewsCategory } from "../../../supabase/functions/important-news-monitor/news_candidate_logic.ts";
import type { Importance } from "../src/fixtures.ts";
import { sanitizeBody } from "../src/sanitize.ts";
import type { EvalCase, EvalSetFile, LabelRecord, LabelsFile } from "../src/eval_set.ts";
import { sha256Hex } from "./eval_manifest.ts";

type Row = Record<string, unknown>;
type Selection = { window: string; seed: string; hard: string[]; sample: string[] };

/** Wire-service article text is not ours to republish; keep a short lead only. */
export const COPYRIGHT_SOURCES = new Set(["bbc_world", "al_jazeera"]);
export const COPYRIGHT_LEAD_CHARS = 300;

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/** A coarse, deterministic domain for reporting coverage (the areas listed in the Phase 3 brief). */
export function domainOf(sourceName: string, category: string, rule: string | null): string {
  if (sourceName === "tdnet") {
    if (rule === "R-TOB") return "tdnet_ma_tob";
    if (rule === "R-REGULATOR" || rule === "R-INVESTIGATION" || rule === "R-LITIGATION") return "tdnet_misconduct_regulatory";
    if (rule === "R-EXCHANGE") return "tdnet_listing_exchange";
    if (rule === "R-REVISION" || rule === "R-DIVIDEND" || rule === "R-BUYBACK") return "tdnet_earnings_capital";
    if (rule === "R-ROUTINE" || rule === "R-FOLLOWUP") return "tdnet_routine_followup";
    if (category === "ma" || category === "tob") return "tdnet_ma_tob";
    if (category === "misconduct" || category === "administrative_action" || category === "litigation" || category === "major_security_incident") {
      return "tdnet_misconduct_regulatory";
    }
    if (category.startsWith("earnings") || category === "dividend_increase" || category === "share_buyback") return "tdnet_earnings_capital";
    return "tdnet_other";
  }
  if (sourceName === "jp_official") return "official_jp";
  if (sourceName === "market_macro" && (category === "boj" || category === "frb" || category === "interest_rates")) return "official_boj_frb";
  if (category === "disaster") return "disaster";
  if (category === "tariffs" || category === "us_government_policy" || category === "china_policy" || category === "sanctions") return "us_policy_trade_sanctions";
  if (category === "semiconductor_ai") return "ai_semiconductor";
  if (category === "fx" || category === "boj" || category === "other_market_moving") return "macro_fx_rates";
  return "geopolitics";
}

function primarySourceCheck(sourceName: string, override: string | undefined): string {
  if (override) return override;
  if (sourceName === "tdnet" || sourceName === "jp_official" || sourceName === "market_macro") return "stored_extraction_of_official_document";
  return "secondary_article_summary";
}

export async function buildEvalCase(
  row: Row,
  labels: LabelsFile,
  selection: Selection,
  sampling: { stratum: string; stratumN: number; stratumRank: number } | null,
): Promise<EvalCase> {
  const id = String(row.id ?? "");
  const id8 = id.slice(0, 8);
  const entry = labels.labels[id8];
  if (!entry) throw new Error(`NO_LABEL:${id8}`);
  const sourceName = String(row.source_name);
  const category = String(row.category) as ImportantNewsCategory;
  const full = sanitizeBody(text(row.body_summary));
  const truncate = COPYRIGHT_SOURCES.has(sourceName) && full !== null && full.length > COPYRIGHT_LEAD_CHARS;
  const body = truncate ? sanitizeBody(full, COPYRIGHT_LEAD_CHARS) : full;
  const importance = row.importance as Importance;
  const generated = text(row.generated_text);
  const hasGeneration = generated !== null || text(row.generation_error) !== null;
  const rule = entry.rule ?? null;
  const label: LabelRecord = {
    expected: entry.expected,
    status: entry.status,
    rule,
    cluster: entry.cluster ?? null,
    headline: entry.headline ?? true,
    keyFacts: entry.keyFacts ?? [],
    rationale: entry.rationale ?? "",
    ...(entry.gradeNote ? { gradeNote: entry.gradeNote } : {}),
    ...(entry.reviewReason ? { reviewReason: entry.reviewReason } : {}),
    primarySourceCheck: primarySourceCheck(sourceName, (entry as { primarySourceCheck?: string }).primarySourceCheck),
    verifier: "none",
  };
  const sets: EvalCase["sets"] = [];
  if (selection.hard.includes(id8)) sets.push("hard");
  if (selection.sample.includes(id8)) sets.push("sample");
  return {
    caseId: `${sourceName.replace(/_/g, "-")}-${id8}`,
    group: domainOf(sourceName, category, rule),
    candidateId: id,
    sets,
    candidate: {
      sourceType: String(row.source_type),
      sourceUrl: String(row.source_url),
      sourceName,
      title: String(row.title),
      bodySummary: body,
      companyName: text(row.company_name),
      companyCode: text(row.company_code),
      entityKey: text(row.entity_key),
      category,
      publishedAt: new Date(String(row.published_at)).toISOString(),
      ...(truncate ? { bodyTruncatedForCopyright: true } : {}),
      bodyCharsOriginal: (text(row.body_summary) ?? "").length,
      bodySha256: await sha256Hex(text(row.body_summary) ?? ""),
    },
    recorded: {
      judgement: {
        importance,
        category,
        affectedEntities: list(row.affected_entities),
        japanMarketRelevance: (text(row.japan_market_relevance) ?? "none") as "none" | "low" | "medium" | "high",
        reason: text(row.judgement_reason) ?? "",
        confidence: Number(row.confidence ?? 0),
        needsSol: row.escalated_to_sol === true,
        factCheckStatus: (text(row.fact_check_status) ?? "needs_review") as "passed" | "needs_review",
        model: text(row.judgement_model) ?? "unknown",
        escalatedToSol: row.escalated_to_sol === true,
      },
      generation: hasGeneration
        ? {
          text: generated,
          model: text(row.generation_model),
          factStatus: text(row.generation_fact_status),
          voiceStatus: text(row.generation_voice_status),
          error: text(row.generation_error),
          factIssues: list(row.generation_fact_issues),
          voiceIssues: list(row.generation_voice_issues),
        }
        : null,
    },
    label,
    sampling: sets.includes("sample") ? sampling : null,
  };
}

export async function buildEvalSet(rows: Row[], sampleRows: Row[], labels: LabelsFile, selection: Selection): Promise<EvalSetFile> {
  const sampleById = new Map(sampleRows.map((r) => [String(r.id8), r]));
  const strata: Record<string, { n: number; sampled: number }> = {};
  for (const r of sampleRows) {
    const stratum = String(r.source_name);
    strata[stratum] = { n: Number(r.stratum_n), sampled: (strata[stratum]?.sampled ?? 0) + 1 };
  }
  const cases: EvalCase[] = [];
  const unlabeled: string[] = [];
  for (const row of rows) {
    const id8 = String(row.id ?? "").slice(0, 8);
    if (!labels.labels[id8]) {
      unlabeled.push(id8);
      continue;
    }
    const s = sampleById.get(id8);
    cases.push(
      await buildEvalCase(
        row,
        labels,
        selection,
        s ? { stratum: String(s.source_name), stratumN: Number(s.stratum_n), stratumRank: Number(s.stratum_rank) } : null,
      ),
    );
  }
  if (unlabeled.length > 0) throw new Error(`UNLABELED_ROWS:${unlabeled.join(",")}`);
  cases.sort((a, b) => a.caseId.localeCompare(b.caseId));
  const quotas: Record<string, number> = {};
  for (const [stratum, value] of Object.entries(strata)) quotas[stratum] = value.sampled;
  return {
    version: 2,
    exportedAt: "2026-10-10",
    population: {
      window: selection.window,
      definition:
        "Every AI-judged candidate (judgement_model is not null) created in the window, minus the 22 original fixtures. Rows production dropped as duplicates are not AI-judged and are outside the population. The window starts after the 2026-09-10 prompt and model changes so the recorded decisions come from one production configuration.",
      sample: { seed: selection.seed, quotas, strata },
    },
    codeVersions: labels.codeVersions,
    cases,
  };
}

if (import.meta.main) {
  const [rowsPath, samplePath, outPath] = Deno.args;
  if (!rowsPath || !samplePath) {
    console.error("usage: build_eval_set.ts <rows.jsonl> <sample.jsonl> [out.json]");
    Deno.exit(2);
  }
  const lines = async (path: string) =>
    (await Deno.readTextFile(path)).split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Row);
  const labels = JSON.parse(await Deno.readTextFile(new URL("../fixtures/eval_labels.json", import.meta.url))) as LabelsFile;
  const selection = JSON.parse(await Deno.readTextFile(new URL("../fixtures/eval_selection.json", import.meta.url))) as Selection;
  const file = await buildEvalSet(await lines(rowsPath), await lines(samplePath), labels, selection);
  const target = outPath ?? new URL("../fixtures/eval_expansion.json", import.meta.url).pathname;
  await Deno.writeTextFile(target, JSON.stringify(file, null, 2) + "\n");
  console.log(`wrote ${file.cases.length} cases to ${target}`);
}
