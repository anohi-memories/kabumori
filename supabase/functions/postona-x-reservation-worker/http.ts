// HTTP entry of the POSTONA X reservation delivery worker. F3 SOURCE CANDIDATE (2026-10-16; G3-50 2026-10-30: generation-bound
// delivery): not deployed, release gate OFF, no Cron.
//
// With the gate OFF (the source constant) every request answers 503 NOT_AVAILABLE before the environment, the body,
// the database or X is touched. Behind the gate (only after the reviewed rollout):
//   caller : a scheduler holding the server-side secret POSTONA_RESV_WORKER_SECRET (header x-postona-worker-secret,
//            compared in constant time). It acts for no user: there is no user token and no user id in the request.
//            G3-02 #11 (H4-17 P1): the database's tick (SQL 016, through pg_net, whose queue other roles may read) never sends
//            that secret. It sends a one-use ticket instead, x-postona-worker-tick: v1.<ref>.<unix s>.<nonce>.<HMAC-SHA256>
//            keyed with the same secret. Accepted only when the HMAC matches (constant time), <ref> is this project's own (from
//            SUPABASE_URL https://<ref>.supabase.co), the time is within 120 s, and the database's consume_worker_tick(nonce)
//            answers true -- once, for a nonce a tick issued. Anything else: 401, nothing claimed or sent.
//   DB     : one transaction per step as a login role that is a member of postona_resv_worker (SQL candidates 004 + 014 +
//            015) via POSTONA_RESV_WORKER_DATABASE_URL -- never service_role, never an owner credential.
//   run    : x_bound_delivery.ts (G3-49): claim (014 pins the credential generation) -> ONE credentialFor(account) -> 015's
//            pre_publish_check_bound -> exactly one X create (x_publisher.ts, a one-shot source of that token) only when the
//            token's generation equals the generation pinned at claim; otherwise never sent (failed_before_send), unknown ->
//            uncertain, never re-sent.
//   X      : the G4-owned GENERATION-BOUND source { token, generation } read in ONE snapshot (x_credential_generation.ts;
//            or G4's raw generation through credential_generation_derivation.ts). A token-only source (x_publisher.ts port) is
//            not accepted. Until G4 delivers a reviewed one the source is X_GENERATION_CREDENTIALS_NOT_CONNECTED: the run
//            claims NOTHING and opens no database connection.
//   time   : the run stops claiming new sends after RUN_BUDGET_MS or when the request is aborted; whatever it claimed
//            and did not send is handed back to 'planned' (graceful shutdown), never left to become 'uncertain'.
// The answer carries counts only (no row, text, post id or account). Nothing is logged.
import { createPostgresBoundDeliveryStore, WORKER_ROLE } from "../_shared/postona_reservations/postgres_delivery_store.ts";
import type { PgConnect } from "../_shared/postona_reservations/postgres_db.ts";
import { runBoundXReservationDelivery } from "../_shared/postona_reservations/x_bound_delivery.ts";
import {
  generationSourceOf,
  X_GENERATION_CREDENTIALS_NOT_CONNECTED,
  type XPostingGenerationCredentialSource,
} from "../_shared/postona_reservations/x_credential_generation.ts";
import { createXReservationPublisher } from "../_shared/postona_reservations/x_publisher.ts";

