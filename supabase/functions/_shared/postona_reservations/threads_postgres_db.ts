/**
 * ThreadsReservationDb over Postgres — G3 SOURCE CANDIDATE (2026-10-30, Issue #318 G3-46). The same session protocol as the X adapter
 * (postgres_db.ts). One call = one connection session = ONE transaction:
 *   BEGIN ISOLATION LEVEL READ COMMITTED
 *   SET LOCAL ROLE postona_resv_api            -- a constant; the role is never taken from input
 *   SET LOCAL statement_timeout = '15s'
 *   set_config('request.jwt.claims', {sub, role, session_id, is_anonymous}, true), request.jwt.claim.sub = ''
 *                                              -- the VERIFIED subject and its session only, local to the transaction (what G5's
 *                                                 person-session gate S2-2 reads)
 *   SELECT ... FROM postona_threads_resv.<one fixed owner function>($1, ...)   -- every value is a bind parameter
 *   COMMIT
 * Only the three functions 007 grants to postona_resv_api can be reached: create_reservation, cancel_reservation, receipt.
 *
 * Outcomes: a POSTONA_THREADS_RESV_* / POSTONA_RESV_* error from the function => { ok: false, code } (the transaction rolled back:
 * nothing was written); a lock timeout (55P03) => POSTONA_RESV_SERVICE_BUSY; any other database error => DB_ERROR; a connection failure or
 * an error after the call may have committed => THROW (the outcome is unknown and the client must read back with receipt). The adapter
 * logs nothing (no token, subject, text or row ever reaches a log).
 */
import type { ReservationSubject } from "./api.ts";
import type { PgConnect } from "./postgres_db.ts";
import type { ThreadsDbFunction, ThreadsDbResult, ThreadsReservationDb } from "./threads_api.ts";

export const THREADS_API_ROLE = "postona_resv_api";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CODE_RE = /^POSTONA_(THREADS_)?RESV_[A-Z_]{1,60}$/u;

/** Fixed calls: function name and typed bind parameters. Nothing else can be executed through this adapter. */
const CALLS: Record<ThreadsDbFunction, { sql: string; arity: number }> = {
  create_reservation: {
    sql: "postona_threads_resv.create_reservation($1::text, $2::uuid, $3::text, $4::text, $5::timestamptz) r",
    arity: 5,
  },
  // a scalar function: wrapped so the row is {"state": ...} (json_agg of a bare scalar alias would give the value itself)
  cancel_reservation: { sql: "(SELECT postona_threads_resv.cancel_reservation($1::uuid) AS state) r", arity: 1 },
  receipt: { sql: "postona_threads_resv.receipt($1::text, $2::uuid) r", arity: 2 },
};

/** The server error fields of a driver error (jsr:@db/postgres PostgresError), or null for anything else. */
function serverError(error: unknown): { code: string; message: string } | null {
  if (typeof error !== "object" || error === null) return null;
  const fields = (error as { fields?: unknown }).fields;
  if (typeof fields !== "object" || fields === null) return null;
  const { code, message } = fields as { code?: unknown; message?: unknown };
  return typeof code === "string" && typeof message === "string" ? { code, message } : null;
}

export function createPostgresThreadsReservationDb(connect: PgConnect): ThreadsReservationDb {
  return {
    async call(fn: ThreadsDbFunction, args: readonly unknown[], subject: ReservationSubject): Promise<ThreadsDbResult> {
      const target = Object.hasOwn(CALLS, fn) ? CALLS[fn] : undefined;
      if (!target || args.length !== target.arity || args.some((a) => typeof a !== "string") || !UUID_RE.test(subject.userId)
          || !UUID_RE.test(subject.sessionId) || subject.isAnonymous !== false) {
        return { ok: false, code: "DB_REQUEST_INVALID" };
      }
      const session = await connect(); // throws: unreachable, outcome unknown (nothing was sent)
      const { client } = session;
      let phase: "before_call" | "after_call" = "before_call";
      try {
        await client.queryArray({ text: "BEGIN ISOLATION LEVEL READ COMMITTED" });
        await client.queryArray({ text: `SET LOCAL ROLE ${THREADS_API_ROLE}` });
        await client.queryArray({ text: "SET LOCAL statement_timeout = '15s'" });
        await client.queryArray({
          text: "SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', '', true)",
          // is_anonymous is the token's own explicit false carried in the subject (checked above), never a default.
          args: [JSON.stringify({ sub: subject.userId, role: "authenticated", session_id: subject.sessionId, is_anonymous: subject.isAnonymous })],
        });
        const result = await client.queryArray({ text: `SELECT coalesce(json_agg(r), '[]'::json)::text FROM ${target.sql}`, args: [...args] });
        phase = "after_call";
        await client.queryArray({ text: "COMMIT" });
        const text = result.rows[0]?.[0];
        if (typeof text !== "string") throw new Error("THREADS_RESERVATION_DB_ANSWER_INVALID");
        const rows = JSON.parse(text) as unknown;
        if (!Array.isArray(rows)) throw new Error("THREADS_RESERVATION_DB_ANSWER_INVALID");
        return { ok: true, rows: rows as Record<string, unknown>[] };
      } catch (error) {
        const server = serverError(error);
        if (phase === "after_call" || !server) {
          // The COMMIT may or may not have happened (or the connection broke): never report a definite answer.
          await client.queryArray({ text: "ROLLBACK" }).catch(() => undefined);
          throw new Error("THREADS_RESERVATION_DB_OUTCOME_UNKNOWN");
        }
        await client.queryArray({ text: "ROLLBACK" }).catch(() => undefined);
        if (CODE_RE.test(server.message)) return { ok: false, code: server.message };
        if (server.code === "55P03") return { ok: false, code: "POSTONA_RESV_SERVICE_BUSY" };
        return { ok: false, code: "DB_ERROR" };
      } finally {
        await session.release().catch(() => undefined);
      }
    },
  };
}
