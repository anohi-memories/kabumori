// One-call connection smoke for the shared AI provider -> Claude Opus 5.5 (common AI foundation, Phase 1d).
//
//   plan (default)  builds the fixed request, checks the environment and prints the cost upper bound. NO network.
//   live            exactly ONE HTTP request to api.anthropic.com through executeAiRequest (one transport attempt, no
//                   retry, no fallback), then reconciles: provider usage vs the provider layer's usage, the catalog
//                   price recomputed here vs the estimated cost, and (with --ledger=supabase) the production ledger's
//                   usage_summary delta vs the call. Needs --confirm=ONE_PAID_CALL.
//
// The request is fixed and synthetic: there is no input, so no user, holding, brand or other personal data can enter.
// It runs under the ledger's allowlist identity (application "kabumori", feature "market_report", subject system) with
// its own logical role, so it is visible as such in the ledger. It imports nothing from the market report, the model
// registry or any delivery path, and on any error it stops (non-zero exit) without touching anything else.
//
// Usage (repository root; the key comes from an env file, never from argv; see PHASE1D_ACTIVATION_RUNBOOK.md):
//   env -i PATH="$PATH" HOME="$HOME" deno run --no-config --no-prompt \
//     --allow-env=ANTHROPIC_API_KEY,ANTHROPIC_CUSTOM_HEADERS,ANTHROPIC_BASE_URL,ANTHROPIC_AUTH_TOKEN,ANTHROPIC_WEBHOOK_SIGNING_KEY,ANTHROPIC_LOG,SUPABASE_URL,AI_LEDGER_SERVICE_KEY \
//     --allow-net=api.anthropic.com[,<ref>.supabase.co] --env-file=<600-mode file> \
//     supabase/tests/ai_provider_claude_smoke.ts [--mode=plan|live] [--ledger=memory|supabase] [--confirm=ONE_PAID_CALL]
//
// Exit codes: 0 PASS (plan printed, or live call reconciled), 1 FAIL (the call was made and something did not
// reconcile, or the provider answered an error), 2 REFUSED before any provider request, 3 usage error.

import {
  type AiRequest,
  type AiResult,
  type BudgetGuard,
  executeAiRequest,
  findModelSpec,
  InMemoryBudgetGuard,
  resolveProviderApiKey,
  resolveSecret,
  SupabaseLedgerBudgetGuard,
  upperBoundAttemptCostUsd,
  validateAiRequest,
} from "../functions/_shared/ai_provider/mod.ts";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type EnvReader = (name: string) => string | undefined;

export const SMOKE_MODEL = "claude-opus-5-5";
export const SMOKE_LOGICAL_ROLE = "kabumori.market_report.connection_smoke";
export const SMOKE_MAX_USD = 0.05;
export const SMOKE_CONFIRM = "ONE_PAID_CALL";
export const SMOKE_MAX_OUTPUT_TOKENS = 1536;
/** Read by the Anthropic SDK even when the key is passed explicitly (CUSTOM_HEADERS), or able to redirect a client. */
export const FORBIDDEN_ENV = ["ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"] as const;
export const EXPECTED_PAYLOAD = { status: "ok", sum: 2 };
const ANTHROPIC_HOST = "api.anthropic.com";

export type SmokeOptions = {
  readonly mode: "plan" | "live";
  readonly ledger: "memory" | "supabase";
  readonly confirm: string | null;
};

export type SmokeCheck = { readonly name: string; readonly ok: boolean; readonly detail: string };
export type SmokeReport = {
  readonly verdict: "PASS" | "FAIL" | "REFUSED";
  readonly exitCode: 0 | 1 | 2;
  readonly mode: SmokeOptions["mode"];
  readonly ledger: SmokeOptions["ledger"];
  readonly upperBoundUsd: number;
  readonly providerRequests: number;
  readonly checks: readonly SmokeCheck[];
  readonly call: Record<string, unknown> | null;
};

export function parseArgs(args: readonly string[]): SmokeOptions | string {
  let mode: SmokeOptions["mode"] = "plan";
  let ledger: SmokeOptions["ledger"] = "memory";
  let confirm: string | null = null;
  for (const arg of args) {
    const [key, value] = arg.split("=", 2);
    if (key === "--mode" && (value === "plan" || value === "live")) mode = value;
    else if (key === "--ledger" && (value === "memory" || value === "supabase")) ledger = value;
    else if (key === "--confirm" && value !== undefined) confirm = value;
    else return `unknown argument: ${arg.split("=")[0]}`;
  }
  return { mode, ledger, confirm };
}

