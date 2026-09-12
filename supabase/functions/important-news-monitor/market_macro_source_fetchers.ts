import { hrefValue, tagValue } from "./official_source_fetchers.ts";
import type { ImportantNewsCategory, IncomingNewsCandidate } from "./news_candidate_logic.ts";

// P0 market_macro lane: broad macro/political/geopolitical material that moves Japanese equities as a
// whole, sourced separately from the corporate (TDnet/company IR) lane. Every feed below is a public,
// official/primary RSS source that needs no API key and no new secret. Coverage is deliberately uneven
// at P0 — see the STEP 8 report for what is and isn't covered; the goal is opening the input funnel, not
// perfecting it, since judgement (Luna/Sol) already expects and can classify this kind of material.
export type MarketMacroSource = {
  key: string;
  sourceName: string;
  feedUrl: string;
  defaultCategory: ImportantNewsCategory;
  defaultTopicKey: string;
  refine?: (title: string) => { category: ImportantNewsCategory; topicKey: string } | null;
  /**
   * Optional gate for a feed that publishes routine items alongside the ones
   * that matter. Only used by the JMA feed, whose titles are fixed strings
   * ("気象特別警報・警報・注意報", "降灰予報（定時）") with the actual grade in
   * the body — without this, every ash forecast and advisory would become a
   * candidate. Returning false drops the item before it is normalised.
   */
  include?: (title: string, summary: string | null) => boolean;
};

// Grades worth a candidate: a shindo-5+ quake, any tsunami warning, an eruption
// warning, or a J-Alert-grade emergency quake bulletin. Advisories (注意報),
// scheduled ash forecasts and drills are deliberately excluded.
const JMA_SIGNIFICANT_TITLE =
  /震度速報|震源・震度に関する情報|津波警報・注意報・予報|津波情報|緊急地震速報|噴火警報|噴火速報|火口周辺警報/u;
const JMA_SIGNIFICANT_BODY =
  /大津波警報|津波警報|震度\s*[5-7５-７]|マグニチュード\s*[6-9６-９]|緊急地震速報（警報）|噴火警報|噴火速報|噴火警戒レベル\s*[4-5４-５]/u;

export function isSignificantJmaItem(title: string, summary: string | null): boolean {
  const normalizedTitle = title.normalize("NFKC");
  const normalizedBody = (summary ?? "").normalize("NFKC");
  if (!JMA_SIGNIFICANT_TITLE.test(normalizedTitle)) return false;
  return JMA_SIGNIFICANT_BODY.test(normalizedBody) || JMA_SIGNIFICANT_BODY.test(normalizedTitle);
}

export const MARKET_MACRO_SOURCES: MarketMacroSource[] = [
  {
    key: "boj",
    sourceName: "market_macro",
    feedUrl: "https://www.boj.or.jp/rss/whatsnew.xml",
    defaultCategory: "boj",
    defaultTopicKey: "macro:boj",
  },
  {
    key: "fed",
    sourceName: "market_macro",
    feedUrl: "https://www.federalreserve.gov/feeds/press_all.xml",
    defaultCategory: "frb",
    defaultTopicKey: "macro:fed",
    refine: (title) => /discount rate|fomc|federal funds|monetary policy/i.test(title)
      ? { category: "interest_rates", topicKey: "macro:fomc" }
      : null,
  },
  {
    key: "ustr",
    sourceName: "market_macro",
    feedUrl: "https://ustr.gov/rss.xml",
    defaultCategory: "us_government_policy",
    defaultTopicKey: "policy:ustr",
    refine: (title) => {
      if (/tariff|section 301|section 232|duties/i.test(title)) {
        return { category: "tariffs", topicKey: "policy:tariff" };
      }
      if (/china|prc\b/i.test(title)) return { category: "china_policy", topicKey: "policy:china_trade" };
      return null;
    },
  },
  {
    key: "un_peace_security",
    sourceName: "market_macro",
    feedUrl: "https://news.un.org/feed/subscribe/en/news/topic/peace-and-security/feed/rss.xml",
    defaultCategory: "geopolitics",
    defaultTopicKey: "geo:un",
    refine: (title) => {
      if (/ceasefire|truce/i.test(title)) return { category: "war_ceasefire", topicKey: "geo:ceasefire" };
      if (/sanction/i.test(title)) return { category: "sanctions", topicKey: "geo:sanctions" };
      if (/taiwan/i.test(title)) return { category: "geopolitics", topicKey: "geo:taiwan" };
      if (/war\b|conflict|military|strike|attack/i.test(title)) {
        return { category: "war_ceasefire", topicKey: "geo:conflict" };
      }
      return null;
    },
  },
  // Phase 2: the only Japanese primary feed that is actually subscribable. A
  // read-only probe on 2026-09-12 found eqvol.xml and extra.xml returning 200
  // Atom, while mod.go.jp (403), jpx.co.jp / mof.go.jp / kantei.go.jp (404 on the
  // documented paths), treasury.gov and bis.doc.gov (redirect to HTML) do not
  // offer a usable feed; those categories stay on breaking_market web search
  // rather than gaining a fragile scraper. extra.xml (weather warnings) is left
  // out too: its grade is only in the body, and the volume is dominated by
  // advisories.
  {
    key: "jma_eqvol",
    sourceName: "market_macro",
    feedUrl: "https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml",
    defaultCategory: "disaster",
    defaultTopicKey: "disaster:jma_eqvol",
    include: isSignificantJmaItem,
    refine: (title) => /津波/u.test(title.normalize("NFKC"))
      ? { category: "disaster", topicKey: "disaster:tsunami" }
      : null,
  },
  {
    key: "eia",
    sourceName: "market_macro",
    feedUrl: "https://www.eia.gov/rss/press_rss.xml",
    defaultCategory: "other_market_moving",
    defaultTopicKey: "commodity:oil",
  },
];

