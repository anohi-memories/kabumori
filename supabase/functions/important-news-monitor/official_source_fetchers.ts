import type { IncomingNewsCandidate } from "./news_candidate_logic.ts";

export type CompanyIrSource = {
  id: string;
  companyCode: string;
  companyName: string;
  entityKey: string;
  feedUrl: string;
  feedFormat: "rss" | "json";
};

export type NewsSourceProvider = {
  key: string;
  fetchCandidates: () => Promise<IncomingNewsCandidate[]>;
};

export type SourceCollectionResult = {
  candidates: IncomingNewsCandidate[];
  errors: string[];
  succeededSources: string[];
};

export type PdfTextExtractor = (pdfBytes: Uint8Array) => Promise<string>;

export type TdnetPdfEnrichmentResult = {
  candidates: IncomingNewsCandidate[];
  errors: string[];
};

const MAX_TDNET_PDF_BYTES = 10 * 1024 * 1024;
const MAX_TDNET_PDF_PAGES = 40;
const MAX_TDNET_PDF_TEXT_CHARS = 120_000;
const MAX_TDNET_BODY_SUMMARY_CHARS = 6_000;

const TDNET_IMPORTANT_LINE_PATTERN = new RegExp([
  "業績", "売上", "利益", "修正前", "修正後", "増減", "配当", "自己株式",
  "取得", "株式", "金額", "期間", "公開買付", "TOB", "M&A", "合併", "買収",
  "中止", "変更", "理由", "契約", "条件", "日程", "効力発生日", "受注", "失注",
].join("|"), "i");

function safePdfError(error: unknown): string {
  const value = error instanceof Error ? error.message : "TDNET_PDF_UNKNOWN_ERROR";
  return /^[A-Z0-9_:-]+$/.test(value) ? value.slice(0, 120) : "TDNET_PDF_PARSE_FAILED";
}

export async function cleanupPdfDocument(document: unknown): Promise<void> {
  const destroy = (document as { destroy?: () => void | Promise<void> } | null)?.destroy;
  if (typeof destroy === "function") await destroy.call(document);
}

async function extractPdfTextWithUnpdf(pdfBytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("npm:unpdf@1.8.1");
  const document = await getDocumentProxy(pdfBytes);
  try {
    const pageCount = Math.min(document.numPages, MAX_TDNET_PDF_PAGES);
    if (pageCount === document.numPages) {
      const result = await extractText(document, { mergePages: true });
      return result.text.slice(0, MAX_TDNET_PDF_TEXT_CHARS);
    }
    let extracted = "";
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      for (const raw of content.items) {
        if (typeof raw !== "object" || raw === null || !("str" in raw)) continue;
        const item = raw as { str?: unknown; hasEOL?: unknown };
        if (typeof item.str !== "string" || !item.str) continue;
        extracted += item.str;
        extracted += item.hasEOL === true ? "\n" : " ";
        if (extracted.length >= MAX_TDNET_PDF_TEXT_CHARS) {
          return extracted.slice(0, MAX_TDNET_PDF_TEXT_CHARS);
        }
      }
      extracted += "\n";
    }
    return extracted;
  } finally {
    await cleanupPdfDocument(document);
  }
}

export function buildTdnetBodySummary(
  pdfText: string,
  maxChars = MAX_TDNET_BODY_SUMMARY_CHARS,
): string | null {
  const lines = pdfText.split(/\r?\n/).map((line) => line.replace(/[\t ]+/g, " ").trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const selectedIndexes = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    if (!TDNET_IMPORTANT_LINE_PATTERN.test(lines[index])) continue;
    for (let context = Math.max(0, index - 1); context <= Math.min(lines.length - 1, index + 1); context += 1) {
      selectedIndexes.add(context);
    }
  }
  const selected = (selectedIndexes.size ? Array.from(selectedIndexes).sort((a, b) => a - b).map((index) => lines[index]) : lines);
  const summary: string[] = [];
  let length = 0;
  for (const line of selected) {
    const addition = (summary.length ? 1 : 0) + line.length;
    if (length + addition > maxChars) break;
    summary.push(line);
    length += addition;
  }
  return summary.join("\n") || null;
}

