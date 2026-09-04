import {
  candidateStatusForDuplicate,
  findNewsDuplicate,
  isImportantNewsCategory,
  prepareNewsCandidate,
  type DuplicateComparable,
  type ImportantNewsSourceType,
  type IncomingNewsCandidate,
  type PreparedNewsCandidate,
} from "./news_candidate_logic.ts";
import {
  aggregateImportantNewsGroup,
  groupImportantNewsCandidates,
  type ImportantNewsCandidateGroup,
} from "./important_news_grouping_logic.ts";
import {
  planImportantNewsCandidateBatch,
  planImportantNewsFetchGroups,
} from "./fetch_resource_limit_logic.ts";
import {
  reconcileStaleImportantNewsRuns,
  runAfterBestEffortStaleRunReconciliation,
} from "./stale_run_logic.ts";
import {
  enrichTdnetCandidatesWithPdfSummaries,
  fetchCompanyIrSource,
  fetchTdnetCandidates,
  runNewsSourceProviders,
  type CompanyIrSource,
  type NewsSourceProvider,
} from "./official_source_fetchers.ts";
import {
  judgeCandidateWithEscalation,
  requestImportantNewsJudgement,
  type FinalJudgement,
  type JudgementCandidate,
} from "./importance_judgement_logic.ts";
import {
  generateImportantNewsPost,
  requestGenerationStep,
  type GenerationCandidate,
  type PostGenerationResult,
} from "./post_generation_logic.ts";
import {
  loadXTokens,
  postToXWithRefresh,
  type XAuthContext,
} from "../_shared/x_oauth2_post.ts";
import {
  publishImportantNewsCandidate,
  type PublishCandidate,
  type PublishRepository,
} from "./publish_logic.ts";
import { executeWhenAutoPublishEnabled } from "./auto_publish_logic.ts";
import { orderImportantNewsPublishQueue } from "./rate_control_logic.ts";

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };
const MAX_CANDIDATES_PER_REQUEST = 100;
const UNPDF_EDGE_TEST_URL = "https://www.release.tdnet.info/inbs/140120260828528131.pdf";

const SOURCE_POLICY: Record<string, { type: ImportantNewsSourceType; priority: 1; domains?: string[] }> = {
  tdnet: { type: "tdnet", priority: 1, domains: ["tdnet.info"] },
  company_ir: { type: "company_ir", priority: 1 },
};

const BLOCKED_SOURCE_DOMAINS = [
  "x.com", "twitter.com", "facebook.com", "reddit.com", "stocktwits.com", "5ch.net",
];

type StoredCandidate = {
  id: string;
  source_url: string;
  normalized_title: string;
  content_hash: string;
  company_code: string | null;
  entity_key: string | null;
  published_at: string;
};

type CandidateResult = {
  id: string;
  status: "pending_judgement" | "duplicate";
  duplicateOf: string | null;
  eventGroupRepresentativeId?: string;
};

type StoredCompanyIrSource = {
  id: string;
  company_code: string;
  company_name: string;
  entity_key: string;
  feed_url: string;
  feed_format: "rss" | "json";
};

type StoredJudgementCandidate = {
  id: string;
  source_type: string;
  source_url: string;
  source_name: string;
  title: string;
  body_summary: string | null;
  company_name: string | null;
  company_code: string | null;
  entity_key: string | null;
  category: IncomingNewsCandidate["category"];
  published_at: string;
};

type JudgementSettings = {
  lunaEnabled: boolean;
  solEscalationEnabled: boolean;
};

type StoredGenerationCandidate = StoredJudgementCandidate & {
  importance: "important" | "most_important";
  affected_entities: unknown;
  japan_market_relevance: "none" | "low" | "medium" | "high";
  judgement_reason: string | null;
  fact_check_status: "passed" | "needs_review" | null;
  status: string;
};

type StoredPublishCandidate = {
  id: string;
  importance: string;
  status: string;
  generated_text: string | null;
  generation_fact_status: string | null;
  generation_voice_status: string | null;
  source_url: string | null;
  x_post_id: string | null;
  x_published_at: string | null;
  publish_attempts: number;
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function headers(serviceRoleKey: string, prefer?: string): Record<string, string> {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {}),
  };
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : "UNEXPECTED_ERROR";
  return /^[A-Z0-9_:-]+$/.test(value) ? value.slice(0, 160) : "UNEXPECTED_ERROR";
}

async function runUnpdfEdgeVerification(): Promise<Record<string, unknown>> {
  const startedAt = performance.now();
  let httpStatus: number | null = null;
  let contentType: string | null = null;
  let stage = "pdf_fetch";
  try {
    const pdfResponse = await fetch(UNPDF_EDGE_TEST_URL, {
      headers: { Accept: "application/pdf" },
      signal: AbortSignal.timeout(15_000),
    });
    httpStatus = pdfResponse.status;
    contentType = pdfResponse.headers.get("content-type");
    if (!pdfResponse.ok) throw new Error(`UNPDF_EDGE_PDF_FETCH_FAILED:${pdfResponse.status}`);
    stage = "pdf_download";
    const bytes = new Uint8Array(await pdfResponse.arrayBuffer());
    if (new TextDecoder("ascii").decode(bytes.slice(0, 5)) !== "%PDF-") {
      throw new Error("UNPDF_EDGE_INVALID_PDF");
    }
    stage = "module_import_initialization";
    const { extractText, getDocumentProxy } = await import("npm:unpdf@1.8.1");
    stage = "document_initialization";
    const document = await getDocumentProxy(bytes);
    try {
      stage = "text_extraction";
      const extracted = await extractText(document, { mergePages: true });
      const text = extracted.text.normalize("NFKC").replaceAll(/\s+/g, "");
      const checks = {
        "0株": text.includes("0株"),
        "0円": text.includes("0円"),
        "3,800,000株": text.includes("3,800,000株"),
        "10億円相当": text.includes("1,000,000,000円") || text.includes("10億円"),
        "3.3%": text.includes("3.3%"),
        "取得中止理由": text.includes("取得を中止") && text.includes("公開買付け"),
      };
      return {
        mode: "unpdf_edge_verification",
        success: Object.values(checks).every(Boolean),
        httpStatus,
        contentType,
        pdfParseSucceeded: true,
        pages: extracted.totalPages,
        extractedCharacters: text.length,
        checks,
        executionTimeMs: Math.round(performance.now() - startedAt),
        error: null,
      };
    } finally {
      const destroy = (document as unknown as {
        destroy?: () => void | Promise<void>;
      }).destroy;
      if (typeof destroy === "function") await destroy.call(document);
    }
  } catch (error) {
    const redact = (value: string) => value
      .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
      .replace(/\beyJ[A-Za-z0-9._-]+/gu, "[REDACTED_JWT]")
      .replace(/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+/gu, "[REDACTED_KEY]");
    const errorName = error instanceof Error ? redact(error.name).slice(0, 120) : typeof error;
    const errorMessage = error instanceof Error
      ? redact(error.message).slice(0, 1000)
      : "Non-Error value thrown";
    const stackHead = error instanceof Error && error.stack
      ? redact(error.stack).split("\n").slice(0, 6)
      : [];
    return {
      mode: "unpdf_edge_verification",
      success: false,
      httpStatus,
      contentType,
      pdfParseSucceeded: false,
      extractedCharacters: 0,
      checks: null,
      executionTimeMs: Math.round(performance.now() - startedAt),
      error: safeError(error),
      failureStage: stage,
      errorName,
      errorMessage,
      stackHead,
    };
  }
}

