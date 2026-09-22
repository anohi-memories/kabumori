import {
  buildFedDecisionEvent,
  extractOfficialFedStatementUrls,
  parseFedStatementHtml,
  statementIdentityChanged,
  type FedStatementIdentity,
  type FedTargetRange,
} from "./mic_fed_statement_adapter.ts";
import type { MarketEventInput } from "./mic_normalize_logic.ts";

export const FED_BACKFILL_RECOMMENDED_SCOPE = "recent_four" as const;
export const FED_BACKFILL_RECOMMENDED_LIMIT = 4 as const;

export type FedBackfillScope = "previous_one" | "recent_four" | "calendar_year";

export type HistoricalFedRangeFact = FedTargetRange & {
  observedDate: string;
  sourceKey: "fred";
  lowerSeriesId: "DFEDTARL";
  upperSeriesId: "DFEDTARU";
};

export type FedHistoricalBackfillCandidate = {
  outcome: "candidate" | "duplicate";
  event: MarketEventInput | null;
  identity: FedStatementIdentity;
  statementRange: FedTargetRange;
  fredRange: HistoricalFedRangeFact;
};

function statementDateFromUrl(url: string): string | null {
  const match = new URL(url).pathname.match(/monetary(\d{4})(\d{2})(\d{2})a\.htm$/i);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

export function selectFedHistoricalStatementUrls(
  calendarHtml: string,
  currentMeetingDate: string,
  scope: FedBackfillScope = FED_BACKFILL_RECOMMENDED_SCOPE,
): string[] {
  const candidates = extractOfficialFedStatementUrls(calendarHtml)
    .map((url) => ({ url, meetingDate: statementDateFromUrl(url) }))
    .filter((entry): entry is { url: string; meetingDate: string } =>
      entry.meetingDate !== null && entry.meetingDate < currentMeetingDate
    )
    .sort((a, b) => b.meetingDate.localeCompare(a.meetingDate));
  if (scope === "previous_one") return candidates.slice(0, 1).map((entry) => entry.url);
  if (scope === "recent_four") return candidates.slice(0, FED_BACKFILL_RECOMMENDED_LIMIT).map((entry) => entry.url);
  return candidates.filter((entry) => entry.meetingDate.startsWith(currentMeetingDate.slice(0, 4))).map((entry) => entry.url);
}

export function selectHistoricalFedRange(
  facts: readonly HistoricalFedRangeFact[],
  observedOnOrBefore: string,
): HistoricalFedRangeFact | null {
  return facts
    .filter((fact) => fact.sourceKey === "fred" && fact.observedDate <= observedOnOrBefore)
    .sort((a, b) => b.observedDate.localeCompare(a.observedDate))[0] ?? null;
}

export function assertHistoricalFedRangeConsistency(
  statementRange: FedTargetRange | null,
  fredRange: HistoricalFedRangeFact | null,
): asserts statementRange is FedTargetRange {
  if (!statementRange) throw new Error("FED_BACKFILL_STATEMENT_RANGE_MISSING");
  if (!fredRange) throw new Error("FED_BACKFILL_FRED_RANGE_MISSING");
  if (statementRange.lower !== fredRange.lower || statementRange.upper !== fredRange.upper) {
    throw new Error("FED_BACKFILL_RANGE_MISMATCH");
  }
}

export async function buildFedHistoricalBackfillCandidate(args: {
  statementUrl: string;
  statementHtml: string;
  previousRange: HistoricalFedRangeFact;
  effectiveRange: HistoricalFedRangeFact;
  existingIdentities?: readonly FedStatementIdentity[];
}): Promise<FedHistoricalBackfillCandidate> {
  const statement = await parseFedStatementHtml(args.statementUrl, args.statementHtml, args.previousRange);
  assertHistoricalFedRangeConsistency(statement.targetRange, args.effectiveRange);
  const identity = { meetingDate: statement.meetingDate, documentHash: statement.documentHash };
  const existing = args.existingIdentities?.find((candidate) => candidate.meetingDate === statement.meetingDate) ?? null;
  const identityOutcome = statementIdentityChanged(existing, identity);
  if (identityOutcome === "duplicate") {
    return { outcome: "duplicate", event: null, identity, statementRange: statement.targetRange, fredRange: args.effectiveRange };
  }
  return {
    outcome: "candidate",
    event: buildFedDecisionEvent(statement, args.previousRange, identityOutcome === "revision"),
    identity,
    statementRange: statement.targetRange,
    fredRange: args.effectiveRange,
  };
}
