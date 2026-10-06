import {
  TDNET_WORKER_LIMITS,
  type TdnetQueueInsert,
  type TdnetQueueRow,
} from "./tdnet_intake_logic.ts";

// TDnet T1: PostgREST access to public.tdnet_intake_queue (service_role). The claim is an atomic conditional PATCH:
// the WHERE filter is re-evaluated under the row lock, so two workers racing for a row cannot both get it.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type TdnetQueueRepository = {
  /** Inserts rows that are not queued yet (ON CONFLICT DO NOTHING); returns how many were new. */
  enqueue(rows: TdnetQueueInsert[]): Promise<number>;
  /** Rows the worker may consider (queued, retryable, or with an expired lease), bounded. */
  readClaimable(nowMs: number): Promise<TdnetQueueRow[]>;
  /** Atomically takes the given rows (attempt_count + 1); returns only the rows this caller actually won. */
  claim(rows: TdnetQueueRow[], workerId: string, nowMs: number): Promise<TdnetQueueRow[]>;
  markCandidateCreated(id: string, candidateId: string | null, lastError: string | null): Promise<void>;
  markSkipped(id: string, reason: string): Promise<void>;
  markRetry(id: string, nextAttemptAt: string, lastError: string): Promise<void>;
  markTerminal(id: string, lastError: string): Promise<void>;
  /** Rows that ran out of attempts without finishing (crash loops) become failed_terminal; returns the count. */
  sweepExhausted(nowMs: number): Promise<number>;
  stats(nowMs: number): Promise<TdnetQueueStats>;
};

export type TdnetQueueStats = {
  queued: number;
  enriching: number;
  failedRetryable: number;
  failedTerminal: number;
  oldestWaitingMinutes: number | null;
};

const COLUMNS = [
  "id", "source_url", "company_code", "company_name", "title", "published_at", "priority_tier", "priority_reason",
  "group_key", "state", "attempt_count", "last_error", "next_attempt_at", "claimed_by", "claimed_at",
  "lease_expires_at", "candidate_id", "discovered_at",
].join(",");

