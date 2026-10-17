// Which article and disclosure bodies may be written into the repository.
//
// The evaluation data keeps, for every case: title, source URL, metadata, the length and SHA-256 of the body production
// saw, and the labeller's own key facts. The body itself is stored only where reuse is clearly allowed. Everywhere else the
// body is re-read from production at run time (read-only, by candidate id) and checked against the stored SHA-256.
//
// Stored (reuse is covered by the publisher's open terms):
//   - Japanese government and central-bank pages (Government Standard Terms of Use / BOJ terms), US federal agency pages
//     (public domain), and UN News (CC BY 3.0 IGO).
// Not stored (permission not confirmed, so the body stays out of the repository):
//   - TDnet disclosures (JPX / issuer terms not checked), BBC, Al Jazeera, AP and the search-lane summaries derived from them.
//
// Adding a host here is a decision about someone else's content: it needs the terms checked, not just a convenient URL.
export const BODY_STORAGE_ALLOWED_HOSTS: readonly string[] = [
  "boj.or.jp",
  "fsa.go.jp",
  "mof.go.jp",
  "caa.go.jp",
  "jma.go.jp",
  "cao.go.jp",
  "meti.go.jp",
  "federalreserve.gov",
  "ustr.gov",
  "treasury.gov",
  "news.un.org",
];

export function hostOf(sourceUrl: string): string | null {
  try {
    return new URL(sourceUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True when the body of an item from this URL may be committed. */
export function bodyMayBeStored(sourceUrl: string): boolean {
  const host = hostOf(sourceUrl);
  if (host === null) return false;
  return BODY_STORAGE_ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}
