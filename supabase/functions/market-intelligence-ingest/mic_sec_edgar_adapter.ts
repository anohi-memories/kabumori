// SEC EDGAR company submissions adapter -- detects 8-K/10-Q/10-K filings
// for a small, fixed starter watchlist. Existing gap this fills: nothing
// else in the kabumori codebase reads SEC EDGAR at all.
//
// Endpoint confirmed by direct request during implementation:
// https://data.sec.gov/submissions/CIK##########.json (10-digit, zero-padded
// CIK). Response shape confirmed against a real response (Apple, CIK
// 0000320193): top-level "name", and "filings.recent" holding parallel
// arrays (form[], filingDate[], reportDate[], accessionNumber[],
// acceptanceDateTime[], primaryDocument[], ...), one entry per filing at
// the same array index.
//
// SEC requires a descriptive User-Agent ("<org> <contact email>") on every
// request (https://www.sec.gov/os/webmaster-faq) and enforces a 10 req/sec
// ceiling -- this adapter's caller is responsible for supplying that
// header value via an env var, never hardcoding a real contact here.
import type { MarketEventInput } from "./mic_normalize_logic.ts";

export const SEC_SUBMISSIONS_BASE_URL = "https://data.sec.gov/submissions/";
export const SEC_SOURCE_KEY = "sec_edgar";
export const SEC_WATCHED_FORMS = ["8-K", "10-Q", "10-K"] as const;

export class SecEdgarAdapterError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "SecEdgarAdapterError";
  }
}

export type SecWatchedCompany = { cik: string; ticker: string; companyName: string };

// Phase 1A: a small, fixed starter watchlist of US mega-cap tickers, the
// same companies already referenced as IR sources in
// x-test-post/index.ts's MORNING_SOURCE_DOMAINS allowlist. A dynamic,
// DB-driven watchlist covering more companies is Phase 1B scope.
export const SEC_STARTER_WATCHLIST: SecWatchedCompany[] = [
  { cik: "0000320193", ticker: "AAPL", companyName: "Apple Inc." },
  { cik: "0000789019", ticker: "MSFT", companyName: "Microsoft Corp." },
  { cik: "0001045810", ticker: "NVDA", companyName: "NVIDIA Corp." },
];

export function buildSecSubmissionsUrl(cik: string): string {
  const padded = cik.replace(/\D/g, "").padStart(10, "0");
  return `${SEC_SUBMISSIONS_BASE_URL}CIK${padded}.json`;
}

