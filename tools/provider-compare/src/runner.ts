import type { CaseFixture } from "./fixtures.ts";
import type { NeutralRequest, Provider, ProviderName, ProviderResult, Usage } from "./types.ts";
import { BudgetError, type BudgetGuard, type RunMode } from "./budget.ts";
import { assertNoSecrets } from "./redact.ts";
import { costUsd } from "./pricing.ts";
import { estimateUsage, type EstimateSpec } from "./estimate.ts";
import type { LedgerAverages } from "./providers/recorded.ts";
import { buildTaskRequest, buildWebSearchRequests, type TaskId } from "./tasks.ts";
import { checkMetric, draftMetric, judgementMetric, searchMetric } from "./metrics.ts";

export type Entry = {
  taskId: TaskId;
  caseId: string;
  provider: ProviderName;
  label: string;
  model: string;
  ok: boolean;
  /** dry-run entries carry an estimate instead of a measurement. */
  estimated: boolean;
  error: ProviderResult["error"];
  attempts: number;
  usage: Usage;
  costUsd: number;
  latencyMs: number;
  stopReason: string | null;
  parseError: string | null;
  text: string | null;
  sourceUrls: string[];
  metric: unknown;
};

export type SummaryRow = {
  taskId: TaskId;
  label: string;
  n: number;
  okRate: number;
  parseFailRate: number;
  avgLatencyMs: number;
  avgCostUsd: number;
  totalCostUsd: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  // judgement
  agreeWithRecorded?: number;
  agreeWithExpected?: number;
  missedImportant?: number;
  falseAlarm?: number;
  over?: number;
  under?: number;
  // generation
  avgUnsupportedNumbers?: number;
  localFactIssueRate?: number;
  missingTitleDateRate?: number;
  // fact / voice
  agreeWithRecordedCheck?: number;
  // search
  avgSources?: number;
  avgArticleLikeShare?: number;
};

export type Report = {
  version: 1;
  mode: RunMode;
  generatedAt: string;
  budget: ReturnType<BudgetGuard["snapshot"]>;
  /** Set when the run stopped early (budget); results before that point are still valid. */
  stoppedBy: string | null;
  skipped: Array<{ taskId: TaskId; caseId: string; reason: string }>;
  entries: Entry[];
  summary: SummaryRow[];
};

export type RunOptions = {
  cases: readonly CaseFixture[];
  providers: readonly Provider[];
  /** Estimation specs, parallel to `providers`, used by dry-run only. */
  estimateSpecs: readonly (EstimateSpec | null)[];
  tasks: readonly TaskId[];
  mode: RunMode;
  budget: BudgetGuard;
  averages: LedgerAverages;
  now?: () => string;
  /** Keys that must never appear in the output (checked before the report is returned). */
  knownSecrets?: readonly string[];
};

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function metricFor(
  taskId: TaskId,
  result: ProviderResult,
  request: NeutralRequest,
  fixture: CaseFixture | undefined,
): unknown {
  if (taskId === "web_search") return searchMetric(result, request);
  if (!fixture) return null;
  if (taskId === "judgement_primary" || taskId === "judgement_detail") return judgementMetric(result, fixture);
  if (taskId === "generation_draft") {
    const parsed = result.parsed as { text?: unknown } | null;
    return draftMetric(typeof parsed?.text === "string" ? parsed.text : null, fixture);
  }
  return checkMetric(result, fixture, taskId === "generation_fact" ? "fact" : "voice");
}

