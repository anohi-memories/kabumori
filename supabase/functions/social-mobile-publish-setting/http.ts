// HTTP layer for social-mobile-publish-setting. SOURCE CANDIDATE.
//
// Two outgoing calls, both with the CALLER'S token and the public anon key, and nothing else:
//  - Auth:  GET  /auth/v1/user                                   (is this bearer token valid)
//  - RPC:   POST /rest/v1/rpc/set_social_account_publish_enabled (the one transactional decision)
// This file holds no service-role key and never reads it from the environment: the function has no
// privileged path of its own, so there is nothing here a stale authorization could be replayed through.
// It reads or writes no table, sends no user id and no brand id, and never calls X.
import {
  BLOCKED_REASONS,
  handlePublishSetting,
  type PublishSettingBlockedReason,
  type PublishSettingDecision,
  type PublishSettingDeps,
  PublishSettingError,
} from "./logic.ts";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const PUBLISH_SETTING_RPC = "set_social_account_publish_enabled";

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const unavailable = () => new PublishSettingError("PUBLISH_SETTING_UNAVAILABLE", 503);

/** Accepts only the database function's documented shapes; anything else is "unavailable". */
export function parseDecision(body: unknown): PublishSettingDecision {
  if (!isRecord(body) || typeof body.status !== "string") throw unavailable();
  const keys = Object.keys(body).sort().join(",");
  switch (body.status) {
    case "updated":
    case "unchanged":
    case "stale":
      if (keys !== "publish_enabled,status" || typeof body.publish_enabled !== "boolean") throw unavailable();
      return { status: body.status, publishEnabled: body.publish_enabled };
    case "blocked":
      if (keys !== "reason,status" || typeof body.reason !== "string" || !BLOCKED_REASONS.has(body.reason)) {
        throw unavailable();
      }
      return { status: "blocked", reason: body.reason as PublishSettingBlockedReason };
    case "not_found":
    case "forbidden":
    case "busy":
    case "auth_required":
    case "invalid":
      if (keys !== "status") throw unavailable();
      return { status: body.status };
    default:
      throw unavailable();
  }
}

export function createDeps(
  config: { supabaseUrl: string; anonKey: string },
  fetchImpl: FetchLike = fetch,
): PublishSettingDeps {
  const { supabaseUrl, anonKey } = config;
  return {
    async getUser(token) {
      let response: Response;
      try {
        response = await fetchImpl(`${supabaseUrl}/auth/v1/user`, {
          method: "GET",
          redirect: "manual",
          headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
        });
      } catch {
        throw unavailable();
      }
      if (response.status >= 500) throw unavailable();
      const body = await readJson(response);
      if (!response.ok || !isRecord(body) || typeof body.id !== "string" || !body.id) return null;
      return { id: body.id };
    },

    async decide(token, request) {
      let response: Response;
      try {
        response = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${PUBLISH_SETTING_RPC}`, {
          method: "POST",
          redirect: "manual",
          headers: {
            apikey: anonKey,
            // The caller's own JWT: inside the database auth.uid() is the caller, role `authenticated`.
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            p_social_account_id: request.socialAccountId,
            p_desired_enabled: request.desiredEnabled,
            p_expected_current_enabled: request.expectedCurrentEnabled,
          }),
        });
      } catch {
        throw unavailable();
      }
      // The Data API refused the token itself (expired or invalid).
      if (response.status === 401) return { status: "auth_required" };
      const body = await readJson(response);
      if (!response.ok) throw unavailable();
      return parseDecision(body);
    },
  };
}

export function createHandler(env: { get: (name: string) => string | undefined }, fetchImpl: FetchLike = fetch) {
  return (request: Request): Promise<Response> => {
    const supabaseUrl = (env.get("SUPABASE_URL") ?? "").replace(/\/$/u, "");
    const anonKey = env.get("SUPABASE_ANON_KEY") ?? "";
    if (!supabaseUrl || !anonKey) {
      // Deliberately does not say which value is missing.
      return Promise.resolve(
        Response.json({ success: false, error: "PUBLISH_SETTING_UNAVAILABLE" }, { status: 503 }),
      );
    }
    return handlePublishSetting(request, createDeps({ supabaseUrl, anonKey }, fetchImpl));
  };
}
