// Provider-aware cleanup port of the common-account deletion (T10, docs/postona/threads-g5-t9-t10-t13-shared-
// contract-20261010.md). SOURCE CANDIDATE -- no adapter is registered by this change; nothing here calls a
// provider.
//
// X is cleaned by its own saga (XServiceCleaner). Every OTHER provider a service connects (Threads today,
// Instagram later) is cleaned by an adapter its OWNER (POSTONA, G4) writes and registers through this port, so
// the orchestrator never learns a provider's credential shape and never hands one provider's token to
// another provider's revoke call. The port fixes only what the lifecycle needs from the answer:
//
//   confirmed_remote_revoked         local credentials and footprint removed, and the provider confirmed the grant is gone
//   local_removed_remote_unverified  local credentials and footprint removed; the provider's own revoke is unavailable or unconfirmed
//   reconciliation_required          something may be half done (an unknown answer, a lost response): a human checks, nothing is replayed
//   blocked                          nothing was started and cannot be now (not integrated, not permitted, precondition missing)
//
// Ownership (H4-P4-R1). The deletion is owned by one request through a durable lease that the DATABASE checks;
// an await is not a lock, so the port asks the database again at every boundary where a stale owner could do
// harm, and an adapter is handed the same question:
//   * after hasConnection() returns and before cleanup() is called (the destructive step);
//   * after cleanup() returns, before its answer is used and before the next adapter starts;
//   * (the orchestrator) before the POSTONA entitlement ends.
// A lost lease ends the whole step as `lease_lost`: the stale owner records nothing, calls no further adapter,
// ends no entitlement and reports no success; the next owner re-runs the (idempotent) adapters. An adapter
// that performs several awaits or external mutations MUST call `context.stillOwned()` immediately before EACH
// mutation and stop when it is false (answer `reconciliation_required` if something may already have been
// done, `blocked` if nothing was). `stillOwned()` is also false once the port stopped waiting for the adapter
// (timeout) and `context.signal` is aborted then, so a late continuation of an abandoned call must not
// mutate. A lease check is not a lock: each mutation must still be idempotent, and the adapter keeps its own
// durable uncertain state (the orchestrator only keeps a fixed code and gives the lease back).
//
// Decision (a pure function of the answers; time and retries are not evidence):
//   * a lost lease wins over everything and stops at once;
//   * any adapter without an answer, unknown answer, throw or timeout is reconciliation_required;
//   * a configuration error (invalid or duplicate key, a reserved name) is blocked;
//   * reconciliation_required wins over blocked (an unsettled effect needs a person first);
//   * local_removed_remote_unverified lets a POSTONA-only end complete (product spec, T10 section 3) but does NOT
//     make a whole-account deletion safe by itself: the orchestrator stops unless it was told to accept it.
// Every adapter runs (a failure of one never leaves another provider's credentials behind) in a fixed order.
// Only fixed provider keys and fixed result codes leave this module: no token, id, address or provider body.

export const PROVIDER_OUTCOMES = [
  'confirmed_remote_revoked', 'local_removed_remote_unverified', 'reconciliation_required', 'blocked',
] as const;
export type ProviderOutcome = typeof PROVIDER_OUTCOMES[number];

/** What an adapter is given for every call; see "Ownership" above. */
export type ProviderCleanupContext = {
  /** Aborted when the port stops waiting for this adapter (timeout, lost lease, or after it returned). */
  readonly signal: AbortSignal;
  /**
   * true only while this request still owns the deletion (asked of the database now) and the port is still
   * waiting for this adapter. Call it immediately before every external mutation.
   */
  stillOwned(): Promise<boolean>;
};

export type ProviderCleanupAdapter = {
  /** A fixed lowercase key such as 'threads'. Never 'x', 'x_autopost', 'kabumori' or 'apple' (owned elsewhere). */
  readonly provider: string;
  /** Read-only: does this person hold a connection with this provider? null = could not be read. */
  hasConnection(userId: string, context: ProviderCleanupContext): Promise<boolean | null>;
  /** Removes the local credentials and footprint. Idempotent; never replays an unsettled provider call. */
  cleanup(userId: string, context: ProviderCleanupContext): Promise<ProviderOutcome>;
};

