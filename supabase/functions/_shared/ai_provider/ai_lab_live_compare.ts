// Task54: the A/B/C real-model comparison runner gate.
//
// Task53 checked model access for three models, saw OpenAI answer 401, and
// still ran the Claude mode (3 paid calls) because it stopped per mode. The
// approved condition was to stop the whole trial. This module makes that the
// only behaviour:
//
// 1. The plan is checked against the server selection of every run before any
//    request: a run whose AI_LAB_TEXT_PROVIDER / AI_LAB_TEXT_MODE would pick
//    other models than the plan names is refused (no silent substitution).
// 2. One free model check (GET /v1/models/{id}) per planned provider+model, all
//    before the first paid call. Any check that is not HTTP 200 for that very
//    model stops the whole trial with 0 paid calls on every provider.
// 3. Every paid request goes through one gate shared by all runs. After a paid
//    send, an auth error, any other non-200, an unreadable body, a timeout or a
//    network error, or a response for another model stops the whole trial. The
//    gate then refuses every later request without sending it, so no other run
//    or provider continues and nothing is re-sent.
// 4. A request for a model the current run does not plan, a request body sent
//    before (a retry), or a call over the paid-call cap is refused unsent and
//    stops the trial.
//
// Keys are taken from readEnv (the AI Lab key names) and only placed in the
// request header. This module never reads a keychain, logs a key, or prints
// response text; the ledger holds statuses, models and counts only.

import { resolveAiLabTextSelection, AI_LAB_TEXT_KEY_ENV } from "./ai_lab_post.ts";
import type { FetchLike } from "./adapter.ts";
import { ANTHROPIC_BASE_URL } from "./anthropic_adapter.ts";
import { OPENAI_RESPONSES_URL } from "./openai_adapter.ts";
import { findModelSpec } from "./model_catalog.ts";
import type { AiProvider } from "./types.ts";

// Hosts come from the adapters only (isolation_test).
export const LIVE_COMPARE_PAID_URL: Readonly<Record<AiProvider, string>> = Object
  .freeze({
    anthropic: `${ANTHROPIC_BASE_URL}/v1/messages`,
    openai: OPENAI_RESPONSES_URL,
  });
const MODEL_CHECK_BASE: Readonly<Record<AiProvider, string>> = Object.freeze({
  anthropic: `${ANTHROPIC_BASE_URL}/v1/models/`,
  openai: OPENAI_RESPONSES_URL.replace(/\/responses$/u, "/models/"),
});

export type LiveCompareRun = {
  /** "A-1009" etc. Never text. */
  label: string;
  provider: AiProvider;
  generateModel: string;
  rewriteModel: string;
  /** The server settings this run uses (AI_LAB_TEXT_PROVIDER / AI_LAB_TEXT_MODE). */
  env: Readonly<Record<string, string>>;
};

export type LiveCompareStop =
  | "PLAN_MODEL_MISMATCH"
  | "PLAN_MODEL_UNPRICED"
  | "KEY_MISSING"
  | "PREFLIGHT_AUTH_FAILED"
  | "PREFLIGHT_MODEL_UNAVAILABLE"
  | "PREFLIGHT_UNEXPECTED"
  | "PREFLIGHT_NETWORK"
  | "PAID_AUTH_FAILED"
  | "PAID_UNEXPECTED_RESPONSE"
  | "PAID_UNKNOWN_OUTCOME"
  | "PAID_MODEL_SUBSTITUTED"
  | "REQUEST_NOT_ALLOWED"
  | "REQUEST_MODEL_NOT_PLANNED"
  | "RETRY_REFUSED"
  | "PAID_CALL_CAP";

export class LiveCompareStopped extends Error {
  constructor(readonly reason: LiveCompareStop) {
    super(`AI_LAB_LIVE_COMPARE_STOPPED:${reason}`);
  }
}

export type LiveCompareLedgerEntry = {
  kind: "model_check" | "paid";
  run: string | null;
  provider: AiProvider;
  model: string;
  /** HTTP status, or null when no response arrived. */
  httpStatus: number | null;
  responseModel?: string | null;
};

/** OpenAI answers with a dated snapshot of the requested alias (gpt-6.1-sol-2026-09-01). */
function sameModel(provider: AiProvider, requested: string, actual: unknown) {
  if (actual === requested) return true;
  return provider === "openai" && typeof actual === "string" &&
    actual.startsWith(requested) &&
    /^-\d{4}-\d{2}-\d{2}$/u.test(actual.slice(requested.length));
}

