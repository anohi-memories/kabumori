/**
 * Real database adapter for the POSTONA X approval API (G3-02 #16 SOURCE CANDIDATE). Not deployed. The same transaction shape as
 * ../postona_reservations/postgres_db.ts: BEGIN; SET LOCAL ROLE postona_resv_api (a constant); statement_timeout; the VERIFIED subject's
 * claims, local to the transaction; ONE fixed SQL 018 function with bind parameters; COMMIT. A POSTONA_RESV_* error => { ok: false, code }
 * (rolled back: nothing written); 55P03 => SERVICE_BUSY; another database error => DB_ERROR; a connection failure or an error after the
 * call may have committed => THROW (outcome unknown; the client reads back). Logs nothing.
 */
import type { ReservationSubject } from "../postona_reservations/api.ts";
import { API_ROLE, type PgConnect } from "../postona_reservations/postgres_db.ts";
import type { ApprovalDb, ApprovalDbFunction, ApprovalDbResult } from "./api.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CODE_RE = /^POSTONA_RESV_[A-Z_]{1,60}$/u;

/** Fixed calls: function name and typed bind parameters. Nothing else can be executed through this adapter. */
const CALLS: Record<ApprovalDbFunction, { sql: string; arity: number }> = {
  submit_approval: { sql: "postona_x_resv.submit_approval($1::text, $2::uuid, $3::text, $4::timestamptz)", arity: 4 },
  revise_approval: { sql: "postona_x_resv.revise_approval($1::uuid, $2::integer, $3::text, $4::timestamptz)", arity: 4 },
  approve_candidate: { sql: "postona_x_resv.approve_candidate($1::uuid, $2::integer, $3::text)", arity: 3 },
  reject_candidate: { sql: "postona_x_resv.reject_candidate($1::uuid, $2::integer)", arity: 2 },
  list_approvals: { sql: "postona_x_resv.list_approvals($1::text)", arity: 1 },
  get_approval: { sql: "postona_x_resv.get_approval($1::uuid)", arity: 1 },
  list_notifications: { sql: "postona_x_resv.list_notifications($1::integer)", arity: 1 },
  mark_notification_read: { sql: "postona_x_resv.mark_notification_read($1::uuid)", arity: 1 },
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

export function createPostgresApprovalDb(connect: PgConnect): ApprovalDb {
  return {
    async call(fn: ApprovalDbFunction, args: readonly unknown[], subject: ReservationSubject): Promise<ApprovalDbResult> {
      const target = CALLS[fn];
      if (!target || args.length !== target.arity || !UUID_RE.test(subject.userId) || !UUID_RE.test(subject.sessionId) || subject.isAnonymous !== false) {
        return { ok: false, code: "DB_REQUEST_INVALID" };
      }
      const session = await connect(); // throws: unreachable, outcome unknown (nothing was sent)
      const { client } = session;
      let phase: "before_call" | "after_call" = "before_call";
      try {
        await client.queryArray({ text: "BEGIN ISOLATION LEVEL READ COMMITTED" });
        await client.queryArray({ text: `SET LOCAL ROLE ${API_ROLE}` });
        await client.queryArray({ text: "SET LOCAL statement_timeout = '15s'" });
        await client.queryArray({
          text: "SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', '', true)",
          // G3-34 F1: is_anonymous is the token's own explicit false carried in the subject (checked above), never a default.
          args: [JSON.stringify({ sub: subject.userId, role: "authenticated", session_id: subject.sessionId, is_anonymous: subject.isAnonymous })],
        });
        const result = await client.queryArray({
          text: `SELECT coalesce(json_agg(r), '[]'::json)::text FROM ${target.sql} r`,
          args: args.map(bind),
        });
        phase = "after_call";
        await client.queryArray({ text: "COMMIT" });
        const text = result.rows[0]?.[0];
        if (typeof text !== "string") throw new Error("APPROVAL_DB_ANSWER_INVALID");
        return { ok: true, rows: JSON.parse(text) as Record<string, unknown>[] };
      } catch (error) {
        const server = serverError(error);
        if (phase === "after_call" || !server) {
          // The COMMIT may or may not have happened (or the connection broke): never report a definite answer.
          await client.queryArray({ text: "ROLLBACK" }).catch(() => undefined);
          throw new Error("APPROVAL_DB_OUTCOME_UNKNOWN");
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
