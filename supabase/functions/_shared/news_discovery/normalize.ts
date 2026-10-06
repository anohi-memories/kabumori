// Deterministic normalization: URLs, titles, timestamps, fingerprints. No AI, no network.

/** Query parameters that only track the click and never change the document. */
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "yclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
  "at_medium",
  "at_campaign",
  "cmpid",
  "rss",
  "feature",
  "ncid",
  "guccounter",
]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || lower.startsWith("at_") || TRACKING_PARAMS.has(lower);
}

/**
 * A link that starts with "www." + a dotted host and has no scheme (BEA RSS, 2026-09-29:
 * "www.bea.gov/news/2026/..."). Only this unambiguous form is completed; "bea.gov/foo" is not
 * guessed (it stays a relative path of the feed).
 */
const WWW_SCHEMELESS = /^www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/?#:]|$)/i;

/**
 * Feed link -> absolute http(s) URL, or null (the item is then dropped as invalid_url).
 * - absolute http(s) URLs are kept as given (only parsed and serialized);
 * - "www.host.tld/..." without a scheme becomes "https://www.host.tld/...";
 * - genuine relative ("/path", "page.html") and protocol-relative ("//host/path") links are resolved
 *   against `base` (the feed URL);
 * - other schemes (javascript:, data:, file:, ftp:, ...), whitespace/control characters inside the
 *   link, and anything unparsable -> null.
 * This is the single place where a raw link becomes a URL; canonicalizeUrl builds on it.
 */
export function resolveHttpUrl(raw: string, base?: string): string | null {
  const value = raw.trim();
  // deno-lint-ignore no-control-regex -- control characters inside a link are rejected on purpose
  if (!value || /[\s\u0000-\u001f\u007f]/.test(value)) return null;
  const candidate = WWW_SCHEMELESS.test(value) ? `https://${value}` : value;
  let url: URL;
  try {
    url = new URL(candidate, base);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname) return null;
  return url.toString();
}

/**
 * Resolves `raw` (via resolveHttpUrl, against `base`), then removes fragments, tracking parameters,
 * default ports and a trailing slash; sorts the remaining parameters. Returns null for
 * non-http(s) or unparsable URLs.
 */
export function canonicalizeUrl(raw: string, base?: string): string | null {
  const resolved = resolveHttpUrl(raw, base);
  if (!resolved) return null;
  const url = new URL(resolved);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
  const kept = [...url.searchParams.entries()].filter(([name]) => !isTrackingParam(name));
  kept.sort(([a, av], [b, bv]) => a === b ? av.localeCompare(bv) : a.localeCompare(b));
  url.search = "";
  for (const [name, value] of kept) url.searchParams.append(name, value);
  url.pathname = url.pathname.replace(/\/{2,}/g, "/");
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

/** Scheme- and www-insensitive key used only for duplicate detection. */
export function urlDedupeKey(canonicalUrl: string): string {
  const url = new URL(canonicalUrl);
  return `${url.hostname.replace(/^www\./, "")}${url.pathname}${url.search}`;
}

/** Trailing " - Publisher" / " | Publisher" suffixes that differ between syndications. */
const TITLE_SUFFIX = /\s+[-|｜–—:：]\s*[^-|｜–—:：]{1,40}$/u;

/**
 * NFKC, lower case, publisher suffix removed, punctuation and spaces removed. Japanese and other
 * scripts are kept as-is so "日銀、利上げ決定" and "日銀 利上げ決定" produce the same key.
 */
export function normalizeTitle(title: string, options: { stripSuffix?: boolean } = {}): string {
  let value = title.normalize("NFKC").toLowerCase().trim();
  if (options.stripSuffix ?? true) {
    const stripped = value.replace(TITLE_SUFFIX, "");
    // Only strip when a meaningful title remains (avoid eating "Q&A - 2026").
    if ([...stripped].length >= 12) value = stripped;
  }
  return value.replace(/[\p{P}\p{S}\s]+/gu, "");
}

/** Zone abbreviations some official feeds write instead of an offset (金融庁: "... 16:00:00 JST"). */
const EXPLICIT_ZONES: Record<string, string> = { JST: "+0900", KST: "+0900" };

export type ParsedTime = { iso: string; precision: "datetime" | "date" } | null;

/** RFC 822 / ISO 8601 / YYYY-MM-DD. Unparsable -> null (never guessed). */
export function parseTimestamp(raw: string | null): ParsedTime {
  if (!raw) return null;
  const value = raw.trim();
  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) return { iso: `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`, precision: "date" };
  const compact = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/); // GDELT seendate
  const normalized = compact
    ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z`
    : value.replace(/\s(JST|KST)$/, (_, zone: string) => ` ${EXPLICIT_ZONES[zone]}`);
  const time = Date.parse(normalized);
  if (!Number.isFinite(time)) return null;
  // A timestamp without any zone designator is ambiguous; refuse it rather than assume UTC.
  if (!compact && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value)) return null;
  return { iso: new Date(time).toISOString(), precision: "datetime" };
}

export const FUTURE_SKEW_TOLERANCE_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Latest instant a parsed timestamp can denote. A date-only value ("YYYY-MM-DD", no zone) is still
 * that calendar day somewhere until 12:00 UTC of the next day (UTC-12), so it is never treated as
 * older than it can possibly be.
 */
function latestInstant(parsed: NonNullable<ParsedTime>): number {
  const start = Date.parse(parsed.precision === "date" ? `${parsed.iso}T00:00:00Z` : parsed.iso);
  return parsed.precision === "date" ? start + 36 * 60 * 60 * 1000 : start;
}

/**
 * Freshness guard. Effective time = published, else updated (Atom feeds such as JMA only have
 * updated). A newer update does not make an old publication new. No usable timestamp -> not stale
 * (kept). Stale only when certainly older than the window (exactly maxAgeDays old is kept).
 */
export function isStale(published: ParsedTime, updated: ParsedTime, now: Date, maxAgeDays: number): boolean {
  const effective = published ?? updated;
  if (!effective) return false;
  return now.getTime() - latestInstant(effective) > maxAgeDays * DAY_MS;
}

export function isFuture(parsed: ParsedTime, now: Date): boolean {
  return !!parsed && parsed.precision === "datetime" && Date.parse(parsed.iso) > now.getTime() + FUTURE_SKEW_TOLERANCE_MS;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function truncateHint(value: string | null, max = 280): string | null {
  if (!value) return null;
  const chars = [...value.replace(/\s+/g, " ").trim()];
  if (chars.length === 0) return null;
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}
