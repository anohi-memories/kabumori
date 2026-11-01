// HTTP entry of the POSTONA X single manual post. F3 SOURCE CANDIDATE (2026-10-18, M1 + M1-F1): not deployed, gate OFF.
//
// With the gate OFF (the source constant) every request answers 503 NOT_AVAILABLE before the environment, the body,
// Auth, the database or X is touched. Behind the gate (only after the reviewed rollout):
//   Auth : GET /auth/v1/user with the CALLER'S token + the public anon key (live, every request)
//   DB   : one transaction per step as a login role that is a member of postona_resv_api (POSTONA_RESV_DATABASE_URL),
//          the verified subject and the token's session_id in the claims (G5's T13 checks the session is live)
//   X    : x_publisher.ts, given only the token of G4's generation-bound credential source (x_credential_generation.ts)
//          that matched the generation the database answered right before the send -- X_GENERATION_CREDENTIALS_NOT_CONNECTED
//          until G4 delivers (Issue #131): the request is refused (X_NOT_AVAILABLE) before anything is recorded. A source
//          without credentialFor (the older accessTokenFor-only port) counts as not connected.
//          Transport mark: 'x' when the real X API is reached; a test's fake X (xFetch) is recorded as 'simulated'.
// No service-role key, no Vault, no log; the body is read bounded; the answer carries no token and no text.
import { type AuthVerifier } from "../_shared/postona_reservations/api.ts";
import type { PgConnect } from "../_shared/postona_reservations/postgres_db.ts";
import { createSinglePostHandler, POSTONA_X_SINGLE_POST_ENABLED } from "../_shared/postona_reservations/single_post.ts";
import { createSinglePostDb } from "../_shared/postona_reservations/single_post_db.ts";
import { createSupabaseAuthVerifier } from "../_shared/postona_reservations/supabase_auth.ts";
import { generationSourceOf, X_GENERATION_CREDENTIALS_NOT_CONNECTED, type XPostingGenerationCredentialSource } from "../_shared/postona_reservations/x_credential_generation.ts";
import { createXReservationPublisher } from "../_shared/postona_reservations/x_publisher.ts";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const MAX_BODY_BYTES = 16 * 1024;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function readBounded(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const buffer = new Uint8Array(await request.arrayBuffer().catch(() => new ArrayBuffer(MAX_BODY_BYTES + 1)));
  return buffer.byteLength > MAX_BODY_BYTES ? null : new TextDecoder().decode(buffer);
}

export type SinglePostHttpOverrides = {
  /** Tests only. Production uses POSTONA_X_SINGLE_POST_ENABLED (false). */
  enabled?: boolean;
  /** Tests only: fake GoTrue. */
  authFetch?: FetchLike;
  auth?: AuthVerifier;
  connect?: PgConnect;
  readConnect?: PgConnect;
  createConnect?: (databaseUrl: string) => PgConnect;
  /** Tests only (MOCK_ONLY). Production: X_GENERATION_CREDENTIALS_NOT_CONNECTED until G4 delivers a reviewed source. */
  credentials?: XPostingGenerationCredentialSource;
  /** Tests only: a fake X (its results are recorded and answered as simulated). */
  xFetch?: FetchLike;
};

export function createSinglePostHttpHandler(env: { get(name: string): string | undefined }, overrides: SinglePostHttpOverrides = {}) {
  const enabled = overrides.enabled ?? POSTONA_X_SINGLE_POST_ENABLED;
  return async (request: Request): Promise<Response> => {
    if (enabled !== true) return json(503, { ok: false, code: "NOT_AVAILABLE" });
    const supabaseUrl = env.get("SUPABASE_URL") ?? "";
    const anonKey = env.get("SUPABASE_ANON_KEY") ?? "";
    const databaseUrl = env.get("POSTONA_RESV_DATABASE_URL") ?? "";
    if (!supabaseUrl || !anonKey || (!databaseUrl && !overrides.connect)) return json(503, { ok: false, code: "NOT_CONFIGURED" });
    let connect: PgConnect;
    try {
      connect = overrides.connect ?? (overrides.createConnect ?? (() => { throw new Error("NO_DRIVER"); }))(databaseUrl);
    } catch {
      return json(503, { ok: false, code: "NOT_CONFIGURED" });
    }
    const body = await readBounded(request);
    if (body === null) return json(413, { ok: false, code: "REQUEST_TOO_LARGE" });
    const handler = createSinglePostHandler({
      enabled: true,
      auth: overrides.auth ?? createSupabaseAuthVerifier({ supabaseUrl, anonKey, fetch: overrides.authFetch }),
      db: createSinglePostDb(connect),
      readDb: createSinglePostDb(overrides.readConnect ?? connect),
      credentials: generationSourceOf(overrides.credentials ?? X_GENERATION_CREDENTIALS_NOT_CONNECTED),
      publisherFor: (source) => createXReservationPublisher({ credentials: source, fetch: overrides.xFetch }),
      transport: overrides.xFetch ? "simulated" : "x",
    });
    const answer = await handler({ method: request.method, authorization: request.headers.get("authorization"), body });
    return json(answer.status, answer.body);
  };
}
