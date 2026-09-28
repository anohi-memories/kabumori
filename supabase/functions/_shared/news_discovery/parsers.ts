// Parsers: source payload -> RawItem[]. Pure functions; no network, no clock.
//
// Parsers throw ParseError for payloads that are not the declared format (the fetcher maps that to
// MALFORMED_RESPONSE) and return [] for a well-formed payload without items (EMPTY_RESPONSE upstream).
import type { RawItem, SourceDefinition } from "./types.ts";

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** CDATA unwrap -> tag strip -> entity decode -> whitespace collapse. */
export function xmlText(value: string): string {
  const unwrapped = value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  // Entity-encoded HTML inside descriptions (&lt;p&gt;) is decoded first, then stripped.
  const decodedOnce = decodeEntities(unwrapped);
  return decodeEntities(decodedOnce.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tagText(block: string, names: readonly string[]): string | null {
  for (const name of names) {
    const found = block.match(new RegExp(`<${escapeRegExp(name)}\\b[^>]*>([\\s\\S]*?)</${escapeRegExp(name)}>`, "i"));
    if (found) {
      const text = xmlText(found[1]);
      if (text) return text;
    }
  }
  return null;
}

function attr(tag: string, name: string): string | null {
  const found = tag.match(new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  return found ? decodeEntities(found[2] ?? found[3] ?? "") : null;
}

function itemLink(block: string): string | null {
  // Atom: prefer rel="alternate" (or no rel) with an href.
  const linkTags = block.match(/<link\b[^>]*\/?>/gi) ?? [];
  let fallback: string | null = null;
  for (const linkTag of linkTags) {
    const href = attr(linkTag, "href");
    if (!href) continue;
    const rel = attr(linkTag, "rel");
    if (!rel || rel === "alternate") return href;
    fallback ??= href;
  }
  const text = tagText(block, ["link"]);
  if (text) return text;
  const rdfAbout = block.match(/<item\b[^>]*rdf:about\s*=\s*"([^"]+)"/i)?.[1];
  if (rdfAbout) return decodeEntities(rdfAbout);
  const guid = block.match(/<guid\b([^>]*)>([\s\S]*?)<\/guid>/i);
  if (guid && !/isPermaLink\s*=\s*"false"/i.test(guid[1])) return xmlText(guid[2]);
  return fallback;
}

function itemImage(block: string): string | null {
  for (const tag of block.match(/<(?:media:thumbnail|media:content|enclosure)\b[^>]*>/gi) ?? []) {
    const url = attr(tag, "url");
    if (!url) continue;
    const type = attr(tag, "type") ?? "";
    const medium = attr(tag, "medium") ?? "";
    if (/^media:thumbnail/i.test(tag.slice(1)) || type.startsWith("image/") || medium === "image") return url;
  }
  return null;
}

/** RSS 2.0, RSS 1.0 (RDF) and Atom. */
export function parseFeed(body: string): RawItem[] {
  const trimmed = body.trimStart();
  const isXml = /^(<\?xml|<rss\b|<feed\b|<rdf:RDF\b)/i.test(trimmed) || /<(rss|feed|rdf:RDF)\b/i.test(trimmed.slice(0, 2000));
  if (!isXml) throw new ParseError("NOT_A_FEED");
  if (!/<\/(rss|feed|rdf:RDF)>\s*$/i.test(body.trimEnd())) throw new ParseError("TRUNCATED_FEED");
  const blocks = body.match(/<(item|entry)\b[^>]*>[\s\S]*?<\/\1>/gi) ?? [];
  return blocks.flatMap((block) => {
    const title = tagText(block, ["title"]);
    const link = itemLink(block);
    if (!title || !link) return [];
    const guid = tagText(block, ["guid", "id"]);
    return [{
      title,
      link,
      external_id: guid,
      summary: tagText(block, ["description", "summary", "content:encoded", "content"]),
      published_raw: tagText(block, ["pubDate", "published", "dc:date", "issued"]),
      updated_raw: tagText(block, ["updated", "dc:modified", "atom:updated"]),
      seen_raw: null,
      structured_ticker: null,
      image_url: itemImage(block),
      publisher: null, // the source's operator is the publisher for DIRECT feeds
      language: null,
      country: null,
    }];
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new ParseError("INVALID_JSON");
  }
}

export function parseFederalRegister(body: string): RawItem[] {
  const root = asRecord(parseJson(body));
  if (!root || !Array.isArray(root.results)) throw new ParseError("FEDERAL_REGISTER_NO_RESULTS_ARRAY");
  return root.results.flatMap((value) => {
    const record = asRecord(value);
    const title = str(record?.title);
    const link = str(record?.html_url);
    if (!record || !title || !link) return [];
    const agencies = Array.isArray(record.agencies)
      ? record.agencies.map((agency) => str(asRecord(agency)?.name)).filter((name): name is string => !!name)
      : [];
    return [{
      title,
      link,
      external_id: str(record.document_number),
      summary: str(record.abstract),
      published_raw: str(record.publication_date), // date only
      updated_raw: null,
      seen_raw: null,
      structured_ticker: null,
      image_url: null,
      publisher: agencies.length ? agencies.join("; ") : null,
      language: "en",
      country: "US",
    }];
  });
}

/** GDELT DOC 2.0 mode=artlist JSON. socialimage is deliberately ignored (images are not ours to use). */
export function parseGdeltDoc(body: string): RawItem[] {
  // GDELT answers rate limiting with a plain-text sentence and 200/429.
  if (/limit requests/i.test(body.slice(0, 300))) throw new ParseError("GDELT_RATE_LIMIT_TEXT");
  if (!body.trim()) return [];
  const root = asRecord(parseJson(body));
  if (!root) throw new ParseError("GDELT_NOT_OBJECT");
  if (root.articles === undefined) return []; // GDELT returns {} when nothing matched
  if (!Array.isArray(root.articles)) throw new ParseError("GDELT_ARTICLES_NOT_ARRAY");
  return root.articles.flatMap((value) => {
    const record = asRecord(value);
    const title = str(record?.title);
    const link = str(record?.url);
    if (!record || !title || !link) return [];
    return [{
      title,
      link,
      external_id: null,
      summary: null,
      published_raw: null, // GDELT does not give the publisher's publication time
      updated_raw: null,
      seen_raw: str(record.seendate),
      structured_ticker: null,
      image_url: null,
      publisher: str(record.domain),
      language: str(record.language),
      country: str(record.sourcecountry),
    }];
  });
}

/**
 * EDINET API v2 documents.json (type=2). submitDateTime is JST without offset ("2026-09-25 15:00").
 * secCode is 5 digits (4-digit code + check digit "0"); the first 4 characters are the ticker.
 */
export function parseEdinetDocuments(body: string): RawItem[] {
  const root = asRecord(parseJson(body));
  if (!root || !Array.isArray(root.results)) throw new ParseError("EDINET_NO_RESULTS_ARRAY");
  return root.results.flatMap((value) => {
    const record = asRecord(value);
    const docId = str(record?.docID);
    const filer = str(record?.filerName);
    const description = str(record?.docDescription);
    if (!record || !docId || !filer || !description) return [];
    const submitted = str(record.submitDateTime);
    const jst = submitted?.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/);
    const secCode = str(record.secCode);
    return [{
      title: `${filer} ${description}`,
      link: `https://api.edinet-fsa.go.jp/api/v2/documents/${encodeURIComponent(docId)}`,
      external_id: docId,
      summary: null,
      published_raw: jst ? `${jst[1]}T${jst[2]}:${jst[3] ?? "00"}+09:00` : null,
      updated_raw: null,
      seen_raw: null,
      structured_ticker: secCode && /^[0-9A-Z]{4}0$/.test(secCode) ? secCode.slice(0, 4) : null,
      image_url: null,
      publisher: "EDINET",
      language: "ja",
      country: "JP",
    }];
  });
}

export function parseSourcePayload(source: SourceDefinition, body: string): RawItem[] {
  switch (source.source_type) {
    case "rss":
    case "atom":
    case "rdf":
      return parseFeed(body);
    case "federal_register_json":
      return parseFederalRegister(body);
    case "gdelt_doc_json":
      return parseGdeltDoc(body);
    case "edinet_documents_json":
      return parseEdinetDocuments(body);
  }
}
