// Market Intelligence Core (MIC) Phase 1B State evaluator entry point.
//
// Scope: read Facts (market_metrics/market_events via the Phase 1B views),
// decide deterministically whether anything material changed per domain,
// and only call AI (Luna, escalating to Sol) when it did. Never calls
// OpenAI on a routine/no-change pass. Writes only to market_state_current,
// market_state_history, mic_state_evaluation_runs, and ai_usage_events --
// never to market_metrics/market_events (Facts stay Facts).
//
// Auth model, same convention as market-intelligence-ingest/index.ts:
// never called with a Supabase JWT, only by cron/manual invocation
// carrying X-Cron-Secret. DB access uses the new-format secret key
// (SUPABASE_SECRET_KEYS['default']).
//
// NOT deployed, NOT scheduled, and NOT invoked against production as part
// of Phase 1B implementation -- see the completion report for what
// remains before any of that happens.
import {
  ALL_DOMAINS,
  type CoverageStatus,
  type Domain,
  type EventFact,
  type FetchStatus,
  type MaterialChangeDecision,
  type MetricObservationRow,
  type ObservationStatus,
} from "./mic_state_types.ts";
import {
  computeCoverageStatus,
  computeDataConfidence,
  detectNewObservations,
  evaluateEventMaterialChange,
  evaluateMaterialChange,
  rollUpFetchStatus,
  rollUpObservationStatus,
} from "./mic_state_decision_logic.ts";
import {
  fetchDomainMetricMap,
  fetchMetricObservationStatus,
  fetchPriorState,
  fetchRecentDomainEvents,
  fetchSourceFetchStatuses,
} from "./mic_state_query_logic.ts";
import {
  claimStateEvaluationRun,
  completeStateEvaluationRun,
  computeRunWindow,
  failStateEvaluationRun,
  reconcileStaleStateEvaluationRuns,
  safeErrorMessage,
} from "./mic_state_run_logic.ts";
import type { RestContext } from "./mic_state_run_logic.ts";
import { applyMaterialChangeUpdate, refreshStatusOnly } from "./mic_state_writer_logic.ts";
import {
  requestStateEvaluation,
  shouldEscalateToSol,
  STATE_EVAL_LUNA_MODEL,
} from "./mic_state_ai_logic.ts";
import { recordStateAiUsageEvent } from "./mic_state_ai_usage_logic.ts";

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function isAuthorizedCronCaller(req: Request): boolean {
  const expected = Deno.env.get("MARKET_INTELLIGENCE_STATE_EVALUATOR_CRON_SECRET");
  const provided = req.headers.get("X-Cron-Secret");
  return typeof expected === "string" && expected.length > 0 && provided === expected;
}

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

function buildNumericBaselineSnapshot(metrics: MetricObservationRow[]): Record<
  string,
  { value: number; observedDate: string | null; observedAt: string | null }
> {
  const snapshot: Record<string, { value: number; observedDate: string | null; observedAt: string | null }> = {};
  for (const metric of metrics) {
    if (metric.currentValue === null) continue;
    snapshot[metric.metricKey] = {
      value: metric.currentValue,
      observedDate: metric.observedDate,
      observedAt: metric.observedAt,
    };
  }
  return snapshot;
}

// Everything Step-1/Step-2 (deterministic, no AI, no claim, no write) --
// computed once per domain and reused by both the pre-pass (to get an
// accurate cross-domain material count for Sol escalation) and the actual
// claimed evaluation, so the two never disagree with each other.
type DomainDecision = {
  domain: Domain;
  metrics: MetricObservationRow[];
  recentEvents: EventFact[];
  metricDecision: MaterialChangeDecision;
  eventDecision: MaterialChangeDecision;
  isMaterial: boolean;
  coverageStatus: CoverageStatus;
  fetchStatus: FetchStatus;
  observationStatus: ObservationStatus;
  dataConfidence: number;
  latestAsOf: string | null;
};

type DomainDecisionOrError = { ok: true; decision: DomainDecision } | { ok: false; domain: Domain; error: string };

