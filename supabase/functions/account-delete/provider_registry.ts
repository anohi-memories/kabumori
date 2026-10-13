// The G5-owned registration of provider cleanup adapters (T10). SOURCE CANDIDATE.
//
// An adapter is written and reviewed by the owner of the provider (Threads: POSTONA / F4, under
// supabase/functions/_shared/social/); this file is where the account-delete function learns that it exists.
// Registration is deliberately explicit: an import a reviewer can see, never a dynamic load, so a deployed
// bundle contains exactly what was reviewed.
//
// NOTHING IS REGISTERED YET. With no adapter, a person who has a connected provider other than X is refused
// before anything changes (PROVIDER_ADAPTER_MISSING) -- fail closed. The registration for Threads, written
// against F4's PR #169 adapter and proven in an overlay (supabase/tests/common_account_phase6_overlay_run.sh),
// is supabase/candidates/common_account_provider_registration/provider_registry.threads.candidate.ts: it
// replaces this file, in the same change that brings F4's module and the EXECUTE grant to the function's
// role (threads_cleanup_execute_grant_candidate.sql) onto the branch, after the owners' review.
import type { ProviderCleanupAdapter } from './provider_cleanup.ts';

export type RemoteRevoke = 'supported' | 'unsupported';
export type ProviderRegistration = {
  adapters: readonly ProviderCleanupAdapter[];
  /**
   * What each adapter can confirm of the REMOTE grant. A provider not listed counts as 'unsupported': the
   * person must acknowledge, before anything changes, that the remote authorization stays.
   */
  remoteRevoke: Readonly<Record<string, RemoteRevoke>>;
};
export type RegistryConfig = {
  supabaseUrl: string;
  /** The service credential of this function (the role the cleanup RPCs are granted to). */
  serviceKey: string;
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
};

export function providerRegistration(_config: RegistryConfig): ProviderRegistration {
  return { adapters: [], remoteRevoke: {} };
}
