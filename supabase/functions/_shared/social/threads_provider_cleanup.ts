// POSTONA Threads — the provider cleanup adapter for G5's account deletion (T10). G4-owned, SOURCE ONLY,
// NOT registered: G5 registers adapters in its own files (Draft PR #152,
// supabase/functions/account-delete/provider_cleanup.ts) after its own review. Structurally it is exactly that
// port's ProviderCleanupAdapter as repaired by H4-P4-R1 (PR #152 ccea1fe8): { provider: 'threads',
// hasConnection(userId, context), cleanup(userId, context) } with context { signal, stillOwned() }.
//
// What it does: asks the database (supabase/candidates/postona_threads_cleanup/) whether the person has a
// Threads connection, and removes the local footprint in ONE database transaction that only acts while G5's
// own lifecycle table shows that person's deletion in its cleanup step, with a live owner lease that the
// database re-checks after its locks. It never calls Threads: Threads has no app-side revoke we can verify,
// so the best result is `local_removed_remote_unverified`, never `confirmed_remote_revoked`. A post that may
// be in flight is never deleted into "not posted" (reconciliation_required).
//
// Ownership (F4, the port's rule "call stillOwned() immediately before EACH mutation"):
//   * before anything: an aborted signal (the port stopped waiting) means do nothing;
//   * the read is read-only, its answer is dropped when the signal was aborted meanwhile (unreadable);
//   * immediately before the one destructive call: stillOwned() must answer exactly true, and the signal
//     must still be open; otherwise nothing was started -> `blocked`;
//   * the destructive call carries the signal; once it was SENT, an abort, a throw, a lost or off-contract
//     answer, or a lease lost by the time it answered may hide a committed removal -> `reconciliation_required`
//     (a person checks; nothing is replayed). Only a `blocked` answer (the database removed nothing) stays
//     `blocked`.
// Only fixed codes leave this module; no token, id or body is logged.

export const THREADS_PROVIDER_KEY = "threads";

/** G5's ProviderOutcome values (PR #152), repeated here so this module does not import unmerged G5 source. */
export const PROVIDER_OUTCOMES = ["confirmed_remote_revoked", "local_removed_remote_unverified", "reconciliation_required", "blocked"] as const;
export type ProviderOutcome = (typeof PROVIDER_OUTCOMES)[number];

/** G5's ProviderCleanupContext (PR #152 ccea1fe8), repeated for the same reason. */
export type ProviderCleanupContext = Readonly<{
  /** Aborted when the port stops waiting for this adapter (timeout, lost lease, or after it returned). */
  signal: AbortSignal;
  /** true only while this request still owns the deletion (asked of the database now). */
  stillOwned(): Promise<boolean>;
}>;

/** The two database calls, injected. The production store below is one implementation. */
export type ThreadsCleanupStore = Readonly<{
  connectionState(userId: string, signal: AbortSignal): Promise<unknown>;
  cleanup(userId: string, signal: AbortSignal): Promise<unknown>;
}>;

export type ThreadsProviderCleanupAdapter = Readonly<{
  provider: "threads";
  hasConnection(userId: string, context: ProviderCleanupContext): Promise<boolean | null>;
  cleanup(userId: string, context: ProviderCleanupContext): Promise<ProviderOutcome>;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** What this adapter may answer. confirmed_remote_revoked is NOT among them: nothing here can verify it. */
const ALLOWED: ReadonlySet<string> = new Set(["local_removed_remote_unverified", "reconciliation_required", "blocked"]);

/** The port's ownership answer, fail closed: anything but a clean `true` (including a throw) is "not owned". */
async function owned(context: ProviderCleanupContext): Promise<boolean> {
  if (context.signal.aborted) return false;
  try {
    return (await context.stillOwned()) === true && !context.signal.aborted;
  } catch {
    return false;
  }
}

export function createThreadsProviderCleanupAdapter(store: ThreadsCleanupStore): ThreadsProviderCleanupAdapter {
  return Object.freeze({
    provider: "threads" as const,
    async hasConnection(userId: string, context: ProviderCleanupContext): Promise<boolean | null> {
      if (!UUID.test(userId) || context.signal.aborted) return null;
      let state: unknown;
      try {
        state = await store.connectionState(userId, context.signal);
      } catch {
        return null;
      }
      // An answer that arrived after the port stopped waiting is not used.
      if (context.signal.aborted) return null;
      return state === "connected" ? true : state === "not_connected" ? false : null;
    },
    async cleanup(userId: string, context: ProviderCleanupContext): Promise<ProviderOutcome> {
      if (!UUID.test(userId)) return "blocked";
      // Immediately before the only mutation: still the owner, and still awaited. Nothing was started yet.
      if (!(await owned(context))) return "blocked";
      let answer: unknown;
      try {
        answer = await store.cleanup(userId, context.signal);
      } catch {
        // Sent: the transaction may or may not have committed. A person checks, nothing is replayed.
        return "reconciliation_required";
      }
      const outcome = typeof answer === "object" && answer !== null && !Array.isArray(answer)
        ? (answer as { outcome?: unknown }).outcome
        : undefined;
      if (typeof outcome !== "string" || !ALLOWED.has(outcome)) return "reconciliation_required";
      // The database removed nothing: that stays true whoever owns the deletion now.
      if (outcome === "blocked") return "blocked";
      // Lost the lease (or was abandoned) while the removal ran: its answer is not ours to report as settled.
      if (!(await owned(context))) return "reconciliation_required";
      return outcome as ProviderOutcome;
    },
  });
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The production store: the two owner-only database functions over the Data API, with the credential of the
 * role G5's account-delete function runs as. The caller (G5's registration) supplies that credential; this
 * module never reads the environment. Until G5's registration grants EXECUTE to that role, every call is
 * refused and the adapter answers unreadable (hasConnection null) — fail closed. Each request carries the
 * port's signal: an abandoned call stops waiting (the database may still commit; see cleanup above).
 */
export function createThreadsCleanupRpcStore(config: Readonly<{ supabaseUrl: string; apiKey: string; bearer: string }>, fetchImpl: FetchLike = fetch): ThreadsCleanupStore {
  const call = async (rpc: string, userId: string, signal: AbortSignal): Promise<unknown> => {
    const response = await fetchImpl(`${config.supabaseUrl}/rest/v1/rpc/${rpc}`, {
      method: "POST",
      redirect: "manual",
      signal,
      headers: { apikey: config.apiKey, Authorization: `Bearer ${config.bearer}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ p_user_id: userId }),
    });
    if (!response.ok) throw new Error("THREADS_CLEANUP_RPC_REFUSED");
    return await response.json();
  };
  return Object.freeze({
    connectionState: (userId: string, signal: AbortSignal) => call("threads_provider_connection_state", userId, signal),
    cleanup: (userId: string, signal: AbortSignal) => call("cleanup_threads_provider_footprint", userId, signal),
  });
}
