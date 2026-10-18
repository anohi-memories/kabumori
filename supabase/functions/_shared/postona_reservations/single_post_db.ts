/**
 * Database adapter for the POSTONA X single manual post (F3 SOURCE CANDIDATE, 2026-10-18, M1). Not deployed.
 *
 * Same discipline as postgres_db.ts (the reservation API adapter): one call = one session = ONE READ COMMITTED
 * transaction as postona_resv_api, the VERIFIED subject in request.jwt.claims (local to the transaction), every value a
 * bind parameter, one fixed function. In addition the claims carry the token's session_id: G5's T13 guard (inside
 * post_now_begin / post_now_check) requires it to be a live row of auth.sessions, so a signed-out token cannot send.
 * Outcomes: { ok: true, rows } | { ok: false, code } (a POSTONA_RESV_* refusal: rolled back, nothing written) | THROW
 * (connection failure or an error after the call: the outcome is unknown -- the caller must read back, never resend).
 * Nothing is logged.
 */
import type { PgConnect } from "./postgres_db.ts";

export type SinglePostFunction = "begin" | "check" | "finish" | "get";
export type SinglePostDbResult = { ok: true; rows: Record<string, unknown>[] } | { ok: false; code: string };
export type SinglePostSubject = { userId: string; sessionId: string };
export type SinglePostDb = { call(fn: SinglePostFunction, args: readonly unknown[], subject: SinglePostSubject): Promise<SinglePostDbResult> };

export const SINGLE_POST_ROLE = "postona_resv_api";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CODE_RE = /^POSTONA_RESV_[A-Z_]{1,60}$/u;
const CALLS: Record<SinglePostFunction, { sql: string; arity: number; scalar: boolean }> = {
  begin: { sql: "postona_x_resv.post_now_begin($1::text, $2::uuid, $3::text, $4::text)", arity: 4, scalar: false },
  check: { sql: "postona_x_resv.post_now_check($1::uuid, $2::uuid)", arity: 2, scalar: true },
  finish: { sql: "postona_x_resv.post_now_finish($1::uuid, $2::uuid, $3::text, $4::text, $5::text)", arity: 5, scalar: true },
  get: { sql: "postona_x_resv.post_now_get($1::uuid)", arity: 1, scalar: false },
};

function serverError(error: unknown): { code: string; message: string } | null {
  if (typeof error !== "object" || error === null) return null;
  const fields = (error as { fields?: unknown }).fields;
  if (typeof fields !== "object" || fields === null) return null;
  const { code, message } = fields as { code?: unknown; message?: unknown };
  return typeof code === "string" && typeof message === "string" ? { code, message } : null;
}

export function createSinglePostDb(connect: PgConnect): SinglePostDb {
  return {
    async call(fn, args, subject) {
      const target = CALLS[fn];
      if (!target || args.length !== target.arity || !UUID_RE.test(subject.userId) || !UUID_RE.test(subject.sessionId)) {
        return { ok: false, code: "DB_REQUEST_INVALID" };
      }
      const session = await connect();
      const { client } = session;
      let phase: "before_call" | "after_call" = "before_call";
      try {
        await client.queryArray({ text: "BEGIN ISOLATION LEVEL READ COMMITTED" });
        await client.queryArray({ text: `SET LOCAL ROLE ${SINGLE_POST_ROLE}` });
        await client.queryArray({ text: "SET LOCAL statement_timeout = '15s'" });
        await client.queryArray({
          text: "SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', '', true)",
          args: [JSON.stringify({ sub: subject.userId, role: "authenticated", session_id: subject.sessionId })],
        });
        const text = target.scalar ? `SELECT json_build_array(json_build_object('answer', ${target.sql}))::text` : `SELECT coalesce(json_agg(r), '[]'::json)::text FROM ${target.sql} r`;
        const result = await client.queryArray({ text, args: args.map((v) => (v === null || v === undefined ? null : String(v))) });
        phase = "after_call";
        await client.queryArray({ text: "COMMIT" });
        const cell = result.rows[0]?.[0];
        if (typeof cell !== "string") throw new Error("SINGLE_POST_DB_ANSWER_INVALID");
        const rows = JSON.parse(cell);
        if (!Array.isArray(rows)) throw new Error("SINGLE_POST_DB_ANSWER_INVALID");
        return { ok: true, rows };
      } catch (error) {
        const server = serverError(error);
        await client.queryArray({ text: "ROLLBACK" }).catch(() => undefined);
        if (phase === "after_call" || !server) throw new Error("SINGLE_POST_DB_OUTCOME_UNKNOWN");
        if (CODE_RE.test(server.message)) return { ok: false, code: server.message };
        if (server.code === "55P03") return { ok: false, code: "POSTONA_RESV_SERVICE_BUSY" };
        return { ok: false, code: "DB_ERROR" };
      } finally {
        await session.release().catch(() => undefined);
      }
    },
  };
}