export function buildSecFilingUrl(cik: string, accessionNumber: string, primaryDocument: string): string {
  const cikNoLeadingZeros = String(Number(cik.replace(/\D/g, "")));
  const accessionNoDashes = accessionNumber.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${cikNoLeadingZeros}/${accessionNoDashes}/${primaryDocument}`;
}

type SecRecentFilings = {
  form: string[];
  filingDate: string[];
  reportDate: string[];
  accessionNumber: string[];
  primaryDocument: string[];
  acceptanceDateTime: string[];
};

export type ParsedSecSubmissions = { companyName: string; recent: SecRecentFilings };

export function parseSecSubmissions(payload: unknown): ParsedSecSubmissions {
  if (typeof payload !== "object" || payload === null) {
    throw new SecEdgarAdapterError("SEC_MALFORMED_RESPONSE", "payload is not an object");
  }
  const obj = payload as Record<string, unknown>;
  const companyName = typeof obj.name === "string" ? obj.name : "";
  const filings = obj.filings as Record<string, unknown> | undefined;
  const recent = filings?.recent as Record<string, unknown> | undefined;
  if (
    !recent || !Array.isArray(recent.form) || !Array.isArray(recent.filingDate) ||
    !Array.isArray(recent.accessionNumber) || !Array.isArray(recent.primaryDocument)
  ) {
    throw new SecEdgarAdapterError("SEC_MALFORMED_RESPONSE", "filings.recent arrays missing");
  }
  return {
    companyName,
    recent: {
      form: recent.form as string[],
      filingDate: recent.filingDate as string[],
      reportDate: (recent.reportDate as string[]) ?? [],
      accessionNumber: recent.accessionNumber as string[],
      primaryDocument: recent.primaryDocument as string[],
      acceptanceDateTime: (recent.acceptanceDateTime as string[]) ?? [],
    },
  };
}

function secFormToEventType(form: string): string {
  if (form === "8-K") return "regulatory";
  if (form === "10-Q" || form === "10-K") return "earnings";
  return "other";
}

export function extractWatchedFilings(
  company: SecWatchedCompany,
  parsed: ParsedSecSubmissions,
  options: { watchedForms?: readonly string[]; maxAgeMs?: number; now?: Date } = {},
): MarketEventInput[] {
  const watchedForms = options.watchedForms ?? SEC_WATCHED_FORMS;
  // Only recent filings -- avoids re-surfacing years of history as "new"
  // the first time this source is ever run.
  const maxAgeMs = options.maxAgeMs ?? 3 * 24 * 60 * 60 * 1000;
  const now = options.now ?? new Date();
  const events: MarketEventInput[] = [];
  const { recent } = parsed;

  for (let i = 0; i < recent.form.length; i++) {
    const form = recent.form[i];
    if (!watchedForms.includes(form)) continue;
    const filingDate = recent.filingDate[i];
    if (!filingDate) continue;
    const filedAt = new Date(`${filingDate}T00:00:00.000Z`);
    if (Number.isNaN(filedAt.getTime())) continue;
    if (now.getTime() - filedAt.getTime() > maxAgeMs) continue;

    const accessionNumber = recent.accessionNumber[i];
    const primaryDocument = recent.primaryDocument[i];
    if (!accessionNumber || !primaryDocument) continue;

    const acceptanceDateTime = recent.acceptanceDateTime[i] || null;
    const reportDate = recent.reportDate[i] || null;
    const sourceUrl = buildSecFilingUrl(company.cik, accessionNumber, primaryDocument);
    const companyLabel = parsed.companyName || company.companyName;

    events.push({
      occurredAt: acceptanceDateTime,
      publishedAt: acceptanceDateTime ?? `${filingDate}T00:00:00.000Z`,
      eventType: secFormToEventType(form),
      category: "sec_filing",
      country: "US",
      entityType: "company",
      entityId: company.ticker,
      ticker: company.ticker,
      title: `${companyLabel} ${form} filing`,
      summary: `${companyLabel} filed SEC Form ${form}` +
        (reportDate ? ` (report period ${reportDate})` : "") + ".",
      sourceName: "SEC EDGAR",
      sourceUrl,
      sourceKey: SEC_SOURCE_KEY,
      sourceTimestamp: acceptanceDateTime,
      rawPayload: { cik: company.cik, form, accessionNumber, primaryDocument, filingDate, reportDate },
    });
  }

  return events;
}

export type FetchSecEdgarFilingsParams = {
  userAgent: string;
  companies?: SecWatchedCompany[];
  now?: Date;
  timeoutMs?: number;
};

export async function fetchSecEdgarFilings(
  params: FetchSecEdgarFilingsParams,
  fetchImpl: typeof fetch = fetch,
): Promise<MarketEventInput[]> {
  if (!params.userAgent) {
    throw new SecEdgarAdapterError("SEC_USER_AGENT_MISSING", "a descriptive User-Agent is required by SEC");
  }
  const companies = params.companies ?? SEC_STARTER_WATCHLIST;
  const now = params.now ?? new Date();
  const events: MarketEventInput[] = [];

  for (const company of companies) {
    const url = buildSecSubmissionsUrl(company.cik);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { "User-Agent": params.userAgent, Accept: "application/json" },
        signal: AbortSignal.timeout(params.timeoutMs ?? 15_000),
      });
    } catch (error) {
      throw new SecEdgarAdapterError("SEC_FETCH_FAILED", `${company.ticker}: ${String(error)}`);
    }
    if (!response.ok) {
      throw new SecEdgarAdapterError("SEC_HTTP_ERROR", `${company.ticker}: status=${response.status}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new SecEdgarAdapterError("SEC_MALFORMED_RESPONSE", `${company.ticker}: invalid JSON`);
    }
    const parsed = parseSecSubmissions(payload);
    events.push(...extractWatchedFilings(company, parsed, { now }));
  }

  return events;
}
