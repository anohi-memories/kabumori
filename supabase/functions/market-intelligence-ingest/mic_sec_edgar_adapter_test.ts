import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSecFilingUrl,
  buildSecSubmissionsUrl,
  extractWatchedFilings,
  fetchSecEdgarFilings,
  parseSecSubmissions,
  SecEdgarAdapterError,
} from "./mic_sec_edgar_adapter.ts";

const COMPANY = { cik: "0000320193", ticker: "AAPL", companyName: "Apple Inc." };

function submissionsPayload(overrides: Partial<{
  form: string[];
  filingDate: string[];
  reportDate: string[];
  accessionNumber: string[];
  primaryDocument: string[];
  acceptanceDateTime: string[];
}> = {}) {
  return {
    name: "Apple Inc.",
    filings: {
      recent: {
        form: overrides.form ?? ["4", "8-K", "10-Q"],
        filingDate: overrides.filingDate ?? ["2026-09-10", "2026-09-09", "2026-07-28"],
        reportDate: overrides.reportDate ?? ["2026-09-08", "2026-09-09", "2026-06-27"],
        accessionNumber: overrides.accessionNumber ?? [
          "0001140361-26-036226",
          "0000320193-26-000091",
          "0000320193-26-000080",
        ],
        primaryDocument: overrides.primaryDocument ?? ["xslF345X03/form4.xml", "form8k.htm", "form10q.htm"],
        acceptanceDateTime: overrides.acceptanceDateTime ?? [
          "2026-09-10T22:30:31.000Z",
          "2026-09-09T21:05:00.000Z",
          "2026-07-28T20:05:00.000Z",
        ],
      },
    },
  };
}

test("buildSecSubmissionsUrl zero-pads the CIK to 10 digits", () => {
  assert.equal(buildSecSubmissionsUrl("320193"), "https://data.sec.gov/submissions/CIK0000320193.json");
  assert.equal(buildSecSubmissionsUrl("0000320193"), "https://data.sec.gov/submissions/CIK0000320193.json");
});

test("buildSecFilingUrl strips leading zeros from the CIK and dashes from the accession number", () => {
  assert.equal(
    buildSecFilingUrl("0000320193", "0000320193-26-000091", "form8k.htm"),
    "https://www.sec.gov/Archives/edgar/data/320193/000032019326000091/form8k.htm",
  );
});

test("parseSecSubmissions extracts the recent filings arrays", () => {
  const parsed = parseSecSubmissions(submissionsPayload());
  assert.equal(parsed.companyName, "Apple Inc.");
  assert.equal(parsed.recent.form.length, 3);
});

test("parseSecSubmissions throws SEC_MALFORMED_RESPONSE when filings.recent is missing", () => {
  assert.throws(() => parseSecSubmissions({ name: "x" }), SecEdgarAdapterError);
  assert.throws(() => parseSecSubmissions("not-an-object"), SecEdgarAdapterError);
});

test("extractWatchedFilings keeps only 8-K/10-Q/10-K, skipping e.g. Form 4", () => {
  const now = new Date("2026-09-11T00:00:00.000Z");
  const events = extractWatchedFilings(COMPANY, parseSecSubmissions(submissionsPayload()), { now });
  assert.equal(events.length, 1);
  assert.equal(events[0].category, "sec_filing");
  assert.equal(events[0].eventType, "regulatory"); // 8-K
  assert.equal(events[0].ticker, "AAPL");
  assert.equal(
    events[0].sourceUrl,
    "https://www.sec.gov/Archives/edgar/data/320193/000032019326000091/form8k.htm",
  );
});

test("extractWatchedFilings excludes a stale filing older than maxAgeMs", () => {
  // The 10-Q in the fixture is dated 2026-07-28; "now" below is 45 days
  // later, well past the default 3-day window -- it must not be reported,
  // even though the 8-K (2026-09-09, 2 days before "now") still is.
  const now = new Date("2026-09-11T00:00:00.000Z");
  const events = extractWatchedFilings(
    COMPANY,
    parseSecSubmissions(submissionsPayload({ form: ["10-Q"], filingDate: ["2026-07-28"] })),
    { now },
  );
  assert.equal(events.length, 0);
});

test("extractWatchedFilings skips a row missing accessionNumber/primaryDocument instead of throwing", () => {
  const now = new Date("2026-09-11T00:00:00.000Z");
  const events = extractWatchedFilings(
    COMPANY,
    parseSecSubmissions(submissionsPayload({ form: ["8-K"], accessionNumber: [""], primaryDocument: [""] })),
    { now },
  );
  assert.equal(events.length, 0);
});

test("extractWatchedFilings is idempotent: the same input always produces the same normalized output", () => {
  const now = new Date("2026-09-11T00:00:00.000Z");
  const parsed = parseSecSubmissions(submissionsPayload());
  const first = extractWatchedFilings(COMPANY, parsed, { now });
  const second = extractWatchedFilings(COMPANY, parsed, { now });
  assert.deepEqual(first, second);
});

test("fetchSecEdgarFilings: normal path sends the required User-Agent and returns watched filings", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(submissionsPayload()), { status: 200 });
  };
  const events = await fetchSecEdgarFilings(
    { userAgent: "Kabumori MIC test@example.com", companies: [COMPANY], now: new Date("2026-09-11T00:00:00.000Z") },
    fetchImpl as typeof fetch,
  );
  assert.equal(events.length, 1);
  assert.equal((calls[0].init?.headers as Record<string, string>)["User-Agent"], "Kabumori MIC test@example.com");
});

test("fetchSecEdgarFilings: missing User-Agent throws before any fetch", async () => {
  const fetchImpl = async () => {
    throw new Error("should not be called");
  };
  await assert.rejects(
    () => fetchSecEdgarFilings({ userAgent: "", companies: [COMPANY] }, fetchImpl as typeof fetch),
    /SEC_USER_AGENT_MISSING/,
  );
});

test("fetchSecEdgarFilings: non-200 surfaces SEC_HTTP_ERROR", async () => {
  const fetchImpl = async () => new Response("forbidden", { status: 403 });
  await assert.rejects(
    () => fetchSecEdgarFilings({ userAgent: "UA", companies: [COMPANY] }, fetchImpl as typeof fetch),
    /SEC_HTTP_ERROR/,
  );
});

test("fetchSecEdgarFilings: a fetch-level failure surfaces SEC_FETCH_FAILED", async () => {
  const fetchImpl = async () => {
    throw new Error("network down");
  };
  await assert.rejects(
    () => fetchSecEdgarFilings({ userAgent: "UA", companies: [COMPANY] }, fetchImpl as typeof fetch),
    /SEC_FETCH_FAILED/,
  );
});
