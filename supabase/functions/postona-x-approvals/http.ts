// HTTP layer for postona-x-approvals (G3-02 #16 SOURCE CANDIDATE): not deployed, release gate OFF.
//
// With the gate OFF (the source constant) every request answers 503 NOT_AVAILABLE before the environment, the body, Auth or the
// database is touched. Behind the gate (only after a reviewed rollout): Auth as the reservation API does (GET /auth/v1/user with the
// caller's token + the public anon key); one transaction per request as a login role that is a member of postona_resv_api
// (_shared/postona_approvals/postgres_db.ts; the same POSTONA_RESV_DATABASE_URL secret as postona-x-reservations). Every permission is
// decided in SQL 018 / 001. This file holds no service-role key, never logs, and calls no provider and no push service.
import { type ApprovalRequest, createApprovalApi, POSTONA_APPROVAL_API_ENABLED } from "../_shared/postona_approvals/api.ts";
import { createPostgresApprovalDb } from "../_shared/postona_approvals/postgres_db.ts";
import type { PgConnect } from "../_shared/postona_reservations/postgres_db.ts";
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
  /** Tests only. Production uses POSTONA_APPROVAL_API_ENABLED (false). */
  enabled?: boolean;
  fetch?: FetchLike;
  /** Tests only: a connection factory (production builds it from POSTONA_RESV_DATABASE_URL). */
  connect?: PgConnect;
  createConnect?: (databaseUrl: string) => PgConnect;
};

export function createHttpHandler(env: { get(name: string): string | undefined }, overrides: HttpOverrides = {}) {
  const enabled = overrides.enabled ?? POSTONA_APPROVAL_API_ENABLED;
  return async (request: Request): Promise<Response> => {
    if (enabled !== true) return json(503, { ok: false, code: "NOT_AVAILABLE" });
    const supabaseUrl = env.get("SUPABASE_URL") ?? "";
    const anonKey = env.get("SUPABASE_ANON_KEY") ?? "";
    const databaseUrl = env.get("POSTONA_RESV_DATABASE_URL") ?? "";
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
    const apiRequest: ApprovalRequest = { method: request.method, authorization: request.headers.get("authorization"), body };
    const answer = await createApprovalApi({ enabled: true, auth, db: createPostgresApprovalDb(connect) })(apiRequest);
    return json(answer.status, answer.body);
  };
}
