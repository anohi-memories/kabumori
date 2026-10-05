// Fetcher: one polite request per source, with per-source timeout, per-host spacing and a
// classified failure instead of an exception. One source failing never stops the others.
import { ParseError, parseSourcePayload } from "./parsers.ts";
import type { FetchFailureCode, SourceDefinition, SourceFetchResult } from "./types.ts";

export const OBSERVER_USER_AGENT = "Kabumori-news-discovery-observer/0.1 (read-only; contact@kabumori.app)";
const MAX_BODY_BYTES = 5_000_000;

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

/** Remembers the last request time per host so hosts like GDELT (one request / 5 s) are respected. */
export class HostRateGate {
  #last = new Map<string, number>();
  constructor(
    private readonly clock: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async wait(url: string, minGapMs: number): Promise<number> {
    const host = new URL(url).host;
    const last = this.#last.get(host);
    let waited = 0;
    if (last !== undefined && minGapMs > 0) {
      waited = Math.max(0, last + minGapMs - this.clock());
      if (waited > 0) await this.sleep(waited);
    }
    this.#last.set(host, this.clock());
    return waited;
  }
}

/** Conditional-GET validators remembered between runs (in memory for N2). */
export type ValidatorCache = Map<string, { etag: string | null; lastModified: string | null }>;

export type FetchOptions = {
  /** Per-request timeout override (the run deadline caps it; never above the source timeout). */
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
  gate?: HostRateGate;
  now?: () => Date;
  validators?: ValidatorCache;
  /** Overrides the registry endpoint (GDELT query URLs). */
  url?: string;
};

export type GdeltQuery = { key: string; query: string; timespan: string; maxrecords: number };

/**
 * Small, topic-level GDELT queries. Kept few on purpose: each costs one 6-second-spaced request.
 * sourcelang:english keeps results within what the ja/en rule set can classify (live run 2026-09-28:
 * without it 32/38 titles were in other languages and got no topic).
 */
export const GDELT_DISCOVERY_QUERIES: readonly GdeltQuery[] = [
  { key: "energy_chokepoints", query: '(oil OR crude OR OPEC OR tanker OR "Strait of Hormuz" OR "Red Sea") sourcelang:english', timespan: "3h", maxrecords: 50 },
  { key: "conflict_sanctions", query: "(missile OR airstrike OR invasion OR sanctions OR ceasefire) sourcelang:english", timespan: "3h", maxrecords: 50 },
  { key: "japan_companies", query: "(Toyota OR Sony OR Nintendo OR SoftBank OR \"Tokyo Electron\" OR Hitachi) sourcelang:english", timespan: "6h", maxrecords: 50 },
  { key: "semis_ai", query: '(semiconductor OR chipmaker OR TSMC OR Nvidia OR "export controls") sourcelang:english', timespan: "3h", maxrecords: 50 },
];

export function gdeltQueryUrl(source: SourceDefinition, query: GdeltQuery): string {
  const url = new URL(source.endpoint);
  url.searchParams.set("query", query.query.trim());
  url.searchParams.set("mode", "artlist");
  url.searchParams.set("format", "json");
  url.searchParams.set("sort", "datedesc");
  url.searchParams.set("timespan", query.timespan);
  url.searchParams.set("maxrecords", String(query.maxrecords));
  return url.toString();
}

function refusal(source: SourceDefinition): FetchFailureCode | null {
  if (source.policy === "DISABLED") return "SOURCE_DISABLED";
  if (source.requires_api_key) return "SOURCE_REQUIRES_API_KEY";
  if (!source.enabled_for_n2) return "SOURCE_NOT_ENABLED_FOR_N2";
  return null;
}

function charsetOf(contentType: string | null, head: string): string {
  const fromHeader = contentType?.match(/charset=["']?([\w-]+)/i)?.[1];
  const fromXml = head.match(/<\?xml[^>]*encoding=["']([\w-]+)["']/i)?.[1];
  const label = (fromHeader ?? fromXml ?? "utf-8").toLowerCase();
  return label === "sjis" || label === "x-sjis" ? "shift_jis" : label;
}

export function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 200));
  try {
    return new TextDecoder(charsetOf(contentType, head)).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
}

export async function fetchSource(source: SourceDefinition, options: FetchOptions = {}): Promise<SourceFetchResult> {
  const now = options.now ?? (() => new Date());
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = options.url ?? source.endpoint;
  const fail = (code: FetchFailureCode, status: number | null, detail: string): SourceFetchResult => ({
    source_id: source.source_id,
    ok: false,
    code,
    status,
    detail: detail.slice(0, 200),
    fetched_at: now().toISOString(),
  });

  const timeoutMs = Math.max(1, Math.min(source.timeout_ms, options.timeoutMs ?? source.timeout_ms));
  const refused = refusal(source);
  if (refused) return fail(refused, null, "refused by source policy");

  await (options.gate ?? new HostRateGate()).wait(url, source.min_request_gap_ms);
  const headers: Record<string, string> = {
    "User-Agent": OBSERVER_USER_AGENT,
    Accept: source.source_type.endsWith("json")
      ? "application/json"
      : "application/rss+xml, application/atom+xml, application/rdf+xml, application/xml, text/xml",
  };
  if (source.request_accept_encoding) headers["Accept-Encoding"] = source.request_accept_encoding;
  const validator = options.validators?.get(url);
  if (validator?.etag) headers["If-None-Match"] = validator.etag;
  if (validator?.lastModified) headers["If-Modified-Since"] = validator.lastModified;

  let response: Response;
  try {
    response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  } catch (error) {
    return isTimeout(error)
      ? fail("TIMEOUT", null, `no response within ${timeoutMs} ms`)
      : fail("NETWORK_ERROR", null, error instanceof Error ? error.name : "unknown");
  }
  const fetchedAt = now().toISOString();

  if (response.status === 304) {
    await response.body?.cancel();
    return { source_id: source.source_id, ok: true, status: 304, items: [], fetched_at: fetchedAt, bytes: 0, not_modified: true };
  }
  if (response.status === 429) {
    await response.body?.cancel();
    return fail("RATE_LIMITED", 429, "429 Too Many Requests");
  }
  if (!response.ok) {
    await response.body?.cancel();
    return fail("HTTP_ERROR", response.status, `HTTP ${response.status}`);
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    return isTimeout(error) ? fail("TIMEOUT", response.status, "body timed out") : fail("NETWORK_ERROR", response.status, "body read failed");
  }
  if (bytes.byteLength === 0) return fail("EMPTY_RESPONSE", response.status, "empty body");
  if (bytes.byteLength > MAX_BODY_BYTES) return fail("MALFORMED_RESPONSE", response.status, "body too large");
  const body = decodeBody(bytes, response.headers.get("content-type"));
  if (!body.trim()) return fail("EMPTY_RESPONSE", response.status, "blank body");

  let items;
  try {
    items = parseSourcePayload(source, body);
  } catch (error) {
    if (error instanceof ParseError && error.message === "GDELT_RATE_LIMIT_TEXT") {
      return fail("RATE_LIMITED", response.status, "GDELT rate-limit notice");
    }
    return fail("MALFORMED_RESPONSE", response.status, error instanceof Error ? error.message : "parse failed");
  }
  options.validators?.set(url, { etag: response.headers.get("etag"), lastModified: response.headers.get("last-modified") });
  return { source_id: source.source_id, ok: true, status: response.status, items, fetched_at: fetchedAt, bytes: bytes.byteLength, not_modified: false };
}