export type ProviderResult = ProviderOutcome | 'not_connected' | 'unreadable' | 'invalid' | 'lease_lost';
export type ProviderCleanupReport = {
  decision: 'proceed' | 'blocked' | 'reconciliation_required' | 'lease_lost';
  providers: { provider: string; result: ProviderResult }[];
  /** Providers whose local data is gone but whose remote grant is not confirmed revoked. */
  remoteUnverified: string[];
};

export const PROVIDER_KEY = /^[a-z][a-z0-9_]{1,31}$/u;
export const RESERVED_PROVIDER_KEYS: readonly string[] = ['x', 'x_autopost', 'kabumori', 'apple', 'google', 'email', 'phone'];
export const PROVIDER_TIMEOUT_MS = 20_000;

async function within<T>(work: Promise<T>, timeoutMs: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The caller's ownership answer, fail closed: anything but a clean `true` is a lost lease. */
async function ownedNow(stillOwned: () => Promise<boolean>): Promise<boolean> {
  try {
    return (await stillOwned()) === true;
  } catch {
    return false;
  }
}

async function runOne(adapter: ProviderCleanupAdapter, userId: string, timeoutMs: number, stillOwned: () => Promise<boolean>): Promise<ProviderResult> {
  const abort = new AbortController();
  let open = true;
  const context: ProviderCleanupContext = {
    signal: abort.signal,
    stillOwned: async () => open && await ownedNow(stillOwned),
  };
  try {
    let connected: boolean | null | 'timeout';
    try {
      connected = await within(adapter.hasConnection(userId, context), timeoutMs);
    } catch {
      connected = 'timeout';
    }
    // The read may have taken a long time: ownership is asked again BEFORE anything destructive is called.
    if (!(await ownedNow(stillOwned))) return 'lease_lost';
    if (connected === false) return 'not_connected';
    if (connected !== true) return 'unreadable';
    let outcome: ProviderOutcome | 'timeout' | unknown;
    try {
      outcome = await within(adapter.cleanup(userId, context), timeoutMs);
    } catch {
      outcome = 'reconciliation_required';
    }
    // The answer of an owner that lost the lease while cleaning is not used: the next owner re-runs it.
    if (!(await ownedNow(stillOwned))) return 'lease_lost';
    return (PROVIDER_OUTCOMES as readonly unknown[]).includes(outcome) ? outcome as ProviderOutcome : 'reconciliation_required';
  } finally {
    // From here on a late continuation of this adapter's call can neither see ownership nor ignore the signal.
    open = false;
    abort.abort();
  }
}

/**
 * Runs every registered adapter for the person and aggregates the answers. Never throws.
 * `stillOwned` asks the database whether this request still owns the deletion lease (required: a port that
 * cannot ask is a port that cannot stop a stale owner).
 */
export async function runProviderCleanups(
  adapters: readonly ProviderCleanupAdapter[],
  userId: string,
  options: { stillOwned: () => Promise<boolean>; timeoutMs?: number },
): Promise<ProviderCleanupReport> {
  const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  const keys = adapters.map((a) => (typeof a?.provider === 'string' ? a.provider : ''));
  const results: ProviderCleanupReport['providers'] = [];
  const runnable: ProviderCleanupAdapter[] = [];
  adapters.forEach((adapter, index) => {
    const key = keys[index];
    const valid = PROVIDER_KEY.test(key) && !RESERVED_PROVIDER_KEYS.includes(key) && keys.indexOf(key) === keys.lastIndexOf(key)
      && typeof adapter.hasConnection === 'function' && typeof adapter.cleanup === 'function';
    if (valid) runnable.push(adapter);
    else results.push({ provider: PROVIDER_KEY.test(key) ? key : 'invalid', result: 'invalid' });
  });
  runnable.sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0));
  let leaseLost = false;
  for (const adapter of runnable) {
    const result = await runOne(adapter, userId, timeoutMs, options.stillOwned);
    results.push({ provider: adapter.provider, result });
    if (result === 'lease_lost') {
      leaseLost = true;
      break; // no further adapter is called by a stale owner
    }
  }
  results.sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : a.result < b.result ? -1 : 1));
  const has = (...wanted: ProviderResult[]) => results.some((r) => wanted.includes(r.result));
  const decision = leaseLost ? 'lease_lost'
    : has('reconciliation_required', 'unreadable') ? 'reconciliation_required'
    : has('blocked', 'invalid') ? 'blocked'
    : 'proceed';
  return {
    decision,
    providers: results,
    remoteUnverified: results.filter((r) => r.result === 'local_removed_remote_unverified').map((r) => r.provider),
  };
}
