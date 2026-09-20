// Market Intelligence Core (MIC) Phase 1A ingestion entry point.
//
// Scope: accumulate Facts only (market_events / market_metrics). This
// function never calls OpenAI, never touches any X-autopost table, and
// never writes anything outside the 5 MIC tables added by
// 20260912090000_add_market_intelligence_core_phase1a.sql.
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

const ALL_SOURCE_KEYS: SourceKey[] = [
  FRED_SOURCE_KEY,
  MOF_SOURCE_KEY,
  EIA_SOURCE_KEY,
  SEC_SOURCE_KEY,
  FRANKFURTER_SOURCE_KEY,
  ESTAT_SOURCE_KEY,
];

type FetchResult =
  | { kind: "metrics"; metrics: NormalizedMarketMetric[] }
  | { kind: "events"; events: MarketEventInput[] };

// Per-source adapter dispatch. Each entry is responsible for its own
// secret lookup so a missing secret produces a per-source SECRET_MISSING
// result (failure isolation) instead of crashing the whole invocation --
// same principle as official_source_fetchers.ts's runNewsSourceProviders.
async function runAdapter(sourceKey: SourceKey, now: Date): Promise<FetchResult> {
  switch (sourceKey) {
    case FRED_SOURCE_KEY: {
      const apiKey = Deno.env.get("FRED_API_KEY");
      if (!apiKey) throw new Error("SECRET_MISSING:FRED_API_KEY");
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
  }
}

async function fetchActiveSourceKeys(ctx: RestContext, fetchImpl: typeof fetch): Promise<SourceKey[]> {
  const result = await fetchImpl(
    `${ctx.supabaseUrl}/rest/v1/mic_source_registry?is_active=eq.true&select=source_key`,
    { headers: restHeaders(ctx.secretKey) },
  );
  if (!result.ok) throw new Error(`ACTIVE_SOURCE_LOOKUP_FAILED:${result.status}`);
  const rows = await result.json() as Array<{ source_key?: unknown }>;
  return rows
    .map((row) => row.source_key)
    .filter((key): key is SourceKey => typeof key === "string" && (ALL_SOURCE_KEYS as string[]).includes(key));
}

type SourceRunResult = {
  sourceKey: SourceKey;
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
  sourceKey: SourceKey,
  triggerType: "manual" | "scheduled",
  now: Date,
): Promise<SourceRunResult> {
  const runWindow = computeRunWindow(sourceKey, now);
  const claim = await claimIngestionRun(ctx, { sourceKey, runWindow, triggerType });
  if (!claim.claimed || !claim.runId) {
    return { sourceKey, status: "skipped_duplicate" };
  }

  try {
    const result = await runAdapter(sourceKey, now);
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
        const written = await writeMarketEvent(ctx, finalized);
        if (written.outcome === "duplicate") duplicateCount += 1;
        else newCount += 1;
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

  const requestBody = await req.json().catch(() => ({})) as { trigger?: unknown; sources?: unknown };
  const triggerType: "manual" | "scheduled" = requestBody.trigger === "scheduled" ? "scheduled" : "manual";
  const requestedSources = Array.isArray(requestBody.sources)
    ? requestBody.sources.filter((s): s is SourceKey =>
      typeof s === "string" && (ALL_SOURCE_KEYS as string[]).includes(s)
    )
    : null;

  // Best-effort; must never block the run below even if it fails.
  await reconcileStaleIngestionRuns(ctx);

  let sourceKeys: SourceKey[];
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
    results.push(await runSource(ctx, sourceKey, triggerType, now));
  }

  return response({ status: "completed", results });
});
