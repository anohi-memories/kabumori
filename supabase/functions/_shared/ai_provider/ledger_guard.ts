// Database-backed BudgetGuard (Phase 1b): the public.ai_ledger_* RPCs of migration 20261010050613, called through
// PostgREST with the service key. One database = one budget for every Edge Function and process, so this is the
// guard that can hold monthly / per-brand / per-user caps across invocations (InMemoryBudgetGuard cannot).
//
// Per attempt:  reserve (atomic check-and-hold in the database) -> markSent (only then is the HTTP request allowed)
//               -> settle (cost + usage + outcome become one append-only ledger row).
// Any RPC failure throws: executeAiRequest then refuses to send (reserve / markSent) or leaves the hold for the
// ledger's recovery (settle), which finalises a sent attempt at its upper bound and never releases it.
//
// The service key is a SecretValue (redacted everywhere) and only goes into the request headers. Errors carry the
// RPC name, the HTTP status and a sanitised PostgREST code, never a body, a key or a payload.

import type { FetchLike } from "./adapter.ts";
import type { BudgetCallContext, BudgetDecision, BudgetDenyReason, BudgetGuard, BudgetReservation, BudgetSettlement } from "./budget.ts";
import { safeToken } from "./redact.ts";
import type { SecretValue } from "./secrets.ts";

export type LedgerGuardOptions = {
  /** The project URL, e.g. https://<ref>.supabase.co (http only for a local loopback test server). */
  readonly supabaseUrl: string;
  /** The service-role key, which alone may execute the ledger RPCs. */
  readonly serviceKey: SecretValue;
  readonly fetch?: FetchLike;
  /** How long an unsent reservation is held before recovery may release it (30..3600, default 900). */
  readonly holdSeconds?: number;
  /** Per RPC call (default 10 s). */
  readonly rpcTimeoutMs?: number;
};

export class LedgerRpcError extends Error {
  readonly rpc: string;
  readonly status: number | null;
  constructor(rpc: string, status: number | null, code: string | null) {
    super(`AI_LEDGER_RPC_FAILED:${rpc}:${status ?? "network"}${code ? `:${code}` : ""}`);
    this.rpc = rpc;
    this.status = status;
  }
}

const LEDGER_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const UNIT = 100_000_000;

/** A value the ledger accepts as an identifier, or null (the ledger column is optional where this is used). */
function ledgerIdentifier(value: string | null | undefined): string | null {
  return typeof value === "string" && LEDGER_IDENTIFIER.test(value) ? value : null;
}

function ceilUsd(value: number): number {
  return Math.ceil(value * UNIT) / UNIT;
}

