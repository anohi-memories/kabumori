// CANDIDATE -- NOT part of the build. The registration of F4's Threads provider cleanup adapter (POSTONA, PR #169
// `supabase/functions/_shared/social/threads_provider_cleanup.ts`) in G5's account-delete function.
//
// It REPLACES supabase/functions/account-delete/provider_registry.ts, in the same change that brings F4's module
// onto the branch and the EXECUTE grant (threads_cleanup_execute_grant_candidate.sql) to the role this function
// runs as, after the owners' review. Until then the registry registers nothing and a person with a connected
// Threads account is refused before anything changes (PROVIDER_ADAPTER_MISSING).
//
// Why remoteRevoke.threads = 'unsupported': the Threads API documents no endpoint with which an app revokes a
// person's authorization (F4's doc, 2026-10-13); the adapter can only ever answer "local removed, remote
// unverified". The person therefore acknowledges, before anything is removed, that the authorization stays and
// has to be removed in Threads' own settings.
//
// Proven in an overlay with F4's real module and real SQL: supabase/tests/common_account_phase6_overlay_run.sh.
import type { ProviderCleanupAdapter } from './provider_cleanup.ts';
import { createThreadsCleanupRpcStore, createThreadsProviderCleanupAdapter } from '../_shared/social/threads_provider_cleanup.ts';

export type RemoteRevoke = 'supported' | 'unsupported';
export type ProviderRegistration = {
  adapters: readonly ProviderCleanupAdapter[];
  remoteRevoke: Readonly<Record<string, RemoteRevoke>>;
};
export type RegistryConfig = {
  supabaseUrl: string;
  /** The service credential of this function (the role the cleanup RPCs are granted to). */
  serviceKey: string;
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
};

export function providerRegistration(config: RegistryConfig): ProviderRegistration {
  const store = createThreadsCleanupRpcStore(
    { supabaseUrl: config.supabaseUrl, apiKey: config.serviceKey, bearer: config.serviceKey },
    config.fetchImpl,
  );
  return {
    adapters: [createThreadsProviderCleanupAdapter(store)],
    remoteRevoke: { threads: 'unsupported' },
  };
}
