/**
 * Real database adapter for the POSTONA Threads reservation DELIVERY worker -- G3 SOURCE CANDIDATE (2026-11-17, G3-02 #27). Not deployed.
 *
 * The Threads reservation ledger is its OWN table (postona_threads_resv.reservations, SQL 007 + 009 + 011 + 013), not G4's manual publish
 * attempt ledger: a reservation's owner, time, consent and lease live here; G4 decides the account (verdict + credential generation) inside
 * these functions and sends through its own two-step port. This adapter reaches exactly the four functions 007 grants to
 * postona_resv_worker, the same session protocol as the X delivery store (postgres_delivery_store.ts):
 *   BEGIN ISOLATION LEVEL READ COMMITTED
 *   SET LOCAL ROLE postona_resv_worker         -- a constant
 *   SET LOCAL statement_timeout = '15s'
 *   SELECT ... FROM postona_threads_resv.<claim_due | preflight | record | release_unsent>($1, ...)   -- bind parameters only
 *   COMMIT
 * There is no subject: the worker acts for no user; every row carries its owner and the SQL re-checks owner, account, G4 verdict, G5 state,
 * publish switch and the credential generation bound at claim.
 *
 * Outcomes: a definite answer of the function, or a THROW ("not known"). The dispatcher never sends on a throw; a claimed row it could not
 * hand back is fenced to 'uncertain' by the next claim when its lease has run out (never re-sent). Nothing is logged.
 */
import type { PgConnect } from "./postgres_db.ts";
import type { ClaimedThreadsReservation, ThreadsDispatchOutcome, ThreadsDispatchStore, ThreadsPreflight } from "./threads_dispatch.ts";

export const THREADS_WORKER_ROLE = "postona_resv_worker";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ACCOUNT_RE = /^[A-Za-z0-9_:-]{1,128}$/u;
const GENERATION_RE = /^[0-9a-f]{64}$/u;
const VERDICTS: readonly ThreadsPreflight["verdict"][] = ["OK", "LEASE_LOST", "NOT_PUBLISHABLE", "RELEASED"];
const RECORDED = ["published", "failed_before_send", "uncertain", "lease_lost"];
const RELEASES = ["released", "lease_lost"];

/** The server error message of a driver error when it is one of 007's fixed codes, else null. */
function fixedCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const fields = (error as { fields?: unknown }).fields;
  if (typeof fields !== "object" || fields === null) return null;
  const message = (fields as { message?: unknown }).message;
  return typeof message === "string" && /^POSTONA_THREADS_RESV_[A-Z_]{1,60}$/u.test(message) ? message : null;
}

/** Runs one fixed SELECT in one transaction as the worker role; returns the single text cell. */
async function once(connect: PgConnect, text: string, args: unknown[]): Promise<string> {
  const session = await connect();
  const { client } = session;
  try {
    await client.queryArray({ text: "BEGIN ISOLATION LEVEL READ COMMITTED" });
    await client.queryArray({ text: `SET LOCAL ROLE ${THREADS_WORKER_ROLE}` });
    await client.queryArray({ text: "SET LOCAL statement_timeout = '15s'" });
    const result = await client.queryArray({ text, args });
    await client.queryArray({ text: "COMMIT" });
    const cell = result.rows[0]?.[0];
    if (typeof cell !== "string") throw new Error("THREADS_WORKER_ANSWER_INVALID");
    return cell;
  } catch (error) {
    await client.queryArray({ text: "ROLLBACK" }).catch(() => undefined);
    throw new Error(fixedCode(error) ?? "THREADS_WORKER_OUTCOME_UNKNOWN");
  } finally {
    await session.release().catch(() => undefined);
  }
}

export function createPostgresThreadsDispatchStore(connect: PgConnect): ThreadsDispatchStore {
  return {
    async claimDue(worker: string, leaseSeconds: number, limit: number): Promise<ClaimedThreadsReservation[]> {
      const text = await once(connect,
        "SELECT coalesce(json_agg(c), '[]'::json)::text FROM postona_threads_resv.claim_due($1::text, $2::integer, $3::integer) c",
        [worker, String(leaseSeconds), String(limit)]);
      const rows = JSON.parse(text) as unknown;
      if (!Array.isArray(rows)) throw new Error("THREADS_WORKER_ANSWER_INVALID");
      return rows.map((row: Record<string, unknown>) => {
        const { reservation_id, lease_token, provider, social_account_id, body } = row ?? {};
        if (typeof reservation_id !== "string" || !UUID_RE.test(reservation_id) || typeof lease_token !== "string" || !UUID_RE.test(lease_token)
            || provider !== "threads" || typeof social_account_id !== "string" || !ACCOUNT_RE.test(social_account_id)
            || typeof body !== "string" || body.length === 0) {
          throw new Error("THREADS_WORKER_ANSWER_INVALID");
        }
        return { reservationId: reservation_id, leaseToken: lease_token, provider, socialAccountId: social_account_id, body };
      });
    },
    async preflight(reservationId: string, leaseToken: string): Promise<ThreadsPreflight> {
      const text = await once(connect,
        "SELECT coalesce(json_agg(p), '[]'::json)::text FROM postona_threads_resv.preflight($1::uuid, $2::uuid) p", [reservationId, leaseToken]);
      const rows = JSON.parse(text) as unknown;
      if (!Array.isArray(rows) || rows.length !== 1) throw new Error("THREADS_WORKER_ANSWER_INVALID");
      const { verdict, credential_generation } = (rows[0] ?? {}) as Record<string, unknown>;
      if (!(VERDICTS as readonly unknown[]).includes(verdict)) throw new Error("THREADS_WORKER_ANSWER_INVALID");
      if (verdict === "OK" && (typeof credential_generation !== "string" || !GENERATION_RE.test(credential_generation))) {
        throw new Error("THREADS_WORKER_ANSWER_INVALID");
      }
      return { verdict: verdict as ThreadsPreflight["verdict"], credentialGeneration: verdict === "OK" ? credential_generation as string : null };
    },
    async record(reservationId: string, leaseToken: string, outcome: ThreadsDispatchOutcome, providerPostId: string | null, code: string | null,
      transport: "threads" | "simulated"): Promise<string> {
      const answer = await once(connect, "SELECT postona_threads_resv.record($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text)",
        [reservationId, leaseToken, outcome, providerPostId, code, transport]);
      if (!RECORDED.includes(answer)) throw new Error("THREADS_WORKER_ANSWER_INVALID");
      return answer;
    },
    async releaseUnsent(reservationId: string, leaseToken: string): Promise<string> {
      const answer = await once(connect, "SELECT postona_threads_resv.release_unsent($1::uuid, $2::uuid)", [reservationId, leaseToken]);
      if (!RELEASES.includes(answer)) throw new Error("THREADS_WORKER_ANSWER_INVALID");
      return answer;
    },
  };
}
