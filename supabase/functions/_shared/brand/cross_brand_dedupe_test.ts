import assert from "node:assert/strict";
import test from "node:test";
import { checkCrossBrandDuplicate, fingerprintText, normalizeForFingerprint, type PublishedFingerprint } from "./cross_brand_dedupe.ts";

test("normalization strips hashtags, URLs, and emoji/whitespace decoration but keeps the sentence", () => {
  const decorated = "日経平均は反発しました📈 https://example.test/article  #日本株 #かぶモリ";
  const plain = "日経平均は反発しました";
  assert.equal(normalizeForFingerprint(decorated), normalizeForFingerprint(plain));
});

test("two brands' independently-worded commentary on the same news is never blocked", async () => {
  const kabumoriText = "今日は半導体株が大きく上昇しました。米国株高を受けた買いが優勢です。";
  const aiLabText = "半導体セクターが強い動き。背景には米国市場の上昇があります。";
  const recent: PublishedFingerprint[] = [
    { brandId: "kabumori", normalizedTextSha256: await fingerprintText(kabumoriText), publishedAt: new Date().toISOString() },
  ];
  const result = await checkCrossBrandDuplicate({ brandId: "ai_salaryman_lab", candidateText: aiLabText, recentFingerprints: recent });
  assert.equal(result.blocked, false);
});

test("an exact (post-normalization) match from a different brand within the window is blocked", async () => {
  const text = "日経平均は反発しました";
  const publishedAt = new Date().toISOString();
  const recent: PublishedFingerprint[] = [
    { brandId: "kabumori", normalizedTextSha256: await fingerprintText(text), publishedAt },
  ];
  const result = await checkCrossBrandDuplicate({
    brandId: "ai_salaryman_lab",
    candidateText: "日経平均は反発しました 📈 #かぶモリ",
    recentFingerprints: recent,
  });
  assert.deepEqual(result, {
    blocked: true, reason: "CROSS_BRAND_EXACT_DUPLICATE", matchedBrandId: "kabumori", matchedPublishedAt: publishedAt,
  });
});

test("an exact match from the SAME brand is never treated as a cross-brand duplicate", async () => {
  const text = "日経平均は反発しました";
  const recent: PublishedFingerprint[] = [
    { brandId: "kabumori", normalizedTextSha256: await fingerprintText(text), publishedAt: new Date().toISOString() },
  ];
  const result = await checkCrossBrandDuplicate({ brandId: "kabumori", candidateText: text, recentFingerprints: recent });
  assert.equal(result.blocked, false);
});

test("an exact match outside the recency window is not blocked", async () => {
  const text = "日経平均は反発しました";
  const staleDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  const recent: PublishedFingerprint[] = [
    { brandId: "kabumori", normalizedTextSha256: await fingerprintText(text), publishedAt: staleDate },
  ];
  const result = await checkCrossBrandDuplicate({
    brandId: "ai_salaryman_lab", candidateText: text, recentFingerprints: recent, windowHours: 24 * 30,
  });
  assert.equal(result.blocked, false);
});

test("an empty recent-fingerprint window never blocks anything", async () => {
  const result = await checkCrossBrandDuplicate({ brandId: "ai_salaryman_lab", candidateText: "何か新しい原稿", recentFingerprints: [] });
  assert.equal(result.blocked, false);
});