function parseIncoming(value: unknown): IncomingNewsCandidate {
  if (typeof value !== "object" || value === null) throw new Error("INVALID_CANDIDATE");
  const item = value as Record<string, unknown>;
  const sourceName = typeof item.sourceName === "string" ? item.sourceName.trim().toLowerCase() : "";
  const policy = SOURCE_POLICY[sourceName];
  if (!policy || item.sourceType !== policy.type) throw new Error("UNSUPPORTED_SOURCE");
  if (typeof item.sourceUrl !== "string" || typeof item.title !== "string" || !item.title.trim()) {
    throw new Error("INVALID_CANDIDATE");
  }
  let sourceHost = "";
  try { sourceHost = new URL(item.sourceUrl).hostname.toLowerCase(); }
  catch { throw new Error("INVALID_SOURCE_URL"); }
  const matchesDomain = (domain: string) => sourceHost === domain || sourceHost.endsWith(`.${domain}`);
  if (BLOCKED_SOURCE_DOMAINS.some(matchesDomain) ||
    (policy.domains && !policy.domains.some(matchesDomain))) throw new Error("UNSUPPORTED_SOURCE");
  if (!isImportantNewsCategory(item.category)) throw new Error("INVALID_NEWS_CATEGORY");
  if (typeof item.publishedAt !== "string" || !Number.isFinite(Date.parse(item.publishedAt))) {
    throw new Error("INVALID_PUBLISHED_AT");
  }
  return {
    sourceType: policy.type,
    sourceUrl: item.sourceUrl,
    sourceName,
    title: item.title.trim(),
    bodySummary: typeof item.bodySummary === "string" ? item.bodySummary.trim() || null : null,
    companyName: typeof item.companyName === "string" ? item.companyName.trim() || null : null,
    companyCode: typeof item.companyCode === "string" ? item.companyCode.trim() || null : null,
    entityKey: typeof item.entityKey === "string" ? item.entityKey.trim().toLowerCase() || null : null,
    category: item.category,
    publishedAt: new Date(item.publishedAt).toISOString(),
  };
}

function comparable(row: StoredCandidate): DuplicateComparable {
  return {
    id: row.id,
    sourceUrl: row.source_url,
    normalizedTitle: row.normalized_title,
    contentHash: row.content_hash,
    companyCode: row.company_code,
    entityKey: row.entity_key,
    publishedAt: row.published_at,
  };
}

async function selectCandidates(
  supabaseUrl: string,
  serviceRoleKey: string,
  filters: Record<string, string | string[]>,
): Promise<StoredCandidate[]> {
  const params = new URLSearchParams({
    select: "id,source_url,normalized_title,content_hash,company_code,entity_key,published_at",
    limit: "20",
  });
  for (const [key, value] of Object.entries(filters)) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
  }
  const result = await fetch(`${supabaseUrl}/rest/v1/important_news_candidates?${params}`, {
    headers: headers(serviceRoleKey),
  });
  if (!result.ok) throw new Error("NEWS_CANDIDATE_LOOKUP_FAILED");
  return await result.json() as StoredCandidate[];
}

async function findStoredDuplicate(
  supabaseUrl: string,
  serviceRoleKey: string,
  candidate: PreparedNewsCandidate,
): Promise<DuplicateComparable | null> {
  const byHash = await selectCandidates(supabaseUrl, serviceRoleKey, {
    content_hash: `eq.${candidate.contentHash}`,
  });
  if (byHash[0]) return comparable(byHash[0]);
  const byUrl = await selectCandidates(supabaseUrl, serviceRoleKey, {
    source_url: `eq.${candidate.sourceUrl}`,
  });
  if (byUrl[0]) return comparable(byUrl[0]);

  const published = Date.parse(candidate.publishedAt);
  const nearby = await selectCandidates(supabaseUrl, serviceRoleKey, {
    normalized_title: `eq.${candidate.normalizedTitle}`,
    published_at: [
      `gte.${new Date(published - 24 * 60 * 60 * 1000).toISOString()}`,
      `lte.${new Date(published + 24 * 60 * 60 * 1000).toISOString()}`,
    ],
  });
  return findNewsDuplicate(candidate, nearby.map(comparable));
}

async function insertCandidate(
  supabaseUrl: string,
  serviceRoleKey: string,
  candidate: PreparedNewsCandidate,
  duplicateOf: string | null,
): Promise<CandidateResult> {
  const policy = SOURCE_POLICY[candidate.sourceName];
  const status = candidateStatusForDuplicate(duplicateOf);
  const result = await fetch(`${supabaseUrl}/rest/v1/important_news_candidates`, {
    method: "POST",
    headers: headers(serviceRoleKey, "return=representation"),
    body: JSON.stringify({
      source_type: candidate.sourceType,
      source_priority: policy.priority,
      source_url: candidate.sourceUrl,
      source_name: candidate.sourceName,
      title: candidate.title,
      normalized_title: candidate.normalizedTitle,
      body_summary: candidate.bodySummary || null,
      company_name: candidate.companyName || null,
      company_code: candidate.companyCode || null,
      entity_key: candidate.entityKey || null,
      category: candidate.category,
      published_at: candidate.publishedAt,
      content_hash: candidate.contentHash,
      importance: "no_post",
      status,
      duplicate_of: duplicateOf,
    }),
  });
  if (result.status === 409) {
    const raced = await findStoredDuplicate(supabaseUrl, serviceRoleKey, candidate);
    if (raced) return { id: raced.id, status: "duplicate", duplicateOf: raced.id };
    throw new Error("NEWS_CANDIDATE_CONFLICT");
  }
  if (!result.ok) throw new Error("NEWS_CANDIDATE_INSERT_FAILED");
  const rows = await result.json() as Array<{ id?: unknown }>;
  if (typeof rows[0]?.id !== "string") throw new Error("NEWS_CANDIDATE_INSERT_INVALID");
  return { id: rows[0].id, status, duplicateOf };
}

