// F8 hard pause (offline source candidate, 2026-10-15): fail-closed stop gate for EVERY side effect of important-news-monitor.
//
// Two layers, both driven by the same setting (important_news_monitor_settings.is_active, row id = true):
//   1. entry gate  — checked after the caller is authenticated and before any mode dispatch / body parsing
//                    (readNewsPauseState + the 503 in index.ts);
//   2. egress guard — a request-scoped replacement of the global fetch that re-checks the setting immediately before every
//                    OUTWARD call (AI, X, push RPC, external feeds, every database write / claim / rpc POST). Database
//                    READS (GET/HEAD on this project's PostgREST) are not outward and pass through, so the handler can still
//                    answer and the gate can always read its own setting.
// Anything that is not exactly `is_active === true` (false, null, missing row, malformed value, unreadable) is "paused":
// callers cannot unlock it with the request body, `mode`, `dry_run`, `trigger` or any other field.
//
// What this cannot do: cancel a request that was already sent to OpenAI / X / a feed before the flag changed. After the flag
// flips, the next outward call is refused as soon as the cached state expires (PAUSE_RECHECK_TTL_MS).

export const PAUSE_RECHECK_TTL_MS = 1_000;
export const NEWS_PAUSED_CODE = "NEWS_HARD_PAUSED";

export type PauseState = "running" | "paused" | "unreadable";

export class NewsPausedError extends Error {
  constructor(state: PauseState = "paused") {
    super(state === "unreadable" ? "NEWS_PAUSE_STATE_UNREADABLE" : NEWS_PAUSED_CODE);
    this.name = "NewsPausedError";
  }
}

type FetchLike = typeof fetch;

/** Reads the single setting. Never throws; any failure is "unreadable" (treated as paused by every caller). */
export async function readNewsPauseState(
  supabaseUrl: string,
  serviceRoleKey: string,
  fetchImpl: FetchLike,
): Promise<PauseState> {
  try {
    const result = await fetchImpl(
      `${supabaseUrl}/rest/v1/important_news_monitor_settings?id=eq.true&select=is_active`,
      { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` } },
    );
    if (!result.ok) return "unreadable";
    const rows = await result.json() as Array<{ is_active?: unknown }>;
    if (!Array.isArray(rows) || rows.length !== 1) return "paused";
    return rows[0]?.is_active === true ? "running" : "paused";
  } catch {
    return "unreadable";
  }
}

export type GuardOptions = {
  fetchImpl: FetchLike;
  /** lazily resolved so the guard can be installed at module load, before the environment is read */
  config: () => { supabaseUrl: string; serviceRoleKey: string } | null;
  ttlMs?: number;
  now?: () => number;
};

/** True for the calls that stay open while paused: read-only requests to this project's PostgREST. */
export function isDatabaseRead(url: string, method: string, supabaseUrl: string): boolean {
  const verb = method.toUpperCase();
  if (verb !== "GET" && verb !== "HEAD") return false;
  return url.startsWith(`${supabaseUrl}/rest/v1/`);
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

/**
 * Returns a fetch that refuses every outward call unless the pause setting is exactly "running".
 * The decision is cached for `ttlMs` (default PAUSE_RECHECK_TTL_MS); a "running" answer is the only one ever cached
 * for that long, a refusal is re-evaluated at the next call so a resume is picked up without waiting.
 */
export function createPauseGuardedFetch(options: GuardOptions): FetchLike {
  const ttl = options.ttlMs ?? PAUSE_RECHECK_TTL_MS;
  // resolved per call so tests (and a fake clock) can control it
  const now = options.now ?? (() => Date.now());
  let runningUntil = 0;

  const guarded = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const config = options.config();
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const url = requestUrl(input);
    // No configuration at all: nothing outward may happen (this also covers a missing SUPABASE_URL).
    if (!config) throw new NewsPausedError("unreadable");
    if (isDatabaseRead(url, method, config.supabaseUrl)) return await options.fetchImpl(input, init);
    if (now() >= runningUntil) {
      const state = await readNewsPauseState(config.supabaseUrl, config.serviceRoleKey, options.fetchImpl);
      if (state !== "running") {
        runningUntil = 0;
        throw new NewsPausedError(state);
      }
      runningUntil = ttl > 0 ? now() + ttl : 0;
    }
    return await options.fetchImpl(input, init);
  };
  return guarded as FetchLike;
}

const GUARD_FLAG = "__newsPauseGuard";

/** Wraps the current global fetch (idempotent: an already guarded fetch is left as is). */
export function installNewsPauseGuard(): void {
  const current = globalThis.fetch as unknown as Record<string, unknown>;
  if (current[GUARD_FLAG] === true) return;
  const original = globalThis.fetch.bind(globalThis);
  const guarded = createPauseGuardedFetch({
    fetchImpl: original,
    config: () => {
      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      return supabaseUrl && serviceRoleKey ? { supabaseUrl, serviceRoleKey } : null;
    },
  });
  (guarded as unknown as Record<string, unknown>)[GUARD_FLAG] = true;
  globalThis.fetch = guarded;
}
