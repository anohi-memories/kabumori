// Phase 6 (offline): turning a Bank of Japan official document into a usable body — or into an explicit "no body".
//
// Finding (2026-10-11): all 77 items of https://www.boj.or.jp/rss/whatsnew.xml have an EMPTY <description>, and the
// market_macro lane takes the RSS description as the candidate body. So the "0 characters" is not a PDF problem: the
// document behind <link> is never read. The PDFs themselves extract fine with unpdf (Japanese text, ~1–3k chars,
// each CJK character separated by a space), the HTML pages are plain UTF-8.
//
// RIGHTS: the Bank's terms ask for prior consultation before commercial reproduction. Nothing in this module fetches or
// stores anything. It only describes how text that has been obtained lawfully (once the terms are confirmed) is turned
// into a bounded judgement context, and it refuses to pass empty / garbled text on as a body.

import { assessBodyText, type BodyQuality, collapseCjkSpacing } from "./body_quality.ts";

export type BojDocumentKind = "pdf" | "html" | "spreadsheet" | "other";

export type BojDocumentLink = { kind: BojDocumentKind; allowed: boolean; reason: "ok" | "host_not_boj" | "not_http" | "malformed" };

/** Classifies the link of a BOJ feed item. Only boj.or.jp (and subdomains) are ever allowed. */
export function classifyBojDocumentUrl(raw: string): BojDocumentLink {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "other", allowed: false, reason: "malformed" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { kind: "other", allowed: false, reason: "not_http" };
  const host = url.hostname.toLowerCase();
  const onBoj = host === "boj.or.jp" || host.endsWith(".boj.or.jp");
  const path = url.pathname.toLowerCase();
  const kind: BojDocumentKind = /\.pdf$/u.test(path) ? "pdf" : /\.(?:xlsx?|csv)$/u.test(path) ? "spreadsheet" : /\.html?$|\/$/u.test(path) ? "html" : "other";
  return { kind, allowed: onBoj, reason: onBoj ? "ok" : "host_not_boj" };
}

const REMOVE_BLOCKS = ["head", "script", "style", "noscript", "nav", "header", "footer", "aside", "form", "iframe", "svg"];

/** Main text of a BOJ HTML page: blocks without content removed, the content container preferred. */
export function extractBojHtmlMainText(html: string): string {
  let work = html.replace(/<!--[\s\S]*?-->/gu, " ");
  for (const tag of REMOVE_BLOCKS) work = work.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, "giu"), " ");
  const container = /<(?:div|main|article)\b[^>]*\bid="(?:contents?|main|mainContents?)"[^>]*>/iu.exec(work);
  if (container) work = work.slice(container.index + container[0].length);
  return work
    .replace(/<br\s*\/?>|<\/(?:p|div|li|tr|h[1-6]|dt|dd|section|table|ul|ol)\s*>/giu, "\n")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .split(/\n+/u)
    .map((line) => line.replace(/[ \t　]+/gu, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

export type BojBody = {
  status: "usable" | "unusable";
  /** Why the text cannot be used (empty extraction, garbled fonts, not Japanese, too short). */
  reason: BodyQuality["reason"] | "not_a_text_document";
  quality: BodyQuality | null;
  /** Bounded judgement context; null when unusable. Never an empty string passed off as a body. */
  body: string | null;
};

export const BOJ_BODY_MAX_CHARS = 2400;

/**
 * Builds the bounded body from text extracted from a BOJ PDF or HTML page. Empty, garbled (CID font without a usable
 * ToUnicode map yields replacement characters) or non-Japanese output is reported as unusable instead of being
 * returned as a body.
 */
export function buildBojBody(extracted: string | null | undefined, kind: BojDocumentKind): BojBody {
  if (kind === "spreadsheet" || kind === "other") {
    return { status: "unusable", reason: "not_a_text_document", quality: null, body: null };
  }
  const text = collapseCjkSpacing(extracted ?? "");
  const quality = assessBodyText(text, { minChars: 30, expectJapanese: true });
  if (!quality.usable) return { status: "unusable", reason: quality.reason, quality, body: null };
  // keep whole lines (a figure is never cut mid-number) within the cap
  const lines = text.split(/\n+/u).map((line) => line.trim()).filter(Boolean);
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length + 1 > BOJ_BODY_MAX_CHARS) break;
    kept.push(line);
    length += line.length + 1;
  }
  return { status: "usable", reason: "ok", quality, body: kept.join("\n") };
}
