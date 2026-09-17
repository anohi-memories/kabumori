// X morning_report / close_report as consumers of the shared market report
// (docs/market-report-shared-platform/DESIGN.md §3, Phase 2).
//
// Gate OFF (market_report_consumer_settings.x_enabled = false, the default):
// index.ts runs its legacy generation unchanged.
// Gate ON: the post body is formatted deterministically from the Fact-passed
// market_report_packet.v1. No web search, no Yahoo fetch, no OpenAI call, no
// Voice step here. If the shared packet is not completed the run fails closed
// with SHARED_MARKET_REPORT_UNAVAILABLE; it never falls back to a separate
// legacy analysis, so X and the app cannot diverge.

import {
  formatSharedXPost,
  parseSharedMarketReportResult,
  type ReportType,
  type SharedMarketReportResult,
  sharedXPostIssues,
  tokyoDate,
} from "../_shared/market_report_packet.ts";
import { appendKabumoriReportFixedHashtags } from "./fixed_hashtags_logic.ts";

export const SHARED_MODEL_LABEL = "shared_market_report";

/**
 * Reads the gate and, when on, the shared packet. A missing RPC (the migration
 * is not applied yet) means the gate cannot be on, so it is treated as disabled;
 * any other failure is retried once and then surfaces as an error.
 */
export async function loadSharedMarketReport(args: {
  supabaseUrl: string;
  serviceRoleKey: string;
  reportType: ReportType;
  scheduledFor: string;
  fetchImpl?: typeof fetch;
}): Promise<SharedMarketReportResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const tradingDate = tokyoDate(new Date(args.scheduledFor));
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetchImpl(`${args.supabaseUrl}/rest/v1/rpc/get_shared_market_report`, {
        method: "POST",
        headers: {
          apikey: args.serviceRoleKey,
          Authorization: `Bearer ${args.serviceRoleKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ p_consumer: "x", p_report_type: args.reportType, p_trading_date: tradingDate }),
      });
      if (response.status === 404) return { enabled: false, status: "disabled" };
      if (!response.ok) throw new Error(`SHARED_MARKET_REPORT_GATE_FAILED:${response.status}`);
      return parseSharedMarketReportResult(await response.json());
    } catch (error) {
      if (attempt === 2) {
        throw error instanceof Error && error.message.startsWith("SHARED_MARKET_REPORT")
          ? error
          : new Error("SHARED_MARKET_REPORT_GATE_FAILED:network");
      }
    }
  }
  throw new Error("SHARED_MARKET_REPORT_GATE_FAILED:unreachable");
}

type Metric = { key?: unknown; value?: unknown; session_date?: unknown; observed_at?: unknown; label?: unknown; source_url?: unknown; freshness?: unknown };

export type SharedPublishDeps = {
  createRun: () => Promise<string>;
  updateRun: (runId: string, values: Record<string, unknown>) => Promise<void>;
  postToX: (text: string) => Promise<string>;
  completePost: (runId: string, xPostId: string) => Promise<void>;
  now: () => Date;
};

export type SharedPublishResult = { runId: string; text: string; xPostId: string; reportPacketId: string; reportContentHash: string };

function closeMetricColumn(data: { metrics?: Metric[] }, key: string): Record<string, unknown> | null {
  const metric = data.metrics?.find((item) => item.key === key);
  if (!metric || metric.value === null || metric.value === undefined) return null;
  return {
    label: metric.label, value: String(metric.value), timestamp: metric.observed_at,
    session_date: metric.session_date, source_url: metric.source_url, freshness: metric.freshness,
    source: "market_data_packet",
  };
}

/**
 * Publishes the shared packet as the X post. The run row is always created
 * first so a failure is recorded; the caller's outer handler marks the
 * scheduled post failed when this throws.
 */
export async function publishSharedMarketReport(
  reportType: ReportType,
  shared: SharedMarketReportResult,
  deps: SharedPublishDeps,
): Promise<SharedPublishResult> {
  const runId = await deps.createRun();
  const baseMarketData = {
    sharedMarketReport: shared.enabled && shared.status === "completed"
      ? {
        reportPacketId: shared.report_packet_id,
        reportContentHash: shared.report_content_hash,
        dataPacketId: shared.data_packet_id,
        dataContentHash: shared.data_content_hash,
      }
      : { status: shared.status, reportStatus: shared.enabled ? shared.report_status ?? null : null },
    pipeline: { generation_status: "shared_packet", voice_evaluation_status: "not_applicable" },
  };

  if (!shared.enabled || shared.status !== "completed") {
    await deps.updateRun(runId, {
      status: "failed", error: "SHARED_MARKET_REPORT_UNAVAILABLE", model_used: SHARED_MODEL_LABEL,
      fact_check_status: "failed", fact_check_notes: ["SHARED_MARKET_REPORT_UNAVAILABLE"],
      market_data: baseMarketData,
    });
    throw new Error("SHARED_MARKET_REPORT_UNAVAILABLE");
  }

  if (shared.report.report_type !== reportType) {
    await deps.updateRun(runId, {
      status: "failed", error: "SHARED_MARKET_REPORT_TYPE_MISMATCH", model_used: SHARED_MODEL_LABEL,
      fact_check_status: "failed", fact_check_notes: ["SHARED_MARKET_REPORT_TYPE_MISMATCH"], market_data: baseMarketData,
    });
    throw new Error("SHARED_MARKET_REPORT_TYPE_MISMATCH");
  }

  const body = formatSharedXPost(shared.report);
  const issues = sharedXPostIssues(shared.report, body);
  if (issues.length > 0) {
    await deps.updateRun(runId, {
      status: "failed", error: "SHARED_MARKET_REPORT_FORMAT_INVALID", model_used: SHARED_MODEL_LABEL,
      fact_check_status: "passed", fact_check_notes: issues, generated_text: body,
      character_count: Array.from(body).length, market_data: baseMarketData,
    });
    throw new Error("SHARED_MARKET_REPORT_FORMAT_INVALID");
  }

  const text = appendKabumoriReportFixedHashtags(body);
  const asOf = typeof shared.data.as_of === "string" ? shared.data.as_of : null;
  await deps.updateRun(runId, {
    generated_at: deps.now().toISOString(),
    source_urls: [],
    market_data_timestamp: asOf,
    model_used: SHARED_MODEL_LABEL,
    input_tokens: 0,
    output_tokens: 0,
    web_search_calls: 0,
    api_cost_usd: 0,
    generated_text: body,
    character_count: Array.from(body).length,
    fact_check_status: "passed",
    fact_check_notes: [`shared market_report_packet ${shared.report_packet_id}`],
    market_data: baseMarketData,
    ...(reportType === "close"
      ? { nikkei_data: closeMetricColumn(shared.data, "nikkei225"), topix_data: closeMetricColumn(shared.data, "topix_proxy_1306") }
      : {}),
  });

  let xPostId: string;
  try {
    xPostId = await deps.postToX(text);
  } catch (error) {
    const code = error instanceof Error ? error.message : "X_POST_FAILED";
    // A post whose id is unknown may exist on X: leave the run as generated so it is not retried as failed.
    if (code !== "X_RESPONSE_MISSING_POST_ID") {
      await deps.updateRun(runId, { status: "failed", error: code.slice(0, 200) }).catch(() => {});
    }
    throw error;
  }
  await deps.completePost(runId, xPostId);
  return { runId, text, xPostId, reportPacketId: shared.report_packet_id, reportContentHash: shared.report_content_hash };
}
