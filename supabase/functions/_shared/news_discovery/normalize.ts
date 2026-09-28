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
 * Resolves `raw` against `base`, then removes fragments, tracking parameters, default ports and
 * a trailing slash; sorts the remaining parameters. Returns null for non-http(s) or unparsable URLs.
 */
export function canonicalizeUrl(raw: string, base?: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim(), base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
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
