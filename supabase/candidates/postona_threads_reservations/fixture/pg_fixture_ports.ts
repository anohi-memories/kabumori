/**
 * TEST FIXTURE -- PostgreSQL ports over candidate 007 for the disposable-PG17 runs only (G3 Issue #318 TASK 3/50).
 * Imported by no product code. One call = one connection = one READ COMMITTED transaction:
 *   person  (postona_resv_api):    request.jwt.claims = { sub, role: authenticated, session_id } of the MOCK verdict
 *   worker  (postona_resv_worker): the four dispatcher functions
 * A refusal raised by 007 (POSTONA_*) is answered { ok: false, code }; anything after the call (a lost COMMIT) THROWS so
 * the caller treats the outcome as unknown. `hooks` let a test lose the answer before or after the COMMIT on purpose.
 */
import { Client } from "jsr:@db/postgres@0.19.5";
import type { ThreadsDispatchStore } from "../../../functions/_shared/postona_reservations/threads_dispatch.ts";
import type { StoreAnswer, ThreadsReservationStore, VerifiedCaller } from "./threads_reservation_http_fixture.ts";

const CODE_RE = /^POSTONA_[A-Z_]{1,70}$/u;
const PERSON_SQL = {
  create: "select reservation_id::text, status, created from postona_threads_resv.create_reservation($1, $2::uuid, $3, $4, $5::timestamptz)",
  cancel: "select postona_threads_resv.cancel_reservation($1::uuid) as answer",
  receipt: "select reservation_id::text, state, provider_post_id, outcome_code, after_freeze, simulated from postona_threads_resv.receipt($1, $2::uuid)",
} as const;

function serverMessage(error: unknown): string | null {
  const fields = (error as { fields?: { message?: unknown } } | null)?.fields;
  return typeof fields?.message === "string" ? fields.message : null;
}

export function createPgPersonStore(url: string, hooks: { beforeCommit?: () => Promise<void>; loseAnswerAfterCommit?: () => boolean } = {}): ThreadsReservationStore {
  return {
    async call(fn, args, caller: VerifiedCaller): Promise<StoreAnswer> {
      const c = new Client(url);
      await c.connect();
      let phase: "before" | "after" = "before";
      try {
        await c.queryArray("BEGIN ISOLATION LEVEL READ COMMITTED");
        await c.queryArray("SET LOCAL ROLE postona_resv_api");
        await c.queryArray({ text: "SELECT set_config('request.jwt.claims', $1, true)", args: [JSON.stringify({ sub: caller.userId, role: "authenticated", session_id: caller.sessionId })] });
        const result = await c.queryObject<Record<string, unknown>>({ text: PERSON_SQL[fn], args: args.map((v) => (v === null || v === undefined ? null : String(v))) });
        phase = "after";
        if (hooks.beforeCommit) await hooks.beforeCommit();
        await c.queryArray("COMMIT");
        if (hooks.loseAnswerAfterCommit?.() === true) throw new Error("connection reset after COMMIT");
        return { ok: true, rows: result.rows };
      } catch (error) {
        await c.queryArray("ROLLBACK").catch(() => undefined);
        const message = serverMessage(error);
        if (phase === "after" || !message) throw new Error("PERSON_STORE_OUTCOME_UNKNOWN");
        return { ok: false, code: CODE_RE.test(message) ? message : "DB_ERROR" };
      } finally {
        await c.end().catch(() => undefined);
      }
    },
  };
}

async function asWorker<T>(url: string, text: string, args: unknown[]): Promise<T[]> {
  const c = new Client(url);
  await c.connect();
  try {
    await c.queryArray("BEGIN ISOLATION LEVEL READ COMMITTED");
    await c.queryArray("SET LOCAL ROLE postona_resv_worker");
    const rows = (await c.queryObject<T>({ text, args })).rows;
    await c.queryArray("COMMIT");
    return rows;
  } finally {
    await c.end().catch(() => undefined);
  }
}

export function createPgWorkerStore(url: string): ThreadsDispatchStore {
  return {
    async claimDue(worker, lease, limit) {
      const rows = await asWorker<{ reservation_id: string; lease_token: string; provider: string; social_account_id: string; body: string }>(url,
        "select reservation_id::text, lease_token::text, provider, social_account_id, body from postona_threads_resv.claim_due($1, $2, $3)", [worker, lease, limit]);
      return rows.map((r) => ({ reservationId: r.reservation_id, leaseToken: r.lease_token, provider: r.provider, socialAccountId: r.social_account_id, body: r.body }));
    },
    async preflight(id, lease) {
      const [r] = await asWorker<{ verdict: string; credential_generation: string | null }>(url,
        "select verdict, credential_generation from postona_threads_resv.preflight($1::uuid, $2::uuid)", [id, lease]);
      return { verdict: r.verdict as "OK", credentialGeneration: r.credential_generation };
    },
    async record(id, lease, outcome, postId, code, transport) {
      const [r] = await asWorker<{ answer: string }>(url, "select postona_threads_resv.record($1::uuid, $2::uuid, $3, $4, $5, $6) as answer",
        [id, lease, outcome, postId, code, transport]);
      return r.answer;
    },
    async releaseUnsent(id, lease) {
      const [r] = await asWorker<{ answer: string }>(url, "select postona_threads_resv.release_unsent($1::uuid, $2::uuid) as answer", [id, lease]);
      return r.answer;
    },
  };
}
