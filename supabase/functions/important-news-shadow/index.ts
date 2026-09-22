import {
  decideConditionalSearch,
  dedupeKey,
  estimateCostUsd,
  eventKey,
  hasValidCronSecret,
  type LiveCandidate,
  matchLiveCandidate,
  runSlot,
  type ShadowCandidate,
} from "./shadow_logic.ts";
import {
  fetchSource,
  isSourceCooldown,
  SHADOW_SOURCES,
} from "./shadow_sources.ts";
import {
  aggregateTargetedSearchUsage,
  createTargetedSearchDiagnostics,
  hasMeaningfulSearchUsage,
  recordTargetedSearchAttempt,
  recordTargetedSearchFailure,
  recordTargetedSearchSuccess,
  shouldAttemptTargetedSearch,
  summarizeTargetedSearchResponse,
  targetedSearchTelemetryColumns,
  type TargetedSearchDiagnostics,
} from "./search_telemetry.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const PROJECT_REF = "wsmznyzcvmuitkglfeuj";
const LIVE_TABLE = "important_news_candidates";
const RUNS_TABLE = "important_news_shadow_runs";
const CANDIDATES_TABLE = "important_news_shadow_candidates";
const MODEL = "gpt-5.6-luna";

type Usage = {
  inputTokens: number;
  outputTokens: number;
  webSearchCalls: number;
  costUsd: number;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

async function targetedSearch(
  apiKey: string,
  candidate: ShadowCandidate,
  reason: string,
  diagnostics: TargetedSearchDiagnostics,
): Promise<Usage> {
  // Count only after a POST is about to be sent. Failure means HTTP, transport,
  // timeout, or response parsing failure; neither raw request nor response is retained.
  recordTargetedSearchAttempt(diagnostics);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({
        model: MODEL,
        store: false,
        reasoning: { effort: "low" },
        max_output_tokens: 300,
        max_tool_calls: 1,
        tools: [{ type: "web_search", search_context_size: "low" }],
        tool_choice: "required",
        instructions:
          "Read-only shadow validation. Search once for a primary or reputable confirmation of the supplied event. Return a short factual summary. Do not draft social posts and do not call external publication services.",
        input:
          `reason=${reason}\ntopic=${candidate.topic}\nheadline=${candidate.headline}\nsource=${candidate.sourceUrl}`,
      }),
    });
    if (!response.ok) throw new Error(`TARGETED_SEARCH_HTTP_${response.status}`);
    const raw = await response.json();
    const summary = summarizeTargetedSearchResponse(raw);
    recordTargetedSearchSuccess(diagnostics, summary);
    const webSearchCalls = summary.webSearchOutputItemCount;
    return {
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      webSearchCalls,
      costUsd: estimateCostUsd(
        summary.inputTokens,
        summary.outputTokens,
        webSearchCalls,
      ),
    };
  } catch (error) {
    recordTargetedSearchFailure(diagnostics);
    throw error;
  }
}

function restHeaders(key: string, prefer?: string): HeadersInit {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {}),
  };
}

