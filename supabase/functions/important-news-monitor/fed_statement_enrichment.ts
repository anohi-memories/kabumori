import type { IncomingNewsCandidate } from "./news_candidate_logic.ts";
import { validateOfficialUrl } from "./jp_official_enrichment.ts";
import {
  classifyFedMonetaryTitle,
  extractFomcStatementFacts,
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

export type FedEnrichmentOutcome = {
  candidates: IncomingNewsCandidate[];
  /** Statement items withheld because their facts could not be read (retried on a later fetch). */
  withheld: number;
  enriched: number;
  errors: string[];
};

/**
 * Candidates of the Fed feed -> the same candidates, statement items carrying the official page's facts. Statement
 * items that cannot be read are dropped from the result; every other item passes through unchanged.
 */
export async function enrichFedStatementCandidates(
  candidates: IncomingNewsCandidate[],
  fetchImpl: FedFetchLike = fetch,
  limits: { maxPerFetch?: number } = {},
): Promise<FedEnrichmentOutcome> {
  const maxPerFetch = limits.maxPerFetch ?? FED_STATEMENT_LIMITS.maxPerFetch;
  const out: IncomingNewsCandidate[] = [];
  const errors: string[] = [];
  let withheld = 0;
  let enriched = 0;
  let attempted = 0;
  for (const candidate of candidates) {
    if (classifyFedMonetaryTitle(candidate.title) !== "statement") {
      out.push(candidate);
      continue;
    }
    if (attempted >= maxPerFetch) {
      withheld += 1;
      continue;
    }
    attempted += 1;
    const page = await fetchFedHtml(candidate.sourceUrl, fetchImpl);
    if (!page.ok) {
      withheld += 1;
      errors.push(`fed_statement:${page.reason}`);
      continue;
    }
    const facts = extractFomcStatementFacts(page.html);
    const summary = renderFomcStatementSummary(facts, page.finalUrl);
    if (!summary) {
      withheld += 1;
      errors.push(`fed_statement:facts_${facts.issues[0] ?? "unreadable"}`);
      continue;
    }
    enriched += 1;
    out.push({ ...candidate, bodySummary: summary });
  }
  return { candidates: out, withheld, enriched, errors };
}
