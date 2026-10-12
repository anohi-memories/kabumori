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
// Decision (a pure function of the answers; time and retries are not evidence):
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

export type ProviderCleanupAdapter = {
  /** A fixed lowercase key such as 'threads'. Never 'x', 'x_autopost', 'kabumori' or 'apple' (owned elsewhere). */
  readonly provider: string;
  /** Read-only: does this person hold a connection with this provider? null = could not be read. */
  hasConnection(userId: string): Promise<boolean | null>;
  /** Removes the local credentials and footprint. Idempotent; never replays an unsettled provider call. */
  cleanup(userId: string): Promise<ProviderOutcome>;
};

export type ProviderResult = ProviderOutcome | 'not_connected' | 'unreadable' | 'invalid';
export type ProviderCleanupReport = {
  decision: 'proceed' | 'blocked' | 'reconciliation_required';
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

async function runOne(adapter: ProviderCleanupAdapter, userId: string, timeoutMs: number): Promise<ProviderResult> {
  let connected: boolean | null | 'timeout';
  try {
    connected = await within(adapter.hasConnection(userId), timeoutMs);
  } catch {
    return 'unreadable';
  }
  if (connected === false) return 'not_connected';
  if (connected !== true) return 'unreadable';
  let outcome: ProviderOutcome | 'timeout' | unknown;
  try {
    outcome = await within(adapter.cleanup(userId), timeoutMs);
  } catch {
    return 'reconciliation_required';
  }
  return (PROVIDER_OUTCOMES as readonly unknown[]).includes(outcome) ? outcome as ProviderOutcome : 'reconciliation_required';
}

/** Runs every registered adapter for the person and aggregates the answers. Never throws. */
export async function runProviderCleanups(
  adapters: readonly ProviderCleanupAdapter[],
  userId: string,
  options: { timeoutMs?: number } = {},
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
  for (const adapter of runnable) {
    results.push({ provider: adapter.provider, result: await runOne(adapter, userId, timeoutMs) });
  }
  results.sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : a.result < b.result ? -1 : 1));
  const has = (...wanted: ProviderResult[]) => results.some((r) => wanted.includes(r.result));
  const decision = has('reconciliation_required', 'unreadable') ? 'reconciliation_required'
    : has('blocked', 'invalid') ? 'blocked'
    : 'proceed';
  return {
    decision,
    providers: results,
    remoteUnverified: results.filter((r) => r.result === 'local_removed_remote_unverified').map((r) => r.provider),
  };
}
