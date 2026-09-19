import type { ShadowCandidate } from "./shadow_logic.ts";

export type ShadowSource = {
  key: string;
  url: string;
  topic: string;
  category: string;
  kind: "rss" | "gdelt";
};

export const SHADOW_SOURCES: readonly ShadowSource[] = [
  {
    key: "boj",
    url: "https://www.boj.or.jp/rss/whatsnew.xml",
    topic: "macro:boj",
    category: "boj",
    kind: "rss",
  },
  {
    key: "fed",
    url: "https://www.federalreserve.gov/feeds/press_all.xml",
    topic: "macro:fed",
    category: "frb",
    kind: "rss",
  },
  {
    key: "jma_eqvol",
    url: "https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml",
    topic: "disaster:jma",
    category: "disaster",
    kind: "rss",
  },
  {
    key: "ustr",
    url: "https://ustr.gov/rss.xml",
    topic: "policy:ustr",
    category: "tariffs",
    kind: "rss",
  },
  {
    key: "un_peace_security",
    url:
      "https://news.un.org/feed/subscribe/en/news/topic/peace-and-security/feed/rss.xml",
    topic: "geo:un",
    category: "geopolitics",
    kind: "rss",
  },
  {
    key: "eia",
    url: "https://www.eia.gov/rss/press_rss.xml",
    topic: "commodity:oil",
    category: "other_market_moving",
    kind: "rss",
  },
  {
    key: "bbc_world",
    url: "https://feeds.bbci.co.uk/news/world/rss.xml",
    topic: "world:breaking",
    category: "geopolitics",
    kind: "rss",
  },
  {
    key: "al_jazeera",
    url: "https://www.aljazeera.com/xml/rss/all.xml",
    topic: "world:breaking",
    category: "geopolitics",
    kind: "rss",
  },
  {
    key: "ecb",
    url: "https://www.ecb.europa.eu/rss/press.html",
    topic: "macro:ecb",
    category: "interest_rates",
    kind: "rss",
  },
  {
    key: "sec",
    url: "https://www.sec.gov/news/pressreleases.rss",
    topic: "policy:sec",
    category: "us_government_policy",
    kind: "rss",
  },
  {
    key: "gdelt",
    url:
      "https://api.gdeltproject.org/api/v2/doc/doc?query=(earthquake%20OR%20tsunami%20OR%20ceasefire%20OR%20sanctions%20OR%20tariff)&mode=artlist&maxrecords=25&format=json&sort=datedesc",
    topic: "world:gdelt",
    category: "other_market_moving",
    kind: "gdelt",
  },
] as const;

/** GDELT has materially higher latency/rate-limit risk, so poll it hourly. */
export function isSourceCooldown(
  source: ShadowSource,
  now = new Date(),
): boolean {
  return source.key === "gdelt" &&
    Math.floor(now.getTime() / (30 * 60 * 1000)) % 2 === 1;
}

function decodeXml(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(
      /&quot;/g,
      '"',
    )
    .replace(/\s+/g, " ").trim();
}

function tag(block: string, names: readonly string[]): string {
  for (const name of names) {
    const found = block.match(
      new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"),
    );
    if (found) return decodeXml(found[1]);
  }
  return "";
}

function link(block: string, base: string): string {
  const raw = tag(block, ["link", "guid"]) ||
    block.match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1] || "";
  try {
    const url = new URL(raw, base);
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export function parseRss(
  source: ShadowSource,
  body: string,
  now = new Date(),
): ShadowCandidate[] {
  const blocks =
    body.match(/<(?:item|entry)\b[^>]*>[\s\S]*?<\/(?:item|entry)>/gi) ?? [];
  const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
  return blocks.flatMap((block) => {
    const headline = tag(block, ["title"]);
    const sourceUrl = link(block, source.url);
    const rawDate = tag(block, [
      "pubDate",
      "published",
      "updated",
      "dc:date",
      "date",
    ]);
    const timestamp = Date.parse(rawDate);
    if (
      !headline || !sourceUrl || !Number.isFinite(timestamp) ||
      timestamp < cutoff || timestamp > now.getTime() + 60 * 60 * 1000
    ) return [];
    return [{
      sourceName: source.key,
      sourceUrl,
      topic: source.topic,
      category: source.category,
      headline,
      bodySummary: tag(block, ["description", "summary", "content"]) || null,
      publishedAt: new Date(timestamp).toISOString(),
    }];
  }).slice(0, 8);
}

export function parseGdelt(
  source: ShadowSource,
  raw: unknown,
  now = new Date(),
): ShadowCandidate[] {
  const articles = (raw as { articles?: unknown } | null)?.articles;
  if (!Array.isArray(articles)) return [];
  const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
  return articles.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.title !== "string" || typeof record.url !== "string") {
      return [];
    }
    const rawDate = typeof record.seendate === "string" ? record.seendate : "";
    const compact = rawDate.match(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
    );
    const timestamp = Date.parse(
      compact
        ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${
          compact[5]
        }:${compact[6]}Z`
        : rawDate,
    );
    let sourceUrl = "";
    try {
      const parsed = new URL(record.url);
      if (parsed.protocol === "https:") sourceUrl = parsed.toString();
    } catch { /* reject */ }
    if (
      !sourceUrl || !Number.isFinite(timestamp) || timestamp < cutoff ||
      timestamp > now.getTime() + 60 * 60 * 1000
    ) return [];
    return [{
      sourceName: source.key,
      sourceUrl,
      topic: source.topic,
      category: source.category,
      headline: record.title.trim(),
      bodySummary: null,
      publishedAt: new Date(timestamp).toISOString(),
    }];
  }).slice(0, 8);
}

export async function fetchSource(
  source: ShadowSource,
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
): Promise<ShadowCandidate[]> {
  const response = await fetchImpl(source.url, {
    headers: {
      Accept: source.kind === "gdelt"
        ? "application/json"
        : "application/rss+xml, application/atom+xml, application/xml, text/xml",
      "User-Agent": "Kabumori-important-news-shadow/1.0 contact@kabumori.app",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`SOURCE_HTTP_${response.status}`);
  return source.kind === "gdelt"
    ? parseGdelt(source, await response.json(), now)
    : parseRss(source, await response.text(), now);
}
