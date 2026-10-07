// Shared market analysis producer (Phase 2). One Fact-passed
// market_report_packet.v1 per market_report_cycle.
//
// Reads: market_holidays, the cycle's completed market_data_packet, and
// Fact-passed Japanese text of the news ids that packet references.
// Calls OpenAI (generation + Fact check, at most two generations).
// Writes only through claim/complete/fail_market_report_analysis.
// Never calls X, push, x-test-post, personalized-reports or
// important-news-monitor. X and the app read the result through
// get_shared_market_report only when their consumer gate is on.
//
// Auth: verify_jwt = false + X-Cron-Secret (existing
// SEND_PUSH_NOTIFICATIONS_CRON_SECRET, same as the other report functions).

import type { MarketDataPacket } from "../market-report-data-packet/packet_schema.ts";
import { decideRunWindow, type ReportType } from "../market-report-data-packet/session_logic.ts";
import { buildAnalysisInput, type NewsTextRow } from "./analysis_input.ts";
import {
  ANALYSIS_MODEL,
  type GenerationRecord,
  generateSharedAnalysis,
  generationDiagnostics,
  generationRequestBody,
  type Requester,
  reportContentHash,
} from "./analysis_logic.ts";
import { persistTraces, promptHash, traceRows } from "./debug_trace.ts";
import {
  fetchWithTransportRetry,
  newTransportStats,
  realSleep,
  type Sleep,
  transportDiagnostics,
  type TransportRetryPolicy,
  type TransportStats,
} from "./transport_retry.ts";

export type Deps = {
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
  now: () => Date;
  // Injectable for tests; production waits for real.
  sleep?: Sleep;
};

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENAI_TIMEOUT_MS = 90_000;

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function safeCode(error: unknown): string {
  const value = error instanceof Error ? error.message : "UNEXPECTED_ERROR";
  return /^[A-Za-z0-9_:.-]+$/.test(value) ? value.slice(0, 120) : "UNEXPECTED_ERROR";
}

function secretKey(env: Deps["env"]): string | null {
  const raw = env("SUPABASE_SECRET_KEYS");
  if (!raw) return null;
  try {
    const value = (JSON.parse(raw) as Record<string, unknown>)["default"];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function extractOutputText(response: unknown): string | null {
  const output = (response as { output?: unknown })?.output;
  if (!Array.isArray(output)) return null;
  const text = output.flatMap((item) => {
    const content = (item as { content?: unknown })?.content;
    return Array.isArray(content) ? content : [];
  }).filter((item) =>
    (item as { type?: unknown })?.type === "output_text" && typeof (item as { text?: unknown }).text === "string"
  ).map((item) => (item as { text: string }).text).join("").trim();
  return text || null;
}

export function openAiRequester(
  apiKey: string,
  fetchImpl: typeof fetch,
  retry: { stats: TransportStats; sleep?: Sleep; policy?: TransportRetryPolicy } = { stats: newTransportStats() },
): Requester {
  return async (step, body) => {
    // Only the HTTP request is retried (429 / 5xx / network); a non-OK final response keeps its existing code.
    const response = await fetchWithTransportRetry(() =>
      fetchImpl(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
        body: JSON.stringify(body),
      }), { stats: retry.stats, sleep: retry.sleep, policy: retry.policy });
    if (!response.ok) throw new Error(`ANALYSIS_OPENAI_${step.toUpperCase()}_FAILED:${response.status}`);
    const raw = await response.json();
    const output = extractOutputText(raw);
    if (!output) throw new Error(`ANALYSIS_OPENAI_${step.toUpperCase()}_EMPTY`);
    let payload: unknown;
    try { payload = JSON.parse(output); } catch { throw new Error(`ANALYSIS_OPENAI_${step.toUpperCase()}_INVALID_JSON`); }
    const usage = (raw as { usage?: { input_tokens?: number; output_tokens?: number } }).usage ?? {};
    return {
      payload,
      inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
      outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    };
  };
}

type Db = {
  get<T>(path: string): Promise<T>;
  rpc<T>(name: string, args: Record<string, unknown>): Promise<T>;
  /** Diagnostic rows only (generation traces): minimal response, short timeout, no retry. */
  insert(table: string, rows: unknown[]): Promise<void>;
};

const TRACE_TIMEOUT_MS = 5_000;

function database(deps: Deps, supabaseUrl: string, key: string): Db {
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  return {
    async get<T>(path: string) {
      const result = await deps.fetch(`${supabaseUrl}/rest/v1/${path}`, { headers });
      if (!result.ok) throw new Error(`REST_GET_FAILED:${path.split("?")[0]}:${result.status}`);
      return await result.json() as T;
    },
    async rpc<T>(name: string, args: Record<string, unknown>) {
      const result = await deps.fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
        method: "POST", headers, body: JSON.stringify(args),
      });
      if (!result.ok) throw new Error(`RPC_FAILED:${name}:${result.status}`);
      const text = await result.text();
      return (text ? JSON.parse(text) : null) as T;
    },
    async insert(table: string, rows: unknown[]) {
      const result = await deps.fetch(`${supabaseUrl}/rest/v1/${table}`, {
        method: "POST",
        headers: { ...headers, Prefer: "return=minimal" },
        signal: AbortSignal.timeout(TRACE_TIMEOUT_MS),
        body: JSON.stringify(rows),
      });
      if (!result.ok) throw new Error(`REST_INSERT_FAILED:${table}:${result.status}`);
    },
  };
}

