// Initial public release scope (G1-02 gen2 TASK 2): Threads and X are the two SNS a user can connect, post to and
// schedule from the iPhone app. Instagram is added later; until then it is shown as "later" and offers no action.
// Pure and import-free. This decides what the app OFFERS; it never claims a provider accepted anything.

export const INITIAL_RELEASE_PROVIDERS = ['threads', 'x'] as const;
export type InitialReleaseProvider = (typeof INITIAL_RELEASE_PROVIDERS)[number];

export const DEFERRED_PROVIDER_LABEL = '後日対応';
export const DEFERRED_PROVIDER_TEXT = 'Instagramへの接続・投稿は後日対応予定です。今は、ThreadsとXをご利用ください。';

/** Exact match: an unknown or future provider is NOT an initial-release provider (fail closed to "later"). */
export function isInitialReleaseProvider(platform: unknown): platform is InitialReleaseProvider {
  return typeof platform === 'string' && (INITIAL_RELEASE_PROVIDERS as readonly string[]).includes(platform);
}

export function isDeferredProvider(platform: unknown): boolean {
  return !isInitialReleaseProvider(platform);
}
