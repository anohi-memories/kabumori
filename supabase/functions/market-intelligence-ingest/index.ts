// Market Intelligence Core (MIC) Phase 1A ingestion entry point.
//
// Scope: accumulate MIC Facts. Fed statement AI interpretation is an explicit,
// separately authorized action in this endpoint and is never part of ingest.
// The explicit Fed interpretation action also writes the shared AI usage
// ledger; ordinary source ingestion does not call the model.
//
// Auth model, deliberately copied from stocks-master-sync/index.ts: never
// called with a Supabase JWT, only by pg_cron/manual invocation carrying
// X-Cron-Secret. DB access uses the new-format secret key
// (SUPABASE_SECRET_KEYS['default']), not the legacy SUPABASE_SERVICE_ROLE_KEY.
//
// NOT deployed, NOT scheduled, and NOT wired into supabase/config.toml as
// part of Phase 1A -- see docs/market-intelligence/ARCHITECTURE.md and the
// Phase 1A completion report for what remains before any of that happens.
import {
  EIA_SOURCE_KEY,
  fetchEiaMetrics,
} from "./mic_eia_adapter.ts";
import {
  fetchFrankfurterFxMetrics,
  FRANKFURTER_SOURCE_KEY,
} from "./mic_frankfurter_fx_adapter.ts";
import {
  FRED_SOURCE_KEY,
  FRED_SERIES_MAPPINGS,
  fetchFredHistoricalMetrics,
  fetchFredMetrics,
} from "./mic_fred_adapter.ts";
import {
  fetchMofJgbMetrics,
  MOF_SOURCE_KEY,
} from "./mic_mof_jgb_adapter.ts";
import {
  fetchSecEdgarFilings,
  SEC_SOURCE_KEY,
} from "./mic_sec_edgar_adapter.ts";
import {
  ESTAT_SOURCE_KEY,
  fetchEstatCpiMetrics,
} from "./mic_estat_adapter.ts";
import {
  buildFedDecisionEvent,
  classifyFedDecision,
  FED_STATEMENT_SOURCE_KEY,
  fetchFedStatement,
  fetchFedStatementEventBundle,
  parseFedStatementHtml,
  statementIdentityChanged,
  type FedTargetRange,
  type FedStatement,
  type FedStatementIdentity,
} from "./mic_fed_statement_adapter.ts";
import { buildFedStatementDiffPipeline, persistFedStatementDiff } from "./mic_fed_statement_diff_persistence.ts";
import type { FedStatementRecord } from "./mic_fed_statement_diff.ts";
import {
  executeFedStatementAiAction,
  executeFedStatementAiUsageRepairAction,
  FedStatementAiActionError,
  INTERPRET_FED_STATEMENT_DIFF_ACTION,
  REPAIR_FED_STATEMENT_DIFF_USAGE_ACTION,
} from "./mic_fed_statement_ai_action.ts";
import {
  buildMacroReleaseEvent,
  decideMacroReleaseEvent,
  MACRO_RELEASE_METRIC_KEYS,
  type MacroReleaseEventContext,
} from "./mic_macro_release_logic.ts";
import { finalizeMarketEvent, type MarketEventInput, type NormalizedMarketMetric } from "./mic_normalize_logic.ts";
import {
  claimIngestionRun,
  completeIngestionRun,
  computeRunWindow,
  failIngestionRun,
  reconcileStaleIngestionRuns,
} from "./mic_ingestion_run_logic.ts";
import {
  readExistingMarketMetricValue,
  restHeaders,
  safeErrorMessage,
  upsertMarketMetric,
  updateMarketEvent,
  writeMarketEvent,
} from "./mic_writer_logic.ts";
import type { RestContext } from "./mic_writer_logic.ts";

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function requireMetricMetadataString(metric: NormalizedMarketMetric, key: string): string {
  const value = metric.metadata?.[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`MACRO_RELEASE_METADATA_MISSING:${key}`);
  return value;
}

