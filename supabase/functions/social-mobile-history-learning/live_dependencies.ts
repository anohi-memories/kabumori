import {
  createHistoryLearningCandidateDependencies,
  createXHistoryPageFetcher,
  HistoryLearningError,
  type HistoryLearningDependencies,
} from "./logic.ts";

export const HISTORY_LIVE_GATE = "SOCIAL_MOBILE_HISTORY_LIVE_ENABLED";
// Exact, case-sensitive value. Missing, empty, and all other values are OFF.
export function historyLiveEnabled(value: string | undefined): boolean {
  return value === "true";
}

type LiveConfig = {
  supabaseUrl?: string;
  publishableKey?: string;
  serviceRoleKey?: string;
  fetchImpl?: typeof fetch;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** User-JWT reads remain RLS-scoped; only the dedicated token RPC uses service role. */
export function createLiveHistoryDependencies(config: LiveConfig): HistoryLearningDependencies {
  if (!config.supabaseUrl || !config.publishableKey || !config.serviceRoleKey) {
    throw new HistoryLearningError("HISTORY_CONFIGURATION_UNAVAILABLE", 503);
  }
  const baseUrl = config.supabaseUrl.replace(/\/$/u, "");
  const fetchImpl = config.fetchImpl ?? fetch;
  let verifiedUserId: string | null = null;
  let verifiedBearer: string | null = null;
  const ownedWorkspaceIds = new Set<string>();

  async function userRead(path: string, bearer: string): Promise<unknown> {
    if (bearer !== verifiedBearer || !verifiedUserId) {
      throw new HistoryLearningError("AUTH_REQUIRED", 401);
    }
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        headers: { apikey: config.publishableKey!, Authorization: `Bearer ${bearer}`, Accept: "application/json" },
      });
    } catch {
      throw new HistoryLearningError("HISTORY_WORKSPACE_READ_UNAVAILABLE", 503);
    }
    if (!response.ok) throw new HistoryLearningError("HISTORY_WORKSPACE_READ_UNAVAILABLE", 503);
    try { return await response.json(); } catch {
      throw new HistoryLearningError("HISTORY_WORKSPACE_READ_UNAVAILABLE", 503);
    }
  }

  function tableUrl(table: string, params: Record<string, string>): string {
    const url = new URL(`${baseUrl}/rest/v1/${table}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return `${url.pathname}${url.search}`;
  }

  const base: Omit<HistoryLearningDependencies, "readAccessToken"> = {
    async readAuthUser(bearer) {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/auth/v1/user`, {
          headers: { apikey: config.publishableKey!, Authorization: `Bearer ${bearer}` },
        });
      } catch { throw new HistoryLearningError("AUTH_VERIFICATION_UNAVAILABLE", 503); }
      if (!response.ok) return null;
      let body: unknown;
      try { body = await response.json(); } catch { return null; }
      if (!record(body) || typeof body.id !== "string" || !body.id) return null;
      verifiedUserId = body.id;
      verifiedBearer = bearer;
      return { id: body.id };
    },
    async readOwnerMemberships(userId, bearer) {
      if (userId !== verifiedUserId) throw new HistoryLearningError("AUTH_REQUIRED", 401);
      const rows = await userRead(tableUrl("brand_memberships", {
        select: "brand_id,role", user_id: `eq.${userId}`, role: "eq.owner",
      }), bearer);
      if (!Array.isArray(rows)) throw new HistoryLearningError("HISTORY_WORKSPACE_READ_UNAVAILABLE", 503);
      const owners = rows.flatMap((row) => record(row) && typeof row.brand_id === "string" && row.role === "owner"
        ? [{ workspaceId: row.brand_id, role: "owner" }] : []);
      for (const row of owners) ownedWorkspaceIds.add(row.workspaceId);
      return owners;
    },
    async readWorkspace(workspaceId, bearer) {
      if (!ownedWorkspaceIds.has(workspaceId)) return null;
      const rows = await userRead(tableUrl("brands", { select: "id", id: `eq.${workspaceId}`, limit: "1" }), bearer);
      if (!Array.isArray(rows) || rows.length !== 1 || !record(rows[0]) || rows[0].id !== workspaceId) return null;
      return { id: workspaceId, ownerUserId: verifiedUserId! };
    },
    async readXAccounts(workspaceId, bearer) {
      if (!ownedWorkspaceIds.has(workspaceId)) return [];
      const rows = await userRead(tableUrl("social_accounts", {
        select: "id,brand_id,platform,connection_status,platform_user_id,handle",
        brand_id: `eq.${workspaceId}`, platform: "eq.x", limit: "2",
      }), bearer);
      if (!Array.isArray(rows)) throw new HistoryLearningError("HISTORY_WORKSPACE_READ_UNAVAILABLE", 503);
      return rows.map((row) => {
        if (!record(row) || typeof row.id !== "string" || row.brand_id !== workspaceId ||
            row.platform !== "x" || typeof row.connection_status !== "string") {
          throw new HistoryLearningError("HISTORY_ACCOUNT_NOT_CONFIGURED", 409);
        }
        return { id: row.id, workspaceId, platform: "x", connectionStatus: row.connection_status,
          platformUserId: typeof row.platform_user_id === "string" ? row.platform_user_id : null,
          handle: typeof row.handle === "string" ? row.handle : null };
      });
    },
    fetchXPage: createXHistoryPageFetcher(fetchImpl),
  };
  return createHistoryLearningCandidateDependencies(base, {
    supabaseUrl: baseUrl, serviceRoleKey: config.serviceRoleKey, fetchImpl,
  });
}