// Never throws -- a failure reading one domain's Facts must not prevent
// any other domain from being claimed/evaluated (failure isolation, same
// principle as important-news-monitor's per-lane fetch isolation).
async function computeDomainDecisionSafe(ctx: RestContext, domain: Domain): Promise<DomainDecisionOrError> {
  try {
    return { ok: true, decision: await computeDomainDecision(ctx, domain) };
  } catch (error) {
    return { ok: false, domain, error: safeErrorMessage(error) };
  }
}

async function computeDomainDecision(ctx: RestContext, domain: Domain): Promise<DomainDecision> {
  const [domainMapRows, metrics, prior] = await Promise.all([
    fetchDomainMetricMap(ctx, domain),
    fetchMetricObservationStatus(ctx, domain),
    fetchPriorState(ctx, domain),
  ]);
  const domainMapById = new Map(domainMapRows.map((row) => [row.metricKey, row]));

  const sourceKeys = metrics.map((m) => m.sourceKey).filter((k): k is string => k !== null);
  const fetchStatusBySource = await fetchSourceFetchStatuses(ctx, sourceKeys);

  const newObservations = detectNewObservations(metrics, prior.numericBaselineSnapshot);
  const metricDecision = evaluateMaterialChange(newObservations, domainMapById);

  const recentEvents = await fetchRecentDomainEvents(ctx, domain, null);
  const eventDecision = evaluateEventMaterialChange(recentEvents);

  const isMaterial = metricDecision.isMaterial || eventDecision.isMaterial ||
    (prior.narrativeIsNull && metrics.some((m) => m.currentValue !== null));

  const registeredMetricKeys = domainMapRows.map((r) => r.metricKey);
  const metricsWithFacts = metrics.filter((m) => m.currentValue !== null).map((m) => m.metricKey);
  const coverageStatus = computeCoverageStatus(registeredMetricKeys, metricsWithFacts);
  const fetchStatus = rollUpFetchStatus(sourceKeys.map((k) => fetchStatusBySource.get(k) ?? "unknown"));
  const observationStatus = rollUpObservationStatus(metrics.map((m) => m.observationStatus));
  const dataConfidence = computeDataConfidence(coverageStatus, fetchStatus, observationStatus);
  const latestAsOf = metrics
    .map((m) => m.fetchedAt)
    .filter((v): v is string => v !== null)
    .sort()
    .at(-1) ?? null;

  return {
    domain,
    metrics,
    recentEvents,
    metricDecision,
    eventDecision,
    isMaterial,
    coverageStatus,
    fetchStatus,
    observationStatus,
    dataConfidence,
    latestAsOf,
  };
}

type DomainEvalResult = {
  domain: Domain;
  status: "no_change" | "evaluated" | "failed" | "skipped_duplicate";
  reason?: string;
  error?: string;
};