async function createRun(
  supabaseUrl: string,
  serviceRoleKey: string,
  triggerType: "manual" | "scheduled",
  fetchedCount: number,
  status = "running",
): Promise<string> {
  const result = await fetch(`${supabaseUrl}/rest/v1/important_news_monitor_runs`, {
    method: "POST",
    headers: headers(serviceRoleKey, "return=representation"),
    body: JSON.stringify({
      trigger_type: triggerType,
      fetched_count: fetchedCount,
      status,
      completed_at: status === "skipped_inactive" ? new Date().toISOString() : null,
    }),
  });
  if (!result.ok) throw new Error("NEWS_MONITOR_RUN_CREATE_FAILED");
  const rows = await result.json() as Array<{ id?: unknown }>;
  if (typeof rows[0]?.id !== "string") throw new Error("NEWS_MONITOR_RUN_INVALID");
  return rows[0].id;
}

async function updateRun(
  supabaseUrl: string,
  serviceRoleKey: string,
  runId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const result = await fetch(`${supabaseUrl}/rest/v1/important_news_monitor_runs?id=eq.${encodeURIComponent(runId)}`, {
    method: "PATCH",
    headers: headers(serviceRoleKey, "return=minimal"),
    body: JSON.stringify(values),
  });
  if (!result.ok) throw new Error("NEWS_MONITOR_RUN_UPDATE_FAILED");
}

async function monitorIsActive(supabaseUrl: string, serviceRoleKey: string): Promise<boolean> {
  const result = await fetch(
    `${supabaseUrl}/rest/v1/important_news_monitor_settings?id=eq.true&select=is_active`,
    { headers: headers(serviceRoleKey) },
  );
  if (!result.ok) throw new Error("NEWS_MONITOR_SETTINGS_FAILED");
  const rows = await result.json() as Array<{ is_active?: unknown }>;
  return rows[0]?.is_active === true;
}

async function autoPublishIsEnabled(supabaseUrl: string, serviceRoleKey: string): Promise<boolean> {
  const result = await fetch(
    `${supabaseUrl}/rest/v1/important_news_monitor_settings?id=eq.true&select=auto_publish`,
    { headers: headers(serviceRoleKey) },
  );
  if (!result.ok) throw new Error("NEWS_MONITOR_SETTINGS_FAILED");
  const rows = await result.json() as Array<{ auto_publish?: unknown }>;
  return rows[0]?.auto_publish === true;
}

async function selectCompanyIrSources(
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<CompanyIrSource[]> {
  const params = new URLSearchParams({
    select: "id,company_code,company_name,entity_key,feed_url,feed_format",
    is_active: "eq.true",
    order: "company_code.asc",
  });
  const result = await fetch(`${supabaseUrl}/rest/v1/important_news_company_ir_sources?${params}`, {
    headers: headers(serviceRoleKey),
  });
  if (!result.ok) throw new Error("COMPANY_IR_SOURCES_LOOKUP_FAILED");
  return (await result.json() as StoredCompanyIrSource[]).map((source) => ({
    id: source.id,
    companyCode: source.company_code,
    companyName: source.company_name,
    entityKey: source.entity_key,
    feedUrl: source.feed_url,
    feedFormat: source.feed_format,
  }));
}

async function markCompanyIrSourceFetched(
  supabaseUrl: string,
  serviceRoleKey: string,
  sourceId: string,
): Promise<void> {
  const result = await fetch(
    `${supabaseUrl}/rest/v1/important_news_company_ir_sources?id=eq.${encodeURIComponent(sourceId)}`,
    {
      method: "PATCH",
      headers: headers(serviceRoleKey, "return=minimal"),
      body: JSON.stringify({ last_fetched_at: new Date().toISOString() }),
    },
  );
  if (!result.ok) throw new Error("COMPANY_IR_SOURCE_UPDATE_FAILED");
}

function toJudgementCandidate(row: StoredJudgementCandidate): JudgementCandidate {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceUrl: row.source_url,
    sourceName: row.source_name,
    title: row.title,
    bodySummary: row.body_summary,
    companyName: row.company_name,
    companyCode: row.company_code,
    entityKey: row.entity_key,
    category: row.category,
    publishedAt: row.published_at,
  };
}

function parseDryRunCandidate(value: unknown): JudgementCandidate {
  const parsed = parseIncoming(value);
  const item = value as Record<string, unknown>;
  return {
    id: typeof item.id === "string" ? item.id : null,
    sourceType: parsed.sourceType,
    sourceUrl: parsed.sourceUrl,
    sourceName: parsed.sourceName,
    title: parsed.title,
    bodySummary: parsed.bodySummary ?? null,
    companyName: parsed.companyName ?? null,
    companyCode: parsed.companyCode ?? null,
    entityKey: parsed.entityKey ?? null,
    category: parsed.category,
    publishedAt: parsed.publishedAt,
  };
}

