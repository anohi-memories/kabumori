// Minimum viable cross-brand duplicate guard for multibrand-phase3d-ai-lab-dry-run-routing-safety.
// Scope is deliberately narrow: exact-normalized-text matches from a DIFFERENT brand within a recent
// window. Same-brand duplicate prevention already exists elsewhere (publish_claims, tips/interaction
// cooldowns, important_news_candidates uniqueness) and is untouched. A semantic/near-duplicate detector
// is explicitly out of scope here -- two brands independently commenting on the same real news event
// must not be blocked just because the underlying event is the same; only near-identical *wording* is.
//
// This module is pure (no DB/network) so the actual read/write of published_content_fingerprints can be
// wired into the live publish-completion path in a follow-up task without touching this logic. Doing
// that now would mean writing to Kabumori's live dispatch path, which multibrand-phase3d-ai-lab-dry-run-
// routing-safety's own safety rules ask not to do without separate review.

export type PublishedFingerprint = {
  brandId: string;
  normalizedTextSha256: string;
  publishedAt: string; // ISO 8601
};

export type CrossBrandDuplicateResult =
  | { blocked: false }
  | { blocked: true; reason: "CROSS_BRAND_EXACT_DUPLICATE"; matchedBrandId: string; matchedPublishedAt: string };

// Strips everything that legitimately varies between two brands describing the same event (hashtags,
// URLs, whitespace/emoji runs, punctuation) so the hash reflects the actual written sentence, not its
// decoration. NFKC first so full-width/half-width variants and combining characters normalize the same way.
export function normalizeForFingerprint(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/https?:\/\/\S+/gu, "")
    .replace(/#\S+/gu, "")
    .replace(/[\p{Extended_Pictographic}‍️]/gu, "")
    .replace(/[\s　]+/gu, " ")
    .trim()
    .toLowerCase();
}

export async function fingerprintText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeForFingerprint(text));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function checkCrossBrandDuplicate({
  brandId,
  candidateText,
  recentFingerprints,
  now = new Date(),
  windowHours = 24 * 30,
}: {
  brandId: string;
  candidateText: string;
  // Caller supplies the recent window (e.g. from published_content_fingerprints); this function does
  // not query anything itself, so it stays deterministic and DB-free in tests.
  recentFingerprints: PublishedFingerprint[];
  now?: Date;
  windowHours?: number;
}): Promise<CrossBrandDuplicateResult> {
  const candidateHash = await fingerprintText(candidateText);
  const windowStart = now.getTime() - windowHours * 60 * 60 * 1000;
  const match = recentFingerprints.find((fingerprint) =>
    fingerprint.brandId !== brandId &&
    fingerprint.normalizedTextSha256 === candidateHash &&
    Date.parse(fingerprint.publishedAt) >= windowStart
  );
  if (!match) return { blocked: false };
  return { blocked: true, reason: "CROSS_BRAND_EXACT_DUPLICATE", matchedBrandId: match.brandId, matchedPublishedAt: match.publishedAt };
}
