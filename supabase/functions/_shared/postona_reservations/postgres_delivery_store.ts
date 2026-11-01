/**
 * Real database adapter for the POSTONA X reservation DELIVERY worker (F3 SOURCE CANDIDATE, 2026-10-16). Not deployed.
 *
 * One call = one connection session = ONE transaction:
 *   BEGIN ISOLATION LEVEL READ COMMITTED       -- G5's decision refuses any other isolation
 *   SET LOCAL ROLE postona_resv_worker         -- a constant; executes exactly the four worker functions (004) + 015 bound check
 *   SET LOCAL statement_timeout = '15s'
 *   SELECT ... FROM postona_x_resv.<one fixed worker function>($1, ...)   -- every value is a bind parameter
 *   COMMIT
 * There is no subject: the worker acts for no user; every row carries its owner, and the SQL re-checks the owner,
 * account, G5 and G4 itself (G5's locks first, then the row).
 *
 * Outcomes: a definite answer of the function, or a THROW. A throw means "not known": the worker never sends on a
 * throw, and the rows it may have claimed age into 'uncertain' only if they were claimed and never handed back.
 * The adapter logs nothing (no row, text or post id ever reaches a log).
 */
import type { PgConnect } from "./postgres_db.ts";
import type { ClaimedReservation, FinishOutcome, PrePublishVerdict, ReservationDeliveryStore } from "./worker.ts";
import type { BoundPrePublish, BoundReservationDeliveryStore } from "./x_bound_delivery.ts";

export const WORKER_ROLE = "postona_resv_worker";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ACCOUNT_RE = /^[A-Za-z0-9_:-]{1,128}$/u;
const VERDICTS: readonly PrePublishVerdict[] = ["OK", "LEASE_LOST", "NOT_PUBLISHABLE", "RELEASED"];
const FINISHED = ["published", "failed_before_send", "uncertain", "lease_lost"];
const RELEASES = ["released", "lease_lost"];
const GENERATION_RE = /^[0-9a-f]{64}$/u;

/** The server error message of a driver error when it is one of our fixed codes, else null. */
function fixedCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const fields = (error as { fields?: unknown }).fields;
  if (typeof fields !== "object" || fields === null) return null;
  const message = (fields as { message?: unknown }).message;
  return typeof message === "string" && /^POSTONA_RESV_[A-Z_]{1,60}$/u.test(message) ? message : null;
}

/** Runs one fixed SELECT in one transaction as the worker role; returns the single text cell. */
async function once(connect: PgConnect, text: string, args: unknown[]): Promise<string> {
  const session = await connect();
  const { client } = session;
  try {
    await client.queryArray({ text: "BEGIN ISOLATION LEVEL READ COMMITTED" });
    await client.queryArray({ text: `SET LOCAL ROLE ${WORKER_ROLE}` });
    await client.queryArray({ text: "SET LOCAL statement_timeout = '15s'" });
    const result = await client.queryArray({ text, args });
    await client.queryArray({ text: "COMMIT" });
    const cell = result.rows[0]?.[0];
    if (typeof cell !== "string") throw new Error("RESERVATION_WORKER_ANSWER_INVALID");
    return cell;
  } catch (error) {
    await client.queryArray({ text: "ROLLBACK" }).catch(() => undefined);
    throw new Error(fixedCode(error) ?? "RESERVATION_WORKER_OUTCOME_UNKNOWN");
  } finally {
    await session.release().catch(() => undefined);
  }
}

