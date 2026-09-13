// Phase 3F: proves checkCrossBrandDuplicate() actually fires both outcomes for a real generated AI Lab
// draft, without reading any real Kabumori production content. published_content_fingerprints (Phase 3D)
// is not deployed yet, so there is no live "recent Kabumori text" window to query -- and even once it is,
// a manual admin dry-run endpoint has no business reading Kabumori's real recent post text just to run
// this probe. Instead this builds two synthetic single-entry "as if" windows entirely from the candidate
// text itself (deterministic, no DB/network): one that is guaranteed to exact-match (same text, labeled as
// a different brand) so `would_block` is proven to actually fire, and one using a fixed, unrelated probe
// sentence so `would_allow` is proven for genuinely different text.
import { checkCrossBrandDuplicate, fingerprintText, type CrossBrandDuplicateResult } from "./cross_brand_dedupe.ts";

const DISTINCT_PROBE_TEXT = "これはcross-brand重複判定のwould_allow経路を確認するための固定テキストです。";

export type CrossBrandDedupeProbeResult = {
  wouldBlockOnExactMatch: CrossBrandDuplicateResult;
  wouldAllowOnDistinctText: CrossBrandDuplicateResult;
};

export async function runCrossBrandDedupeProbe({
  brandId,
  candidateText,
  now = new Date(),
}: {
  brandId: string;
  candidateText: string;
  now?: Date;
}): Promise<CrossBrandDedupeProbeResult> {
  const publishedAt = now.toISOString();

  const wouldBlockOnExactMatch = await checkCrossBrandDuplicate({
    brandId,
    candidateText,
    now,
    recentFingerprints: [
      { brandId: "kabumori", normalizedTextSha256: await fingerprintText(candidateText), publishedAt },
    ],
  });

  const wouldAllowOnDistinctText = await checkCrossBrandDuplicate({
    brandId,
    candidateText,
    now,
    recentFingerprints: [
      { brandId: "kabumori", normalizedTextSha256: await fingerprintText(DISTINCT_PROBE_TEXT), publishedAt },
    ],
  });

  return { wouldBlockOnExactMatch, wouldAllowOnDistinctText };
}