async function evaluateDomain(
  ctx: RestContext,
  domain: Domain,
  decisionResult: DomainDecisionOrError,
  now: Date,
  materialDomainCountThisPass: number,
): Promise<DomainEvalResult> {
  const runWindow = computeRunWindow(domain, now);
  const claim = await claimStateEvaluationRun(ctx, { domain, runWindow });
  if (!claim.claimed || !claim.runId) {
    return { domain, status: "skipped_duplicate" };
  }

  if (!decisionResult.ok) {
    await failStateEvaluationRun(ctx, claim.runId, decisionResult.error);
    return { domain, status: "failed", error: decisionResult.error };
  }
  const decision = decisionResult.decision;

  try {
    if (!decision.isMaterial) {
      await refreshStatusOnly(ctx, domain, {
        asOf: decision.latestAsOf,
        coverageStatus: decision.coverageStatus,
        fetchStatus: decision.fetchStatus,
        observationStatus: decision.observationStatus,
        dataConfidence: decision.dataConfidence,
      });
      await completeStateEvaluationRun(ctx, claim.runId, {
        status: "no_change",
        decisionDetail: { material: false, reason: decision.metricDecision.reason },
      });
      return { domain, status: "no_change", reason: decision.metricDecision.reason };
    }

    const openAiApiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openAiApiKey) {
      throw new Error("SECRET_MISSING:OPENAI_API_KEY");
    }

    const aiInput = {
      domain,
      metrics: decision.metrics,
      materialMetricKeys: decision.metricDecision.materialMetricKeys,
      events: decision.recentEvents,
      priorNarrative: null as string | null,
    };
    const lunaResult = await requestStateEvaluation({ apiKey: openAiApiKey, model: STATE_EVAL_LUNA_MODEL, input: aiInput });

    const hasCriticalGeopoliticalEvent = domain === "geopolitical" &&
      decision.recentEvents.some((e) => e.importance === "critical");
    let finalResult = lunaResult;
    if (
      shouldEscalateToSol({
        domain,
        lunaOutput: lunaResult.output,
        materialDomainCountThisPass,
        hasCriticalGeopoliticalEvent,
      })
    ) {
      finalResult = await requestStateEvaluation({
        apiKey: openAiApiKey,
        model: "gpt-5.6-sol",
        input: aiInput,
      });
    }

    const usageRecord = await recordStateAiUsageEvent(ctx, {
      domain,
      model: finalResult.model,
      inputTokens: finalResult.inputTokens,
      outputTokens: finalResult.outputTokens,
      costUsd: finalResult.costUsd,
      relatedId: domain,
    });

    const reason = decision.metricDecision.isMaterial ? decision.metricDecision.reason : decision.eventDecision.reason;
    await applyMaterialChangeUpdate(
      ctx,
      domain,
      {
        asOf: decision.latestAsOf,
        coverageStatus: decision.coverageStatus,
        fetchStatus: decision.fetchStatus,
        observationStatus: decision.observationStatus,
        dataConfidence: decision.dataConfidence,
        narrative: finalResult.output.narrative,
        bullishFactors: finalResult.output.bullishFactors,
        bearishFactors: finalResult.output.bearishFactors,
        keyRisks: finalResult.output.keyRisks,
        numericBaselineSnapshot: buildNumericBaselineSnapshot(decision.metrics),
        sourceMetricKeys: decision.metricDecision.materialMetricKeys,
        sourceEventIds: decision.recentEvents.map((e) => e.id),
        aiModel: finalResult.model,
        aiConfidence: finalResult.output.confidence,
        aiInputTokens: finalResult.inputTokens,
        aiOutputTokens: finalResult.outputTokens,
        aiCostUsd: finalResult.costUsd,
      },
      reason,
    );

    await completeStateEvaluationRun(ctx, claim.runId, {
      status: "evaluated",
      decisionDetail: { material: true, reason },
      aiUsageEventId: usageRecord.id,
    });
    return { domain, status: "evaluated" };
  } catch (error) {
    const reason = safeErrorMessage(error);
    await failStateEvaluationRun(ctx, claim.runId, reason);
    return { domain, status: "failed", error: reason };
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return response({ error: "POST_REQUIRED" }, 405);
  if (!isAuthorizedCronCaller(req)) return response({ error: "UNAUTHORIZED" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const secretKey = getSecretKey();
  if (!supabaseUrl || !secretKey) return response({ error: "SERVER_CONFIGURATION_MISSING" }, 500);
  const ctx: RestContext = { supabaseUrl, secretKey };

  const requestBody = await req.json().catch(() => ({})) as { domains?: unknown };
  const requestedDomains = Array.isArray(requestBody.domains)
    ? requestBody.domains.filter((d): d is Domain => typeof d === "string" && (ALL_DOMAINS as string[]).includes(d))
    : ALL_DOMAINS;

  await reconcileStaleStateEvaluationRuns(ctx);

  const now = new Date();

  // Pre-pass: compute every domain's material-change decision (pure
  // reads, no claim, no AI, never throws) so the true cross-domain
  // material count is known before any AI call -- needed for
  // shouldEscalateToSol's "multiple domains material in the same pass"
  // condition. A domain whose read phase failed here still gets claimed
  // and recorded as 'failed' below, it just doesn't count toward
  // materialDomainCount.
  const decisionResults = await Promise.all(
    requestedDomains.map((domain) => computeDomainDecisionSafe(ctx, domain)),
  );
  const materialDomainCount = decisionResults.filter((d) => d.ok && d.decision.isMaterial).length;

  const results: DomainEvalResult[] = [];
  for (let i = 0; i < requestedDomains.length; i++) {
    results.push(await evaluateDomain(ctx, requestedDomains[i], decisionResults[i], now, materialDomainCount));
  }

  return response({ status: "completed", results });
});