function denyReason(reason: unknown): BudgetDenyReason {
  switch (reason) {
    case "NO_MATCHING_POLICY":
      return "NO_MATCHING_LIMIT";
    case "CALL_LIMIT":
    case "COST_LIMIT":
    case "PER_CALL_LIMIT":
    case "ATTEMPT_FINALIZED":
      return reason;
    default:
      return "GUARD_UNAVAILABLE";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class SupabaseLedgerBudgetGuard implements BudgetGuard {
  readonly #base: string;
  readonly #key: SecretValue;
  readonly #fetch: FetchLike;
  readonly #holdSeconds: number;
  readonly #timeoutMs: number;

  constructor(options: LedgerGuardOptions) {
    const url = new URL(options.supabaseUrl);
    const loopback = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
    if (url.protocol !== "https:" && !loopback) throw new Error("AI_LEDGER_URL_NOT_HTTPS");
    this.#base = `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
    this.#key = options.serviceKey;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    const hold = options.holdSeconds ?? 900;
    if (!Number.isInteger(hold) || hold < 30 || hold > 3600) throw new Error("AI_LEDGER_HOLD_SECONDS_INVALID");
    this.#holdSeconds = hold;
    this.#timeoutMs = options.rpcTimeoutMs ?? 10_000;
  }

  async #rpc(name: string, p: Record<string, unknown>): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#base}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: {
          "apikey": this.#key.reveal(),
          "Authorization": `Bearer ${this.#key.reveal()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ p }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new LedgerRpcError(name, null, null);
    }
    const text = await response.text().catch(() => "");
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (!response.ok) throw new LedgerRpcError(name, response.status, isRecord(body) ? safeToken(body.code) : null);
    if (!isRecord(body)) throw new LedgerRpcError(name, response.status, "BAD_BODY");
    return body;
  }

  async reserve(context: BudgetCallContext, upperBoundUsd: number): Promise<BudgetDecision> {
    if (typeof context.callId !== "string" || !Number.isInteger(context.attempt)) throw new Error("AI_LEDGER_CONTEXT_INCOMPLETE");
    if (!Number.isFinite(upperBoundUsd) || upperBoundUsd < 0) return { allowed: false, reason: "INVALID_AMOUNT", limitId: null };
    const subject = context.subject ?? { kind: "system" as const };
    const p: Record<string, unknown> = {
      request_id: context.callId,
      attempt: context.attempt,
      provider: context.provider,
      model: context.model,
      application: context.application,
      feature: context.feature,
      logical_role: context.logicalRole,
      subject_kind: subject.kind,
      amount_usd: ceilUsd(upperBoundUsd),
      hold_seconds: this.#holdSeconds,
    };
    if (subject.kind === "user") {
      p.user_id = subject.userId;
      if (subject.brandId) p.brand_id = subject.brandId;
    }
    const result = await this.#rpc("ai_ledger_reserve", p);
    if (result.allowed === true && typeof result.reservation_id === "string") {
      return { allowed: true, reservation: { id: result.reservation_id, limitIds: [], reservedUsd: ceilUsd(upperBoundUsd) } };
    }
    return { allowed: false, reason: denyReason(result.reason), limitId: safeToken(result.policy_key) };
  }

  async markSent(reservation: BudgetReservation): Promise<void> {
    const result = await this.#rpc("ai_ledger_mark_sent", { reservation_id: reservation.id });
    if (result.may_send !== true) throw new Error(`AI_LEDGER_SEND_NOT_ALLOWED:${safeToken(result.status) ?? "unknown"}`);
  }

  async release(reservation: BudgetReservation): Promise<void> {
    await this.#rpc("ai_ledger_release", { reservation_id: reservation.id });
  }

  async settle(reservation: BudgetReservation, costUsd: number, settlement?: BudgetSettlement): Promise<void> {
    // Without details (a caller that predates the ledger) the attempt is recorded as unknown at its upper bound.
    const details: BudgetSettlement = settlement ?? {
      outcome: "unknown",
      costBasis: "upper_bound",
      usage: null,
      errorCode: null,
      actualModel: null,
      providerRequestId: null,
      httpStatus: null,
      latencyMs: 0,
      catalogVersion: "unspecified",
    };
    const p: Record<string, unknown> = {
      reservation_id: reservation.id,
      outcome: details.outcome,
      cost_basis: details.costBasis,
      estimated_cost_usd: ceilUsd(Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : reservation.reservedUsd),
      price_catalog_version: ledgerIdentifier(details.catalogVersion) ?? "unspecified",
      latency_ms: Math.max(0, Math.round(details.latencyMs)),
    };
    if (details.costBasis === "measured" && details.usage) {
      const usage = details.usage;
      p.input_tokens = usage.inputTokens;
      p.cache_read_input_tokens = usage.cacheReadInputTokens;
      p.cache_write_5m_input_tokens = usage.cacheWrite5mInputTokens;
      p.cache_write_1h_input_tokens = usage.cacheWrite1hInputTokens;
      p.output_tokens = usage.outputTokens;
      // A breakdown the provider reported inconsistently is dropped rather than failing the whole settlement.
      if (usage.reasoningOutputTokens !== null && usage.reasoningOutputTokens <= usage.outputTokens) {
        p.reasoning_output_tokens = usage.reasoningOutputTokens;
      }
    }
    const actualModel = ledgerIdentifier(details.actualModel);
    if (actualModel) p.actual_model = actualModel;
    const requestId = ledgerIdentifier(details.providerRequestId);
    if (requestId) p.provider_request_id = requestId;
    if (details.errorCode && ERROR_CODE.test(details.errorCode)) p.error_code = details.errorCode;
    if (Number.isInteger(details.httpStatus) && (details.httpStatus as number) >= 100 && (details.httpStatus as number) <= 599) {
      p.http_status = details.httpStatus;
    }
    await this.#rpc("ai_ledger_settle", p);
  }
}