export async function fetchTdnetPdfBodySummary(
  sourceUrl: string,
  options: { fetcher?: typeof fetch; extractor?: PdfTextExtractor } = {},
): Promise<string> {
  const fetcher = options.fetcher ?? fetch;
  const result = await fetcher(sourceUrl, {
    headers: { Accept: "application/pdf" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!result.ok) throw new Error(`TDNET_PDF_FETCH_FAILED:${result.status}`);
  const declaredLength = Number(result.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TDNET_PDF_BYTES) {
    throw new Error("TDNET_PDF_TOO_LARGE");
  }
  const bytes = new Uint8Array(await result.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_TDNET_PDF_BYTES) throw new Error("TDNET_PDF_TOO_LARGE");
  if (new TextDecoder("ascii").decode(bytes.slice(0, 5)) !== "%PDF-") throw new Error("TDNET_PDF_INVALID");
  const text = await (options.extractor ?? extractPdfTextWithUnpdf)(bytes);
  const summary = buildTdnetBodySummary(text);
  if (!summary) throw new Error("TDNET_PDF_TEXT_EMPTY");
  return summary;
}

export async function enrichTdnetCandidatesWithPdfSummaries(
  candidates: IncomingNewsCandidate[],
  loader: (sourceUrl: string) => Promise<string> = fetchTdnetPdfBodySummary,
): Promise<TdnetPdfEnrichmentResult> {
  const enriched: IncomingNewsCandidate[] = [];
  const errors: string[] = [];
  for (const candidate of candidates) {
    if (candidate.sourceType !== "tdnet" || candidate.bodySummary) {
      enriched.push(candidate);
      continue;
    }
    try {
      enriched.push({ ...candidate, bodySummary: await loader(candidate.sourceUrl) });
    } catch (error) {
      enriched.push(candidate);
      errors.push(`${candidate.sourceUrl}:${safePdfError(error)}`);
    }
  }
  return { candidates: enriched, errors };
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity: string) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x";
      const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(point) ? String.fromCodePoint(point) : "";
    }
    return named[entity.toLowerCase()] ?? `&${entity};`;
  });
}

function textContent(value: string): string {
  return decodeHtml(value.replace(/<br\s*\/?\s*>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ").trim();
}

export function tagValue(xml: string, names: string[]): string {
  for (const name of names) {
    const match = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
    if (match) return textContent(match[1].replace(/^<!\[CDATA\[|\]\]>$/g, ""));
  }
  return "";
}

export function hrefValue(fragment: string, baseUrl: string): string {
  const href = fragment.match(/<a\b[^>]*href=["']([^"']+)["']/i)?.[1] ||
    fragment.match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1] || tagValue(fragment, ["link"]);
  if (!href) return "";
  try { return new URL(decodeHtml(href), baseUrl).toString(); } catch { return ""; }
}

function jstDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function normalizeTdnetCandidate(args: {
  title: string;
  companyName: string;
  companyCode: string;
  publishedAt: string;
  disclosureUrl: string;
}): IncomingNewsCandidate {
  if (!args.title.trim() || !args.companyName.trim() || !args.companyCode.trim() ||
    !Number.isFinite(Date.parse(args.publishedAt))) throw new Error("TDNET_CANDIDATE_INVALID");
  return {
    sourceType: "tdnet",
    sourceName: "tdnet",
    sourceUrl: args.disclosureUrl,
    title: args.title.trim(),
    bodySummary: null,
    companyName: args.companyName.trim(),
    companyCode: args.companyCode.trim(),
    entityKey: `company:${args.companyCode.trim().toLowerCase()}`,
    category: "other_corporate_ir",
    publishedAt: new Date(args.publishedAt).toISOString(),
  };
}

export function parseTdnetListHtml(html: string, date: string, baseUrl: string): IncomingNewsCandidate[] {
  const rows = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? [];
  const results: IncomingNewsCandidate[] = [];
  for (const row of rows) {
    const cells = Array.from(row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi), (match) => match[1]);
    if (cells.length < 4) continue;
    const time = textContent(cells[0]);
    const companyCode = textContent(cells[1]).replace(/\s/g, "");
    const companyName = textContent(cells[2]);
    const title = textContent(cells[3]);
    const disclosureUrl = hrefValue(cells[3], baseUrl);
    if (!/^\d{1,2}:\d{2}$/.test(time) || !/^[0-9a-z]{4,5}$/i.test(companyCode) || !disclosureUrl) continue;
    try {
      results.push(normalizeTdnetCandidate({
        title, companyName, companyCode,
        publishedAt: `${date}T${time.padStart(5, "0")}:00+09:00`, disclosureUrl,
      }));
    } catch { /* skip malformed disclosure rows without stopping the source */ }
  }
  return results;
}