export async function runComparison(options: RunOptions): Promise<Report> {
  const entries: Entry[] = [];
  const skipped: Report["skipped"] = [];
  let stoppedBy: string | null = null;
  const caseById = new Map(options.cases.map((fixture) => [fixture.caseId, fixture]));
  const orderedCases = [...options.cases].sort((a, b) => a.caseId.localeCompare(b.caseId));

  outer:
  for (const taskId of options.tasks) {
    const requests: Array<{ request: NeutralRequest; fixture?: CaseFixture }> = [];
    if (taskId === "web_search") {
      for (const request of buildWebSearchRequests()) requests.push({ request });
    } else {
      for (const fixture of orderedCases) {
        const request = await buildTaskRequest(taskId, fixture);
        if (request === null) skipped.push({ taskId, caseId: fixture.caseId, reason: "nothing to run this task on" });
        else requests.push({ request, fixture });
      }
    }
    for (const { request, fixture } of requests) {
      for (const [index, provider] of options.providers.entries()) {
        const spec = options.estimateSpecs[index];
        let result: ProviderResult;
        let estimated = false;
        if (options.mode === "dry-run" && provider.name !== "recorded") {
          if (!spec) {
            skipped.push({ taskId, caseId: request.caseId, reason: `no estimate spec for ${provider.label}` });
            continue;
          }
          const usage = estimateUsage(request, spec, options.averages);
          result = {
            provider: provider.name, model: provider.model, label: provider.label, ok: true, text: null, parsed: null,
            parseError: null, usage, costUsd: costUsd(provider.model, usage), latencyMs: 0, stopReason: "estimate",
            attempts: 0, sourceUrls: [], error: null,
          };
          estimated = true;
        } else {
          try {
            result = await provider.run(request, {
              beforeAttempt: (usd) => options.budget.beforeAttempt(usd),
              afterAttempt: (usd) => options.budget.afterAttempt(usd),
            });
          } catch (error) {
            if (error instanceof BudgetError) {
              stoppedBy = error.message;
              break outer;
            }
            throw error;
          }
        }
        const metric = estimated ? null : metricFor(taskId, result, request, fixture ?? caseById.get(request.caseId));
        entries.push({
          taskId,
          caseId: request.caseId,
          provider: result.provider,
          label: result.label,
          model: result.model,
          ok: result.ok,
          estimated,
          error: result.error,
          attempts: result.attempts,
          usage: result.usage,
          costUsd: result.costUsd,
          latencyMs: result.latencyMs,
          stopReason: result.stopReason,
          parseError: result.parseError,
          text: result.text,
          sourceUrls: result.sourceUrls,
          metric,
        });
      }
    }
  }

  entries.sort((a, b) =>
    a.taskId.localeCompare(b.taskId) || a.caseId.localeCompare(b.caseId) || a.label.localeCompare(b.label)
  );
  const report: Report = {
    version: 1,
    mode: options.mode,
    generatedAt: (options.now ?? (() => new Date().toISOString()))(),
    budget: options.budget.snapshot(),
    stoppedBy,
    skipped,
    entries,
    summary: summarise(entries),
  };
  assertNoSecrets(JSON.stringify(report), options.knownSecrets ?? []);
  return report;
}

export function summarise(entries: readonly Entry[]): SummaryRow[] {
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    const key = `${entry.taskId}\u0000${entry.label}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const rows: SummaryRow[] = [];
  for (const [, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const n = group.length;
    const mean = (pick: (entry: Entry) => number) => group.reduce((sum, entry) => sum + pick(entry), 0) / n;
    const row: SummaryRow = {
      taskId: group[0].taskId,
      label: group[0].label,
      n,
      okRate: round(group.filter((e) => e.ok).length / n, 4),
      parseFailRate: round(group.filter((e) => e.parseError !== null).length / n, 4),
      avgLatencyMs: Math.round(mean((e) => e.latencyMs)),
      avgCostUsd: round(mean((e) => e.costUsd)),
      totalCostUsd: round(group.reduce((sum, e) => sum + e.costUsd, 0)),
      avgInputTokens: Math.round(mean((e) => e.usage.inputTokens)),
      avgOutputTokens: Math.round(mean((e) => e.usage.outputTokens)),
    };
    const measured = group.filter((e) => !e.estimated && e.metric !== null);
    const m = measured.length;
    if (m > 0) {
      if (row.taskId === "judgement_primary" || row.taskId === "judgement_detail") {
        const metrics = measured.map((e) => e.metric as ReturnType<typeof judgementMetric>);
        row.agreeWithRecorded = round(metrics.filter((x) => x.matchesRecorded).length / m, 4);
        row.agreeWithExpected = round(metrics.filter((x) => x.matchesExpected).length / m, 4);
        row.missedImportant = metrics.filter((x) => x.missedImportant).length;
        row.falseAlarm = metrics.filter((x) => x.falseAlarm).length;
        row.over = metrics.filter((x) => x.direction === "over").length;
        row.under = metrics.filter((x) => x.direction === "under").length;
      } else if (row.taskId === "generation_draft") {
        const metrics = measured.map((e) => e.metric as ReturnType<typeof draftMetric>).filter((x) => x.present);
        if (metrics.length > 0) {
          row.avgUnsupportedNumbers = round(metrics.reduce((s, x) => s + x.unsupportedNumbers.length, 0) / metrics.length, 3);
          row.localFactIssueRate = round(metrics.filter((x) => x.localFactIssues.length > 0).length / metrics.length, 4);
          row.missingTitleDateRate = round(metrics.filter((x) => x.missingTitleDates.length > 0).length / metrics.length, 4);
        }
      } else if (row.taskId === "generation_fact" || row.taskId === "generation_voice") {
        const metrics = measured.map((e) => e.metric as ReturnType<typeof checkMetric>).filter((x) => x.agreesWithRecorded !== null);
        if (metrics.length > 0) row.agreeWithRecordedCheck = round(metrics.filter((x) => x.agreesWithRecorded).length / metrics.length, 4);
      } else if (row.taskId === "web_search") {
        const metrics = measured.map((e) => e.metric as ReturnType<typeof searchMetric>);
        row.avgSources = round(metrics.reduce((s, x) => s + x.sourceCount, 0) / m, 2);
        const shares = metrics.map((x) => x.articleLikeShare).filter((x): x is number => x !== null);
        if (shares.length > 0) row.avgArticleLikeShare = round(shares.reduce((s, x) => s + x, 0) / shares.length, 3);
      }
    }
    rows.push(row);
  }
  return rows;
}
