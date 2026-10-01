// HTTP layer for social-mobile-publish-setting: the real dependencies over PostgREST. SOURCE CANDIDATE.
//
// Three kinds of call, and nothing else:
//  - Auth:   GET /auth/v1/user with the caller's token (who is calling).
//  - Reads:  the caller's own brand_memberships row with the CALLER's JWT (RLS applies); the exact
//            account and its brand with the service key, because Vault *reference* columns are not
//            something the app role may read. Reference columns are reduced to presence booleans here and
//            never leave this file; no Vault secret is read.
//  - Write:  ONE conditional PATCH of social_accounts.publish_enabled (service key). No other table, no
//            other column, no RPC, no X API.
import {
  type AccountRow,
  type BrandRow,
  type CompareAndSetResult,
  handlePublishSetting,
  PublishSettingError,
  type PublishSettingDeps,
  VERIFIED_CONNECTION_STATUS,
} from "./logic.ts";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const ACCOUNT_COLUMNS = [
  "id",
  "brand_id",
  "platform",
  "connection_status",
  "platform_user_id",
  "verified_at",
  "last_connection_error_code",
  "publish_enabled",
  "vault_access_token_secret_id",
  "vault_refresh_token_secret_id",
].join(",");

function restUrl(supabaseUrl: string, table: string, params: Record<string, string>): string {
  const url = new URL(`/rest/v1/${table}`, supabaseUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

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

export function createDeps(
  config: { supabaseUrl: string; anonKey: string; serviceKey: string },
  fetchImpl: FetchLike = fetch,
): PublishSettingDeps {
  const { supabaseUrl, anonKey, serviceKey } = config;
  const service = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Accept: "application/json" };

  async function serviceRows(table: string, params: Record<string, string>): Promise<Record<string, unknown>[]> {
    let response: Response;
    try {
      response = await fetchImpl(restUrl(supabaseUrl, table, params), { method: "GET", headers: service });
    } catch {
      throw unavailable();
    }
    const body = await readJson(response);
    if (!response.ok || !Array.isArray(body)) throw unavailable();
    return body.filter(isRecord);
  }

  return {
    async getUser(token) {
      let response: Response;
      try {
        response = await fetchImpl(`${supabaseUrl}/auth/v1/user`, {
          method: "GET",
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

    async readAccount(accountId): Promise<AccountRow | null> {
      const rows = await serviceRows("social_accounts", {
        select: ACCOUNT_COLUMNS,
        id: `eq.${accountId}`,
        limit: "2",
      });
      if (rows.length === 0) return null;
      const row = rows[0];
      if (
        rows.length !== 1 || row.id !== accountId || typeof row.brand_id !== "string" || !row.brand_id ||
        typeof row.platform !== "string" || typeof row.publish_enabled !== "boolean"
      ) throw unavailable();
      return {
        id: accountId,
        brand_id: row.brand_id,
        platform: row.platform,
        connection_status: typeof row.connection_status === "string" ? row.connection_status : "",
        platform_user_id: typeof row.platform_user_id === "string" && row.platform_user_id ? row.platform_user_id : null,
        verified_at: typeof row.verified_at === "string" && row.verified_at ? row.verified_at : null,
        last_connection_error_code: typeof row.last_connection_error_code === "string" && row.last_connection_error_code
          ? row.last_connection_error_code
          : null,
        publish_enabled: row.publish_enabled,
        has_access_secret_ref: typeof row.vault_access_token_secret_id === "string" && row.vault_access_token_secret_id.length > 0,
        has_refresh_secret_ref: typeof row.vault_refresh_token_secret_id === "string" && row.vault_refresh_token_secret_id.length > 0,
      };
    },

    async readBrand(brandId): Promise<BrandRow | null> {
      const rows = await serviceRows("brands", { select: "id,is_active,publish_mode", id: `eq.${brandId}`, limit: "2" });
      if (rows.length === 0) return null;
      const row = rows[0];
      if (
        rows.length !== 1 || row.id !== brandId || typeof row.is_active !== "boolean" ||
        typeof row.publish_mode !== "string"
      ) throw unavailable();
      return { id: brandId, is_active: row.is_active, publish_mode: row.publish_mode };
    },

    async readMembershipRole(token, userId, brandId) {
      let response: Response;
      try {
        response = await fetchImpl(
          restUrl(supabaseUrl, "brand_memberships", {
            select: "user_id,brand_id,role",
            user_id: `eq.${userId}`,
            brand_id: `eq.${brandId}`,
            limit: "2",
          }),
          { method: "GET", headers: { apikey: anonKey, Authorization: `Bearer ${token}`, Accept: "application/json" } },
        );
      } catch {
        throw unavailable();
      }
      const body = await readJson(response);
      if (!response.ok || !Array.isArray(body)) throw unavailable();
      const rows = body.filter(isRecord).filter((row) => row.user_id === userId && row.brand_id === brandId);
      if (rows.length === 0) return null;
      if (rows.length !== 1 || typeof rows[0].role !== "string") throw unavailable();
      return rows[0].role;
    },

    async compareAndSetPublishEnabled({ accountId, brandId, expected, desired, requireReadiness }): Promise<CompareAndSetResult> {
      const params: Record<string, string> = {
        id: `eq.${accountId}`,
        brand_id: `eq.${brandId}`,
        publish_enabled: `eq.${expected}`,
        select: "id,publish_enabled",
      };
      if (requireReadiness) {
        // Enabling is atomic with the readiness it relies on: a connection that failed between the read
        // and this write simply does not match, so it can never be enabled by a stale read.
        params.platform = "eq.x";
        params.connection_status = `eq.${VERIFIED_CONNECTION_STATUS}`;
        params.platform_user_id = "not.is.null";
        params.verified_at = "not.is.null";
        params.vault_access_token_secret_id = "not.is.null";
        params.vault_refresh_token_secret_id = "not.is.null";
        params.last_connection_error_code = "is.null";
      }
      let response: Response;
      try {
        response = await fetchImpl(restUrl(supabaseUrl, "social_accounts", params), {
          method: "PATCH",
          headers: { ...service, "Content-Type": "application/json", Prefer: "return=representation" },
          // The only column this function ever writes.
          body: JSON.stringify({ publish_enabled: desired }),
        });
      } catch {
        throw unavailable();
      }
      const body = await readJson(response);
      if (!response.ok) {
        // The account-deletion guard trigger refuses writes while a workspace deletion is in progress.
        if (isRecord(body) && /SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS/u.test(String(body.message ?? ""))) return "busy";
        throw unavailable();
      }
      if (!Array.isArray(body)) throw unavailable();
      if (body.length === 0) return "no_match";
      if (body.length === 1 && isRecord(body[0]) && body[0].id === accountId && body[0].publish_enabled === desired) {
        return "updated";
      }
      throw unavailable();
    },
  };
}

export function createHandler(env: { get: (name: string) => string | undefined }, fetchImpl: FetchLike = fetch) {
  return (request: Request): Promise<Response> => {
    const supabaseUrl = (env.get("SUPABASE_URL") ?? "").replace(/\/$/u, "");
    const anonKey = env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceKey = env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!supabaseUrl || !anonKey || !serviceKey) {
      // Deliberately does not say which value is missing.
      return Promise.resolve(
        Response.json({ success: false, error: "PUBLISH_SETTING_UNAVAILABLE" }, { status: 503 }),
      );
    }
    return handlePublishSetting(request, createDeps({ supabaseUrl, anonKey, serviceKey }, fetchImpl));
  };
}
