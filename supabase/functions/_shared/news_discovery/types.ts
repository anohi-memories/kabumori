// News discovery observer (N2): shared types.
//
// Observation only. Nothing in this directory is wired to important-news-monitor, the shadow,
// Fact/Voice, app copy, Push or X. See docs/news-sources/n2_discovery_observer.md.

/**
 * How a source may be used.
 * - DIRECT_SOURCE: official/primary publisher whose items may be normalized into NewsSignals.
 * - DISCOVERY_ONLY: only tells us "something is being reported"; no body, no image, never displayed.
 * - DISABLED: not used in N2 (terms prohibit or are unclear; see news_source_catalog.md).
 */
export type SourcePolicy = "DIRECT_SOURCE" | "DISCOVERY_ONLY" | "SEARCH_DISCOVERY" | "DISABLED";

/**
 * For DISABLED publishers, what is still allowed (N3 v2):
 * - no_access: terms forbid automated access AND AI/TDM processing. Never fetched; results from
 *   these domains that surface in a Web Search are dropped (only counted).
 * - no_direct_fetch: never crawled/fetched, but a Web Search may reveal that a story exists. Only
 *   URL/domain/discovery title are kept, flagged for a primary/official source; never displayed.
 */
export type DisabledScope = "no_access" | "no_direct_fetch";

export type CommercialUsageStatus =
  | "allowed_public_domain" // US federal works (17 USC 105)
  | "allowed_with_attribution" // PDL1.0 / CC BY / ECB / EC style terms
  | "allowed_open_data" // GDELT: open for commercial use with citation + link
  | "allowed_search_metadata" // own Web Search results: URL/domain/title as discovery metadata only
  | "unclear" // needs contact / written confirmation
  | "prohibited"; // terms say personal / non-commercial, or AI/TDM banned

export type ContentUsageScope = "direct" | "discovery_only" | "none";

export type SourceFormat =
  | "rss"
  | "atom"
  | "rdf"
  | "federal_register_json"
  | "gdelt_doc_json"
  | "edinet_documents_json"
  | "web_search";

export type SourceCategory =
  | "monetary_policy"
  | "fiscal_policy"
  | "regulation"
  | "trade_tariffs"
  | "energy"
  | "disaster"
  | "corporate_disclosure"
  | "government"
  | "geopolitics"
  | "macro_data"
  | "discovery";

export type TrustLevel = "official_primary" | "official_secondary" | "discovery_metadata" | "untrusted";

export type SourceDefinition = {
  source_id: string;
  source_name: string;
  operator: string;
  category: SourceCategory;
  country: string; // ISO-3166 alpha-2, or "INT"
  language: string; // BCP-47 primary tag
  source_type: SourceFormat;
  /** Fetch URL. For query-driven sources (GDELT) the query is appended by the fetcher. */
  endpoint: string;
  fetch_interval_hint_sec: number;
  /** Minimum gap between two requests to this source's host (GDELT: 5 s). */
  min_request_gap_ms: number;
  timeout_ms: number;
  /**
   * Ask this source for an uncompressed body ("Accept-Encoding: identity") instead of the runtime default
   * (gzip, br). Only for a publisher whose compressed responses have no length framing: ec.europa.eu answers
   * gzip with "Connection: close" and no Content-Length / Transfer-Encoding, ends the TCP connection without
   * a TLS close_notify, and the Edge Runtime's fetch fails the body read ("body read failed"). Uncompressed
   * it answers chunked. One fixed value on purpose: not a general header map.
   */
  request_accept_encoding?: "identity";
  policy: SourcePolicy;
  commercial_usage_status: CommercialUsageStatus;
  content_usage_scope: ContentUsageScope;
  trust_level: TrustLevel;
  discovery_only: boolean;
  article_body_allowed: boolean;
  headline_storage_allowed: boolean;
  image_usage_allowed: boolean;
  /** Needs a secret (API key) we do not have yet. The fetcher refuses such sources. */
  requires_api_key: boolean;
  enabled_for_n2: boolean;
  /**
   * Freshness guard: items whose publication (or, without one, update) time is certainly older than
   * this many days are dropped as stale before persistence. null = no age filter (GDELT keeps its own
   * query timespan; disabled sources are never fetched). Items without a usable timestamp are kept.
   */
  max_item_age_days: number | null;
  /** DISABLED publishers only: what a Web Search result from these domains may still be used for. */
  disabled_scope?: DisabledScope;
  /** Publisher domains (registrable part) used to recognise Web Search results. */
  publisher_domains?: string[];
  /** Default topics implied by the source itself (in addition to text rules). */
  default_topics: Topic[];
  terms_url: string | null;
  attribution: string | null;
  notes: string;
};