export function createTdnetQueueRepository(
  supabaseUrl: string,
  serviceRoleKey: string,
  fetchImpl: FetchLike = fetch,
): TdnetQueueRepository {
  const base = `${supabaseUrl}/rest/v1/tdnet_intake_queue`;
  const headers = (prefer?: string): Record<string, string> => ({
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {}),
  });
  const iso = (ms: number) => new Date(ms).toISOString();
  const fail = (code: string) => new Error(code);

  async function patch(filter: Record<string, string>, body: Record<string, unknown>, returning: boolean): Promise<TdnetQueueRow[]> {
    const params = new URLSearchParams({ ...filter, ...(returning ? { select: COLUMNS } : {}) });
    const response = await fetchImpl(`${base}?${params}`, {
      method: "PATCH",
      headers: headers(returning ? "return=representation" : "return=minimal"),
      body: JSON.stringify(body),
    });
    if (!response.ok) throw fail("TDNET_QUEUE_UPDATE_FAILED");
    return returning ? await response.json() as TdnetQueueRow[] : [];
  }

  async function count(filter: Record<string, string>): Promise<number> {
    const params = new URLSearchParams({ select: "id", limit: "1", ...filter });
    const response = await fetchImpl(`${base}?${params}`, { headers: headers("count=exact") });
    if (!response.ok) throw fail("TDNET_QUEUE_STATS_FAILED");
    const total = Number(response.headers.get("content-range")?.split("/")[1]);
    return Number.isFinite(total) ? total : 0;
  }

  return {
    async enqueue(rows) {
      let inserted = 0;
      for (let offset = 0; offset < rows.length; offset += 200) {
        const chunk = rows.slice(offset, offset + 200);
        const response = await fetchImpl(`${base}?on_conflict=source_url&select=id`, {
          method: "POST",
          headers: headers("resolution=ignore-duplicates,return=representation"),
          body: JSON.stringify(chunk),
        });
        if (!response.ok) throw fail("TDNET_QUEUE_ENQUEUE_FAILED");
        inserted += (await response.json() as unknown[]).length;
      }
      return inserted;
    },

    async readClaimable(nowMs) {
      const now = iso(nowMs);
      const params = new URLSearchParams({
        select: COLUMNS,
        attempt_count: `lt.${TDNET_WORKER_LIMITS.maxAttempts + 1}`,
        or: `(state.eq.queued,and(state.eq.failed_retryable,next_attempt_at.lte.${now}),and(state.eq.enriching,lease_expires_at.lt.${now}))`,
        order: "published_at.asc",
        limit: String(TDNET_WORKER_LIMITS.readLimit),
      });
      const response = await fetchImpl(`${base}?${params}`, { headers: headers() });
      if (!response.ok) throw fail("TDNET_QUEUE_READ_FAILED");
      return await response.json() as TdnetQueueRow[];
    },

    async claim(rows, workerId, nowMs) {
      const now = iso(nowMs);
      // One conditional PATCH per row (groups are small). The filter pins the attempt_count that was read, so a
      // concurrent claimer that already bumped it makes this statement match zero rows: optimistic, race-safe.
      const won = await Promise.all(rows.map(async (row) => {
        const updated = await patch(
          {
            id: `eq.${row.id}`,
            attempt_count: `eq.${row.attempt_count}`,
            or: `(state.eq.queued,and(state.eq.failed_retryable,next_attempt_at.lte.${now}),and(state.eq.enriching,lease_expires_at.lt.${now}))`,
          },
          {
            state: "enriching",
            claimed_by: workerId,
            claimed_at: now,
            lease_expires_at: iso(nowMs + TDNET_WORKER_LIMITS.leaseMs),
            attempt_count: row.attempt_count + 1,
          },
          true,
        );
        return updated[0] ?? null;
      }));
      return won.filter((row): row is TdnetQueueRow => row !== null);
    },

    async markCandidateCreated(id, candidateId, lastError) {
      await patch({ id: `eq.${id}`, state: "eq.enriching" }, {
        state: "candidate_created",
        candidate_id: candidateId,
        last_error: lastError,
        claimed_by: null,
        lease_expires_at: null,
        completed_at: new Date().toISOString(),
      }, false);
    },

    async markSkipped(id, reason) {
      await patch({ id: `eq.${id}`, state: "eq.enriching" }, {
        state: "skipped_routine",
        last_error: reason,
        claimed_by: null,
        lease_expires_at: null,
        completed_at: new Date().toISOString(),
      }, false);
    },

    async markRetry(id, nextAttemptAt, lastError) {
      await patch({ id: `eq.${id}`, state: "eq.enriching" }, {
        state: "failed_retryable",
        next_attempt_at: nextAttemptAt,
        last_error: lastError,
        claimed_by: null,
        lease_expires_at: null,
      }, false);
    },

    async markTerminal(id, lastError) {
      await patch({ id: `eq.${id}`, state: "eq.enriching" }, {
        state: "failed_terminal",
        last_error: lastError,
        claimed_by: null,
        lease_expires_at: null,
        completed_at: new Date().toISOString(),
      }, false);
    },

    async sweepExhausted(nowMs) {
      const now = iso(nowMs);
      const rows = await patch(
        {
          attempt_count: `gte.${TDNET_WORKER_LIMITS.maxAttempts + 1}`,
          or: `(state.eq.queued,state.eq.failed_retryable,and(state.eq.enriching,lease_expires_at.lt.${now}))`,
        },
        { state: "failed_terminal", claimed_by: null, lease_expires_at: null, last_error: "TDNET_QUEUE_ATTEMPTS_EXHAUSTED", completed_at: now },
        true,
      );
      return rows.length;
    },

    async stats(nowMs) {
      const [queued, enriching, failedRetryable, failedTerminal] = await Promise.all([
        count({ state: "eq.queued" }),
        count({ state: "eq.enriching" }),
        count({ state: "eq.failed_retryable" }),
        count({ state: "eq.failed_terminal" }),
      ]);
      const params = new URLSearchParams({
        select: "published_at",
        state: "in.(queued,failed_retryable,enriching)",
        order: "published_at.asc",
        limit: "1",
      });
      const response = await fetchImpl(`${base}?${params}`, { headers: headers() });
      if (!response.ok) throw fail("TDNET_QUEUE_STATS_FAILED");
      const oldest = (await response.json() as Array<{ published_at?: string }>)[0]?.published_at;
      return {
        queued, enriching, failedRetryable, failedTerminal,
        oldestWaitingMinutes: oldest ? Math.max(0, Math.round((nowMs - Date.parse(oldest)) / 60000)) : null,
      };
    },
  };
}
