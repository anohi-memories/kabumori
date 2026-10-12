// HTTP layer for postona-x-reservations. F3 SOURCE CANDIDATE: not deployed, release gate OFF.
//
// With the gate OFF (the source constant) every request answers 503 NOT_AVAILABLE before the environment, the
// body, Auth or the database is touched. Behind the gate (only after the reviewed rollout):
//   Auth : GET /auth/v1/user with the CALLER'S token + the public anon key (live, every request)
//   DB   : one transaction per request as a login role that is a member of postona_resv_api (see
//          _shared/postona_reservations/postgres_db.ts); its connection string is a server-side secret
//   G5/G4: decided inside the database (G5 binding candidate 003; G4 still DENY). The TS permission port stays
//          PERMISSIONS_NOT_CONNECTED (deny) until the owners deliver reviewed decisions.
// This file holds no service-role key, never reads one, never logs, and never calls X.
import {
  type ApiRequest,
  createReservationApi,
  type PermissionSources,
  PERMISSIONS_NOT_CONNECTED,
  POSTONA_RESERVATION_API_ENABLED,
} from "../_shared/postona_reservations/api.ts";
import { createPostgresReservationDb, type PgConnect } from "../_shared/postona_reservations/postgres_db.ts";
import { createSupabaseAuthVerifier } from "../_shared/postona_reservations/supabase_auth.ts";

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
  /** Tests only. Production uses POSTONA_RESERVATION_API_ENABLED (false). */
  enabled?: boolean;
  fetch?: FetchLike;
  /** Tests only: a connection factory (production builds it from POSTONA_RESV_DATABASE_URL). */
  connect?: PgConnect;
  /** Tests only (MOCK_ONLY). Production: PERMISSIONS_NOT_CONNECTED until G5 / G4 deliver. */
  permissions?: PermissionSources;
  createConnect?: (databaseUrl: string) => PgConnect;
};

export function createHttpHandler(env: { get(name: string): string | undefined }, overrides: HttpOverrides = {}) {
  const enabled = overrides.enabled ?? POSTONA_RESERVATION_API_ENABLED;
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
    const api = createReservationApi({
      enabled: true,
      auth,
      permissions: overrides.permissions ?? PERMISSIONS_NOT_CONNECTED,
      db: createPostgresReservationDb(connect),
    });
    const answer = await api(apiRequest);
    return json(answer.status, answer.body);
  };
}