/** Runs whose server selection does not name exactly the planned models. */
export function checkLiveComparePlan(
  runs: readonly LiveCompareRun[],
): LiveCompareStop | null {
  for (const run of runs) {
    const selection = resolveAiLabTextSelection((name) => run.env[name]);
    if (
      !selection.ok || selection.models.provider !== run.provider ||
      selection.models.generate !== run.generateModel ||
      selection.models.rewrite !== run.rewriteModel
    ) return "PLAN_MODEL_MISMATCH";
    for (const model of [run.generateModel, run.rewriteModel]) {
      if (findModelSpec(model)?.provider !== run.provider) {
        return "PLAN_MODEL_UNPRICED";
      }
    }
  }
  return null;
}

function authHeaders(provider: AiProvider, key: string): HeadersInit {
  return provider === "anthropic"
    ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${key}` };
}

/** Every planned provider+model once, in plan order. */
function plannedModels(runs: readonly LiveCompareRun[]) {
  const seen = new Map<string, { provider: AiProvider; model: string }>();
  for (const run of runs) {
    for (const model of [run.generateModel, run.rewriteModel]) {
      seen.set(`${run.provider}/${model}`, { provider: run.provider, model });
    }
  }
  return [...seen.values()];
}

/**
 * The free model checks, all before any paid call. Stops at the first check
 * that is not HTTP 200 for the requested model; a missing key stops before
 * any request at all.
 */
export async function preflightLiveCompare(
  runs: readonly LiveCompareRun[],
  deps: { fetch: FetchLike; readEnv: (name: string) => string | undefined },
  ledger: LiveCompareLedgerEntry[] = [],
): Promise<LiveCompareStop | null> {
  const targets = plannedModels(runs);
  for (const { provider } of targets) {
    if (!deps.readEnv(AI_LAB_TEXT_KEY_ENV[provider])) return "KEY_MISSING";
  }
  for (const { provider, model } of targets) {
    const key = deps.readEnv(AI_LAB_TEXT_KEY_ENV[provider])!;
    let response: Response;
    try {
      response = await deps.fetch(
        MODEL_CHECK_BASE[provider] + encodeURIComponent(model),
        { method: "GET", headers: authHeaders(provider, key) },
      );
    } catch {
      ledger.push({ kind: "model_check", run: null, provider, model, httpStatus: null });
      return "PREFLIGHT_NETWORK";
    }
    ledger.push({ kind: "model_check", run: null, provider, model, httpStatus: response.status });
    if (response.status === 401 || response.status === 403) {
      return "PREFLIGHT_AUTH_FAILED";
    }
    if (response.status === 404) return "PREFLIGHT_MODEL_UNAVAILABLE";
    if (response.status !== 200) return "PREFLIGHT_UNEXPECTED";
    let id: unknown;
    try {
      id = ((await response.json()) as { id?: unknown })?.id;
    } catch {
      return "PREFLIGHT_UNEXPECTED";
    }
    if (id !== model) return "PREFLIGHT_MODEL_UNAVAILABLE";
  }
  return null;
}

async function bodyText(input: string | URL | Request, init?: RequestInit) {
  if (typeof init?.body === "string") return init.body;
  if (input instanceof Request) return await input.clone().text();
  return null;
}

/**
 * One gate shared by every run of a trial. `forRun` returns the fetch a run's
 * provider stages must use; the gate decides before each send and reads each
 * answer's status and model before handing it on.
 */
export function createLiveCompareGate(
  options: { fetch: FetchLike; maxPaidCalls: number },
  ledger: LiveCompareLedgerEntry[] = [],
) {
  let stopped: LiveCompareStop | null = null;
  let paidCalls = 0;
  const sentBodies = new Set<string>();
  const stop = (reason: LiveCompareStop): never => {
    stopped ??= reason;
    throw new LiveCompareStopped(stopped);
  };

  const forRun = (run: LiveCompareRun): FetchLike => async (input, init) => {
    if (stopped) throw new LiveCompareStopped(stopped);
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET"))
      .toUpperCase();
    // The SDK may add a query string; the path itself must be the paid endpoint.
    if (method !== "POST" || url.split("?")[0] !== LIVE_COMPARE_PAID_URL[run.provider]) {
      return stop("REQUEST_NOT_ALLOWED");
    }
    const raw = await bodyText(input, init);
    let model: unknown;
    try {
      model = raw === null ? undefined : (JSON.parse(raw) as { model?: unknown }).model;
    } catch {
      model = undefined;
    }
    if (model !== run.generateModel && model !== run.rewriteModel) {
      return stop("REQUEST_MODEL_NOT_PLANNED");
    }
    if (sentBodies.has(raw!)) return stop("RETRY_REFUSED");
    if (paidCalls >= options.maxPaidCalls) return stop("PAID_CALL_CAP");
    sentBodies.add(raw!);
    paidCalls += 1;
    const entry: LiveCompareLedgerEntry = {
      kind: "paid",
      run: run.label,
      provider: run.provider,
      model: model as string,
      httpStatus: null,
    };
    ledger.push(entry);
    let response: Response;
    try {
      response = await options.fetch(input, init);
    } catch {
      // Timeout, abort or network error after the send: the outcome (and the
      // bill) is unknown. Nothing is re-sent.
      return stop("PAID_UNKNOWN_OUTCOME");
    }
    entry.httpStatus = response.status;
    if (response.status === 401 || response.status === 403) {
      return stop("PAID_AUTH_FAILED");
    }
    if (response.status !== 200) return stop("PAID_UNEXPECTED_RESPONSE");
    let answered: unknown;
    try {
      answered = ((await response.clone().json()) as { model?: unknown })?.model;
    } catch {
      return stop("PAID_UNKNOWN_OUTCOME");
    }
    entry.responseModel = typeof answered === "string" ? answered : null;
    if (!sameModel(run.provider, model as string, answered)) {
      return stop("PAID_MODEL_SUBSTITUTED");
    }
    return response;
  };

  return {
    forRun,
    stopped: () => stopped,
    paidCalls: () => paidCalls,
  };
}

export type LiveCompareRunResult = { label: string; outcome: string };

export type LiveCompareResult = {
  status: "completed" | "stopped";
  stop: LiveCompareStop | null;
  /** "plan" | "preflight" | the run label the stop happened in. */
  stoppedAt: string | null;
  paidCalls: number;
  runs: LiveCompareRunResult[];
  ledger: LiveCompareLedgerEntry[];
};

/**
 * Plan check → all model checks → runs one after another through one gate.
 * `runOne` drives the real AI Lab stages with the fetch it is given and
 * returns a short outcome code (never post text). A content hold thrown by a
 * run (grounding, voice) is that run's outcome; a gate stop ends the trial.
 */
export async function runLiveCompare(
  runs: readonly LiveCompareRun[],
  deps: {
    fetch: FetchLike;
    readEnv: (name: string) => string | undefined;
    maxPaidCalls: number;
    runOne: (
      run: LiveCompareRun,
      deps: { fetch: FetchLike; readEnv: (name: string) => string | undefined },
    ) => Promise<string>;
  },
): Promise<LiveCompareResult> {
  const ledger: LiveCompareLedgerEntry[] = [];
  const results: LiveCompareRunResult[] = [];
  const done = (
    stop: LiveCompareStop | null,
    stoppedAt: string | null,
    paidCalls: number,
  ): LiveCompareResult => ({
    status: stop ? "stopped" : "completed",
    stop,
    stoppedAt,
    paidCalls,
    runs: results,
    ledger,
  });
  if (
    !Number.isSafeInteger(deps.maxPaidCalls) || deps.maxPaidCalls < 1
  ) return done("PAID_CALL_CAP", "plan", 0);
  const planStop = checkLiveComparePlan(runs);
  if (planStop) return done(planStop, "plan", 0);
  const preflightStop = await preflightLiveCompare(runs, deps, ledger);
  if (preflightStop) return done(preflightStop, "preflight", 0);

  const gate = createLiveCompareGate(
    { fetch: deps.fetch, maxPaidCalls: deps.maxPaidCalls },
    ledger,
  );
  for (const run of runs) {
    const readEnv = (name: string) =>
      name in run.env ? run.env[name] : deps.readEnv(name);
    let outcome: string;
    try {
      outcome = await deps.runOne(run, { fetch: gate.forRun(run), readEnv });
    } catch (error) {
      outcome = error instanceof Error ? error.message.slice(0, 120) : "UNKNOWN";
    }
    // A stop inside the stages may surface as a provider error code; the gate
    // is the record of truth.
    const stop = gate.stopped();
    results.push({ label: run.label, outcome: stop ? `STOPPED:${stop}` : outcome });
    if (stop) return done(stop, run.label, gate.paidCalls());
  }
  return done(null, null, gate.paidCalls());
}
