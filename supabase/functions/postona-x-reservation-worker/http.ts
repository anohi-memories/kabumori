// HTTP entry of the POSTONA X reservation delivery worker. F3 SOURCE CANDIDATE (2026-10-16): not deployed, release
// gate OFF, no Cron.
//
// With the gate OFF (the source constant) every request answers 503 NOT_AVAILABLE before the environment, the body,
// the database or X is touched. Behind the gate (only after the reviewed rollout):
//   caller : a scheduler holding the server-side secret POSTONA_RESV_WORKER_SECRET (header x-postona-worker-secret,
//            compared in constant time). It acts for no user: there is no user token and no user id in the request.
//   DB     : one transaction per step as a login role that is a member of postona_resv_worker (SQL candidate 004)
//            via POSTONA_RESV_WORKER_DATABASE_URL -- never service_role, never an owner credential.
//   X      : x_publisher.ts with the G4-owned credential source. Until G4 delivers it (Issue #131) the source is
//            X_CREDENTIALS_NOT_CONNECTED: the publisher is unavailable and the run claims NOTHING.
//   time   : the run stops claiming new sends after RUN_BUDGET_MS or when the request is aborted; whatever it claimed
//            and did not send is handed back to 'planned' (graceful shutdown), never left to become 'uncertain'.
// The answer carries counts only (no row, text, post id or account). Nothing is logged.
import { createPostgresDeliveryStore } from "../_shared/postona_reservations/postgres_delivery_store.ts";
import type { PgConnect } from "../_shared/postona_reservations/postgres_db.ts";
import { runReservationDelivery } from "../_shared/postona_reservations/worker.ts";
import {
  createXReservationPublisher,
  X_CREDENTIALS_NOT_CONNECTED,
  type XPostingCredentialSource,
} from "../_shared/postona_reservations/x_publisher.ts";

export const POSTONA_RESERVATION_WORKER_ENABLED = false as const;
export const WORKER_NAME = "postona-x-worker";
const RUN_BUDGET_MS = 45_000;
const SECRET_HEADER = "x-postona-worker-secret";
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

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

export type WorkerHttpOverrides = {
  /** Tests only. Production uses POSTONA_RESERVATION_WORKER_ENABLED (false). */
  enabled?: boolean;
  /** Tests only: a connection factory (production builds it from POSTONA_RESV_WORKER_DATABASE_URL). */
  connect?: PgConnect;
  createConnect?: (databaseUrl: string) => PgConnect;
  /** Tests only (MOCK_ONLY). Production: X_CREDENTIALS_NOT_CONNECTED until G4 delivers a reviewed source. */
  credentials?: XPostingCredentialSource;
  /** Tests only: a fake X. */
  fetch?: FetchLike;
  now?: () => number;
  runBudgetMs?: number;
};

export function createWorkerHandler(env: { get(name: string): string | undefined }, overrides: WorkerHttpOverrides = {}) {
  const enabled = overrides.enabled ?? POSTONA_RESERVATION_WORKER_ENABLED;
  const now = overrides.now ?? Date.now;
  return async (request: Request): Promise<Response> => {
    if (enabled !== true) return json(503, { ok: false, code: "NOT_AVAILABLE" });
    if (request.method !== "POST") return json(405, { ok: false, code: "METHOD_NOT_ALLOWED" });
    const secret = env.get("POSTONA_RESV_WORKER_SECRET") ?? "";
    const databaseUrl = env.get("POSTONA_RESV_WORKER_DATABASE_URL") ?? "";
    // Deliberately does not say which value is missing.
    if (secret.length < 32 || (!databaseUrl && !overrides.connect)) return json(503, { ok: false, code: "NOT_CONFIGURED" });
    const given = request.headers.get(SECRET_HEADER) ?? "";
    if (!(await sameSecret(given, secret))) return json(401, { ok: false, code: "WORKER_AUTH_REQUIRED" });
    await request.body?.cancel().catch(() => undefined); // the run takes no input
    let connect: PgConnect;
    try {
      connect = overrides.connect ?? (overrides.createConnect ?? (() => { throw new Error("NO_DRIVER"); }))(databaseUrl);
    } catch {
      return json(503, { ok: false, code: "NOT_CONFIGURED" });
    }
    const deadline = now() + (overrides.runBudgetMs ?? RUN_BUDGET_MS);
    const publisher = createXReservationPublisher({ credentials: overrides.credentials ?? X_CREDENTIALS_NOT_CONNECTED, fetch: overrides.fetch });
    try {
      const report = await runReservationDelivery({
        store: createPostgresDeliveryStore(connect),
        publisher,
        worker: WORKER_NAME,
        shouldStop: () => request.signal.aborted || now() >= deadline,
      });
      return json(200, { ok: true, report });
    } catch {
      // The claim itself could not be read: nothing was sent by this run.
      return json(503, { ok: false, code: "STORE_UNAVAILABLE" });
    }
  };
}