export async function fetchTdnetCandidates(args: {
  date?: string;
  maxPages?: number;
  fetcher?: typeof fetch;
} = {}): Promise<IncomingNewsCandidate[]> {
  const targetDate = args.date ?? jstDate();
  const compactDate = targetDate.replaceAll("-", "");
  if (!/^\d{8}$/.test(compactDate)) throw new Error("TDNET_DATE_INVALID");
  const fetcher = args.fetcher ?? fetch;
  const maxPages = Math.min(Math.max(args.maxPages ?? 3, 1), 10);
  const candidates: IncomingNewsCandidate[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const pageNumber = String(page).padStart(3, "0");
    const url = `https://www.release.tdnet.info/inbs/I_list_${pageNumber}_${compactDate}.html`;
    const result = await fetcher(url, { headers: { Accept: "text/html" } });
    if (!result.ok) {
      if (page > 1 && result.status === 404) break;
      throw new Error(`TDNET_FETCH_FAILED:${result.status}`);
    }
    const pageCandidates = parseTdnetListHtml(await result.text(), targetDate, url);
    candidates.push(...pageCandidates);
    if (pageCandidates.length === 0) break;
  }
  return candidates;
}

export function normalizeCompanyIrCandidate(
  source: CompanyIrSource,
  item: { title: string; url: string; publishedAt: string; summary?: string | null },
): IncomingNewsCandidate {
  if (!item.title.trim() || !Number.isFinite(Date.parse(item.publishedAt))) {
    throw new Error("COMPANY_IR_CANDIDATE_INVALID");
  }
  return {
    sourceType: "company_ir",
    sourceName: "company_ir",
    sourceUrl: new URL(item.url, source.feedUrl).toString(),
    title: item.title.trim(),
    bodySummary: item.summary?.trim() || null,
    companyName: source.companyName,
    companyCode: source.companyCode,
    entityKey: source.entityKey,
    category: "other_corporate_ir",
    publishedAt: new Date(item.publishedAt).toISOString(),
  };
}

function parseCompanyIrRss(source: CompanyIrSource, xml: string): IncomingNewsCandidate[] {
  const items = xml.match(/<(?:item|entry)\b[^>]*>[\s\S]*?<\/(?:item|entry)>/gi) ?? [];
  const results: IncomingNewsCandidate[] = [];
  for (const item of items) {
    try {
      results.push(normalizeCompanyIrCandidate(source, {
        title: tagValue(item, ["title"]),
        url: hrefValue(item, source.feedUrl),
        publishedAt: tagValue(item, ["pubDate", "published", "updated", "date"]),
        summary: tagValue(item, ["description", "summary", "content"]),
      }));
    } catch { /* skip malformed feed entries */ }
  }
  return results;
}

function parseCompanyIrJson(source: CompanyIrSource, value: unknown): IncomingNewsCandidate[] {
  const items = Array.isArray(value) ? value
    : typeof value === "object" && value !== null && Array.isArray((value as { items?: unknown }).items)
    ? (value as { items: unknown[] }).items : [];
  const results: IncomingNewsCandidate[] = [];
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Record<string, unknown>;
    try {
      results.push(normalizeCompanyIrCandidate(source, {
        title: typeof item.title === "string" ? item.title : "",
        url: typeof item.url === "string" ? item.url : typeof item.link === "string" ? item.link : "",
        publishedAt: typeof item.published_at === "string" ? item.published_at
          : typeof item.publishedAt === "string" ? item.publishedAt
          : typeof item.date === "string" ? item.date : "",
        summary: typeof item.summary === "string" ? item.summary
          : typeof item.description === "string" ? item.description : null,
      }));
    } catch { /* skip malformed feed entries */ }
  }
  return results;
}

export async function fetchCompanyIrSource(
  source: CompanyIrSource,
  fetcher: typeof fetch = fetch,
): Promise<IncomingNewsCandidate[]> {
  const result = await fetcher(source.feedUrl, { headers: { Accept: "application/rss+xml, application/json, text/xml" } });
  if (!result.ok) throw new Error(`COMPANY_IR_FETCH_FAILED:${result.status}`);
  if (source.feedFormat === "json") return parseCompanyIrJson(source, await result.json());
  return parseCompanyIrRss(source, await result.text());
}

export async function runNewsSourceProviders(providers: NewsSourceProvider[]): Promise<SourceCollectionResult> {
  const candidates: IncomingNewsCandidate[] = [];
  const errors: string[] = [];
  const succeededSources: string[] = [];
  for (const provider of providers) {
    try {
      candidates.push(...await provider.fetchCandidates());
      succeededSources.push(provider.key);
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_:-]+$/.test(error.message)
        ? error.message : "SOURCE_FETCH_FAILED";
      errors.push(`${provider.key}:${code}`);
    }
  }
  return { candidates, errors, succeededSources };
}
