// Phase 5 report: gate outcomes, generation failures by cause, the failure rate under each definition, and per-channel reach.
//   deno run --no-config --allow-read [--allow-write=<out>] tools/provider-compare/scripts/phase5_report.ts \
//     --gate <gate.jsonl> --reasons <gated_reasons.jsonl> --generation <generation.jsonl> --channels <channels.jsonl> [--out f.json]
// Inputs are the JSON-lines outputs of export_gate_breakdown.sql, a reasons export, export_generation_outcomes.sql and
// export_delivery_channels.sql. Everything here is arithmetic over those rows: no network, no key, no production access.
import { classifyStoredJudgement, GATE_SENTENCE, reasonSignal } from "../src/gate_analysis.ts";
import { classifyGenerationFailure, type FailureCause, pr116Outlook } from "../src/generation_failure_classifier.ts";
import { type ChannelRow, failureRateDefinitions, reachOf, summariseChannels } from "../src/delivery_channels.ts";
import { currentRowStatus, isOperatingCompanyReport } from "../src/tanshin_extraction.ts";

type Json = Record<string, unknown>;

async function lines(path: string): Promise<Json[]> {
  return (await Deno.readTextFile(path)).split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Json);
}

const tally = (items: string[]) => {
  const out: Record<string, number> = {};
  for (const item of items) out[item] = (out[item] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
};

export type GateRow = {
  final_no_post: boolean;
  gate_text: boolean;
  escalated_to_sol: boolean;
  judgement_model: string;
  fact_check_status: string;
  sol_escalation_reasons: string;
  n: number;
};

export function gateSummary(rows: readonly GateRow[]) {
  const outcomes: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  const models: Record<string, number> = {};
  for (const row of rows) {
    const c = classifyStoredJudgement({
      importance: row.final_no_post ? "no_post" : "important",
      judgementModel: row.judgement_model,
      escalatedToSol: row.escalated_to_sol,
      factCheckStatus: row.fact_check_status,
      reason: row.gate_text ? GATE_SENTENCE : "",
      solEscalationReasons: row.sol_escalation_reasons,
    });
    outcomes[c.outcome] = (outcomes[c.outcome] ?? 0) + row.n;
    if (c.outcome === "gate_after_sol") {
      const key = row.sol_escalation_reasons === "" ? "(not recorded)" : row.sol_escalation_reasons;
      reasons[key] = (reasons[key] ?? 0) + row.n;
      models[row.judgement_model] = (models[row.judgement_model] ?? 0) + row.n;
    }
  }
  const noPost = (outcomes["model_no_post"] ?? 0) + (outcomes["gate_after_sol"] ?? 0) + (outcomes["gate_sol_required_not_run"] ?? 0);
  const solEscalatedFinal = rows.filter((r) => r.escalated_to_sol).reduce((s, r) => s + r.n, 0);
  const solGated = outcomes["gate_after_sol"] ?? 0;
  return {
    outcomes,
    noPost,
    gateShareOfNoPost: noPost === 0 ? null : Math.round(((solGated + (outcomes["gate_sol_required_not_run"] ?? 0)) / noPost) * 1000) / 1000,
    solEscalated: solEscalatedFinal,
    gateShareOfSolEscalated: solEscalatedFinal === 0 ? null : Math.round((solGated / solEscalatedFinal) * 1000) / 1000,
    gateAfterSolByEscalationReasons: reasons,
    gateAfterSolByModel: models,
  };
}

export function generationSummary(rows: readonly Json[]) {
  const failed = rows.filter((r) => r.status === "generation_failed");
  const period = (day: string) => (day < "2026-09-19" ? "A 09-10..09-18" : day < "2026-10-03" ? "B 09-19..10-02" : "C 10-03..10-09");
  const byCause: Record<string, number> = {};
  const byPeriod: Record<string, Record<string, number>> = {};
  const byStage: string[] = [];
  const outlook: string[] = [];
  const secondary: Record<string, number> = {};
  const bySourceOutlook: Record<string, Record<string, number>> = {};
  for (const r of failed) {
    const c = classifyGenerationFailure({
      generationError: String(r.generation_error ?? ""),
      factStatus: (r.generation_fact_status as string | null) ?? null,
      voiceStatus: (r.generation_voice_status as string | null) ?? null,
      factIssues: String(r.fact_issues ?? ""),
      voiceIssues: String(r.voice_issues ?? ""),
      sourceName: String(r.source_name),
    });
    byCause[c.primary] = (byCause[c.primary] ?? 0) + 1;
    const p = period(String(r.created_jst).slice(0, 10));
    byPeriod[p] ??= {};
    byPeriod[p][c.primary] = (byPeriod[p][c.primary] ?? 0) + 1;
    byStage.push(c.stage);
    const o = pr116Outlook(c.primary as FailureCause, String(r.source_name));
    outlook.push(o);
    bySourceOutlook[String(r.source_name)] ??= {};
    bySourceOutlook[String(r.source_name)][o] = (bySourceOutlook[String(r.source_name)][o] ?? 0) + 1;
    for (const cause of c.causes) secondary[cause] = (secondary[cause] ?? 0) + 1;
  }
  return {
    failed: failed.length,
    byPrimaryCause: byCause,
    anyCause: secondary,
    byPeriod,
    byStage: tally(byStage),
    pr116Outlook: tally(outlook),
    pr116OutlookBySource: bySourceOutlook,
    bySource: tally(failed.map((r) => String(r.source_name))),
  };
}

export function tanshinSummary(rows: readonly Json[]) {
  const operating = rows.filter((r) => isOperatingCompanyReport(String(r.title)));
  const status = operating.map((r) => currentRowStatus(String(r.title), String(r.body ?? "")));
  const counts = tally(status);
  const determinable = (counts["prior_period_only"] ?? 0) + (counts["current_row_present"] ?? 0);
  return {
    operatingCompanyReports: operating.length,
    excludedFundsAndReits: rows.length - operating.length,
    byCurrentRowStatus: counts,
    priorPeriodOnlyShareOfDeterminable: determinable === 0 ? null : Math.round(((counts["prior_period_only"] ?? 0) / determinable) * 1000) / 1000,
    priorPeriodOnlyByOutcome: tally(
      operating.filter((_, i) => status[i] === "prior_period_only").map((r) =>
        r.importance === "no_post" ? (r.gate_suppressed ? "no_post_gated" : "no_post_model") : String(r.status)
      ),
    ),
  };
}

if (import.meta.main) {
  const arg = (name: string) => {
    const i = Deno.args.indexOf(name);
    return i >= 0 ? Deno.args[i + 1] : undefined;
  };
  const [gatePath, reasonsPath, generationPath, channelsPath] = ["--gate", "--reasons", "--generation", "--channels"].map(arg);
  if (!gatePath || !reasonsPath || !generationPath || !channelsPath) {
    console.error("usage: phase5_report.ts --gate g.jsonl --reasons r.jsonl --generation gen.jsonl --channels c.jsonl [--out f.json]");
    Deno.exit(2);
  }
  const gate = (await lines(gatePath)) as unknown as GateRow[];
  const reasons = await lines(reasonsPath);
  const generation = await lines(generationPath);
  const channels = (await lines(channelsPath)) as unknown as ChannelRow[];
  const selection = JSON.parse(await Deno.readTextFile(new URL("../fixtures/eval_selection.json", import.meta.url)));
  const original = JSON.parse(await Deno.readTextFile(new URL("../fixtures/cases.json", import.meta.url))).cases.map((c: { caseId: string }) => c.caseId.slice(-8));
  const exclude = new Set<string>([...selection.hard, ...selection.sample, ...original]);

  const tanshinPath = arg("--tanshin");
  const ingestionPath = arg("--ingestion");
  const signal = tally(reasons.map((r) => reasonSignal(String(r.reason))));
  const positives = channels.filter((r) => r.importance !== "no_post");
  const week = positives.filter((r) => r.created_day >= "2026-10-03");
  const report = {
    window: "2026-09-10 .. 2026-10-09 (created, JST)",
    gate: { ...gateSummary(gate), gatedReasonWording: { total: reasons.length, ...signal } },
    generation: generationSummary(generation),
    failureRates: failureRateDefinitions(channels, { windowFrom: "2026-09-10", windowTo: "2026-10-09", excludeId8: exclude }),
    channels: {
      importantPlusAll: summariseChannels(positives),
      importantPlusFailedOnX: summariseChannels(positives.filter((r) => r.status === "generation_failed")),
      importantPlusLast7Days: summariseChannels(week),
      importantPlusLast7DaysFailed: summariseChannels(week.filter((r) => r.status === "generation_failed")),
      noPostSeverityMediumOrHigher: summariseChannels(
        channels.filter((r) => r.importance === "no_post" && ["emergency", "critical", "high", "medium"].includes(r.severity)),
      ),
    },
    ingestion: {
      earningsReports: tanshinPath ? tanshinSummary(await lines(tanshinPath)) : null,
      emptyBodiesByHost: ingestionPath ? await lines(ingestionPath) : null,
    },
    missCandidates: ["bff661cc", "ca38bae4", "8648e274", "0720532f", "a989d1f3"].map((id) => {
      const row = channels.find((r) => r.id8 === id);
      return row ? { id8: id, source: row.source_name, severity: row.severity, status: row.status, ...reachOf(row) } : { id8: id, missing: true };
    }),
  };
  console.log(JSON.stringify(report, null, 2));
  const out = arg("--out");
  if (out) await Deno.writeTextFile(out, JSON.stringify(report, null, 2) + "\n");
}