/** The only request this script can send. Fixed text, system subject, one transport attempt. */
export function buildSmokeRequest(callId: string): AiRequest {
  return {
    logicalRole: SMOKE_LOGICAL_ROLE,
    provider: "anthropic",
    model: SMOKE_MODEL,
    systemInstructions: "You are a connectivity check. Answer with the JSON object the schema asks for, nothing else.",
    userContent: "Set status to \"ok\" and sum to the result of 1 + 1.",
    jsonSchema: {
      name: "connection_smoke",
      schema: {
        type: "object",
        properties: { status: { type: "string", enum: ["ok"] }, sum: { type: "integer" } },
        required: ["status", "sum"],
        additionalProperties: false,
      },
    },
    reasoningEffort: "low",
    maxOutputTokens: SMOKE_MAX_OUTPUT_TOKENS,
    timeoutMs: 120_000,
    transport: { maxAttempts: 1, retryOnTimeout: false },
    usageContext: { application: "kabumori", feature: "market_report", subject: { kind: "system" } },
    callId,
  };
}

type ObservedResponse = {
  status: number;
  requestId: string | null;
  organizationId: string | null;
  workspaceId: string | null;
  model: string | null;
  stopReason: string | null;
  usage: Record<string, unknown> | null;
};

/** Counts every request by host and keeps what the provider itself said (ids, model, raw usage). */
export function observingFetch(inner: FetchLike) {
  const counts = { anthropic: 0, ledger: 0, other: 0 };
  const anthropic: ObservedResponse[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === ANTHROPIC_HOST) counts.anthropic += 1;
    else if (url.pathname.startsWith("/rest/v1/rpc/ai_ledger_")) counts.ledger += 1;
    else counts.other += 1;
    const response = await inner(input, init);
    if (url.hostname === ANTHROPIC_HOST) {
      const observed: ObservedResponse = {
        status: response.status,
        requestId: response.headers.get("request-id"),
        organizationId: response.headers.get("anthropic-organization-id"),
        workspaceId: response.headers.get("anthropic-workspace-id"),
        model: null,
        stopReason: null,
        usage: null,
      };
      try {
        const body = await response.clone().json() as Record<string, unknown>;
        observed.model = typeof body.model === "string" ? body.model : null;
        observed.stopReason = typeof body.stop_reason === "string" ? body.stop_reason : null;
        observed.usage = body.usage && typeof body.usage === "object" ? body.usage as Record<string, unknown> : null;
      } catch {
        // not JSON: the provider layer classifies it; nothing more to observe
      }
      anthropic.push(observed);
    }
    return response;
  };
  return { fetch: fetchImpl, counts, anthropic };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Catalog price recomputed here from the provider's raw usage (independent of cost.ts). */
export function independentCostUsd(rawUsage: Record<string, unknown>): number {
  const spec = findModelSpec(SMOKE_MODEL);
  if (!spec) throw new Error("SMOKE_MODEL_NOT_IN_CATALOG");
  const uncached = count(rawUsage.input_tokens);
  const cacheRead = count(rawUsage.cache_read_input_tokens);
  const cacheWrite = count(rawUsage.cache_creation_input_tokens);
  const output = count(rawUsage.output_tokens);
  const total = uncached + cacheRead + cacheWrite;
  const tier = [...spec.priceTiers].reverse().find((t) => total > t.promptTokensAbove) ?? spec.priceTiers[0];
  // Cache writes are priced at the 5-minute rate (the smoke sets no cache control, so it expects none).
  return (uncached * tier.inputPer1M + cacheRead * tier.cacheReadPer1M + cacheWrite * tier.cacheWrite5mPer1M + output * tier.outputPer1M) / 1_000_000;
}

// The same rounding the ledger guard applies before settle (ledger_guard.ts ceilUsd), and an 8-decimal tolerance.
const ceil8 = (value: number) => Math.ceil(value * 100_000_000) / 100_000_000;
const near = (a: number, b: number) => Math.abs(a - b) <= 1.5e-8;

