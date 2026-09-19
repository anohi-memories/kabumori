export type OfficialBodyCandidate = {
  sourceType: string;
  sourceUrl: string;
  title: string;
  bodySummary?: string | null;
};

export type EnrichmentPlan =
  | {
    kind: "skip";
    reason:
      | "body_sufficient"
      | "title_not_high_signal"
      | "existing_tdnet_pdf_path";
  }
  | { kind: "fetch"; url: string }
  | {
    kind: "needs_review";
    reason:
      | "untrusted_source_type"
      | "invalid_url"
      | "source_not_allowlisted"
      | "pdf_requires_pdf_pipeline";
  };

export type EnrichmentResult =
  | { status: "enriched"; bodySummary: string }
  | {
    status: "needs_review";
    reason:
      | "fetch_failed"
      | "http_error"
      | "content_type_rejected"
      | "body_too_large"
      | "body_empty";
  };

export type OfficialCandidateDisposition =
  | { action: "judge"; candidate: OfficialBodyCandidate }
  | {
    action: "conditional_search_fallback";
    reason: string;
    candidate: OfficialBodyCandidate;
  };

const MIN_BODY_CHARS = 160;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_SUMMARY_CHARS = 6_000;
const FETCH_TIMEOUT_MS = 15_000;

const TRUSTED_OFFICIAL_HOSTS = [
  "boj.or.jp",
  "federalreserve.gov",
  "mof.go.jp",
  "jma.go.jp",
  "mod.go.jp",
  "kantei.go.jp",
  "ustr.gov",
  "whitehouse.gov",
  "treasury.gov",
  "sec.gov",
  "ecb.europa.eu",
  "un.org",
  "gov.uk",
  "centcom.mil",
  "defense.gov",
  "bis.doc.gov",
  "tdnet.info",
] as const;

const HIGH_SIGNAL_TITLE =
  /(?:rate decision|interest rate|policy rate|central bank|currency intervention|missile|airstrike|air strike|attack|strike|ceasefire|tariff|sanction|bank failure|bank collapse|default|emergency|evacuat|earthquake|tsunami|blackout|outage|shutdown|strait|shipping|oil tanker|利上げ|利下げ|政策金利|為替介入|ミサイル|空爆|攻撃|攻勢|停戦|関税|制裁|銀行破綻|債務不履行|緊急|避難|地震|津波|停電|停止|海峡|船舶|タンカー)/iu;

function parseTrustedOfficialUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) {
      return null;
    }
    if (url.hostname.endsWith(".")) return null;
    const hostname = url.hostname.toLowerCase();
    if (
      !TRUSTED_OFFICIAL_HOSTS.some((host) =>
        hostname === host || hostname.endsWith(`.${host}`)
      )
    ) return null;
    return url;
  } catch {
    return null;
  }
}

export function planOfficialBodyEnrichment(
  candidate: OfficialBodyCandidate,
): EnrichmentPlan {
  if (candidate.sourceType === "tdnet") {
    return { kind: "skip", reason: "existing_tdnet_pdf_path" };
  }
  if ((candidate.bodySummary ?? "").trim().length >= MIN_BODY_CHARS) {
    return { kind: "skip", reason: "body_sufficient" };
  }
  if (!HIGH_SIGNAL_TITLE.test(candidate.title.normalize("NFKC"))) {
    return { kind: "skip", reason: "title_not_high_signal" };
  }
  if (
    candidate.sourceType !== "market_macro" &&
    candidate.sourceType !== "company_ir"
  ) {
    return { kind: "needs_review", reason: "untrusted_source_type" };
  }
  const url = parseTrustedOfficialUrl(candidate.sourceUrl);
  if (!url) {
    return {
      kind: "needs_review",
      reason: candidate.sourceUrl ? "source_not_allowlisted" : "invalid_url",
    };
  }
  if (/\.pdf$/i.test(url.pathname)) {
    return { kind: "needs_review", reason: "pdf_requires_pdf_pipeline" };
  }
  return { kind: "fetch", url: url.toString() };
}

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
    (entity, body: string) => {
      const normalized = body.toLowerCase();
      if (normalized === "amp") return "&";
      if (normalized === "lt") return "<";
      if (normalized === "gt") return ">";
      if (normalized === "quot") return '"';
      if (normalized === "apos" || normalized === "#39") return "'";
      if (normalized === "nbsp") return " ";
      const codePoint = normalized.startsWith("#x")
        ? Number.parseInt(normalized.slice(2), 16)
        : Number.parseInt(normalized.slice(1), 10);
      try {
        return Number.isFinite(codePoint)
          ? String.fromCodePoint(codePoint)
          : entity;
      } catch {
        return " ";
      }
    },
  );
}

