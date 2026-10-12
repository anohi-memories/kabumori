/**
 * Live access-token verification against Supabase Auth (GET /auth/v1/user) for the POSTONA X reservation API
 * (F3 SOURCE CANDIDATE). Same call the reviewed social-mobile-publish-setting function makes: the CALLER'S token
 * and the public anon key only -- no service-role key.
 *
 * A token whose signature and lifetime are still valid is NOT enough: Auth is asked on every request, so a
 * signed-out session, a banned user, a deleted user or an anonymous sign-in is refused even before the token
 * expires. Account freeze / withdrawal of the common account is decided by the database (G5 binding), not here.
 * Nothing is logged; the token never leaves this request.
 */
import type { AuthVerifier } from "./api.ts";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function createSupabaseAuthVerifier(config: {
  supabaseUrl: string;
  anonKey: string;
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
}): AuthVerifier {
  const base = new URL(config.supabaseUrl);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname))) {
    throw new Error("SUPABASE_URL_MUST_BE_HTTPS");
  }
  const endpoint = `${base.origin}/auth/v1/user`;
  const fetchImpl = config.fetch ?? fetch;
  const now = config.now ?? Date.now;
  return {
    async verify(accessToken: string) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 8000);
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: { apikey: config.anonKey, Authorization: `Bearer ${accessToken}` },
        });
      } finally {
        clearTimeout(timer);
      }
      // Auth itself is unavailable: the caller answers 503, never a guess.
      if (response.status >= 500) throw new Error("AUTH_UNAVAILABLE");
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (response.status !== 200 || !isRecord(body)) return null;
      if (typeof body.id !== "string" || !UUID_RE.test(body.id)) return null;
      if (body.role !== undefined && body.role !== "authenticated") return null;
      if (body.aud !== undefined && body.aud !== "authenticated") return null;
      if (body.is_anonymous === true) return null;
      if (body.deleted_at !== undefined && body.deleted_at !== null) return null;
      if (typeof body.banned_until === "string") {
        const until = Date.parse(body.banned_until);
        if (!Number.isFinite(until) || until > now()) return null;
      }
      return { userId: body.id };
    },
  };
}
