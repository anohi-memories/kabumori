// 一斉通知の worker と DB の境界（PostgREST の RPC と、許された SELECT だけ）と、Cron からの呼び出しの認証。
// 状態の変更はすべて SECURITY DEFINER の RPC（区切りの貸し出しの token・版・期限で守る）。

import type { BroadcastSettings, BroadcastStore, ClaimedChunk, Target, UserResult } from "./broadcast_logic.ts";

export type Db = {
  get<T>(path: string): Promise<T>;
  rpc<T>(name: string, args: Record<string, unknown>): Promise<T>;
};

export function isAuthorizedCronCaller(req: Request, expected: string | undefined): boolean {
  const provided = req.headers.get("X-Cron-Secret");
  return typeof expected === "string" && expected.length > 0 && provided === expected;
}

export function restDb(supabaseUrl: string, secretKey: string, fetchImpl: typeof fetch = fetch): Db {
  const headers = { apikey: secretKey, Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" };
  return {
    async get<T>(path: string) {
      const result = await fetchImpl(`${supabaseUrl}/rest/v1/${path}`, { headers });
      if (!result.ok) throw new Error(`REST_GET_FAILED:${path.split("?")[0]}:${result.status}`);
      return await result.json() as T;
    },
    async rpc<T>(name: string, args: Record<string, unknown>) {
      const result = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${name}`, {
        method: "POST", headers, body: JSON.stringify(args),
      });
      if (!result.ok) {
        // begin の貸し出しの喪失は、本文のコードで区別する（ほかの失敗と混ぜない）。
        const text = await result.text().catch(() => "");
        if (text.includes("MARKET_REPORT_BROADCAST_LEASE_LOST")) throw new Error("MARKET_REPORT_BROADCAST_LEASE_LOST");
        throw new Error(`REST_RPC_FAILED:${name}:${result.status}`);
      }
      const text = await result.text();
      return (text ? JSON.parse(text) : null) as T;
    },
  };
}

function statusOf(value: unknown): string {
  const status = (value as { status?: unknown } | null)?.status;
  return typeof status === "string" ? status : "unknown";
}

export function rpcStore(db: Db): BroadcastStore {
  return {
    enqueue: () => db.rpc("enqueue_market_report_broadcasts", {}),
    async planningBroadcasts(limit) {
      const rows = await db.get<Array<{ id: string }>>(
        `market_report_broadcasts?status=eq.planning&select=id&order=created_at.asc&limit=${limit}`,
      );
      return (rows ?? []).map((row) => row.id);
    },
    async plan(broadcastId) {
      return statusOf(await db.rpc("plan_market_report_broadcast", { p_broadcast_id: broadcastId }));
    },
    async settings(): Promise<BroadcastSettings | null> {
      const rows = await db.get<Array<BroadcastSettings & { enabled: boolean }>>(
        "market_report_broadcast_settings?id=eq.true&select=enabled,messages_per_second,max_parallel_chunks",
      );
      const row = rows?.[0];
      return row && row.enabled === true
        ? { messages_per_second: row.messages_per_second, max_parallel_chunks: row.max_parallel_chunks }
        : null;
    },
    async claim(limit) {
      const rows = await db.rpc<ClaimedChunk[]>("claim_market_report_broadcast_chunks", { p_limit: limit });
      return Array.isArray(rows) ? rows : [];
    },
    async begin(chunk) {
      const rows = await db.rpc<Target[]>("begin_market_report_broadcast_chunk", {
        p_chunk_id: chunk.chunk_id, p_lease_token: chunk.lease_token, p_lease_version: chunk.lease_version,
      });
      return Array.isArray(rows) ? rows : [];
    },
    async finish(chunk, results: UserResult[], errorCode) {
      return statusOf(await db.rpc("finish_market_report_broadcast_chunk", {
        p_chunk_id: chunk.chunk_id, p_lease_token: chunk.lease_token, p_lease_version: chunk.lease_version,
        p_results: results, p_error_code: errorCode,
      }));
    },
    purge: (limit) => db.rpc("purge_market_report_broadcasts", { p_limit: limit }),
  };
}