type ClaimRow = { cycle_id: string | null; claim_token: string | null; attempt: number; outcome: string; data_packet_id: string | null };
type DataPacketRow = { id: string; content_hash: string; payload: MarketDataPacket; data_quality_status: string };

const NEWS_COLUMNS = [
  "id", "source_type", "company_code", "company_name", "title", "coverage_severity", "coverage_categories",
  "published_at", "created_at", "app_title_ja", "app_summary_ja", "app_copy_fact_status",
  "generated_text", "generation_fact_status",
].join(",");

export async function handleRequest(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== "POST") return respond({ error: "METHOD_NOT_ALLOWED" }, 405);
  const expectedSecret = deps.env("SEND_PUSH_NOTIFICATIONS_CRON_SECRET");
  if (!expectedSecret || req.headers.get("X-Cron-Secret") !== expectedSecret) {
    return respond({ error: "UNAUTHORIZED" }, 401);
  }
  const supabaseUrl = deps.env("SUPABASE_URL");
  const key = secretKey(deps.env);
  const openAiApiKey = deps.env("OPENAI_API_KEY");
  if (!supabaseUrl || !key || !openAiApiKey) return respond({ error: "MISSING_CONFIGURATION" }, 500);

  let body: { mode?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const reportType: ReportType | null = body.mode === "morning" || body.mode === "close" ? body.mode : null;
  if (!reportType) return respond({ error: "INVALID_MODE" }, 400);

  const db = database(deps, supabaseUrl, key);
  const now = deps.now();

  let jpxHolidays: Set<string>;
  try {
    const rows = await db.get<Array<{ holiday_date: string }>>(
      `market_holidays?select=holiday_date&market=eq.JPX&holiday_date=gte.${now.getUTCFullYear() - 1}-12-01`,
    );
    jpxHolidays = new Set(rows.map((row) => row.holiday_date));
  } catch (error) {
    return respond({ status: "failed", error: safeCode(error) }, 500);
  }
  const window = decideRunWindow(reportType, now, jpxHolidays);
  if (!window.run) return respond({ status: "skipped", reason: window.reason, reportType, tradingDate: window.tradingDate });
  const tradingDate = window.tradingDate;

  let claim: ClaimRow | null;
  try {
    const rows = await db.rpc<ClaimRow[]>("claim_market_report_analysis", {
      p_report_type: reportType,
      p_trading_date: tradingDate,
    });
    claim = rows?.[0] ?? null;
  } catch (error) {
    return respond({ status: "failed", error: safeCode(error), reportType, tradingDate }, 500);
  }
  if (!claim || claim.outcome !== "claimed" || !claim.claim_token || !claim.cycle_id || !claim.data_packet_id) {
    return respond({ status: "skipped", reason: claim?.outcome ?? "CLAIM_EMPTY", reportType, tradingDate });
  }

  const diagnostics: Record<string, string> = { model: ANALYSIS_MODEL };
  const transport = newTransportStats();
  // Test-phase debug evidence: every generation of this invocation, kept whole. Written best-effort after the
  // run is settled (success, failure or exception) and never in the way of delivery.
  const invocationId = crypto.randomUUID();
  const records: GenerationRecord[] = [];
  let tracePromptHash: string | null = null;
  let traced = false;
  const writeTraces = async (reportPacketId: string | null) => {
    if (traced) return;
    traced = true;
    const rows = traceRows({
      reportType, tradingDate, cycleId: claim!.cycle_id, dataPacketId: claim!.data_packet_id, reportPacketId,
      invocationId, attempt: claim!.attempt, model: ANALYSIS_MODEL, promptHash: tracePromptHash,
    }, records);
    await persistTraces((table, batch) => db.insert(table, batch), rows);
  };
  const fail = async (code: string, extra: Record<string, string> = {}) => {
    await db.rpc("fail_market_report_analysis", {
      p_cycle_id: claim!.cycle_id,
      p_claim_token: claim!.claim_token,
      p_error: code,
      p_diagnostics: { ...diagnostics, ...extra },
    }).catch(() => {});
  };

  try {
    const packets = await db.get<DataPacketRow[]>(
      `market_data_packets?select=id,content_hash,payload,data_quality_status&id=eq.${claim.data_packet_id}`,
    );
    const dataPacket = packets?.[0];
    if (!dataPacket || !["ok", "partial"].includes(dataPacket.data_quality_status)) {
      await fail("DATA_PACKET_NOT_USABLE");
      return respond({ status: "failed", error: "DATA_PACKET_NOT_USABLE", reportType, tradingDate }, 500);
    }

    const refIds = dataPacket.payload.news_refs.items.map((item) => item.ref_id);
    let newsRows: NewsTextRow[] = [];
    if (refIds.length > 0) {
      newsRows = await db.get<NewsTextRow[]>(
        `important_news_candidates?select=${NEWS_COLUMNS}&id=in.(${refIds.join(",")})`,
      );
    }
    const input = buildAnalysisInput({
      dataPacket: dataPacket.payload,
      dataPacketId: dataPacket.id,
      dataContentHash: dataPacket.content_hash,
      newsRows,
    });
    diagnostics.news_items = String(input.news.length);
    diagnostics.metrics = String(input.majorMoves.length);
    diagnostics.direction = input.direction;
    tracePromptHash = await promptHash(String(generationRequestBody(input, []).instructions)).catch(() => null);

    const outcome = await generateSharedAnalysis(
      input,
      openAiRequester(openAiApiKey, deps.fetch, { stats: transport, sleep: deps.sleep ?? realSleep }),
      deps.now,
      records,
    );
    Object.assign(diagnostics, transportDiagnostics(transport));
    // Content regeneration (local / Fact rejection, quality rewrite) is not a transport retry.
    Object.assign(diagnostics, generationDiagnostics(outcome.trace));
    diagnostics.calls = String(outcome.calls);
    diagnostics.input_tokens = String(outcome.inputTokens);
    diagnostics.output_tokens = String(outcome.outputTokens);
    diagnostics.cost_usd = String(outcome.costUsd);

    if (!outcome.ok) {
      await fail(outcome.error, { issues: outcome.issues.join(" / ").slice(0, 900) });
      await writeTraces(null);
      return respond({ status: "failed", error: outcome.error, issues: outcome.issues, reportType, tradingDate, attempt: claim.attempt });
    }

    const contentHash = await reportContentHash(outcome.packet);
    const packetId = await db.rpc<string>("complete_market_report_analysis", {
      p_cycle_id: claim.cycle_id,
      p_claim_token: claim.claim_token,
      p_payload: outcome.packet,
      p_content_hash: contentHash,
      p_model: ANALYSIS_MODEL,
      p_generation_calls: outcome.calls,
      p_input_tokens: outcome.inputTokens,
      p_output_tokens: outcome.outputTokens,
      p_api_cost_usd: outcome.costUsd,
      p_diagnostics: diagnostics,
    });
    await writeTraces(packetId);
    return respond({
      status: "completed",
      reportType,
      tradingDate,
      attempt: claim.attempt,
      reportPacketId: packetId,
      contentHash,
      direction: outcome.packet.market_direction,
      calls: outcome.calls,
      costUsd: outcome.costUsd,
    });
  } catch (error) {
    const code = safeCode(error);
    await fail(code, transportDiagnostics(transport));
    await writeTraces(null);
    return respond({ status: "failed", error: code, reportType, tradingDate, transportRetries: transport.retries }, 500);
  }
}
