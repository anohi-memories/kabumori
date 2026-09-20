export type ShadowCandidate = {
  sourceName: string;
  sourceUrl: string;
  topic: string;
  category: string;
  headline: string;
  bodySummary: string | null;
  publishedAt: string | null;
};

export type LiveCandidate = {
  id: string;
  source_url: string;
  title: string;
  normalized_title: string | null;
  entity_key: string | null;
  category: string;
  published_at: string;
  fetched_at: string;
  importance: string;
  content_hash: string;
};

const HIGH_SIGNAL =
  /earthquake|tsunami|eruption|ceasefire|sanction|tariff|fomc|federal reserve|bank of japan|boj|ecb|emergency|missile|attack|strike|explosion|地震|津波|噴火|停戦|制裁|関税|緊急/u;

export function normalizeText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function canonicalUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
  }
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  url.pathname = url.pathname.replace(/\/$/, "") || "/";
  return url.toString();
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)].map((item) =>
    item.toString(16).padStart(2, "0")
  ).join("");
}

export async function dedupeKey(candidate: ShadowCandidate): Promise<string> {
  return sha256(
    `${canonicalUrl(candidate.sourceUrl)}\n${
      normalizeText(candidate.headline)
    }\n${candidate.topic}`,
  );
}

export async function eventKey(candidate: ShadowCandidate): Promise<string> {
  return sha256(`${candidate.topic}\n${normalizeText(candidate.headline)}`);
}

function tokenSet(value: string): Set<string> {
  return new Set(
    normalizeText(value).split(" ").filter((token) => token.length >= 3),
  );
}

function overlap(a: string, b: string): number {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const token of left) if (right.has(token)) common += 1;
  return common / Math.min(left.size, right.size);
}

export function matchLiveCandidate(
  candidate: ShadowCandidate,
  live: readonly LiveCandidate[],
): LiveCandidate | null {
  let candidateUrl: string;
  try {
    candidateUrl = canonicalUrl(candidate.sourceUrl);
  } catch {
    return null;
  }
  const published = candidate.publishedAt
    ? Date.parse(candidate.publishedAt)
    : NaN;
  for (const item of live) {
    try {
      if (canonicalUrl(item.source_url) === candidateUrl) return item;
    } catch { /* an invalid live URL cannot match */ }
  }
  const ranked = live
    .filter((item) =>
      item.category === candidate.category ||
      item.entity_key === candidate.topic
    )
    .map((item) => ({
      item,
      score: overlap(candidate.headline, item.normalized_title ?? item.title),
    }))
    .filter(({ item, score }) => {
      if (score < 0.66) return false;
      if (!Number.isFinite(published)) return true;
      return Math.abs(Date.parse(item.published_at) - published) <=
        12 * 60 * 60 * 1000;
    })
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.item ?? null;
}

export type SearchTrigger = { shouldSearch: boolean; reason: string };

export function hasValidCronSecret(
  request: Request,
  expectedSecret: string,
): boolean {
  const provided = request.headers.get("x-cron-secret") ?? "";
  if (!expectedSecret || provided.length !== expectedSecret.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < expectedSecret.length; index += 1) {
    mismatch |= expectedSecret.charCodeAt(index) ^ provided.charCodeAt(index);
  }
  return mismatch === 0;
}

export function runSlot(now: Date, minutes = 10): string {
  const value = new Date(now);
  value.setUTCMinutes(
    Math.floor(value.getUTCMinutes() / minutes) * minutes,
    0,
    0,
  );
  return value.toISOString();
}

export function decideConditionalSearch(
  candidate: ShadowCandidate,
  options: {
    isNew: boolean;
    topicCoolingDown: boolean;
    degradedSourceCount: number;
  },
): SearchTrigger {
  if (!options.isNew) return { shouldSearch: false, reason: "duplicate" };
  if (options.topicCoolingDown) {
    return { shouldSearch: false, reason: "topic_cooldown" };
  }
  const sparse = (candidate.bodySummary?.trim().length ?? 0) < 80;
  if (
    sparse &&
    HIGH_SIGNAL.test(`${candidate.headline} ${candidate.bodySummary ?? ""}`)
  ) {
    return { shouldSearch: true, reason: "new_high_signal_sparse" };
  }
  if (
    options.degradedSourceCount >= 2 && HIGH_SIGNAL.test(candidate.headline)
  ) {
    return { shouldSearch: true, reason: "source_degradation_fallback" };
  }
  return { shouldSearch: false, reason: "free_source_only" };
}

export function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  webSearchCalls: number,
): number {
  const amount = inputTokens * 0.2 / 1_000_000 +
    outputTokens * 1.2 / 1_000_000 + webSearchCalls * 0.01;
  return Number(amount.toFixed(8));
}
