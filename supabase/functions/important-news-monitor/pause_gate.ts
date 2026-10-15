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
// Linearization contract (J2-R1):
//   * every outward call performs its OWN authoritative read of the setting (no positive cache by default: TTL 0);
//   * each read gets a monotonically increasing start sequence; once a read that STARTED LATER has observed a stop
//     (paused / unreadable / timeout), every read that started earlier is refused when it completes — a slow stale
//     "true" can never authorise a send after a newer stop observation, and can never revive a cache;
//   * a read has a hard deadline (PAUSE_READ_TIMEOUT_MS); timeout = unreadable = refused;
//   * the opt-in positive cache (ttlMs > 0, used only by tests) is valid only for a read that started after the newest
//     observed stop, and never longer than ttlMs.
// What this still cannot do: cancel a request that was already sent to OpenAI / X / a feed, and a call whose own read
// started and completed with "true" BEFORE the flag changed may send up to the read latency (<= PAUSE_READ_TIMEOUT_MS)
// after the OFF commit. Stop completion therefore = OFF commit + PAUSE_READ_TIMEOUT_MS + completion of in-flight requests,
// confirmed by the no-new-effects read-back; it is not instantaneous.

/** Positive-authorisation cache. 0 = re-read before every outward call (default and the production setting). */
export const PAUSE_RECHECK_TTL_MS = 0;
/** Hard deadline of one setting read; exceeding it is treated as unreadable (refused). */
export const PAUSE_READ_TIMEOUT_MS = 3_000;
export const NEWS_PAUSED_CODE = "NEWS_HARD_PAUSED";

export type PauseState = "running" | "paused" | "unreadable";

export class NewsPausedError extends Error {
  constructor(state: PauseState = "paused") {
    super(state === "unreadable" ? "NEWS_PAUSE_STATE_UNREADABLE" : NEWS_PAUSED_CODE);
    this.name = "NewsPausedError";
  }
}

type FetchLike = typeof fetch;

/** Reads the single setting. Never throws; any failure or timeout is "unreadable" (refused by every caller). */
export async function readNewsPauseState(
  supabaseUrl: string,
  serviceRoleKey: string,
  fetchImpl: FetchLike,
  timeoutMs = PAUSE_READ_TIMEOUT_MS,
): Promise<PauseState> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<PauseState>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("unreadable");
    }, timeoutMs);
  });
  const read = (async (): Promise<PauseState> => {
    try {
      const result = await fetchImpl(
        `${supabaseUrl}/rest/v1/important_news_monitor_settings?id=eq.true&select=is_active`,
        { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }, signal: controller.signal },
      );
      if (!result.ok) return "unreadable";
      const rows = await result.json() as Array<{ is_active?: unknown }>;
      if (!Array.isArray(rows) || rows.length !== 1) return "paused";
      return rows[0]?.is_active === true ? "running" : "paused";
    } catch {
      return "unreadable";
    }
  })();
  try {
    return await Promise.race([read, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export type GuardOptions = {
  fetchImpl: FetchLike;
  /** lazily resolved so the guard can be installed at module load, before the environment is read */
  config: () => { supabaseUrl: string; serviceRoleKey: string } | null;
  ttlMs?: number;
  now?: () => number;
  readTimeoutMs?: number;
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
 * Returns a fetch that refuses every outward call unless an authoritative read of the pause setting, started for THAT call,
 * returned exactly "running" and no later-started read has observed a stop (see the linearization contract above).
 */
export function createPauseGuardedFetch(options: GuardOptions): FetchLike {
  const ttl = options.ttlMs ?? PAUSE_RECHECK_TTL_MS;
  // resolved per call so tests (and a fake clock) can control it
  const now = options.now ?? (() => Date.now());
  const readTimeout = options.readTimeoutMs ?? PAUSE_READ_TIMEOUT_MS;
  let sequence = 0;
  /** highest start sequence among reads that completed with a stop (paused / unreadable / timeout) */
  let stopSequence = 0;
  let cache: { sequence: number; until: number } | null = null;

  const guarded = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const config = options.config();
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const url = requestUrl(input);
    // No configuration at all: nothing outward may happen (this also covers a missing SUPABASE_URL).
    if (!config) throw new NewsPausedError("unreadable");
    if (isDatabaseRead(url, method, config.supabaseUrl)) return await options.fetchImpl(input, init);
    const cached = ttl > 0 && cache !== null && now() < cache.until && cache.sequence > stopSequence;
    if (!cached) {
      const mine = ++sequence;
      const state = await readNewsPauseState(config.supabaseUrl, config.serviceRoleKey, options.fetchImpl, readTimeout);
      if (state !== "running") {
        stopSequence = Math.max(stopSequence, mine);
        cache = null;
        throw new NewsPausedError(state);
      }
      // a read that started later already observed a stop: this older "true" is stale and must not authorise anything
      if (stopSequence > mine) {
        cache = null;
        throw new NewsPausedError("paused");
      }
      if (ttl > 0) cache = { sequence: mine, until: now() + ttl };
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