export function createPostgresDeliveryStore(connect: PgConnect): ReservationDeliveryStore {
  return {
    async claimDue(worker: string, leaseSeconds: number, limit: number): Promise<ClaimedReservation[]> {
      const text = await once(connect,
        "SELECT coalesce(json_agg(c), '[]'::json)::text FROM postona_x_resv.claim_due($1::text, $2::integer, $3::integer) c",
        [worker, String(leaseSeconds), String(limit)]);
      const rows = JSON.parse(text) as Record<string, unknown>[];
      if (!Array.isArray(rows)) throw new Error("RESERVATION_WORKER_ANSWER_INVALID");
      return rows.map((row) => {
        const { reservation_id, lease_token, social_account_id, body } = row;
        if (typeof reservation_id !== "string" || !UUID_RE.test(reservation_id) || typeof lease_token !== "string" || !UUID_RE.test(lease_token)
            || typeof social_account_id !== "string" || !ACCOUNT_RE.test(social_account_id) || typeof body !== "string" || body.length === 0) {
          throw new Error("RESERVATION_WORKER_ANSWER_INVALID");
        }
        return { reservationId: reservation_id, leaseToken: lease_token, socialAccountId: social_account_id, body };
      });
    },
    async prePublishCheck(reservationId: string, leaseToken: string): Promise<PrePublishVerdict> {
      const verdict = await once(connect, "SELECT postona_x_resv.pre_publish_check($1::uuid, $2::uuid)", [reservationId, leaseToken]);
      if (!(VERDICTS as readonly string[]).includes(verdict)) throw new Error("RESERVATION_WORKER_ANSWER_INVALID");
      return verdict as PrePublishVerdict;
    },
    async finish(reservationId: string, leaseToken: string, outcome: FinishOutcome, providerPostId: string | null, code: string | null): Promise<string> {
      const recorded = await once(connect, "SELECT postona_x_resv.finish($1::uuid, $2::uuid, $3::text, $4::text, $5::text)",
        [reservationId, leaseToken, outcome, providerPostId, code]);
      if (!FINISHED.includes(recorded)) throw new Error("RESERVATION_WORKER_ANSWER_INVALID");
      return recorded;
    },
    async releaseUnsent(reservationId: string, leaseToken: string): Promise<string> {
      const answer = await once(connect, "SELECT postona_x_resv.release_unsent($1::uuid, $2::uuid)", [reservationId, leaseToken]);
      if (!RELEASES.includes(answer)) throw new Error("RESERVATION_WORKER_ANSWER_INVALID");
      return answer;
    },
  };
}

/**
 * G3-49: the same store with 015's bound pre-send check (postona_x_resv.pre_publish_check_bound) in place of 004's verdict-only one,
 * for x_bound_delivery.ts. One row: { verdict, credential_generation }; the generation is answered only with OK (64 hex), else null.
 * Any other shape is a throw (never sent).
 */
export function createPostgresBoundDeliveryStore(connect: PgConnect): BoundReservationDeliveryStore {
  const { claimDue, finish, releaseUnsent } = createPostgresDeliveryStore(connect);
  return {
    claimDue,
    finish,
    releaseUnsent,
    async prePublishCheckBound(reservationId: string, leaseToken: string): Promise<BoundPrePublish> {
      const text = await once(connect,
        "SELECT coalesce(json_agg(r), '[]'::json)::text FROM postona_x_resv.pre_publish_check_bound($1::uuid, $2::uuid) r", [reservationId, leaseToken]);
      const rows = JSON.parse(text) as Record<string, unknown>[];
      if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0] !== "object" || rows[0] === null) throw new Error("RESERVATION_WORKER_ANSWER_INVALID");
      const { verdict, credential_generation } = rows[0];
      if (typeof verdict !== "string" || !(VERDICTS as readonly string[]).includes(verdict)) throw new Error("RESERVATION_WORKER_ANSWER_INVALID");
      if (verdict === "OK" ? !(credential_generation === null || (typeof credential_generation === "string" && GENERATION_RE.test(credential_generation)))
          : credential_generation !== null) {
        throw new Error("RESERVATION_WORKER_ANSWER_INVALID");
      }
      return { verdict: verdict as PrePublishVerdict, credentialGeneration: credential_generation as string | null };
    },
  };
}
