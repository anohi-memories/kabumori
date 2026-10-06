import type { ImportantNewsCategory, IncomingNewsCandidate } from "./news_candidate_logic.ts";
import {
  classifyJpOfficialTitle,
  isJpOfficialSourceId,
  JP_OFFICIAL_SOURCES,
  type JpOfficialSourceId,
} from "./jp_official_filters.ts";

// JP official lane (JP Coverage Phase B): reads the Japanese government releases that the observation-only
// news_discovery pipeline has already fetched and normalised (table news_discovery_signals, SELECT-only for
// service_role) and turns the ones worth judging into important-news candidates.  The feeds are NOT fetched a
// second time, nothing is written to news_discovery_*, and no news_discovery code is imported: the only contract
// is the explicit column list below.
//
// Stored as source_type "market_macro" + source_name "jp_official" (no migration: source_type's CHECK already
// allows market_macro, source_name has no CHECK) with its own SOURCE_POLICY domains.

export const JP_OFFICIAL_SOURCE_NAME = "jp_official";
export const JP_OFFICIAL_FRESHNESS_MS = 48 * 60 * 60 * 1000;
export const JP_OFFICIAL_FUTURE_TOLERANCE_MS = 60 * 60 * 1000;
/** Re-read window beyond the freshness window: a late-committed observer run must not be missed. */
export const JP_OFFICIAL_READ_OVERLAP_MS = 2 * 60 * 60 * 1000;
export const JP_OFFICIAL_READ_LIMIT = 200;

/** Every domain a connected source may publish on (the lane's SOURCE_POLICY domains). */
export const JP_OFFICIAL_ALLOWED_DOMAINS: string[] = [
  ...new Set(Object.values(JP_OFFICIAL_SOURCES).filter((source) => source.enabled).flatMap((source) => source.domains)),
];

export const NEWS_DISCOVERY_SIGNAL_COLUMNS = [
  "id", "source_id", "source_url", "canonical_url", "title", "summary_hint",
  "published_at", "published_date", "source_updated_at", "fetched_at",
].join(",");

export type NewsDiscoverySignalRow = {
  id: string;
  source_id: string;
  source_url: string;
  canonical_url: string | null;
  title: string;
  summary_hint: string | null;
  published_at: string | null;
  published_date: string | null;
  source_updated_at: string | null;
  fetched_at: string;
};

export type JpOfficialSelected = {
  row: NewsDiscoverySignalRow;
  sourceId: JpOfficialSourceId;
  publishedAt: string;
  sourceUrl: string;
  category: ImportantNewsCategory;
  reason: string;
};

export type JpOfficialDrops = Record<string, number>;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The PostgREST read (explicit columns, service_role). Throws a short code on failure. */
export async function fetchJpOfficialSignalRows(deps: {
  supabaseUrl: string;
  serviceRoleKey: string;
  now: Date;
  fetchImpl?: FetchLike;
}): Promise<NewsDiscoverySignalRow[]> {
  const enabled = Object.entries(JP_OFFICIAL_SOURCES).filter(([, source]) => source.enabled).map(([id]) => id);
  const since = new Date(deps.now.getTime() - JP_OFFICIAL_FRESHNESS_MS - JP_OFFICIAL_READ_OVERLAP_MS).toISOString();
  const params = new URLSearchParams({
    select: NEWS_DISCOVERY_SIGNAL_COLUMNS,
    source_id: `in.(${enabled.join(",")})`,
    policy: "eq.DIRECT_SOURCE",
    discovery_only: "eq.false",
    restricted_publisher: "eq.false",
    title_display_allowed: "eq.true",
    fetched_at: `gte.${since}`,
    order: "fetched_at.asc,id.asc",
    limit: String(JP_OFFICIAL_READ_LIMIT),
  });
  const response = await (deps.fetchImpl ?? fetch)(`${deps.supabaseUrl}/rest/v1/news_discovery_signals?${params}`, {
    headers: { apikey: deps.serviceRoleKey, Authorization: `Bearer ${deps.serviceRoleKey}` },
  });
  if (!response.ok) throw new Error("JP_OFFICIAL_SIGNALS_LOOKUP_FAILED");
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("JP_OFFICIAL_SIGNALS_LOOKUP_FAILED");
  return rows.filter((row): row is NewsDiscoverySignalRow =>
    typeof row === "object" && row !== null && typeof row.id === "string" && typeof row.source_id === "string" &&
    typeof row.title === "string" && typeof row.source_url === "string"
  );
}