export function extractReadableOfficialText(
  html: string,
  maxChars = MAX_SUMMARY_CHARS,
): string {
  const withoutNonArticle = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<(script|style|nav|header|footer|iframe|svg|form|noscript|template|button)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      " ",
    )
    .replace(
      /<(br|\/p|\/div|\/article|\/main|\/section|\/h[1-6]|\/li|\/tr)\b[^>]*>/gi,
      "\n",
    );
  const text = decodeHtmlEntities(withoutNonArticle.replace(/<[^>]*>/g, " "))
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n+ */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.slice(0, Math.max(0, maxChars));
}

async function readBoundedUtf8(
  body: ReadableStream<Uint8Array> | null,
): Promise<string> {
  if (!body) throw new Error("BODY_EMPTY");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HTML_BYTES) {
        await reader.cancel();
        throw new Error("BODY_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export async function fetchOfficialBodySummary(
  plan: EnrichmentPlan,
  options: { fetcher?: typeof fetch } = {},
): Promise<EnrichmentResult> {
  if (plan.kind !== "fetch") {
    return { status: "needs_review", reason: "fetch_failed" };
  }
  try {
    const response = await (options.fetcher ?? fetch)(plan.url, {
      method: "GET",
      redirect: "error",
      headers: { Accept: "text/html, application/xhtml+xml" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return { status: "needs_review", reason: "http_error" };
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]
      .trim().toLowerCase();
    if (
      contentType !== "text/html" && contentType !== "application/xhtml+xml"
    ) {
      await response.body?.cancel();
      return { status: "needs_review", reason: "content_type_rejected" };
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_HTML_BYTES) {
      await response.body?.cancel();
      return { status: "needs_review", reason: "body_too_large" };
    }
    let html: string;
    try {
      html = await readBoundedUtf8(response.body);
    } catch (error) {
      return {
        status: "needs_review",
        reason: error instanceof Error && error.message === "BODY_TOO_LARGE"
          ? "body_too_large"
          : "body_empty",
      };
    }
    const bodySummary = extractReadableOfficialText(html);
    if (bodySummary.length < MIN_BODY_CHARS) {
      return { status: "needs_review", reason: "body_empty" };
    }
    return { status: "enriched", bodySummary };
  } catch {
    return { status: "needs_review", reason: "fetch_failed" };
  }
}

/**
 * Candidate-only pipeline gate. Callers must not enqueue a candidate for AI
 * judgement when this returns conditional_search_fallback. They should first
 * use the existing targeted Web Search fallback, and if that also fails, leave
 * the RSS item uninserted so a later poll can retry it rather than silently
 * judging a high-signal title without supporting facts.
 */
export async function prepareOfficialCandidateForJudgement(
  candidate: OfficialBodyCandidate,
  options: { fetcher?: typeof fetch } = {},
): Promise<OfficialCandidateDisposition> {
  const plan = planOfficialBodyEnrichment(candidate);
  if (plan.kind === "skip") return { action: "judge", candidate };
  if (plan.kind === "needs_review") {
    return {
      action: "conditional_search_fallback",
      reason: plan.reason,
      candidate,
    };
  }
  const fetched = await fetchOfficialBodySummary(plan, options);
  if (fetched.status === "needs_review") {
    return {
      action: "conditional_search_fallback",
      reason: fetched.reason,
      candidate,
    };
  }
  return {
    action: "judge",
    candidate: { ...candidate, bodySummary: fetched.bodySummary },
  };
}
