// The app's consumption of the shared market report (market_report_packet.v1), as pure functions so the
// exact production composition can be tested against real packets. Behaviour is identical to the code
// previously inlined in index.ts:
//   gate OFF                    → legacy lane (no shared market; index values from Yahoo)
//   gate ON, packet completed   → shared lane (market detail + portfolio built on the same packet)
//   gate ON, packet not ready   → skip the whole run (fail closed; no second market analysis)

import {
  appMarketSection,
  type ReportType,
  type SharedMarketReportResult,
} from "../_shared/market_report_packet.ts";
import { buildAppMarketDetail, crossAssetLines, type AppMarketDetail } from "./market_detail.ts";
import type { SharedMarketInput } from "./report_logic.ts";

export type CompletedSharedReport = Extract<SharedMarketReportResult, { status: "completed" }>;

export type SharedGateDecision =
  | { action: "legacy" }
  | { action: "shared"; shared: CompletedSharedReport }
  | { action: "skip"; status: string };

export function sharedGateDecision(result: SharedMarketReportResult): SharedGateDecision {
  if (!result.enabled) return { action: "legacy" };
  if (result.status !== "completed") return { action: "skip", status: result.status };
  return { action: "shared", shared: result };
}

/** Market detail (identical for every user) and the per-user packet input, both from the same packet. */
export function buildSharedConsumption(args: {
  reportType: ReportType;
  tradingDate: string;
  shared: CompletedSharedReport;
  morningShared?: SharedMarketReportResult | null;
}): { marketDetail: AppMarketDetail; sharedInput: SharedMarketInput } {
  const { shared } = args;
  const marketDetail = buildAppMarketDetail({
    reportType: args.reportType,
    tradingDate: args.tradingDate,
    reportPacketId: shared.report_packet_id,
    report: shared.report,
    metrics: (shared.data.metrics ?? []) as Array<Record<string, unknown>>,
    morningPacket: args.morningShared?.enabled && args.morningShared.status === "completed" ? args.morningShared.report : null,
  });
  const sharedInput: SharedMarketInput = {
    direction: shared.report.market_direction,
    headlineJa: shared.report.headline_ja,
    summaryJa: shared.report.market_summary_ja,
    claims: shared.report.claims,
    nextWatchJa: shared.report.next_watch_ja,
    section: appMarketSection(shared.report, shared.report_packet_id, shared.report_content_hash),
    tailwindThemesJa: marketDetail.tailwind_themes_ja,
    headwindThemesJa: marketDetail.headwind_themes_ja,
    crossAssetJa: crossAssetLines(marketDetail),
    morningWatchJa: marketDetail.morning_reference?.next_watch_ja ?? [],
  };
  return { marketDetail, sharedInput };
}