type LedgerRow = { attempts: number; succeeded: number; input_tokens: number; output_tokens: number; estimated_cost_usd: number };

export function jstMonth(nowMs: number): string {
  const jst = new Date(nowMs + 9 * 3_600_000);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

async function ledgerSummary(fetchImpl: FetchLike, base: string, key: string, month: string): Promise<LedgerRow> {
  const response = await fetchImpl(`${base}/rest/v1/rpc/ai_ledger_usage_summary`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p: { billing_month: month, dimension: "logical_role" } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`AI_LEDGER_SUMMARY_FAILED:${response.status}`);
  const rows = await response.json() as Array<Record<string, unknown>>;
  const row = rows.find((r) => r.key === SMOKE_LOGICAL_ROLE) ?? {};
  return {
    attempts: Number(row.attempts ?? 0),
    succeeded: Number(row.succeeded ?? 0),
    input_tokens: Number(row.input_tokens ?? 0),
    output_tokens: Number(row.output_tokens ?? 0),
    estimated_cost_usd: Number(row.estimated_cost_usd ?? 0),
  };
}

/** Pure reconciliation of one live call (exported for tests). */
export function reconcile(input: {
  result: AiResult;
  upperBoundUsd: number;
  anthropicRequests: number;
  observed: ObservedResponse | null;
  ledgerBefore: LedgerRow | null;
  ledgerAfter: LedgerRow | null;
}): SmokeCheck[] {
  const { result, upperBoundUsd, anthropicRequests, observed, ledgerBefore, ledgerAfter } = input;
  const checks: SmokeCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  add("one_provider_request", anthropicRequests === 1, `requests=${anthropicRequests}`);
  add("result_ok", result.ok, result.ok ? `stop_reason=${result.stopReason}` : `error=${result.errorCode} http=${result.httpStatus}`);
  add("actual_model_opus_5_5", result.actualModel === SMOKE_MODEL, `actual=${result.actualModel}`);
  add("cost_within_upper_bound", result.estimatedCostUsd <= upperBoundUsd + 1e-9 && upperBoundUsd <= SMOKE_MAX_USD,
    `estimated=${result.estimatedCostUsd} upper_bound=${upperBoundUsd} cap=${SMOKE_MAX_USD}`);
  const raw = observed?.usage ?? null;
  if (raw) {
    const providerInput = count(raw.input_tokens) + count(raw.cache_read_input_tokens) + count(raw.cache_creation_input_tokens);
    const providerOutput = count(raw.output_tokens);
    add("usage_matches_provider", result.usage.inputTokens === providerInput && result.usage.outputTokens === providerOutput,
      `provider in=${providerInput} out=${providerOutput}; layer in=${result.usage.inputTokens} out=${result.usage.outputTokens}`);
    const independent = independentCostUsd(raw);
    add("cost_matches_catalog", near(Math.round(independent * 100_000_000) / 100_000_000, result.estimatedCostUsd),
      `recomputed=${independent.toFixed(8)} layer=${result.estimatedCostUsd}`);
  } else {
    add("usage_matches_provider", false, "the provider response carried no readable usage");
  }
  if (ledgerBefore && ledgerAfter) {
    const d = {
      attempts: ledgerAfter.attempts - ledgerBefore.attempts,
      succeeded: ledgerAfter.succeeded - ledgerBefore.succeeded,
      input: ledgerAfter.input_tokens - ledgerBefore.input_tokens,
      output: ledgerAfter.output_tokens - ledgerBefore.output_tokens,
      cost: ledgerAfter.estimated_cost_usd - ledgerBefore.estimated_cost_usd,
    };
    add("ledger_one_attempt", d.attempts === 1 && d.succeeded === (result.ok ? 1 : 0), `attempts+${d.attempts} succeeded+${d.succeeded}`);
    add("ledger_tokens_match", d.input === result.usage.inputTokens && d.output === result.usage.outputTokens,
      `ledger in+${d.input} out+${d.output}`);
    add("ledger_cost_matches", near(Math.round(d.cost * 100_000_000) / 100_000_000, ceil8(result.estimatedCostUsd)),
      `ledger +${d.cost.toFixed(8)} vs ${ceil8(result.estimatedCostUsd)}`);
  }
  return checks;
}

function refused(options: SmokeOptions, upperBoundUsd: number, reason: string, providerRequests = 0): SmokeReport {
  return { verdict: "REFUSED", exitCode: 2, mode: options.mode, ledger: options.ledger, upperBoundUsd, providerRequests,
    checks: [{ name: "precondition", ok: false, detail: reason }], call: null };
}

export async function runSmoke(options: SmokeOptions, deps: {
  readEnv: EnvReader;
  fetch: FetchLike;
  nowMs?: () => number;
  callId?: string;
  /** Tests only: accept an http loopback ledger URL. */
  allowLoopbackLedger?: boolean;
}): Promise<SmokeReport> {
  const callId = deps.callId ?? `smoke-${crypto.randomUUID()}`;
  const request = buildSmokeRequest(callId);
  const validated = validateAiRequest(request);
  const spec = findModelSpec(SMOKE_MODEL);
  if ("code" in validated || !spec) return refused(options, 0, `request invalid: ${"code" in validated ? validated.code : "catalog"}`);
  const upperBoundUsd = upperBoundAttemptCostUsd(spec, request);

  const env: SmokeCheck[] = [];
  for (const name of FORBIDDEN_ENV) {
    let value: string | undefined;
    try {
      value = deps.readEnv(name);
    } catch {
      value = undefined;
    }
    env.push({ name: `env_${name.toLowerCase()}_unset`, ok: value === undefined || value === "", detail: value ? "SET (must be removed)" : "unset" });
  }
  const key = resolveProviderApiKey("anthropic", deps.readEnv);
  env.push({ name: "anthropic_key_usable", ok: key.ok, detail: key.ok ? "present (value not shown)" : `${key.code}: ${key.reason}` });
  env.push({ name: "upper_bound_within_cap", ok: upperBoundUsd <= SMOKE_MAX_USD, detail: `${upperBoundUsd} <= ${SMOKE_MAX_USD}` });

  let ledgerBase: string | null = null;
  let ledgerKey: string | null = null;
  if (options.ledger === "supabase") {
    const url = deps.readEnv("SUPABASE_URL") ?? "";
    let host = "";
    try {
      const parsed = new URL(url);
      const loopback = deps.allowLoopbackLedger === true && parsed.protocol === "http:" && parsed.hostname === "127.0.0.1";
      if ((parsed.protocol === "https:" && /^[a-z]{20}\.supabase\.co$/u.test(parsed.hostname)) || loopback) {
        host = parsed.host;
        ledgerBase = parsed.origin;
      }
    } catch {
      // invalid URL: reported below
    }
    env.push({ name: "ledger_url_is_project", ok: ledgerBase !== null, detail: ledgerBase ? host : "SUPABASE_URL must be https://<ref>.supabase.co" });
    const secret = resolveSecret("AI_LEDGER_SERVICE_KEY", deps.readEnv);
    ledgerKey = secret.ok ? secret.value.reveal() : null;
    env.push({ name: "ledger_key_present", ok: secret.ok, detail: secret.ok ? "present (value not shown)" : secret.code });
  }

  const call = {
    model: SMOKE_MODEL, effort: request.reasoningEffort, max_output_tokens: SMOKE_MAX_OUTPUT_TOKENS,
    logical_role: SMOKE_LOGICAL_ROLE, application: "kabumori", feature: "market_report", subject: "system", call_id: callId,
  };
  if (env.some((check) => !check.ok)) {
    return { verdict: "REFUSED", exitCode: 2, mode: options.mode, ledger: options.ledger, upperBoundUsd, providerRequests: 0, checks: env, call };
  }
  if (options.mode === "plan") {
    return { verdict: "PASS", exitCode: 0, mode: "plan", ledger: options.ledger, upperBoundUsd, providerRequests: 0, checks: env, call };
  }
  if (options.confirm !== SMOKE_CONFIRM) return refused(options, upperBoundUsd, `live needs --confirm=${SMOKE_CONFIRM}`);

  const observer = observingFetch(deps.fetch);
  const month = jstMonth((deps.nowMs ?? Date.now)());
  let budget: BudgetGuard;
  let ledgerBefore: LedgerRow | null = null;
  if (options.ledger === "supabase") {
    try {
      ledgerBefore = await ledgerSummary(observer.fetch, ledgerBase!, ledgerKey!, month);
    } catch (error) {
      return refused(options, upperBoundUsd, `ledger not reachable before the call: ${error instanceof Error ? error.message : "error"}`);
    }
    const secret = resolveSecret("AI_LEDGER_SERVICE_KEY", deps.readEnv);
    if (!secret.ok) return refused(options, upperBoundUsd, "ledger key vanished");
    budget = new SupabaseLedgerBudgetGuard({ supabaseUrl: ledgerBase!, serviceKey: secret.value, fetch: observer.fetch });
  } else {
    budget = new InMemoryBudgetGuard([{
      id: "smoke.one_call",
      scope: { provider: "anthropic", application: "kabumori", feature: "market_report", logicalRole: SMOKE_LOGICAL_ROLE },
      maxCalls: 1,
      maxEstimatedUsd: SMOKE_MAX_USD,
      maxUsdPerCall: SMOKE_MAX_USD,
    }]);
  }

  const result = await executeAiRequest(request, { readEnv: deps.readEnv, budget, fetch: observer.fetch, nowMs: deps.nowMs });
  if (observer.counts.anthropic === 0) {
    // Refused before sending (budget denial, missing key ...): nothing was billed.
    return refused(options, upperBoundUsd, result.ok ? "no provider request was made" : `refused before sending: ${result.errorCode} ${result.detail ?? ""}`.trim());
  }
  let ledgerAfter: LedgerRow | null = null;
  const checks: SmokeCheck[] = [];
  if (options.ledger === "supabase") {
    try {
      ledgerAfter = await ledgerSummary(observer.fetch, ledgerBase!, ledgerKey!, month);
    } catch (error) {
      checks.push({ name: "ledger_readable_after", ok: false, detail: error instanceof Error ? error.message : "error" });
    }
  }
  const observed = observer.anthropic.at(-1) ?? null;
  checks.push(...reconcile({ result, upperBoundUsd, anthropicRequests: observer.counts.anthropic, observed, ledgerBefore, ledgerAfter }));
  if (observer.counts.other !== 0) checks.push({ name: "no_other_hosts", ok: false, detail: `other requests=${observer.counts.other}` });
  const payloadMatches = result.ok && JSON.stringify(result.parsedPayload) === JSON.stringify(EXPECTED_PAYLOAD);
  const ok = checks.every((check) => check.ok);
  return {
    verdict: ok ? "PASS" : "FAIL",
    exitCode: ok ? 0 : 1,
    mode: "live",
    ledger: options.ledger,
    upperBoundUsd,
    providerRequests: observer.counts.anthropic,
    checks,
    call: {
      ...call,
      ok: result.ok,
      error_code: result.ok ? null : result.errorCode,
      http_status: observed?.status ?? null,
      provider_request_id: observed?.requestId ?? null,
      organization_id: observed?.organizationId ?? null,
      workspace_id: observed?.workspaceId ?? null,
      actual_model: result.actualModel,
      stop_reason: result.ok ? result.stopReason : observed?.stopReason ?? null,
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
      reasoning_output_tokens: result.usage.reasoningOutputTokens,
      estimated_cost_usd: result.estimatedCostUsd,
      cost_basis: result.costBasis,
      latency_ms: result.latencyMs,
      payload_matches_expected: payloadMatches,
      ledger_before: ledgerBefore,
      ledger_after: ledgerAfter,
    },
  };
}

export function formatReport(report: SmokeReport): string {
  const lines = [
    `mode=${report.mode} ledger=${report.ledger} upper_bound_usd=${report.upperBoundUsd} provider_requests=${report.providerRequests}`,
    ...report.checks.map((check) => `check ${check.name}: ${check.ok ? "ok" : "NG"} (${check.detail})`),
  ];
  if (report.call) lines.push(`call ${JSON.stringify(report.call)}`);
  lines.push(`VERDICT: ${report.verdict}`);
  return lines.join("\n");
}

if (import.meta.main) {
  const options = parseArgs(Deno.args);
  if (typeof options === "string") {
    console.log(`USAGE: ${options}`);
    Deno.exit(3);
  }
  const readEnv: EnvReader = (name) => {
    try {
      return Deno.env.get(name);
    } catch {
      return undefined;
    }
  };
  const report = await runSmoke(options, { readEnv, fetch: (input, init) => fetch(input, init) });
  console.log(formatReport(report));
  Deno.exit(report.exitCode);
}