function requireMetricMetadataNumber(metric: NormalizedMarketMetric, key: string): number {
  const value = metric.metadata?.[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`MACRO_RELEASE_METADATA_MISSING:${key}`);
  return value;
}

function buildMacroReleaseContext(metric: NormalizedMarketMetric): MacroReleaseEventContext {
  const common = {
    metricKey: metric.metricKey,
    observedDate: metric.observedDate,
    newValue: metric.value,
    unit: metric.unit,
    underlyingSource: typeof metric.metadata?.underlyingSource === "string" ? metric.metadata.underlyingSource : null,
    sourceUrl: metric.sourceUrl ?? "",
    fetchedAt: metric.fetchedAt,
  };
  if (metric.sourceKey === FRED_SOURCE_KEY) {
    return {
      ...common,
      sourceKey: FRED_SOURCE_KEY,
      sourceName: "FRED",
      seriesId: typeof metric.metadata?.seriesId === "string" ? metric.metadata.seriesId : metric.metricKey,
      fredUnits: typeof metric.metadata?.fredUnits === "string" ? metric.metadata.fredUnits : null,
    };
  }
  if (metric.sourceKey === ESTAT_SOURCE_KEY) {
    return {
      ...common,
      sourceKey: ESTAT_SOURCE_KEY,
      sourceName: "e-Stat",
      statsDataId: requireMetricMetadataString(metric, "statsDataId"),
      cdArea: requireMetricMetadataString(metric, "cdArea"),
      cdCat01: requireMetricMetadataString(metric, "cdCat01"),
      tabCode: requireMetricMetadataString(metric, "tabCode"),
      cdTime: requireMetricMetadataString(metric, "cdTime"),
      baseYear: requireMetricMetadataNumber(metric, "baseYear"),
    };
  }
  throw new Error(`MACRO_RELEASE_SOURCE_UNSUPPORTED:${metric.sourceKey}`);
}

function isAuthorizedCronCaller(req: Request): boolean {
  const expected = Deno.env.get("MARKET_INTELLIGENCE_INGEST_CRON_SECRET");
  const provided = req.headers.get("X-Cron-Secret");
  return typeof expected === "string" && expected.length > 0 && provided === expected;
}

