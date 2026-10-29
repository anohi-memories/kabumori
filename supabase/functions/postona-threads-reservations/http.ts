// HTTP layer for postona-threads-reservations. G3 SOURCE CANDIDATE (2026-10-30, Issue #318 G3-46): not deployed, release gate OFF.
//
// With the gate OFF (the source constant) every request answers 503 NOT_AVAILABLE before the environment, the body, Auth or the
// database is touched. Behind the gate (only after the reviewed rollout):
//   Auth : GET /auth/v1/user with the CALLER'S token + the public anon key (live, every request); the same token's session_id and
//          is_anonymous JSON false (shared with the X API)
//   DB   : one transaction per request as a login role that is a member of postona_resv_api (see
//          _shared/postona_reservations/threads_postgres_db.ts); its connection string is a server-side secret, the same as the X entry's
//   G5/G4: create is pre-gated by the TS permission port, THREADS_PERMISSIONS_NOT_CONNECTED (deny) until the owners deliver reviewed
//          decisions, and re-checked inside the database (007's fence; G4 still DENY). cancel / receipt: the person session and row
//          ownership, decided in the database.
// This file holds no service-role key, never reads one, never logs, and never calls Threads.
import { createSupabaseAuthVerifier } from "../_shared/postona_reservations/supabase_auth.ts";
import type { ApiRequest } from "../_shared/postona_reservations/api.ts";
import type { PgConnect } from "../_shared/postona_reservations/postgres_db.ts";
import {
  createThreadsReservationApi,
  POSTONA_THREADS_RESERVATION_API_ENABLED,
  type ThreadsPermissionSources,
  THREADS_PERMISSIONS_NOT_CONNECTED,
} from "../_shared/postona_reservations/threads_api.ts";
import { createPostgresThreadsReservationDb } from "../_shared/postona_reservations/threads_postgres_db.ts";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const MAX_BODY_BYTES = 64 * 1024;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/** Reads at most MAX_BODY_BYTES + 1 bytes; null when the body is larger (no unbounded buffering). */
async function readBoundedText(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(all);
}

export type HttpOverrides = {
  /** Tests only. Production uses POSTONA_THREADS_RESERVATION_API_ENABLED (false). */
  enabled?: boolean;
  fetch?: FetchLike;
  /** Tests only: a connection factory (production builds it from POSTONA_RESV_DATABASE_URL). */
  connect?: PgConnect;
  /** Tests only (MOCK_ONLY). Production: THREADS_PERMISSIONS_NOT_CONNECTED until G5 / G4 deliver. */
  permissions?: ThreadsPermissionSources;
  createConnect?: (databaseUrl: string) => PgConnect;
};

export function createHttpHandler(env: { get(name: string): string | undefined }, overrides: HttpOverrides = {}) {
  const enabled = overrides.enabled ?? POSTONA_THREADS_RESERVATION_API_ENABLED;
  return async (request: Request): Promise<Response> => {
    if (enabled !== true) return json(503, { ok: false, code: "NOT_AVAILABLE" });
    const supabaseUrl = env.get("SUPABASE_URL") ?? "";
    const anonKey = env.get("SUPABASE_ANON_KEY") ?? "";
    const databaseUrl = env.get("POSTONA_RESV_DATABASE_URL") ?? "";
    // Deliberately does not say which value is missing.
    if (!supabaseUrl || !anonKey || (!databaseUrl && !overrides.connect)) return json(503, { ok: false, code: "NOT_CONFIGURED" });
    let connect: PgConnect;
    let auth;
    try {
      connect = overrides.connect ?? (overrides.createConnect ?? (() => { throw new Error("NO_DRIVER"); }))(databaseUrl);
      auth = createSupabaseAuthVerifier({ supabaseUrl, anonKey, fetch: overrides.fetch });
    } catch {
      return json(503, { ok: false, code: "NOT_CONFIGURED" });
    }
    const body = await readBoundedText(request);
    if (body === null) return json(413, { ok: false, code: "REQUEST_TOO_LARGE" });
    const apiRequest: ApiRequest = { method: request.method, authorization: request.headers.get("authorization"), body };
    const api = createThreadsReservationApi({
      enabled: true,
      auth,
      permissions: overrides.permissions ?? THREADS_PERMISSIONS_NOT_CONNECTED,
      db: createPostgresThreadsReservationDb(connect),
    });
    const answer = await api(apiRequest);
    return json(answer.status, answer.body);
  };
}