// Domains SOURCE_POLICY.market_macro allows in index.ts must match these feed hosts exactly — kept here
// too so a future added source can't silently rely on parseIncoming's allowlist alone.
export const MARKET_MACRO_ALLOWED_DOMAINS = [
  "boj.or.jp", "federalreserve.gov", "ustr.gov", "news.un.org", "eia.gov", "jma.go.jp",
];

const MAX_MARKET_MACRO_ITEM_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_MARKET_MACRO_FUTURE_SKEW_MS = 60 * 60 * 1000;

function withHttps(url: string): string {
  return url.startsWith("http://") ? `https://${url.slice("http://".length)}` : url;
}

export function isFreshMarketMacroPublishedAt(publishedAtIso: string, now: Date): boolean {
  const parsed = Date.parse(publishedAtIso);
  if (!Number.isFinite(parsed)) return false;
  const delta = now.getTime() - parsed;
  return delta <= MAX_MARKET_MACRO_ITEM_AGE_MS && delta >= -MAX_MARKET_MACRO_FUTURE_SKEW_MS;
}

export function normalizeMarketMacroItem(
  source: MarketMacroSource,
  item: { title: string; url: string; publishedAt: string; summary: string | null },
  now: Date = new Date(),
): IncomingNewsCandidate | null {
  const title = item.title.trim();
  if (!title || !item.url || !Number.isFinite(Date.parse(item.publishedAt))) return null;
  if (source.include && !source.include(title, item.summary)) return null;
  const publishedAt = new Date(item.publishedAt).toISOString();
  if (!isFreshMarketMacroPublishedAt(publishedAt, now)) return null;

  let sourceUrl: string;
  try {
    sourceUrl = withHttps(new URL(item.url, source.feedUrl).toString());
    if (new URL(sourceUrl).protocol !== "https:") return null;
  } catch {
    return null;
  }

  const refined = source.refine?.(title) ?? null;
  return {
    sourceType: "market_macro",
    sourceName: source.sourceName,
    sourceUrl,
    title,
    bodySummary: item.summary?.trim() || null,
    companyName: null,
    companyCode: null,
    entityKey: refined?.topicKey ?? source.defaultTopicKey,
    category: refined?.category ?? source.defaultCategory,
    publishedAt,
  };
}

function parseRssItems(xml: string): string[] {
  return xml.match(/<(?:item|entry)\b[^>]*>[\s\S]*?<\/(?:item|entry)>/gi) ?? [];
}

export function parseMarketMacroRss(
  source: MarketMacroSource,
  xml: string,
  now: Date = new Date(),
): IncomingNewsCandidate[] {
  const results: IncomingNewsCandidate[] = [];
  for (const item of parseRssItems(xml)) {
    const candidate = normalizeMarketMacroItem(source, {
      title: tagValue(item, ["title"]),
      url: hrefValue(item, source.feedUrl),
      publishedAt: tagValue(item, ["pubDate", "published", "updated", "date"]),
      summary: tagValue(item, ["description", "summary", "content"]) || null,
    }, now);
    if (candidate) results.push(candidate);
  }
  return results;
}

export async function fetchMarketMacroSource(
  source: MarketMacroSource,
  fetcher: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<IncomingNewsCandidate[]> {
  const result = await fetcher(source.feedUrl, {
    headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!result.ok) throw new Error(`MARKET_MACRO_FETCH_FAILED:${result.status}`);
  return parseMarketMacroRss(source, await result.text(), now);
}
