/**
 * Real database adapter for the POSTONA X reservation API (F3 SOURCE CANDIDATE, 2026-10-13). Not deployed.
 *
 * One call = one connection session = ONE transaction:
 *   BEGIN
 *   SET LOCAL ROLE postona_resv_api            -- a constant; the role is never taken from input
 *   SET LOCAL statement_timeout = '15s'
 *   set_config('request.jwt.claims' / 'request.jwt.claim.sub' / 'request.jwt.claim.role', ..., true)
 *                                              -- the VERIFIED subject only, local to the transaction
 *   SELECT ... FROM postona_x_resv.<one fixed owner function>($1, ...)   -- every value is a bind parameter
 *   COMMIT
 * The owner function re-checks owner, account, G5 and G4 inside this same transaction (and, with the G5 binding
 * candidate 003 applied, takes the common-account write fence locks until COMMIT).
 *
 * Outcomes: a POSTONA_RESV_* error from the function => { ok: false, code } (the transaction rolled back: nothing
 * was written); a lock timeout (55P03) => POSTONA_RESV_SERVICE_BUSY; any other database error => DB_ERROR; a
 * connection failure or an error after the call may have committed => THROW (the outcome is unknown and the
 * client must read back). The adapter logs nothing (no token, subject or row ever reaches a log).
 */
import type { DbResult, ReservationDb, ReservationDbFunction, ReservationRow } from "./api.ts";

/** The subset of a Postgres client this adapter needs; jsr:@db/postgres `Client` satisfies it. */
export type PgQueryClient = {
  queryArray(query: { text: string; args?: unknown[] }): Promise<{ rows: unknown[][] }>;
};
export type PgSession = { client: PgQueryClient; release(): Promise<void> };
export type PgConnect = () => Promise<PgSession>;

export const API_ROLE = "postona_resv_api";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CODE_RE = /^POSTONA_RESV_[A-Z_]{1,60}$/u;

/** Fixed calls: function name and typed bind parameters. Nothing else can be executed through this adapter. */
const CALLS: Record<ReservationDbFunction, { sql: string; arity: number }> = {
  create_batch: { sql: "postona_x_resv.create_batch($1::text, $2::uuid, $3::integer, $4::text, $5::jsonb, $6::jsonb)", arity: 6 },
  list_reservations: { sql: "postona_x_resv.list_reservations($1::text)", arity: 1 },
  get_reservation: { sql: "postona_x_resv.get_reservation($1::uuid)", arity: 1 },
  reschedule: { sql: "postona_x_resv.reschedule($1::uuid, $2::integer, $3::timestamptz)", arity: 3 },
  reconfirm: { sql: "postona_x_resv.reconfirm($1::uuid, $2::integer, $3::text)", arity: 3 },
  cancel: { sql: "postona_x_resv.cancel($1::uuid, $2::integer)", arity: 2 },
};

/** Bind value: JSON text for objects/arrays (jsonb), text for the rest, SQL NULL for null. */
function bind(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** The server error fields of a driver error (jsr:@db/postgres PostgresError), or null for anything else. */
function serverError(error: unknown): { code: string; message: string } | null {
  if (typeof error !== "object" || error === null) return null;
  const fields = (error as { fields?: unknown }).fields;
  if (typeof fields !== "object" || fields === null) return null;
  const { code, message } = fields as { code?: unknown; message?: unknown };
  return typeof code === "string" && typeof message === "string" ? { code, message } : null;
}

export function createPostgresReservationDb(connect: PgConnect): ReservationDb {
  return {
    async call(fn: ReservationDbFunction, args: readonly unknown[], subject: string): Promise<DbResult> {
      const target = CALLS[fn];
      if (!target || args.length !== target.arity || !UUID_RE.test(subject)) return { ok: false, code: "DB_REQUEST_INVALID" };
      const session = await connect(); // throws: unreachable, outcome unknown (nothing was sent)
      const { client } = session;
      let phase: "before_call" | "after_call" = "before_call";
      try {
        await client.queryArray({ text: "BEGIN ISOLATION LEVEL READ COMMITTED" });
        await client.queryArray({ text: `SET LOCAL ROLE ${API_ROLE}` });
        await client.queryArray({ text: "SET LOCAL statement_timeout = '15s'" });
        await client.queryArray({
          text: "SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), " +
            "set_config('request.jwt.claim.role', 'authenticated', true)",
          args: [JSON.stringify({ sub: subject, role: "authenticated" }), subject],
        });
        const result = await client.queryArray({
          text: `SELECT coalesce(json_agg(r), '[]'::json)::text FROM ${target.sql} r`,
          args: args.map(bind),
        });
        phase = "after_call";
        await client.queryArray({ text: "COMMIT" });
        const text = result.rows[0]?.[0];
        if (typeof text !== "string") throw new Error("RESERVATION_DB_ANSWER_INVALID");
        return { ok: true, rows: JSON.parse(text) as ReservationRow[] };
      } catch (error) {
        const server = serverError(error);
        if (phase === "after_call" || !server) {
          // The COMMIT may or may not have happened (or the connection broke): never report a definite answer.
          await client.queryArray({ text: "ROLLBACK" }).catch(() => undefined);
          throw new Error("RESERVATION_DB_OUTCOME_UNKNOWN");
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