/** published_at, else the telegram's updated time (JMA), else a date-only value at JST midnight; null when none. */
export function signalPublishedAt(row: NewsDiscoverySignalRow): string | null {
  const candidates = [
    row.published_at,
    row.source_updated_at,
    row.published_date ? `${row.published_date}T00:00:00+09:00` : null,
  ];
  for (const value of candidates) {
    if (value && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  }
  return null;
}

/** https form of a signal URL, or null. A plain http URL of the same host is upgraded; anything else is refused. */
export function httpsSourceUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol === "http:") url.protocol = "https:";
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function hostAllowed(url: string, domains: readonly string[]): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

/**
 * Deterministic selection: connected source, usable time inside the freshness window, URL on the source's own
 * domain, a theme match (see jp_official_filters.ts).  Every drop is counted by reason.
 */
export function selectJpOfficialSignals(
  rows: readonly NewsDiscoverySignalRow[],
  now: Date,
  options: { freshnessMs?: number } = {},
): { selected: JpOfficialSelected[]; drops: JpOfficialDrops } {
  const freshnessMs = options.freshnessMs ?? JP_OFFICIAL_FRESHNESS_MS;
  const drops: JpOfficialDrops = {};
  const drop = (reason: string) => {
    drops[reason] = (drops[reason] ?? 0) + 1;
  };
  const selected: JpOfficialSelected[] = [];
  const seenUrls = new Set<string>();
  for (const row of rows) {
    if (!isJpOfficialSourceId(row.source_id)) {
      drop("unknown_source");
      continue;
    }
    const config = JP_OFFICIAL_SOURCES[row.source_id];
    const classification = classifyJpOfficialTitle(row.source_id, row.title);
    if (classification.decision === "drop") {
      drop(classification.reason);
      continue;
    }
    const publishedAt = signalPublishedAt(row);
    if (!publishedAt) {
      drop("no_time");
      continue;
    }
    const age = now.getTime() - Date.parse(publishedAt);
    if (age > freshnessMs) {
      drop("stale");
      continue;
    }
    if (age < -JP_OFFICIAL_FUTURE_TOLERANCE_MS) {
      drop("future");
      continue;
    }
    const sourceUrl = httpsSourceUrl(row.canonical_url ?? row.source_url);
    if (!sourceUrl) {
      drop("bad_url");
      continue;
    }
    if (!hostAllowed(sourceUrl, config.domains)) {
      drop("host_not_allowed");
      continue;
    }
    if (seenUrls.has(sourceUrl)) {
      drop("duplicate_in_batch");
      continue;
    }
    seenUrls.add(sourceUrl);
    selected.push({ row, sourceId: row.source_id, publishedAt, sourceUrl, category: classification.category, reason: classification.reason });
  }
  return { selected, drops };
}

/** The body the judgement sees: the enriched page text, or the feed's own short text for telegram sources. */
export function jpOfficialBodySummary(selected: JpOfficialSelected, enrichedText: string | null): string | null {
  const config = JP_OFFICIAL_SOURCES[selected.sourceId];
  const raw = config.bodyFromHint ? selected.row.summary_hint?.trim() ?? null : enrichedText?.trim() ?? null;
  if (!raw) return null;
  // The feed hint of some sources is just the title again: that is not a body.
  const normalizedRaw = raw.normalize("NFKC").replace(/\s+/gu, "");
  const normalizedTitle = selected.row.title.normalize("NFKC").replace(/\s+/gu, "");
  if (normalizedRaw === normalizedTitle) return null;
  return `${raw}\n（${config.attribution}）`;
}

export function toJpOfficialIncomingCandidate(selected: JpOfficialSelected, bodySummary: string | null): IncomingNewsCandidate {
  return {
    sourceType: "market_macro",
    sourceUrl: selected.sourceUrl,
    sourceName: JP_OFFICIAL_SOURCE_NAME,
    title: selected.row.title.replace(/\s+/gu, " ").trim(),
    bodySummary,
    companyName: null,
    companyCode: null,
    entityKey: `jp_official:${selected.sourceId}`,
    category: selected.category,
    publishedAt: selected.publishedAt,
  };
}
