import type { IncomingNewsCandidate } from "./news_candidate_logic.ts";
import { validateOfficialUrl } from "./jp_official_enrichment.ts";
import {
  classifyFedMonetaryTitle,
  extractFomcStatementFacts,
  fomcDocumentKind,
  renderFomcStatementSummary,
} from "../_shared/news_body_extraction/fomc_statement_facts.ts";

// Phase 7: an FOMC statement item of the Federal Reserve feed carries a title and a link and no description, so it used
// to reach the importance judgement as a headline only. For items whose title is a statement ("Federal Reserve issues
// FOMC statement") the official page behind the link is read and reduced to the decision, the change, the target range
// and the vote. Minutes / projections / other items are not touched.
//
// Safety: https only, host federalreserve.gov (or a subdomain) only, every redirect hop re-validated (max 3), 8 s
// timeout, 400 KB streamed cap, text/html only. A statement whose facts cannot be read with certainty is NOT emitted:
// a title-only candidate for a rate decision could only be judged without its content, so it is withheld and retried
// on the next fetch while the item is still fresh.

export const FED_ENRICHMENT_DOMAINS = ["federalreserve.gov"] as const;
export const FED_STATEMENT_LIMITS = { timeoutMs: 8_000, maxRedirects: 3, maxBytes: 400_000, maxPerFetch: 2 } as const;
const USER_AGENT = "Kabumori-important-news/0.1 (read-only; contact@kabumori.app)";

export type FedFetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type FedHtmlResult =
  | { ok: true; html: string; finalUrl: string }
  | { ok: false; reason: "invalid_url" | "host_not_allowed" | "http_error" | "unsupported_content" | "too_large" | "too_many_redirects" | "timeout" | "network_error" };

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Fetches one Federal Reserve page as HTML text under the limits above. Never throws. */
export async function fetchFedHtml(rawUrl: string, fetchImpl: FedFetchLike = fetch): Promise<FedHtmlResult> {
  let url = validateOfficialUrl(rawUrl, FED_ENRICHMENT_DOMAINS);
  if (!url) return { ok: false, reason: "invalid_url" };
  const signal = AbortSignal.timeout(FED_STATEMENT_LIMITS.timeoutMs);
  try {
    for (let hop = 0; hop <= FED_STATEMENT_LIMITS.maxRedirects; hop += 1) {
      const response = await fetchImpl(url.toString(), {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html, application/xhtml+xml", "Accept-Encoding": "identity" },
        redirect: "manual",
        signal,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) return { ok: false, reason: "http_error" };
        if (hop === FED_STATEMENT_LIMITS.maxRedirects) return { ok: false, reason: "too_many_redirects" };
        let next: URL | null = null;
        try {
          next = validateOfficialUrl(new URL(location, url).toString(), FED_ENRICHMENT_DOMAINS);
        } catch {
          next = null;
        }
        if (!next) return { ok: false, reason: "host_not_allowed" };
        url = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        return { ok: false, reason: "http_error" };
      }
      if (!/^(?:text\/html|application\/xhtml\+xml)/iu.test(response.headers.get("content-type") ?? "")) {
        await response.body?.cancel();
        return { ok: false, reason: "unsupported_content" };
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > FED_STATEMENT_LIMITS.maxBytes) {
        await response.body?.cancel();
        return { ok: false, reason: "too_large" };
      }
      const bytes = await readCapped(response, FED_STATEMENT_LIMITS.maxBytes);
      if (bytes === null) return { ok: false, reason: "too_large" };
      return { ok: true, html: new TextDecoder("utf-8").decode(bytes), finalUrl: url.toString() };
    }
    return { ok: false, reason: "too_many_redirects" };
  } catch (error) {
    return { ok: false, reason: error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError") ? "timeout" : "network_error" };
  }
}

export type FedStoredState = { id: string; status: string; hasBody: boolean };

export type FedEnrichmentOutcome = {
  candidates: IncomingNewsCandidate[];
  /** Existing candidates (judgement still pending, no body yet) that now have an official body to be filled in. */
  bodyUpdates: Array<{ id: string; sourceUrl: string; bodySummary: string }>;
  /** Statement items withheld because their facts could not be read (retried on a later fetch). */
  withheld: number;
  /** Statement items not attempted this time because the per-fetch cap was reached (retried, in rotation). */
  deferred: number;
  enriched: number;
  errors: string[];
};

const STATEMENT_PATH = /^\/newsevents\/pressreleases\/monetary(\d{4})(\d{2})(\d{2})[a-z]?\.htm$/iu;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function isoDateOfFedText(text: string | null): string | null {
  const match = text?.match(/^([A-Za-z]+) (\d{1,2}), (\d{4})$/u);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1].toLowerCase()) + 1;
  if (month === 0) return null;
  return `${match[3]}-${String(month).padStart(2, "0")}-${String(Number(match[2])).padStart(2, "0")}`;
}

function pathOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).pathname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * A fetched page is accepted as THIS candidate's statement only when its address is the statement's own press-release
 * path (no hop to another document, e.g. a redirect to older minutes), the page's own heading is the FOMC statement,
 * and the document date, the date in the address and the feed's publication date agree. Returns a reason or null.
 */
export function statementDocumentRejection(
  candidate: { sourceUrl: string; publishedAt: string },
  finalUrl: string,
  html: string,
  releaseDate: string | null,
): string | null {
  const candidatePath = pathOf(candidate.sourceUrl);
  const match = candidatePath ? STATEMENT_PATH.exec(candidatePath) : null;
  if (!candidatePath || !match) return "doc_url_not_statement";
  if (pathOf(finalUrl) !== candidatePath) return "doc_redirected";
  if (fomcDocumentKind(html) !== "statement") return "doc_not_statement";
  const urlDate = `${match[1]}-${match[2]}-${match[3]}`;
  if (isoDateOfFedText(releaseDate) !== urlDate) return "doc_date_mismatch";
  const published = Date.parse(candidate.publishedAt);
  const documentDay = Date.parse(`${urlDate}T00:00:00Z`);
  if (!Number.isFinite(published) || Math.abs(published - documentDay) > 3 * 24 * 60 * 60 * 1000) return "doc_date_vs_feed";
  return null;
}

/**
 * Consecutive failures per statement URL, kept in the memory of the running Edge instance only (nothing is persisted).
 * It is used to try the statements that did not fail recently first; a cold start simply forgets it.
 */
const defaultFailureMemory = new Map<string, number>();
const FAILURE_MEMORY_MAX = 200;
/** Failing statements are retried; the time spent on them in one fetch is bounded. */
export const FED_ENRICHMENT_BUDGET_MS = 20_000;

export type FedEnrichmentOptions = {
  /** Successful enrichments per fetch (default FED_STATEMENT_LIMITS.maxPerFetch). */
  maxPerFetch?: number;
  /** Fetch attempts per run, successes and failures together (default 2 x maxPerFetch). */
  maxAttempts?: number;
  stored?: ReadonlyMap<string, FedStoredState>;
  /** Tie-break among statements with the same failure count; injected in tests. Default Math.random. */
  random?: () => number;
  memory?: Map<string, number>;
  now?: () => number;
  budgetMs?: number;
};

/**
 * Candidates of the Fed feed -> the same candidates, statement items carrying the official page's facts. Statement
 * items that cannot be read are dropped from the result; every other item passes through unchanged.
 *
 * Quota (no dependence on the call schedule):
 *  - statements already stored with a body cost no fetch (they only become duplicates later);
 *  - the cap counts SUCCESSFUL enrichments, so a failing statement does not take a slot from the ones behind it;
 *  - attempts are bounded (maxAttempts) and time-bounded; the statements are ordered by recent failures (fewest first)
 *    and, among equals, by a random tie-break — never by the clock — so no call interval (hourly, 30 min, 10 min) can
 *    lock a statement out. With at most maxAttempts unstored statements every one is tried on every run. Beyond that a
 *    warm instance moves recent failures behind the untried ones; a cold start is random, so each statement still has
 *    a positive chance on every run (no fixed period can starve it), though not a hard per-run guarantee.
 */
