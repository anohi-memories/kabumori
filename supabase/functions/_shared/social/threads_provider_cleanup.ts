// POSTONA Threads — the provider cleanup adapter for G5's account deletion (T10). G4-owned, SOURCE ONLY,
// NOT registered: G5 registers adapters in its own files (Draft PR #152,
// supabase/functions/account-delete/provider_cleanup.ts) after its own review. Structurally it is exactly that
// port's ProviderCleanupAdapter: { provider: 'threads', hasConnection(userId), cleanup(userId) }.
//
// What it does: asks the database (supabase/candidates/postona_threads_cleanup/) whether the person has a
// Threads connection, and removes the local footprint in ONE database transaction that only acts while G5's
// own lifecycle table shows that person's deletion in its cleanup step. It never calls Threads: Threads has
// no app-side revoke we can verify, so the best result is `local_removed_remote_unverified`, never
// `confirmed_remote_revoked`. A post that may be in flight is never deleted into "not posted"
// (reconciliation_required). An unknown answer (lost response, throw, off-contract) is
// reconciliation_required: something may be half done and nothing is replayed automatically.
// Only fixed codes leave this module; no token, id or body is logged.

export const THREADS_PROVIDER_KEY = "threads";

/** G5's ProviderOutcome values (PR #152), repeated here so this module does not import unmerged G5 source. */
export const PROVIDER_OUTCOMES = ["confirmed_remote_revoked", "local_removed_remote_unverified", "reconciliation_required", "blocked"] as const;
export type ProviderOutcome = (typeof PROVIDER_OUTCOMES)[number];

/** The two database calls, injected. The production store below is one implementation. */
export type ThreadsCleanupStore = Readonly<{
  connectionState(userId: string): Promise<unknown>;
  cleanup(userId: string): Promise<unknown>;
}>;

export type ThreadsProviderCleanupAdapter = Readonly<{
  provider: "threads";
  hasConnection(userId: string): Promise<boolean | null>;
  cleanup(userId: string): Promise<ProviderOutcome>;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** What this adapter may answer. confirmed_remote_revoked is NOT among them: nothing here can verify it. */
const ALLOWED: ReadonlySet<string> = new Set(["local_removed_remote_unverified", "reconciliation_required", "blocked"]);

export function createThreadsProviderCleanupAdapter(store: ThreadsCleanupStore): ThreadsProviderCleanupAdapter {
  return Object.freeze({
    provider: "threads" as const,
    async hasConnection(userId: string): Promise<boolean | null> {
      if (!UUID.test(userId)) return null;
      try {
        const state = await store.connectionState(userId);
        return state === "connected" ? true : state === "not_connected" ? false : null;
      } catch {
        return null;
      }
    },
    async cleanup(userId: string): Promise<ProviderOutcome> {
      if (!UUID.test(userId)) return "blocked";
      let answer: unknown;
      try {
        answer = await store.cleanup(userId);
      } catch {
        // The transaction may or may not have committed: a person checks, nothing is replayed.
        return "reconciliation_required";
      }
      if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return "reconciliation_required";
      const outcome = (answer as { outcome?: unknown }).outcome;
      return typeof outcome === "string" && ALLOWED.has(outcome) ? outcome as ProviderOutcome : "reconciliation_required";
    },
  });
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The production store: the two owner-only database functions over the Data API, with the credential of the
 * role G5's account-delete function runs as. The caller (G5's registration) supplies that credential; this
 * module never reads the environment. Until G5's registration grants EXECUTE to that role, every call is
 * refused and the adapter answers unreadable (hasConnection null) — fail closed.
 */
export function createThreadsCleanupRpcStore(config: Readonly<{ supabaseUrl: string; apiKey: string; bearer: string }>, fetchImpl: FetchLike = fetch): ThreadsCleanupStore {
  const call = async (rpc: string, userId: string): Promise<unknown> => {
    const response = await fetchImpl(`${config.supabaseUrl}/rest/v1/rpc/${rpc}`, {
      method: "POST",
      redirect: "manual",
      headers: { apikey: config.apiKey, Authorization: `Bearer ${config.bearer}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ p_user_id: userId }),
    });
    if (!response.ok) throw new Error("THREADS_CLEANUP_RPC_REFUSED");
    return await response.json();
  };
  return Object.freeze({
    connectionState: (userId: string) => call("threads_provider_connection_state", userId),
    cleanup: (userId: string) => call("cleanup_threads_provider_footprint", userId),
  });
}