async function rest<T>(
  base: string,
  key: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${base}/rest/v1/${path}`, {
    ...init,
    headers: { ...restHeaders(key), ...(init.headers ?? {}) },
  });
  if (!response.ok) {
    throw new Error(`REST_${response.status}:${path.split("?")[0]}`);
  }
  if (
    response.status === 204 || response.headers.get("content-length") === "0"
  ) return undefined as T;
  return await response.json() as T;
}

async function insertRun(
  base: string,
  key: string,
  now: Date,
  triggerType: string,
  synthetic: boolean,
): Promise<{ id: string } | null> {
  const response = await fetch(`${base}/rest/v1/${RUNS_TABLE}?select=id`, {
    method: "POST",
    headers: restHeaders(
      key,
      "return=representation,resolution=ignore-duplicates",
    ),
    body: JSON.stringify({
      run_slot: runSlot(now),
      trigger_type: triggerType,
      synthetic,
    }),
  });
  if (!response.ok) throw new Error(`RUN_INSERT_${response.status}`);
  const rows = await response.json() as Array<{ id: string }>;
  return rows[0] ?? null;
}

async function recentLive(
  base: string,
  key: string,
  now: Date,
): Promise<LiveCandidate[]> {
  const since = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
  const select =
    "id,source_url,title,normalized_title,entity_key,category,published_at,fetched_at,importance,content_hash";
  return rest<LiveCandidate[]>(
    base,
    key,
    `${LIVE_TABLE}?select=${select}&fetched_at=gte.${
      encodeURIComponent(since)
    }&order=fetched_at.desc&limit=1000`,
  );
}

async function topicCoolingDown(
  base: string,
  key: string,
  topic: string,
  now: Date,
): Promise<boolean> {
  const since = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
  const rows = await rest<Array<{ id: string }>>(
    base,
    key,
    `${CANDIDATES_TABLE}?select=id&topic=eq.${
      encodeURIComponent(topic)
    }&conditional_search_used=eq.true&last_seen_at=gte.${
      encodeURIComponent(since)
    }&limit=1`,
  );
  return rows.length > 0;
}

async function runShadow(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  }
  const base = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const cronSecret = Deno.env.get("IMPORTANT_NEWS_SHADOW_CRON_SECRET") ?? "";
  if (!base.includes(PROJECT_REF) || !key) {
    return json({ error: "SERVER_CONFIGURATION_ERROR" }, 500);
  }
  if (!cronSecret) return json({ error: "AUTH_NOT_CONFIGURED" }, 503);
  if (!hasValidCronSecret(request, cronSecret)) {
    return json({ error: "UNAUTHORIZED" }, 401);
  }

  let payload: { trigger?: unknown; dry_run?: unknown; synthetic?: unknown } =
    {};
  try {
    payload = await request.json();
  } catch { /* defaults */ }
  const dryRun = payload.dry_run === true;
  const synthetic = payload.synthetic === true;
  const triggerType = payload.trigger === "smoke"
    ? "smoke"
    : payload.trigger === "manual"
    ? "manual"
    : "scheduled";
  const now = new Date();

  const settled = await Promise.all(SHADOW_SOURCES.map(async (source) => {
    const started = Date.now();
    if (isSourceCooldown(source, now)) {
      return {
        source,
        candidates: [] as ShadowCandidate[],
        health: {
          status: "skipped_cooldown",
          item_count: 0,
          latency_ms: 0,
          checked_at: now.toISOString(),
        },
      };
    }
    try {
      const candidates = await fetchSource(source, fetch, now);
      return {
        source,
        candidates,
        health: {
          status: "healthy",
          item_count: candidates.length,
          latency_ms: Date.now() - started,
          checked_at: now.toISOString(),
        },
      };
    } catch (error) {
      return {
        source,
        candidates: [] as ShadowCandidate[],
        health: {
          status: "failed",
          item_count: 0,
          latency_ms: Date.now() - started,
          checked_at: now.toISOString(),
          error: error instanceof Error
            ? error.message.slice(0, 120)
            : "UNKNOWN",
        },
      };
    }
  }));
  const sourceHealth = Object.fromEntries(
    settled.map((item) => [item.source.key, item.health]),
  );
  const candidates = settled.flatMap((item) => item.candidates);
  const failedSources =
    settled.filter((item) => item.health.status === "failed").length;
  if (dryRun) {
    return json({
      status: "dry_run",
      source_health: sourceHealth,
      free_candidate_count: candidates.length,
    });
  }

  const run = await insertRun(base, key, now, triggerType, synthetic);
  if (!run) {
    return json({ status: "duplicate_run_slot", run_slot: runSlot(now) });
  }
  const earlierRuns = await rest<Array<{ id: string }>>(
    base,
    key,
    `${RUNS_TABLE}?select=id&id=neq.${run.id}&synthetic=eq.${synthetic}&limit=1`,
  );
  const bootstrapBaseline = earlierRuns.length === 0;

  const errors: Array<Record<string, unknown>> = [];
  let matched = 0;
  let inserted = 0;
  let usage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    webSearchCalls: 0,
    costUsd: 0,
  };
  const searchDiagnostics = createTargetedSearchDiagnostics();
  try {
    const live = await recentLive(base, key, now);
    let paidSearchUsed = false;
    for (const candidate of candidates) {
      const keyValue = await dedupeKey(candidate);
      const existing = await rest<Array<{ id: string; first_seen_at: string }>>(
        base,
        key,
        `${CANDIDATES_TABLE}?select=id,first_seen_at&dedupe_key=eq.${keyValue}&synthetic=eq.${synthetic}&limit=1`,
      );
      const liveMatch = matchLiveCandidate(candidate, live);
      if (liveMatch) matched += 1;
      const coolingDown = await topicCoolingDown(
        base,
        key,
        candidate.topic,
        now,
      );
      const decision = decideConditionalSearch(candidate, {
        // The first natural run establishes a free-source baseline only, so
        // pre-rollout backlog cannot trigger a paid search.
        isNew: existing.length === 0 && !bootstrapBaseline,
        topicCoolingDown: coolingDown,
        degradedSourceCount: failedSources,
      });
      let usedSearch = false;
      if (shouldAttemptTargetedSearch(paidSearchUsed, decision.shouldSearch)) {
        const openAiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
        if (openAiKey) {
          try {
            const responseUsage = await targetedSearch(
              openAiKey,
              candidate,
              decision.reason,
              searchDiagnostics,
            );
            usage = aggregateTargetedSearchUsage(usage, responseUsage);
            // Preserve the existing latch decision based on this successful response.
            paidSearchUsed = hasMeaningfulSearchUsage(responseUsage);
            usedSearch = paidSearchUsed;
          } catch (error) {
            errors.push({
              code: "TARGETED_SEARCH_FAILED",
              message: error instanceof Error ? error.message : "UNKNOWN",
              topic: candidate.topic,
            });
          }
        }
      }
      const oldDetected = liveMatch?.fetched_at ?? null;
      const observationFirstSeen = existing[0]?.first_seen_at ??
        now.toISOString();
      const delay = oldDetected
        ? Math.round(
          (Date.parse(oldDetected) - Date.parse(observationFirstSeen)) / 1000,
        )
        : null;
      const row = {
        shadow_run_id: run.id,
        event_key: await eventKey(candidate),
        dedupe_key: keyValue,
        source_name: candidate.sourceName,
        source_url: candidate.sourceUrl,
        topic: candidate.topic,
        category: candidate.category,
        headline: candidate.headline,
        body_summary: candidate.bodySummary,
        published_at: candidate.publishedAt,
        last_seen_at: now.toISOString(),
        trigger_reason: bootstrapBaseline
          ? "bootstrap_baseline"
          : decision.reason,
        free_source_health: sourceHealth[candidate.sourceName] ?? {},
        conditional_search_used: usedSearch,
        search_topic: usedSearch ? candidate.topic : null,
        estimated_cost_usd: usedSearch ? usage.costUsd : 0,
        matched_live_candidate_id: liveMatch?.id ?? null,
        old_detected_at: oldDetected,
        old_importance: liveMatch?.importance ?? null,
        detection_delay_sec: delay,
        evidence: {
          match_method: liveMatch
            ? "canonical_url_or_conservative_title"
            : "none",
          live_content_hash: liveMatch?.content_hash ?? null,
        },
        synthetic,
      };
      if (existing.length) {
        await rest(base, key, `${CANDIDATES_TABLE}?id=eq.${existing[0].id}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify(row),
        });
      } else {
        await rest(base, key, CANDIDATES_TABLE, {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify(row),
        });
        inserted += 1;
      }
    }
    if (
      searchDiagnostics.targetedSearchAttemptCount > 0 ||
      usage.webSearchCalls ||
      usage.inputTokens ||
      usage.outputTokens
    ) {
      await rest(base, key, "ai_usage_events", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          feature: "news_shadow_search",
          model: MODEL,
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          web_search_calls: usage.webSearchCalls,
          cost_usd: usage.costUsd,
          related_table: RUNS_TABLE,
          related_id: run.id,
          ...targetedSearchTelemetryColumns(searchDiagnostics),
        }),
      });
    }
  } catch (error) {
    errors.push({
      code: "SHADOW_RUN_FAILED",
      message: error instanceof Error ? error.message.slice(0, 200) : "UNKNOWN",
    });
  }
  const status = errors.length
    ? (inserted > 0 ? "partial" : "failed")
    : "completed";
  await rest(base, key, `${RUNS_TABLE}?id=eq.${run.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status,
      source_health: sourceHealth,
      free_fetch_count: SHADOW_SOURCES.length,
      free_candidate_count: candidates.length,
      matched_live_count: matched,
      conditional_search_count:
        usage.inputTokens > 0 || usage.webSearchCalls > 0 ? 1 : 0,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      web_search_calls: usage.webSearchCalls,
      cost_usd: usage.costUsd,
      ...targetedSearchTelemetryColumns(searchDiagnostics),
      error_summary: errors,
      completed_at: new Date().toISOString(),
    }),
  });
  return json({
    status,
    run_id: run.id,
    free_candidate_count: candidates.length,
    new_candidate_count: inserted,
    matched_live_count: matched,
    web_search_calls: usage.webSearchCalls,
    cost_usd: usage.costUsd,
  });
}

Deno.serve((request) =>
  runShadow(request).catch((error) => {
    console.error("important-news-shadow failed", {
      code: "UNHANDLED",
      message: error instanceof Error ? error.message : "UNKNOWN",
    });
    return json({ error: "INTERNAL_ERROR" }, 500);
  })
);