// Same new-format secret key lookup as stocks-master-sync/index.ts.
function getSecretKey(): string | null {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = parsed["default"];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

type SourceKey =
  | typeof FRED_SOURCE_KEY
  | typeof MOF_SOURCE_KEY
  | typeof EIA_SOURCE_KEY
  | typeof SEC_SOURCE_KEY
  | typeof FRANKFURTER_SOURCE_KEY
  | typeof ESTAT_SOURCE_KEY;

type SourceKeyWithFed = SourceKey | typeof FED_STATEMENT_SOURCE_KEY;

const ALL_SOURCE_KEYS: SourceKeyWithFed[] = [
  FRED_SOURCE_KEY,
  MOF_SOURCE_KEY,
  EIA_SOURCE_KEY,
  SEC_SOURCE_KEY,
  FRANKFURTER_SOURCE_KEY,
  ESTAT_SOURCE_KEY,
  FED_STATEMENT_SOURCE_KEY,
];

type FetchResult =
  | { kind: "metrics"; metrics: NormalizedMarketMetric[] }
  | { kind: "events"; events: MarketEventInput[]; fedStatement?: FedStatement & { decision: import("./mic_fed_statement_adapter.ts").FedDecision }; previousFedStatement?: FedStatementRecord; fedExistingEventIds?: Record<string, string> };

async function readFedTargetRangeBefore(ctx: RestContext, meetingDate: string): Promise<FedTargetRange | null> {
  const url = `${ctx.supabaseUrl}/rest/v1/market_metrics?metric_key=in.(FED_FUNDS_TARGET_LOWER,FED_FUNDS_TARGET_UPPER)&source_key=eq.fred&observed_date=lt.${encodeURIComponent(meetingDate)}&select=metric_key,value,observed_date&order=observed_date.desc&limit=20`;
  const result = await fetch(url, { headers: restHeaders(ctx.secretKey) });
  if (!result.ok) throw new Error(`FRED_TARGET_LOOKUP_FAILED:${result.status}`);
  const rows = await result.json() as Array<{ metric_key?: unknown; value?: unknown }>;
  const latest = new Map<string, number>();
  for (const row of rows) {
    if (typeof row.metric_key !== "string" || latest.has(row.metric_key)) continue;
    if (typeof row.value === "number" && Number.isFinite(row.value)) latest.set(row.metric_key, row.value);
  }
  const lower = latest.get("FED_FUNDS_TARGET_LOWER");
  const upper = latest.get("FED_FUNDS_TARGET_UPPER");
  return lower === undefined || upper === undefined ? null : { lower, upper };
}

type FedStatementReference = FedStatementIdentity & { eventId: string; statementUrl: string };

async function readPreviousFedStatementIdentities(ctx: RestContext, allowedDuplicateEventIds: Set<string> = new Set()): Promise<FedStatementReference[]> {
  const url = `${ctx.supabaseUrl}/rest/v1/market_events?source_key=eq.fed&event_type=eq.central_bank_decision&select=id,raw_payload&order=published_at.desc&limit=50`;
  const result = await fetch(url, { headers: restHeaders(ctx.secretKey) });
  if (!result.ok) throw new Error(`FED_EVENT_LOOKUP_FAILED:${result.status}`);
  const rows = await result.json() as Array<{ id?: unknown; raw_payload?: { meeting_date?: unknown; document_hash?: unknown; statement_url?: unknown } | null }>;
  const identities: FedStatementReference[] = [];
  for (const row of rows) {
    const eventId = row.id;
    const meetingDate = row.raw_payload?.meeting_date;
    const documentHash = row.raw_payload?.document_hash;
    const statementUrl = row.raw_payload?.statement_url;
    if (typeof eventId === "string" && typeof statementUrl === "string" && typeof meetingDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(meetingDate) && typeof documentHash === "string" && /^[0-9a-f]{64}$/.test(documentHash)) {
      identities.push({ eventId, statementUrl, meetingDate, documentHash });
    }
  }
  const byMeeting = new Map<string, FedStatementReference[]>();
  for (const identity of identities) byMeeting.set(identity.meetingDate, [...(byMeeting.get(identity.meetingDate) ?? []), identity]);
  const resolved: FedStatementReference[] = [];
  for (const [meetingDate, meetingIdentities] of byMeeting) {
    if (meetingIdentities.length === 1) {
      resolved.push(meetingIdentities[0]);
      continue;
    }
    const remaining = meetingIdentities.filter((identity) => !allowedDuplicateEventIds.has(identity.eventId));
    if (remaining.length !== 1) throw new Error(`FED_DUPLICATE_MEETING_EVENTS:${meetingDate}`);
    resolved.push(remaining[0]);
  }
  return resolved;
}

// Per-source adapter dispatch. Each entry is responsible for its own
// secret lookup so a missing secret produces a per-source SECRET_MISSING
// result (failure isolation) instead of crashing the whole invocation --
// same principle as official_source_fetchers.ts's runNewsSourceProviders.
type AdapterOptions = {
  historicalFedStatementUrls?: string[];
  historicalFredRange?: { observationStart: string; observationEnd: string };
  allowedFedDuplicateEventIds?: Set<string>;
};

async function runAdapter(ctx: RestContext, sourceKey: SourceKeyWithFed, now: Date, options: AdapterOptions = {}): Promise<FetchResult> {
  switch (sourceKey) {
    case FRED_SOURCE_KEY: {
      const apiKey = Deno.env.get("FRED_API_KEY");
      if (!apiKey) throw new Error("SECRET_MISSING:FRED_API_KEY");
      if (options.historicalFredRange) {
        return {
          kind: "metrics",
          metrics: await fetchFredHistoricalMetrics({
            apiKey,
            observationStart: options.historicalFredRange.observationStart,
            observationEnd: options.historicalFredRange.observationEnd,
            mappings: FRED_SERIES_MAPPINGS.filter((mapping) =>
              mapping.metricKey === "FED_FUNDS_TARGET_LOWER" || mapping.metricKey === "FED_FUNDS_TARGET_UPPER"
            ),
            fetchedAt: now,
          }),
        };
      }
      return { kind: "metrics", metrics: await fetchFredMetrics({ apiKey, fetchedAt: now }) };
    }
    case MOF_SOURCE_KEY: {
      return { kind: "metrics", metrics: await fetchMofJgbMetrics({ fetchedAt: now }) };
    }
    case EIA_SOURCE_KEY: {
      const apiKey = Deno.env.get("EIA_API_KEY");
      if (!apiKey) throw new Error("SECRET_MISSING:EIA_API_KEY");
      return { kind: "metrics", metrics: await fetchEiaMetrics({ apiKey, fetchedAt: now }) };
    }
    case SEC_SOURCE_KEY: {
      const userAgent = Deno.env.get("SEC_EDGAR_USER_AGENT");
      if (!userAgent) throw new Error("SECRET_MISSING:SEC_EDGAR_USER_AGENT");
      return { kind: "events", events: await fetchSecEdgarFilings({ userAgent, now }) };
    }
    case FRANKFURTER_SOURCE_KEY: {
      // No API key: Frankfurter is a free, unauthenticated, unlimited-quota
      // endpoint, same as MOF's public CSV.
      return { kind: "metrics", metrics: await fetchFrankfurterFxMetrics({ fetchedAt: now }) };
    }
    case ESTAT_SOURCE_KEY: {
      const appId = Deno.env.get("ESTAT_APP_ID");
      if (!appId) throw new Error("SECRET_MISSING:ESTAT_APP_ID");
      return { kind: "metrics", metrics: await fetchEstatCpiMetrics({ appId, fetchedAt: now }) };
    }
    case FED_STATEMENT_SOURCE_KEY: {
      // The statement parser remains source-pure; prior event identity is
      // read here so the writer can label same-meeting document revisions.
      // A missing prior event is the normal new-meeting path.
      const previousIdentities = await readPreviousFedStatementIdentities(ctx, options.allowedFedDuplicateEventIds);
      if (options.historicalFedStatementUrls && options.historicalFedStatementUrls.length > 0) {
        const historicalEvents: MarketEventInput[] = [];
        const existingEventIds: Record<string, string> = {};
        for (const statementUrl of options.historicalFedStatementUrls) {
          const statementHtml = await fetchFedStatement(statementUrl, fetch);
          const parsed = await parseFedStatementHtml(statementUrl, statementHtml, null);
          const previousRange = await readFedTargetRangeBefore(ctx, parsed.meetingDate);
          const statement = { ...parsed, decision: classifyFedDecision(previousRange, parsed.targetRange) };
          if (!previousRange) throw new Error(`FED_HISTORICAL_RANGE_MISSING:${statement.meetingDate}`);
          const existingIdentity = previousIdentities.find((identity) => identity.meetingDate === statement.meetingDate) ?? null;
          const identityOutcome = statementIdentityChanged(existingIdentity, statement);
          historicalEvents.push(buildFedDecisionEvent(statement, previousRange, identityOutcome === "revision"));
          if (existingIdentity) existingEventIds[statement.meetingDate] = existingIdentity.eventId;
        }
        return { kind: "events", events: historicalEvents, fedExistingEventIds: existingEventIds };
      }
      const bundle = await fetchFedStatementEventBundle(fetch, null, previousIdentities);
      const previousRange = await readFedTargetRangeBefore(ctx, bundle.statement.meetingDate);
      const statement = {
        ...bundle.statement,
        decision: classifyFedDecision(previousRange, bundle.statement.targetRange),
      };
      const sameMeetingIdentity = previousIdentities.find((identity) => identity.meetingDate === statement.meetingDate) ?? null;
      const identityOutcome = statementIdentityChanged(sameMeetingIdentity, statement);
      const events = [buildFedDecisionEvent(statement, previousRange, identityOutcome === "revision")];
      const previousRef = previousIdentities
        .filter((identity) => identity.meetingDate < statement.meetingDate)
        .sort((a, b) => b.meetingDate.localeCompare(a.meetingDate))[0];
      let previousFedStatement: FedStatementRecord | undefined;
      if (previousRef) {
        const previousHtml = await fetchFedStatement(previousRef.statementUrl, fetch);
        const parsed = await parseFedStatementHtml(previousRef.statementUrl, previousHtml, null);
        previousFedStatement = {
          eventId: previousRef.eventId,
          centralBank: "Fed",
          meetingDate: parsed.meetingDate,
          documentHash: parsed.documentHash,
          normalizedText: parsed.normalizedText,
          statementUrl: parsed.statementUrl,
          decision: parsed.decision,
          targetRange: parsed.targetRange,
        };
      }
      const fedExistingEventIds = sameMeetingIdentity
        ? { [statement.meetingDate]: sameMeetingIdentity.eventId }
        : undefined;
      return { kind: "events", events, fedStatement: statement, previousFedStatement, fedExistingEventIds };
    }
  }
}

async function fetchActiveSourceKeys(ctx: RestContext, fetchImpl: typeof fetch): Promise<SourceKeyWithFed[]> {
  const result = await fetchImpl(
    `${ctx.supabaseUrl}/rest/v1/mic_source_registry?is_active=eq.true&select=source_key`,
    { headers: restHeaders(ctx.secretKey) },
  );
  if (!result.ok) throw new Error(`ACTIVE_SOURCE_LOOKUP_FAILED:${result.status}`);
  const rows = await result.json() as Array<{ source_key?: unknown }>;
  return rows
    .map((row) => row.source_key)
    .filter((key): key is SourceKeyWithFed => typeof key === "string" && (ALL_SOURCE_KEYS as string[]).includes(key));
}

type SourceRunResult = {
  sourceKey: SourceKeyWithFed;
  status: "completed" | "failed" | "skipped_duplicate";
  attemptNo?: number;
  fetchedCount?: number;
  newCount?: number;
  duplicateCount?: number;
  // Macro Indicators Phase 1A: how many market_events rows
  // (event_type='macro_release') this run actually wrote -- a SEPARATE
  // counter from fetchedCount/newCount/duplicateCount (which describe the
  // metrics themselves), since a metric can be "new" in market_metrics
  // (newCount) while producing zero macro_release events (an unchanged
  // re-fetch) or vice versa is never possible, but keeping the two counts
  // distinct avoids conflating "how many metric rows were written" with
  // "how many release/revision facts were detected". Undefined for every
  // non-FRED / non-macro source, and stays 0 for FRED runs that fetch only
  // non-macro FRED series (e.g. a manual invoke scoped to US2Y/US10Y only).
  // Not persisted to mic_ingestion_runs (no such column exists there, and
  // this phase does not ALTER that table) -- visible only in this
  // response payload for observability.
  macroReleaseEventCount?: number;
  error?: string;
};

async function runSource(
  ctx: RestContext,
  sourceKey: SourceKeyWithFed,
  triggerType: "manual" | "scheduled",
  now: Date,
  options: AdapterOptions = {},
): Promise<SourceRunResult> {
  const runWindow = computeRunWindow(sourceKey, now);
  const claim = await claimIngestionRun(ctx, { sourceKey, runWindow, triggerType });
  if (!claim.claimed || !claim.runId) {
    return { sourceKey, status: "skipped_duplicate" };
  }

  try {
    const result = await runAdapter(ctx, sourceKey, now, options);
    let fetchedCount = 0;
    let newCount = 0;
    let duplicateCount = 0;
    let macroReleaseEventCount: number | undefined;

    if (result.kind === "metrics") {
      fetchedCount = result.metrics.length;
      for (const metric of result.metrics) {
        // Macro Indicators Phase 1A/1B: for the explicit FRED/e-Stat macro
        // metric_keys, read whatever value is currently stored for this
        // (metric_key, source_key, observed_date) triple BEFORE it gets
        // overwritten by the upsert below, so a market_events
        // (macro_release) row can be written for a genuine new release or
        // revision -- and, critically, NOT written for a plain re-fetch of
        // an already-known value. Every other metric_key (US2Y/US10Y/
        // equity_index/fx/commodities, and every MOF/EIA/Frankfurter
        // metric) skips this entirely: zero extra reads, zero behavior
        // change.
        const isMacroRelease = MACRO_RELEASE_METRIC_KEYS.has(metric.metricKey);
        const priorValue = isMacroRelease
          ? await readExistingMarketMetricValue(ctx, metric.metricKey, metric.sourceKey, metric.observedDate)
          : null;

        await upsertMarketMetric(ctx, metric);
        newCount += 1;

        if (isMacroRelease) {
          macroReleaseEventCount = macroReleaseEventCount ?? 0;
          const decision = decideMacroReleaseEvent(priorValue, metric.value);
          const releaseEvent = buildMacroReleaseEvent(decision, buildMacroReleaseContext(metric));
          if (releaseEvent) {
            const finalized = await finalizeMarketEvent(releaseEvent);
            const written = await writeMarketEvent(ctx, finalized);
            if (written.outcome === "inserted") macroReleaseEventCount += 1;
          }
        }
      }
    } else {
      fetchedCount = result.events.length;
      for (const event of result.events) {
        const finalized = await finalizeMarketEvent(event);
        const meetingDate = typeof event.rawPayload?.meeting_date === "string" ? event.rawPayload.meeting_date : null;
        const existingEventId = sourceKey === FED_STATEMENT_SOURCE_KEY && meetingDate
          ? result.fedExistingEventIds?.[meetingDate]
          : undefined;
        let persistedEventId: string | null = null;
        if (existingEventId) {
          await updateMarketEvent(ctx, existingEventId, finalized);
          newCount += 1;
          persistedEventId = existingEventId;
        } else {
          const written = await writeMarketEvent(ctx, finalized);
          if (written.outcome === "duplicate") duplicateCount += 1;
          else newCount += 1;
          persistedEventId = written.id;
        }

        if (sourceKey === FED_STATEMENT_SOURCE_KEY && result.fedStatement && persistedEventId) {
          const currentStatement: FedStatementRecord = {
            eventId: persistedEventId,
            centralBank: "Fed",
            meetingDate: result.fedStatement.meetingDate,
            documentHash: result.fedStatement.documentHash,
            normalizedText: result.fedStatement.normalizedText,
            statementUrl: result.fedStatement.statementUrl,
            decision: result.fedStatement.decision,
            targetRange: result.fedStatement.targetRange,
          };
          const pipeline = await buildFedStatementDiffPipeline(currentStatement, result.previousFedStatement ?? null);
          await persistFedStatementDiff(ctx, pipeline.row);
        }
      }
    }

    await completeIngestionRun(ctx, claim.runId, { fetchedCount, newCount, duplicateCount });
    return {
      sourceKey,
      status: "completed",
      attemptNo: claim.attemptNo ?? undefined,
      fetchedCount,
      newCount,
      duplicateCount,
      macroReleaseEventCount,
    };
  } catch (error) {
    const reason = safeErrorMessage(error);
    await failIngestionRun(ctx, claim.runId, reason);
    return { sourceKey, status: "failed", attemptNo: claim.attemptNo ?? undefined, error: reason };
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return response({ error: "POST_REQUIRED" }, 405);
  if (!isAuthorizedCronCaller(req)) return response({ error: "UNAUTHORIZED" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const secretKey = getSecretKey();
  if (!supabaseUrl || !secretKey) return response({ error: "SERVER_CONFIGURATION_MISSING" }, 500);
  const ctx: RestContext = { supabaseUrl, secretKey };

  const requestBody = await req.json().catch(() => ({})) as {
    action?: unknown;
    diff_id?: unknown;
    trigger?: unknown;
    sources?: unknown;
    historicalFedStatementUrls?: unknown;
    historicalFredRange?: unknown;
    allowedFedDuplicateEventIds?: unknown;
  };
  if (requestBody.action !== undefined) {
    if ((requestBody.action !== INTERPRET_FED_STATEMENT_DIFF_ACTION &&
      requestBody.action !== REPAIR_FED_STATEMENT_DIFF_USAGE_ACTION) || typeof requestBody.diff_id !== "string") {
      return response({ error: "INVALID_ACTION_REQUEST" }, 400);
    }
    try {
      const result = requestBody.action === INTERPRET_FED_STATEMENT_DIFF_ACTION
        ? await executeFedStatementAiAction(ctx, requestBody.diff_id, Deno.env.get("OPENAI_API_KEY") ?? "")
        : await executeFedStatementAiUsageRepairAction(ctx, requestBody.diff_id);
      return response(result);
    } catch (error) {
      if (error instanceof FedStatementAiActionError) return response({ error: error.code }, error.status);
      return response({ error: "FED_AI_ACTION_FAILED" }, 502);
    }
  }
  const triggerType: "manual" | "scheduled" = requestBody.trigger === "scheduled" ? "scheduled" : "manual";
  const requestedSources = Array.isArray(requestBody.sources)
    ? requestBody.sources.filter((s): s is SourceKeyWithFed =>
      typeof s === "string" && (ALL_SOURCE_KEYS as string[]).includes(s)
    )
    : null;
  const historicalFedStatementUrls = Array.isArray(requestBody.historicalFedStatementUrls)
    ? requestBody.historicalFedStatementUrls.filter((url): url is string => typeof url === "string")
    : undefined;
  const historicalFredRange = typeof requestBody.historicalFredRange === "object" && requestBody.historicalFredRange !== null
    ? requestBody.historicalFredRange as Record<string, unknown>
    : undefined;
  const parsedHistoricalFredRange = historicalFredRange &&
      typeof historicalFredRange.observationStart === "string" &&
      typeof historicalFredRange.observationEnd === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(historicalFredRange.observationStart) &&
      /^\d{4}-\d{2}-\d{2}$/.test(historicalFredRange.observationEnd)
    ? { observationStart: historicalFredRange.observationStart, observationEnd: historicalFredRange.observationEnd }
    : undefined;
  const allowedFedDuplicateEventIds = Array.isArray(requestBody.allowedFedDuplicateEventIds)
    ? new Set(requestBody.allowedFedDuplicateEventIds.filter((id): id is string => typeof id === "string"))
    : undefined;

  // Best-effort; must never block the run below even if it fails.
  await reconcileStaleIngestionRuns(ctx);

  let sourceKeys: SourceKeyWithFed[];
  if (requestedSources && requestedSources.length > 0) {
    // Explicit manual override (e.g. ops testing one adapter) -- runs
    // regardless of is_active, since the caller asked for it by name.
    sourceKeys = requestedSources;
  } else {
    try {
      sourceKeys = await fetchActiveSourceKeys(ctx, fetch);
    } catch (error) {
      return response({ error: "ACTIVE_SOURCE_LOOKUP_FAILED", detail: safeErrorMessage(error) }, 502);
    }
  }

  if (sourceKeys.length === 0) {
    return response({ status: "skipped_inactive", results: [] });
  }

  const now = new Date();
  const results: SourceRunResult[] = [];
  for (const sourceKey of sourceKeys) {
    results.push(await runSource(ctx, sourceKey, triggerType, now, {
      historicalFedStatementUrls: sourceKey === FED_STATEMENT_SOURCE_KEY ? historicalFedStatementUrls : undefined,
      historicalFredRange: sourceKey === FRED_SOURCE_KEY ? parsedHistoricalFredRange : undefined,
      allowedFedDuplicateEventIds: sourceKey === FED_STATEMENT_SOURCE_KEY ? allowedFedDuplicateEventIds : undefined,
    }));
  }

  return response({ status: "completed", results });
});
