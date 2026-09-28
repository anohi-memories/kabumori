// Caller authentication for news-discovery-observer: a dedicated secret header, compared in
// constant time. Fails closed when the secret is not configured (the Function then refuses
// every call). Same scheme as the monitor's caller auth, kept separate so the observer never
// depends on important-news-monitor code.

// 32-byte base64url values: 43 unpadded chars, last char from the canonical set.
const SECRET_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
export const OBSERVER_SECRET_HEADER = "x-news-discovery-observer-secret";
export const OBSERVER_SECRET_ENV = "NEWS_DISCOVERY_OBSERVER_SECRET";

export function isConfiguredObserverSecret(value: string | undefined): value is string {
  return typeof value === "string" && SECRET_PATTERN.test(value);
}

export function isValidObserverSecret(configured: string | undefined, supplied: string | null): boolean {
  if (!isConfiguredObserverSecret(configured) || supplied === null || !SECRET_PATTERN.test(supplied)) return false;
  const expected = new TextEncoder().encode(configured);
  const actual = new TextEncoder().encode(supplied);
  if (expected.length !== actual.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i += 1) difference |= expected[i] ^ actual[i];
  return difference === 0;
}
