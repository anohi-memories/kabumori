/**
 * HTTP handler of the POSTONA Threads reservation DELIVERY worker -- G3 SOURCE CANDIDATE (2026-11-17, G3-02 #27). Wired to NO deployed
 * Edge entry, no Cron, no tick: only the local stack's TEST ONLY twin (postona-threads-reservation-worker-e2etest) serves it.
 * THREADS_RESERVATION_WORKER_ENABLED = false: every request answers 503 NOT_AVAILABLE before the environment, the body or the database is
 * touched.
 *
 * Ledger: the reservation is G3's own Threads ledger (postona_threads_resv, 007 / 009 / 011 / 013), NOT G4's manual publish attempt
 * ledger. A manual "post now" attempt and a reservation have different intents, times and re-run rules, so a reservation is never an
 * attempt row and an attempt is never a reservation; what they share is G4's account contract, read inside 007's functions (G4's
 * threads_publish_credential_verdict + the credential generation, the publish switch, G5's bound state) and G4's two-step send port.
 *
 * Behind the gate (only after the reviewed rollout and an approved deploy):
 *   caller  a scheduler holding POSTONA_RESV_WORKER_SECRET (header x-postona-worker-secret, constant-time compare). No user, no user id.
 *           (X's one-use pg_net tick, 016, is X-only; a Threads tick is not designed here.)
 *   DB      POSTONA_RESV_WORKER_DATABASE_URL: a login member of postona_resv_worker (never service_role / an owner).
 *   run     threads_dispatch.ts: claim (007 binds the credential generation) -> ONE credentialFor -> 007 preflight -> G4 two-step send
 *           with the pre-publish hook (007 preflight again, same generation) -> record. Exactly one send per lease, never retried; an
 *           unknown is 'uncertain' and never re-sent; an expired lease becomes 'uncertain' at the next claim (no clock-based retry).
 *   ports   G4's generation-bound credential port and two-step send port. Until G4 delivers reviewed, enabled ones both are NOT
 *           CONNECTED here: the run claims NOTHING and opens no database connection.
 *   time    the run stops claiming after RUN_BUDGET_MS or on abort; claimed rows not yet sent are handed back (never left to age).
 * The answer carries counts only (no row, text, media id, account or token). Nothing is logged.
 */
import type { PgConnect } from "./postgres_db.ts";
import { runThreadsReservationDelivery, type ThreadsCredentialPort, type ThreadsSendPort } from "./threads_dispatch.ts";
import { createPostgresThreadsDispatchStore } from "./threads_worker_store.ts";

export const THREADS_RESERVATION_WORKER_ENABLED = false as const;
export const THREADS_WORKER_NAME = "postona-threads-worker";
const RUN_BUDGET_MS = 45_000;
const SECRET_HEADER = "x-postona-worker-secret";

/** G4's ports are not delivered to G3: nothing can be claimed. */
export const THREADS_CREDENTIALS_NOT_CONNECTED: ThreadsCredentialPort = Object.freeze({
  available: false,
  credentialFor: () => Promise.resolve(null),
});
export const THREADS_SEND_NOT_CONNECTED: ThreadsSendPort = Object.freeze({
  available: false,
  transport: "simulated" as const,
  send: () => Promise.resolve({ kind: "not_written" as const, stage: "container" as const, code: "THREADS_SEND_NOT_CONNECTED" }),
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

/** Constant-time equality of two secrets (compares their SHA-256 digests byte by byte). */
async function sameSecret(given: string, expected: string): Promise<boolean> {
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export type ThreadsWorkerHttpOverrides = {
  /** Tests only. Production uses THREADS_RESERVATION_WORKER_ENABLED (false). */
  enabled?: boolean;
  connect?: PgConnect;
  createConnect?: (databaseUrl: string) => PgConnect;
  /** Tests only (MOCK_ONLY). Production: THREADS_CREDENTIALS_NOT_CONNECTED until G4 delivers a reviewed generation-bound port. */
  credentials?: ThreadsCredentialPort;
  /** Tests only (MOCK_ONLY). Production: THREADS_SEND_NOT_CONNECTED until G4 delivers a reviewed, enabled two-step send port. */
  sender?: ThreadsSendPort;
  now?: () => number;
  runBudgetMs?: number;
  leaseSeconds?: number;
  limit?: number;
};

const NOT_AVAILABLE_REPORT = Object.freeze({
  claimed: 0, published: 0, failedBeforeSend: 0, uncertain: 0, released: 0, skipped: 0, sends: 0, prepublishRechecks: 0, prepublishRefused: 0,
  notAvailable: true, stopped: false,
});

export function createThreadsWorkerHandler(env: { get(name: string): string | undefined }, overrides: ThreadsWorkerHttpOverrides = {}) {
  const enabled = overrides.enabled ?? THREADS_RESERVATION_WORKER_ENABLED;
  const now = overrides.now ?? Date.now;
  return async (request: Request): Promise<Response> => {
    if (enabled !== true) return json(503, { ok: false, code: "NOT_AVAILABLE" });
    if (request.method !== "POST") return json(405, { ok: false, code: "METHOD_NOT_ALLOWED" });
    const secret = env.get("POSTONA_RESV_WORKER_SECRET") ?? "";
    const databaseUrl = env.get("POSTONA_RESV_WORKER_DATABASE_URL") ?? "";
    // Deliberately does not say which value is missing.
    if (secret.length < 32 || (!databaseUrl && !overrides.connect)) return json(503, { ok: false, code: "NOT_CONFIGURED" });
    if (!(await sameSecret(request.headers.get(SECRET_HEADER) ?? "", secret))) return json(401, { ok: false, code: "WORKER_AUTH_REQUIRED" });
    await request.body?.cancel().catch(() => undefined); // the run takes no input
    const credentials = overrides.credentials ?? THREADS_CREDENTIALS_NOT_CONNECTED;
    const sender = overrides.sender ?? THREADS_SEND_NOT_CONNECTED;
    // Either G4 port missing (the production default): nothing to claim, so no connection either.
    if (credentials.available !== true || sender.available !== true) return json(200, { ok: true, report: NOT_AVAILABLE_REPORT });
    let connect: PgConnect;
    try {
      connect = overrides.connect ?? (overrides.createConnect ?? (() => { throw new Error("NO_DRIVER"); }))(databaseUrl);
    } catch {
      return json(503, { ok: false, code: "NOT_CONFIGURED" });
    }
    const deadline = now() + (overrides.runBudgetMs ?? RUN_BUDGET_MS);
    try {
      const report = await runThreadsReservationDelivery({
        enabled: true,
        store: createPostgresThreadsDispatchStore(connect),
        credentials,
        sender,
        worker: THREADS_WORKER_NAME,
        leaseSeconds: overrides.leaseSeconds,
        limit: overrides.limit,
        shouldStop: () => request.signal.aborted || now() >= deadline,
      });
      return json(200, { ok: true, report });
    } catch {
      // The claim itself could not be read: nothing was sent by this run.
      return json(503, { ok: false, code: "STORE_UNAVAILABLE" });
    }
  };
}