export async function enrichFedStatementCandidates(
  candidates: IncomingNewsCandidate[],
  fetchImpl: FedFetchLike = fetch,
  options: FedEnrichmentOptions = {},
): Promise<FedEnrichmentOutcome> {
  const maxPerFetch = options.maxPerFetch ?? FED_STATEMENT_LIMITS.maxPerFetch;
  const maxAttempts = options.maxAttempts ?? maxPerFetch * 2;
  const stored = options.stored ?? new Map<string, FedStoredState>();
  const random = options.random ?? Math.random;
  const memory = options.memory ?? defaultFailureMemory;
  const now = options.now ?? Date.now;
  const budgetMs = options.budgetMs ?? FED_ENRICHMENT_BUDGET_MS;
  const errors: string[] = [];
  const bodyUpdates: FedEnrichmentOutcome["bodyUpdates"] = [];
  const passthrough: Array<{ at: number; candidate: IncomingNewsCandidate }> = [];
  const eligible: Array<{ at: number; candidate: IncomingNewsCandidate; fill: FedStoredState | null; tie: number }> = [];

  candidates.forEach((candidate, at) => {
    if (classifyFedMonetaryTitle(candidate.title) !== "statement") {
      passthrough.push({ at, candidate });
      return;
    }
    const known = stored.get(candidate.sourceUrl);
    if (!known) {
      eligible.push({ at, candidate, fill: null, tie: random() });
    } else if (known.hasBody) {
      passthrough.push({ at, candidate });
    } else if (known.status === "pending_judgement") {
      eligible.push({ at, candidate, fill: known, tie: random() });
    } else {
      // judged / generated / published without a body: never rewritten here (see the PR notes); it only stays a duplicate
      errors.push(`fed_statement:stored_without_body:${known.status}`);
      passthrough.push({ at, candidate });
    }
  });

  const ordered = [...eligible].sort((a, b) =>
    (memory.get(a.candidate.sourceUrl) ?? 0) - (memory.get(b.candidate.sourceUrl) ?? 0) || a.tie - b.tie
  );
  const startedAt = now();
  const emitted: Array<{ at: number; candidate: IncomingNewsCandidate }> = [...passthrough];
  let withheld = 0;
  let enriched = 0;
  let attempted = 0;
  const noteFailure = (url: string) => {
    if (memory.size >= FAILURE_MEMORY_MAX && !memory.has(url)) memory.delete(memory.keys().next().value as string);
    memory.set(url, (memory.get(url) ?? 0) + 1);
  };
  for (const item of ordered) {
    if (enriched >= maxPerFetch || attempted >= maxAttempts || now() - startedAt > budgetMs) break;
    attempted += 1;
    const { candidate } = item;
    const page = await fetchFedHtml(candidate.sourceUrl, fetchImpl);
    if (!page.ok) {
      withheld += 1;
      noteFailure(candidate.sourceUrl);
      errors.push(`fed_statement:${page.reason}`);
      continue;
    }
    const facts = extractFomcStatementFacts(page.html);
    const rejection = statementDocumentRejection(candidate, page.finalUrl, page.html, facts.releaseDate);
    if (rejection) {
      withheld += 1;
      noteFailure(candidate.sourceUrl);
      errors.push(`fed_statement:${rejection}`);
      continue;
    }
    const summary = renderFomcStatementSummary(facts, page.finalUrl);
    if (!summary) {
      withheld += 1;
      noteFailure(candidate.sourceUrl);
      errors.push(`fed_statement:facts_${facts.issues[0] ?? "unreadable"}`);
      continue;
    }
    enriched += 1;
    memory.delete(candidate.sourceUrl);
    if (item.fill) bodyUpdates.push({ id: item.fill.id, sourceUrl: candidate.sourceUrl, bodySummary: summary });
    else emitted.push({ at: item.at, candidate: { ...candidate, bodySummary: summary } });
  }
  const deferred = ordered.length - attempted;
  if (deferred > 0) errors.push(`fed_statement:deferred_over_cap:${deferred}`);
  emitted.sort((x, y) => x.at - y.at);
  return { candidates: emitted.map((entry) => entry.candidate), bodyUpdates, withheld, deferred, enriched, errors };
}