export const POSTONA_RESERVATION_WORKER_ENABLED = false as const;
export const WORKER_NAME = "postona-x-worker";
const RUN_BUDGET_MS = 45_000;
const SECRET_HEADER = "x-postona-worker-secret";
const TICK_HEADER = "x-postona-worker-tick";
const TICK_RE = /^v1\.([a-z0-9]{20})\.([0-9]{10})\.([0-9a-f]{64})\.([0-9a-f]{64})$/u;
const PROJECT_URL_RE = /^https:\/\/([a-z0-9]{20})\.supabase\.co$/u;
const TICK_MAX_SKEW_SECONDS = 120;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The tick's nonce, consumed once in the database as the worker role (016's consume_worker_tick). */
async function consumeTickInDatabase(connect: PgConnect, nonce: string): Promise<boolean> {
  const session = await connect();
  const { client } = session;
  try {
    await client.queryArray({ text: "BEGIN ISOLATION LEVEL READ COMMITTED" });
    await client.queryArray({ text: `SET LOCAL ROLE ${WORKER_ROLE}` });
    await client.queryArray({ text: "SET LOCAL statement_timeout = '15s'" });
    const result = await client.queryArray({ text: "select postona_x_resv.consume_worker_tick($1)::text", args: [nonce] });
    await client.queryArray({ text: "COMMIT" });
    return result.rows[0]?.[0] === "true";
  } catch (error) {
    await client.queryArray({ text: "ROLLBACK" }).catch(() => undefined);
    throw error;
  } finally {
    await session.release().catch(() => undefined);
  }
}

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
  /** Tests only (MOCK_ONLY). Production: X_GENERATION_CREDENTIALS_NOT_CONNECTED until G4 delivers a reviewed generation-bound source. */
  credentials?: XPostingGenerationCredentialSource;
  /** Tests only: a fake X. */
  fetch?: FetchLike;
  now?: () => number;
  runBudgetMs?: number;
  /** Tests only (a local stack has no https://<ref>.supabase.co): the project ref a tick's ticket must name. */
  projectRef?: string;
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
    const ticket = request.headers.get(TICK_HEADER);
    let tickNonce: string | null = null;
    if (ticket !== null) {
      const ref = overrides.projectRef ?? PROJECT_URL_RE.exec(env.get("SUPABASE_URL") ?? "")?.[1];
      const parts = TICK_RE.exec(ticket);
      if (!ref || !parts || parts[1] !== ref || Math.abs(now() / 1000 - Number(parts[2])) > TICK_MAX_SKEW_SECONDS
          || !(await sameSecret(parts[4], await hmacHex(secret, `v1.${parts[1]}.${parts[2]}.${parts[3]}`)))) {
        return json(401, { ok: false, code: "WORKER_AUTH_REQUIRED" });
      }
      tickNonce = parts[3];
    } else if (!(await sameSecret(request.headers.get(SECRET_HEADER) ?? "", secret))) {
      return json(401, { ok: false, code: "WORKER_AUTH_REQUIRED" });
    }
    await request.body?.cancel().catch(() => undefined); // the run takes no input
    // No generation-bound source (the production default, or a token-only one): nothing to claim, so no connection either.
    const credentials = generationSourceOf(overrides.credentials ?? X_GENERATION_CREDENTIALS_NOT_CONNECTED);
    if (credentials.available !== true) {
      return json(200, { ok: true, report: { claimed: 0, sends: 0, published: 0, failedBeforeSend: 0, uncertain: 0, skipped: 0, released: 0, notAvailable: true, stopped: false } });
    }
    let connect: PgConnect;
    try {
      connect = overrides.connect ?? (overrides.createConnect ?? (() => { throw new Error("NO_DRIVER"); }))(databaseUrl);
    } catch {
      return json(503, { ok: false, code: "NOT_CONFIGURED" });
    }
    if (tickNonce !== null) {
      let fresh: boolean;
      try {
        fresh = await consumeTickInDatabase(connect, tickNonce);
      } catch {
        return json(503, { ok: false, code: "STORE_UNAVAILABLE" });
      }
      // a replayed, unknown or expired ticket: nothing is claimed
      if (!fresh) return json(401, { ok: false, code: "WORKER_TICK_REJECTED" });
    }
    const deadline = now() + (overrides.runBudgetMs ?? RUN_BUDGET_MS);
    try {
      const report = await runBoundXReservationDelivery({
        store: createPostgresBoundDeliveryStore(connect),
        credentials,
        publisherFor: (source) => createXReservationPublisher({ credentials: source, fetch: overrides.fetch }),
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