async function selectJudgementSettings(
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<JudgementSettings> {
  const params = new URLSearchParams({
    id: "eq.true",
    select: "luna_enabled,sol_escalation_enabled",
    limit: "1",
  });
  const result = await fetch(`${supabaseUrl}/rest/v1/important_news_monitor_settings?${params}`, {
    headers: headers(serviceRoleKey),
  });
  if (!result.ok) throw new Error("NEWS_MONITOR_SETTINGS_FAILED");
  const rows = await result.json() as Array<{
    luna_enabled?: unknown;
    sol_escalation_enabled?: unknown;
  }>;
  return {
    lunaEnabled: rows[0]?.luna_enabled === true,
    solEscalationEnabled: rows[0]?.sol_escalation_enabled === true,
  };
}

async function selectCandidatesForJudgement(
  supabaseUrl: string,
  serviceRoleKey: string,
  options: { candidateId?: string; limit?: number },
): Promise<JudgementCandidate[]> {
  const params = new URLSearchParams({
    select: [
      "id", "source_type", "source_url", "source_name", "title", "body_summary",
      "company_name", "company_code", "entity_key", "category", "published_at",
    ].join(","),
    order: "source_priority.asc,published_at.asc",
    limit: String(options.candidateId ? 1 : options.limit ?? 10),
  });
  if (options.candidateId) params.set("id", `eq.${options.candidateId}`);
  else params.set("status", "eq.pending_judgement");
  const result = await fetch(`${supabaseUrl}/rest/v1/important_news_candidates?${params}`, {
    headers: headers(serviceRoleKey),
  });
  if (!result.ok) throw new Error("NEWS_JUDGEMENT_CANDIDATE_LOOKUP_FAILED");
  return (await result.json() as StoredJudgementCandidate[]).map(toJudgementCandidate);
}

async function saveCandidateJudgement(
  supabaseUrl: string,
  serviceRoleKey: string,
  candidateId: string,
  judgement: FinalJudgement,
): Promise<void> {
  const final = judgement.final;
  const params = new URLSearchParams({ id: `eq.${candidateId}`, status: "eq.pending_judgement" });
  const result = await fetch(`${supabaseUrl}/rest/v1/important_news_candidates?${params}`, {
    method: "PATCH",
    headers: headers(serviceRoleKey, "return=representation"),
    body: JSON.stringify({
      importance: final.importance,
      category: final.category,
      affected_entities: final.affectedEntities,
      japan_market_relevance: final.japanMarketRelevance,
      judgement_model: final.model,
      escalated_to_sol: judgement.escalatedToSol,
      confidence: final.confidence,
      judgement_reason: final.reason,
      fact_check_status: final.factCheckStatus,
      input_tokens: judgement.inputTokens,
      output_tokens: judgement.outputTokens,
      estimated_cost_usd: judgement.estimatedCost,
      judged_at: new Date().toISOString(),
      status: judgement.status,
    }),
  });
  if (!result.ok) throw new Error("NEWS_JUDGEMENT_SAVE_FAILED");
  const rows = await result.json() as unknown[];
  if (rows.length !== 1) throw new Error("NEWS_JUDGEMENT_CANDIDATE_CHANGED");
}

function judgementResponse(candidate: JudgementCandidate, judgement: FinalJudgement, dryRun: boolean) {
  return {
    candidate,
    luna: judgement.luna,
    solUsed: judgement.escalatedToSol,
    sol: judgement.sol,
    finalImportance: judgement.final.importance,
    confidence: judgement.final.confidence,
    reason: judgement.final.reason,
    factCheckStatus: judgement.final.factCheckStatus,
    status: judgement.status,
    inputTokens: judgement.inputTokens,
    outputTokens: judgement.outputTokens,
    estimatedCost: judgement.estimatedCost,
    databaseUpdated: !dryRun,
  };
}

function toGenerationCandidate(row: StoredGenerationCandidate): GenerationCandidate {
  return {
    ...toJudgementCandidate(row),
    importance: row.importance,
    affectedEntities: Array.isArray(row.affected_entities)
      ? row.affected_entities.filter((item): item is string => typeof item === "string")
      : [],
    japanMarketRelevance: row.japan_market_relevance,
    judgementReason: row.judgement_reason,
    judgementFactStatus: row.fact_check_status,
    status: row.status,
  };
}

async function selectCandidatesForGeneration(
  supabaseUrl: string,
  serviceRoleKey: string,
  options: { candidateId?: string; limit?: number },
): Promise<GenerationCandidate[]> {
  const params = new URLSearchParams({
    select: [
      "id", "source_type", "source_url", "source_name", "title", "body_summary",
      "company_name", "company_code", "entity_key", "category", "published_at",
      "importance", "affected_entities", "japan_market_relevance", "judgement_reason",
      "fact_check_status", "status",
    ].join(","),
    status: "eq.ready_for_generation",
    importance: "in.(important,most_important)",
    order: "importance.desc,published_at.asc",
    limit: String(options.candidateId ? 1 : options.limit ?? 10),
  });
  if (options.candidateId) params.set("id", `eq.${options.candidateId}`);
  const result = await fetch(`${supabaseUrl}/rest/v1/important_news_candidates?${params}`, {
    headers: headers(serviceRoleKey),
  });
  if (!result.ok) throw new Error("NEWS_GENERATION_CANDIDATE_LOOKUP_FAILED");
  return (await result.json() as StoredGenerationCandidate[]).map(toGenerationCandidate);
}

async function saveCandidateGeneration(
  supabaseUrl: string,
  serviceRoleKey: string,
  candidateId: string,
  generated: PostGenerationResult,
): Promise<void> {
  const params = new URLSearchParams({ id: `eq.${candidateId}`, status: "eq.ready_for_generation" });
  const result = await fetch(`${supabaseUrl}/rest/v1/important_news_candidates?${params}`, {
    method: "PATCH",
    headers: headers(serviceRoleKey, "return=representation"),
    body: JSON.stringify({
      generated_text: generated.generatedText,
      generation_model: generated.model,
      generation_input_tokens: generated.inputTokens,
      generation_output_tokens: generated.outputTokens,
      generation_estimated_cost_usd: generated.estimatedCost,
      generation_fact_status: generated.fact.status,
      generation_fact_issues: generated.fact.issues,
      generation_voice_status: generated.voice.status,
      generation_voice_issues: generated.voice.issues,
      generation_error: generated.stoppedReason,
      generated_at: new Date().toISOString(),
      status: generated.status,
    }),
  });
  if (!result.ok) throw new Error("NEWS_GENERATION_SAVE_FAILED");
  const rows = await result.json() as unknown[];
  if (rows.length !== 1) throw new Error("NEWS_GENERATION_CANDIDATE_CHANGED");
}

async function saveGenerationError(
  supabaseUrl: string,
  serviceRoleKey: string,
  candidateId: string,
  code: string,
): Promise<void> {
  const params = new URLSearchParams({ id: `eq.${candidateId}`, status: "eq.ready_for_generation" });
  const result = await fetch(`${supabaseUrl}/rest/v1/important_news_candidates?${params}`, {
    method: "PATCH",
    headers: headers(serviceRoleKey, "return=minimal"),
    body: JSON.stringify({
      generation_model: "gpt-5.6-luna",
      generation_fact_status: "not_run",
      generation_voice_status: "not_run",
      generation_error: code,
      generated_at: new Date().toISOString(),
      status: "generation_failed",
    }),
  });
  if (!result.ok) throw new Error("NEWS_GENERATION_SAVE_FAILED");
}

function generationResponse(
  candidate: GenerationCandidate,
  generated: PostGenerationResult,
  dryRun: boolean,
) {
  return {
    candidate,
    importance: candidate.importance,
    generatedText: generated.generatedText,
    sourceUrl: generated.sourceUrl,
    fact: generated.fact,
    voice: generated.voice,
    model: generated.model,
    inputTokens: generated.inputTokens,
    outputTokens: generated.outputTokens,
    estimatedCost: generated.estimatedCost,
    status: generated.status,
    stoppedReason: generated.stoppedReason,
    databaseUpdated: !dryRun,
  };
}

function toPublishCandidate(row: StoredPublishCandidate): PublishCandidate {
  return {
    id: row.id,
    importance: row.importance,
    status: row.status,
    generatedText: row.generated_text,
    generationFactStatus: row.generation_fact_status,
    generationVoiceStatus: row.generation_voice_status,
    sourceUrl: row.source_url,
    xPostId: row.x_post_id,
    publishedAt: row.x_published_at,
    publishAttempts: row.publish_attempts,
  };
}

const PUBLISH_SELECT = [
  "id", "importance", "status", "generated_text", "generation_fact_status",
  "generation_voice_status", "source_url", "x_post_id", "x_published_at", "publish_attempts",
].join(",");

async function selectPublishCandidate(
  supabaseUrl: string,
  serviceRoleKey: string,
  candidateId: string,
): Promise<PublishCandidate | null> {
  const params = new URLSearchParams({ select: PUBLISH_SELECT, id: `eq.${candidateId}`, limit: "1" });
  const result = await fetch(`${supabaseUrl}/rest/v1/important_news_candidates?${params}`, {
    headers: headers(serviceRoleKey),
  });
  if (!result.ok) throw new Error("NEWS_PUBLISH_CANDIDATE_LOOKUP_FAILED");
  const rows = await result.json() as StoredPublishCandidate[];
  return rows[0] ? toPublishCandidate(rows[0]) : null;
}

async function selectNextPublishCandidateId(
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<string | null> {
  const params = new URLSearchParams({
    select: "id,importance,generated_at",
    status: "eq.ready_for_publish",
    importance: "in.(important,most_important)",
    generated_text: "not.is.null",
    generation_fact_status: "eq.passed",
    generation_voice_status: "eq.passed",
    source_url: "not.is.null",
    x_post_id: "is.null",
    x_published_at: "is.null",
    limit: "100",
  });
  const result = await fetch(`${supabaseUrl}/rest/v1/important_news_candidates?${params}`, {
    headers: headers(serviceRoleKey),
  });
  if (!result.ok) throw new Error("NEWS_PUBLISH_CANDIDATE_LOOKUP_FAILED");
  const rows = await result.json() as Array<{
    id?: unknown;
    importance?: unknown;
    generated_at?: unknown;
  }>;
  const candidates = rows.filter((row): row is { id: string; importance: string; generated_at: string | null } =>
    typeof row.id === "string" && typeof row.importance === "string" &&
    (typeof row.generated_at === "string" || row.generated_at === null)
  ).map((row) => ({ id: row.id, importance: row.importance, generatedAt: row.generated_at }));
  return orderImportantNewsPublishQueue(candidates)[0]?.id ?? null;
}

async function selectLatestImportantNewsPublishedAt(
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<string | null> {
  const params = new URLSearchParams({
    select: "x_published_at",
    status: "eq.published",
    x_published_at: "not.is.null",
    order: "x_published_at.desc",
    limit: "1",
  });
  const result = await fetch(`${supabaseUrl}/rest/v1/important_news_candidates?${params}`, {
    headers: headers(serviceRoleKey),
  });
  if (!result.ok) throw new Error("NEWS_RATE_CONTROL_LOOKUP_FAILED");
  const rows = await result.json() as Array<{ x_published_at?: unknown }>;
  return typeof rows[0]?.x_published_at === "string" ? rows[0].x_published_at : null;
}

async function insertImportantNewsPublishLog(
  supabaseUrl: string,
  serviceRoleKey: string,
  candidateId: string,
  status: "started" | "succeeded" | "failed",
  values: { xPostId?: string | null; httpStatus?: number | null; message: string },
): Promise<void> {
  const result = await fetch(`${supabaseUrl}/rest/v1/post_execution_logs`, {
    method: "POST",
    headers: headers(serviceRoleKey, "return=minimal"),
    body: JSON.stringify({
      post_type: "important_news",
      status,
      important_news_candidate_id: candidateId,
      x_post_id: values.xPostId ?? null,
      http_status: values.httpStatus ?? null,
      message: values.message.slice(0, 1000),
    }),
  });
  if (!result.ok) throw new Error("NEWS_PUBLISH_LOG_FAILED");
}

function createPublishRepository(
  supabaseUrl: string,
  serviceRoleKey: string,
): PublishRepository {
  return {
    read: (candidateId) => selectPublishCandidate(supabaseUrl, serviceRoleKey, candidateId),
    latestPublishedAt: () => selectLatestImportantNewsPublishedAt(supabaseUrl, serviceRoleKey),
    async claim(candidateId) {
      const current = await selectPublishCandidate(supabaseUrl, serviceRoleKey, candidateId);
      if (!current) return null;
      const params = new URLSearchParams({
        id: `eq.${candidateId}`,
        status: "eq.ready_for_publish",
        importance: "in.(important,most_important)",
        generated_text: "not.is.null",
        generation_fact_status: "eq.passed",
        generation_voice_status: "eq.passed",
        source_url: "not.is.null",
        x_post_id: "is.null",
        x_published_at: "is.null",
      });
      const result = await fetch(`${supabaseUrl}/rest/v1/important_news_candidates?${params}`, {
        method: "PATCH",
        headers: headers(serviceRoleKey, "return=representation"),
        body: JSON.stringify({
          status: "publishing",
          publish_attempts: current.publishAttempts + 1,
          publish_error: null,
          last_publish_http_status: null,
        }),
      });
      if (!result.ok) throw new Error("NEWS_PUBLISH_CLAIM_FAILED");
      const rows = await result.json() as StoredPublishCandidate[];
      if (!rows[0]) return null;
      await insertImportantNewsPublishLog(supabaseUrl, serviceRoleKey, candidateId, "started", {
        message: "Important news X publication started",
      });
      return toPublishCandidate(rows[0]);
    },
    async markPublished(candidateId, xPostId, httpStatus) {
      const params = new URLSearchParams({
        id: `eq.${candidateId}`,
        status: "eq.publishing",
        x_post_id: "is.null",
      });
      const result = await fetch(`${supabaseUrl}/rest/v1/important_news_candidates?${params}`, {
        method: "PATCH",
        headers: headers(serviceRoleKey, "return=representation"),
        body: JSON.stringify({
          status: "published",
          x_post_id: xPostId,
          x_published_at: new Date().toISOString(),
          last_publish_http_status: httpStatus,
          publish_error: null,
        }),
      });
      if (!result.ok) throw new Error("NEWS_PUBLISH_FINALIZE_FAILED");
      const rows = await result.json() as unknown[];
      if (rows.length !== 1) throw new Error("NEWS_PUBLISH_CANDIDATE_CHANGED");
      await insertImportantNewsPublishLog(supabaseUrl, serviceRoleKey, candidateId, "succeeded", {
        xPostId, httpStatus, message: "Important news X post created",
      });
    },
    async markFailed(candidateId, errorCode, httpStatus) {
      const params = new URLSearchParams({ id: `eq.${candidateId}`, status: "eq.publishing" });
      const result = await fetch(`${supabaseUrl}/rest/v1/important_news_candidates?${params}`, {
        method: "PATCH",
        headers: headers(serviceRoleKey, "return=minimal"),
        body: JSON.stringify({
          status: "publish_failed",
          publish_error: errorCode.slice(0, 1000),
          last_publish_http_status: httpStatus,
        }),
      });
      if (!result.ok) throw new Error("NEWS_PUBLISH_FAILURE_SAVE_FAILED");
      await insertImportantNewsPublishLog(supabaseUrl, serviceRoleKey, candidateId, "failed", {
        httpStatus, message: errorCode,
      });
    },
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return response({ error: "POST_REQUIRED" }, 405);
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return response({ error: "SERVER_CONFIGURATION_MISSING" }, 500);

  let runId: string | null = null;
  try {
    const body = await req.json() as {
      mode?: unknown;
      trigger?: unknown;
      candidates?: unknown;
      fetchSources?: unknown;
      tdnetDate?: unknown;
      candidate?: unknown;
      candidateId?: unknown;
      limit?: unknown;
    };
    if (body.mode === "unpdf_edge_verification") {
      const result = await runUnpdfEdgeVerification();
      return response(result, result.success === true ? 200 : 500);
    }
    if (body.mode === "publish_dry_run" || body.mode === "publish_ready") {
      const dryRun = body.mode === "publish_dry_run";
      if (dryRun && typeof body.candidateId !== "string") {
        return response({ error: "PUBLISH_DRY_RUN_CANDIDATE_ID_REQUIRED" }, 400);
      }
      if (dryRun) {
        const candidateId = body.candidateId as string;
        const repository = createPublishRepository(supabaseUrl, serviceRoleKey);
        const result = await publishImportantNewsCandidate(
          candidateId,
          true,
          repository,
          async () => { throw new Error("DRY_RUN_X_CALL_FORBIDDEN"); },
        );
        return response({ mode: body.mode, ...result, autoPublish: false });
      }

      const autoPublishEnabled = await autoPublishIsEnabled(supabaseUrl, serviceRoleKey);
      const guarded = await executeWhenAutoPublishEnabled(autoPublishEnabled, async () => {
        const candidateId = typeof body.candidateId === "string"
          ? body.candidateId
          : await selectNextPublishCandidateId(supabaseUrl, serviceRoleKey);
        if (!candidateId) {
          return { mode: body.mode, published: false, wouldPublish: false, blockReason: "NO_READY_CANDIDATE" };
        }
        const repository = createPublishRepository(supabaseUrl, serviceRoleKey);
        const xAccessToken = Deno.env.get("X_OAUTH2_ACCESS_TOKEN");
        const xRefreshToken = Deno.env.get("X_OAUTH2_REFRESH_TOKEN");
        const xClientId = Deno.env.get("X_CLIENT_ID");
        const xClientSecret = Deno.env.get("X_CLIENT_SECRET");
        if (!xAccessToken || !xRefreshToken || !xClientId || !xClientSecret) {
          return { error: "X_OAUTH_CONFIGURATION_MISSING" };
        }
        const xAuth: XAuthContext = {
          tokens: await loadXTokens(
            supabaseUrl,
            serviceRoleKey,
            xClientSecret,
            xAccessToken,
            xRefreshToken,
          ),
          clientId: xClientId,
          clientSecret: xClientSecret,
          supabaseUrl,
          serviceRoleKey,
          refreshExecuted: false,
        };
        const result = await publishImportantNewsCandidate(
          candidateId,
          false,
          repository,
          async (text) => {
            const posted = await postToXWithRefresh(xAuth, text);
            return {
              id: posted.id,
              httpStatus: posted.httpStatus,
              refreshExecuted: posted.refreshExecuted,
            };
          },
        );
        return { mode: body.mode, ...result, autoPublish: true };
      });
      if (!guarded.executed) {
        return response({
          mode: body.mode,
          candidateId: typeof body.candidateId === "string" ? body.candidateId : null,
          published: false,
          wouldPublish: false,
          skipped: true,
          blockReason: guarded.blockReason,
          autoPublish: false,
        });
      }
      if ("error" in guarded.result) return response(guarded.result, 500);
      return response(guarded.result);
    }
    if (body.mode === "generation_dry_run" || body.mode === "generate_ready") {
      const openAiApiKey = Deno.env.get("OPENAI_API_KEY");
      if (!openAiApiKey) return response({ error: "OPENAI_API_KEY_MISSING" }, 500);
      const dryRun = body.mode === "generation_dry_run";
      if (dryRun && typeof body.candidateId !== "string") {
        return response({ error: "GENERATION_DRY_RUN_CANDIDATE_ID_REQUIRED" }, 400);
      }
      const requestedLimit = typeof body.limit === "number" && Number.isInteger(body.limit)
        ? body.limit
        : 10;
      if (!dryRun && (requestedLimit < 1 || requestedLimit > 20)) {
        return response({ error: "INVALID_GENERATION_LIMIT" }, 400);
      }
      const generationCandidates = await selectCandidatesForGeneration(supabaseUrl, serviceRoleKey, {
        candidateId: dryRun ? body.candidateId as string : undefined,
        limit: requestedLimit,
      });
      if (generationCandidates.length === 0) {
        return response({ mode: body.mode, processed: 0, databaseUpdated: false, results: [] });
      }
      const generationResults: unknown[] = [];
      for (const candidate of generationCandidates) {
        try {
          const generated = await generateImportantNewsPost(
            candidate,
            (step, item, text) => requestGenerationStep(openAiApiKey, step, item, text),
          );
          if (!dryRun) {
            if (!candidate.id) throw new Error("NEWS_GENERATION_CANDIDATE_ID_MISSING");
            await saveCandidateGeneration(supabaseUrl, serviceRoleKey, candidate.id, generated);
          }
          generationResults.push(generationResponse(candidate, generated, dryRun));
        } catch (error) {
          const code = safeError(error);
          if (!dryRun && candidate.id) {
            try { await saveGenerationError(supabaseUrl, serviceRoleKey, candidate.id, code); }
            catch { console.error("Failed to save important news generation error"); }
          }
          generationResults.push({ candidateId: candidate.id, error: code, databaseUpdated: false });
        }
      }
      return response({
        mode: body.mode,
        processed: generationResults.length,
        databaseUpdated: !dryRun,
        results: generationResults,
        autoPublish: false,
      });
    }
    if (body.mode === "judgement_dry_run" || body.mode === "judge_pending") {
      const openAiApiKey = Deno.env.get("OPENAI_API_KEY");
      if (!openAiApiKey) return response({ error: "OPENAI_API_KEY_MISSING" }, 500);
      const settings = await selectJudgementSettings(supabaseUrl, serviceRoleKey);
      if (!settings.lunaEnabled) return response({ error: "NEWS_JUDGEMENT_DISABLED" }, 409);
      const dryRun = body.mode === "judgement_dry_run";
      let judgementCandidates: JudgementCandidate[];
      if (dryRun && body.candidate !== undefined) {
        judgementCandidates = [parseDryRunCandidate(body.candidate)];
      } else if (dryRun && typeof body.candidateId === "string") {
        judgementCandidates = await selectCandidatesForJudgement(supabaseUrl, serviceRoleKey, {
          candidateId: body.candidateId,
        });
      } else if (dryRun) {
        return response({ error: "JUDGEMENT_DRY_RUN_CANDIDATE_REQUIRED" }, 400);
      } else {
        const requestedLimit = typeof body.limit === "number" && Number.isInteger(body.limit)
          ? body.limit
          : 10;
        if (requestedLimit < 1 || requestedLimit > 20) {
          return response({ error: "INVALID_JUDGEMENT_LIMIT" }, 400);
        }
        judgementCandidates = await selectCandidatesForJudgement(supabaseUrl, serviceRoleKey, {
          limit: requestedLimit,
        });
      }
      if (judgementCandidates.length === 0) {
        return response({ mode: body.mode, processed: 0, databaseUpdated: false, results: [] });
      }
      const judgementResults: unknown[] = [];
      for (const candidate of judgementCandidates) {
        try {
          const judgement = await judgeCandidateWithEscalation(
            candidate,
            { solEscalationEnabled: settings.solEscalationEnabled },
            (item, model, priorLuna) =>
              requestImportantNewsJudgement(openAiApiKey, item, model, priorLuna),
          );
          if (!dryRun) {
            if (!candidate.id) throw new Error("NEWS_JUDGEMENT_CANDIDATE_ID_MISSING");
            await saveCandidateJudgement(supabaseUrl, serviceRoleKey, candidate.id, judgement);
          }
          judgementResults.push(judgementResponse(candidate, judgement, dryRun));
        } catch (error) {
          const code = safeError(error);
          judgementResults.push({ candidateId: candidate.id ?? null, error: code, databaseUpdated: false });
        }
      }
      return response({
        mode: body.mode,
        processed: judgementResults.length,
        databaseUpdated: !dryRun,
        results: judgementResults,
        autoPublish: false,
      });
    }
    const triggerType = body.trigger === "scheduled" ? "scheduled" : "manual";
    const suppliedCandidates = body.candidates === undefined ? [] : body.candidates;
    if (!Array.isArray(suppliedCandidates) || suppliedCandidates.length > MAX_CANDIDATES_PER_REQUEST ||
      (body.fetchSources !== true && body.candidates === undefined)) {
      return response({ error: "INVALID_CANDIDATE_BATCH" }, 400);
    }
    if (triggerType === "scheduled" && !await monitorIsActive(supabaseUrl, serviceRoleKey)) {
      runId = await createRun(supabaseUrl, serviceRoleKey, triggerType, 0, "skipped_inactive");
      return response({ runId, status: "skipped_inactive", autoPublish: false });
    }

    const sourceErrors: string[] = [];
    const runStart = await runAfterBestEffortStaleRunReconciliation(
      () => reconcileStaleImportantNewsRuns({ supabaseUrl, serviceRoleKey }),
      () => createRun(supabaseUrl, serviceRoleKey, triggerType, 0),
    );
    runId = runStart.value;
    if (runStart.reconciliation.error) {
      sourceErrors.push(`run_reconciliation:${runStart.reconciliation.error}`);
      console.error("Important news stale run reconciliation failed", {
        code: runStart.reconciliation.error,
      });
    }
    const acquiredCandidates: IncomingNewsCandidate[] = [];
    if (body.fetchSources === true) {
      const tdnetDate = typeof body.tdnetDate === "string" ? body.tdnetDate : undefined;
      let companySources: CompanyIrSource[] = [];
      try { companySources = await selectCompanyIrSources(supabaseUrl, serviceRoleKey); }
      catch { sourceErrors.push("company_ir:COMPANY_IR_SOURCES_LOOKUP_FAILED"); }
      const providers: NewsSourceProvider[] = [
        { key: "tdnet", fetchCandidates: () => fetchTdnetCandidates({ date: tdnetDate }) },
        ...companySources.map((source) => ({
          key: `company_ir:${source.id}`,
          fetchCandidates: () => fetchCompanyIrSource(source),
        })),
      ];
      const collected = await runNewsSourceProviders(providers);
      acquiredCandidates.push(...collected.candidates);
      sourceErrors.push(...collected.errors);
      for (const key of collected.succeededSources) {
        if (key.startsWith("company_ir:")) {
          try {
            await markCompanyIrSourceFetched(supabaseUrl, serviceRoleKey, key.slice("company_ir:".length));
          } catch { sourceErrors.push(`${key}:COMPANY_IR_SOURCE_UPDATE_FAILED`); }
        }
      }
    }
    const allCandidates: unknown[] = [...suppliedCandidates, ...acquiredCandidates];
    const candidateBatch = planImportantNewsCandidateBatch(allCandidates, MAX_CANDIDATES_PER_REQUEST);
    let duplicateCount = 0;
    let newCandidateCount = 0;
    let groupedCandidateCount = 0;
    const results: CandidateResult[] = [];
    const lightweightCandidates: PreparedNewsCandidate[] = [];
    const candidateWork = new Map<PreparedNewsCandidate, {
      candidate: IncomingNewsCandidate;
      duplicate: DuplicateComparable | null;
    }>();
    for (const value of candidateBatch.selectedCandidates) {
      const candidate = parseIncoming(value);
      const prepared = await prepareNewsCandidate(candidate);
      const duplicate = await findStoredDuplicate(supabaseUrl, serviceRoleKey, prepared);
      if (duplicate && (duplicate.contentHash === prepared.contentHash || duplicate.sourceUrl === prepared.sourceUrl)) {
        duplicateCount += 1;
        results.push({ id: duplicate.id, status: "duplicate", duplicateOf: duplicate.id });
        continue;
      }
      lightweightCandidates.push(prepared);
      candidateWork.set(prepared, { candidate, duplicate });
    }

    const fetchPlan = planImportantNewsFetchGroups(groupImportantNewsCandidates(lightweightCandidates));
    const groupedResults: Array<{
      representativeId: string;
      eventFamily: string;
      memberCount: number;
      sourceUrls: string[];
    }> = [];
    for (const lightweightGroup of fetchPlan.selectedGroups) {
      const members: PreparedNewsCandidate[] = [];
      for (const lightweight of lightweightGroup.members) {
        const work = candidateWork.get(lightweight);
        if (!work) throw new Error("IMPORTANT_NEWS_FETCH_PLAN_INVALID");
        let candidate = work.candidate;
        let prepared = lightweight;
        let duplicate = work.duplicate;
        if (candidate.sourceType === "tdnet" && !candidate.bodySummary) {
          const enrichment = await enrichTdnetCandidatesWithPdfSummaries([candidate]);
          candidate = enrichment.candidates[0];
          sourceErrors.push(...enrichment.errors.map((error) => `tdnet_pdf:${error}`));
          prepared = await prepareNewsCandidate(candidate);
          duplicate = await findStoredDuplicate(supabaseUrl, serviceRoleKey, prepared);
          if (duplicate && (duplicate.contentHash === prepared.contentHash || duplicate.sourceUrl === prepared.sourceUrl)) {
            duplicateCount += 1;
            results.push({ id: duplicate.id, status: "duplicate", duplicateOf: duplicate.id });
            continue;
          }
        }
        if (duplicate) {
          const saved = await insertCandidate(supabaseUrl, serviceRoleKey, prepared, duplicate.id);
          results.push(saved);
          duplicateCount += 1;
          continue;
        }
        members.push(prepared);
      }
      if (members.length === 0) continue;
      const group: ImportantNewsCandidateGroup = {
        ...lightweightGroup,
        anchorPublishedAt: members[0].publishedAt,
        members,
      };
      const aggregate = await aggregateImportantNewsGroup(group);
      const representative = await insertCandidate(supabaseUrl, serviceRoleKey, aggregate, null);
      results.push(representative);
      if (representative.status === "duplicate") duplicateCount += 1;
      else newCandidateCount += 1;

      for (const member of group.members.slice(1)) {
        const saved = await insertCandidate(supabaseUrl, serviceRoleKey, member, representative.id);
        results.push({ ...saved, eventGroupRepresentativeId: representative.id });
        groupedCandidateCount += 1;
      }
      groupedResults.push({
        representativeId: representative.id,
        eventFamily: group.eventFamily,
        memberCount: group.members.length,
        sourceUrls: group.members.map((member) => member.sourceUrl),
      });
    }
    await updateRun(supabaseUrl, serviceRoleKey, runId, {
      status: "completed",
      fetched_count: allCandidates.length,
      duplicate_count: duplicateCount,
      new_candidate_count: newCandidateCount,
      completed_at: new Date().toISOString(),
      error: sourceErrors.length ? sourceErrors.join(" | ").slice(0, 2000) : null,
    });
    return response({
      runId, status: "completed", fetchedCount: allCandidates.length,
      duplicateCount, newCandidateCount, groupedCandidateCount, eventGroups: groupedResults,
      processedGroupCount: fetchPlan.selectedGroups.length,
      processedCandidateCount: fetchPlan.selectedCandidateCount,
      processedPdfCount: fetchPlan.selectedPdfCount,
      deferredGroupCount: fetchPlan.deferredGroups.length,
      deferredCandidateCount: fetchPlan.deferredCandidateCount,
      candidateBatchDiagnostics: {
        fetchedCandidateCount: candidateBatch.fetchedCandidateCount,
        lightweightProcessedCount: candidateBatch.lightweightProcessedCount,
        deferredCandidateCount: candidateBatch.deferredCandidateCount,
      },
      staleRunsReconciled: runStart.reconciliation.reconciledCount,
      staleRunReconciliationError: runStart.reconciliation.error,
      sourceErrors, autoPublish: false, results,
    });
  } catch (error) {
    const code = safeError(error);
    if (runId) {
      try {
        await updateRun(supabaseUrl, serviceRoleKey, runId, {
          status: "failed", error: code, completed_at: new Date().toISOString(),
        });
      } catch { console.error("Failed to update important news monitor run"); }
    }
    console.error("Important news monitor failed", { code });
    return response({ error: code }, 500);
  }
});