export const TOPICS = [
  "monetary_policy",
  "rates",
  "fx",
  "energy",
  "oil",
  "geopolitics",
  "war",
  "sanctions",
  "tariffs",
  "semiconductor",
  "ai",
  "regulation",
  "disaster",
  "cyber",
  "mna",
  "earnings",
  "product",
  "lawsuit",
  "recall",
  "supply_chain",
  "fiscal",
  "macro_data",
] as const;
export type Topic = typeof TOPICS[number];

export type TickerMatchType =
  | "EXACT_COMPANY_NAME"
  | "STRONG_ALIAS"
  | "WEAK_ALIAS"
  | "TICKER_CODE";

export type TickerCandidate = {
  ticker: string;
  company_name: string;
  /** confirmed: usable as a direct link. candidate: needs corroboration (weak alias only). */
  status: "confirmed" | "candidate";
  /** Why a ticker is confirmed (null for candidates). A weak alias alone never confirms. */
  confirmation_basis: "strong_match" | "ticker_code" | "weak_with_context" | "multiple_weak" | null;
  match_types: TickerMatchType[];
  matched_aliases: string[];
  /** Where the evidence came from; title evidence is stronger than summary evidence. */
  in_title: boolean;
  score: number;
};

export type EntityMention = {
  kind: "country_or_region" | "institution" | "chokepoint" | "commodity" | "company_alias";
  value: string;
};

/** A Web Search is never performed by the observer; this only records why one might be worth it. */
export type VerificationFlag =
  | "no_published_at"
  | "date_only_precision"
  | "future_timestamp"
  | "discovery_only_needs_primary"
  | "restricted_publisher_needs_primary"
  | "weak_ticker_only";

export type NewsSignal = {
  id: string; // = fingerprint (stable)
  source_id: string;
  source_type: SourceFormat;
  policy: SourcePolicy;
  source_url: string;
  canonical_url: string;
  /** Source-supplied stable id (guid / document_number / accession). */
  external_id: string | null;
  title: string;
  /** Whether the title may ever be shown to users (false for DISCOVERY_ONLY: publisher's headline). */
  title_display_allowed: boolean;
  /** Short hint only (<= 280 chars); null when the source's body may not be stored. */
  summary_hint: string | null;
  /** Never fabricated: null when the source gives no timestamp. */
  published_at: string | null;
  published_at_precision: "datetime" | "date" | null;
  updated_at: string | null;
  /** Discovery-service first-seen time (GDELT). Kept apart from published_at on purpose. */
  detected_at: string | null;
  fetched_at: string;
  language: string;
  country: string;
  publisher: string;
  topics: Topic[];
  entities: EntityMention[];
  ticker_candidates: TickerCandidate[];
  image_url: string | null;
  image_source: "feed_media" | null;
  image_usage_allowed: boolean;
  discovery_only: boolean;
  /** Found via a publisher that may not be fetched directly (DISABLED/no_direct_fetch). */
  restricted_publisher: boolean;
  /** Observer Web Search that surfaced this signal (SEARCH_DISCOVERY only). */
  search_id: string | null;
  /** How it was found (GDELT query key, feed key, search lane). */
  discovered_via: string;
  raw_reference: { feed_url: string; item_index: number };
  fingerprint: string;
  title_fingerprint: string;
  same_event_group: string | null;
  needs_verification: VerificationFlag[];
};

/** Output of a parser before normalization. */
export type RawItem = {
  title: string;
  link: string;
  external_id: string | null;
  summary: string | null;
  published_raw: string | null;
  updated_raw: string | null;
  /** When a discovery service first saw the URL (GDELT seendate). Not a publication time. */
  seen_raw: string | null;
  /** Security code given by structured data (EDINET secCode), never guessed from text. */
  structured_ticker: string | null;
  image_url: string | null;
  publisher: string | null;
  language: string | null;
  country: string | null;
};

export type FetchFailureCode =
  | "SOURCE_DISABLED"
  | "SOURCE_NOT_ENABLED_FOR_N2"
  | "SOURCE_REQUIRES_API_KEY"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "HTTP_ERROR"
  | "RATE_LIMITED"
  | "EMPTY_RESPONSE"
  | "MALFORMED_RESPONSE";

export type SourceFetchResult =
  | { source_id: string; ok: true; status: number; items: RawItem[]; fetched_at: string; bytes: number; not_modified: boolean }
  | { source_id: string; ok: false; code: FetchFailureCode; status: number | null; detail: string; fetched_at: string };
