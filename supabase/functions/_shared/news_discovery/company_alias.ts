// Company alias dictionary and ticker matching v0 (Japanese listed companies).
//
// One pass over the shared signal pool assigns ticker candidates; nothing searches per stock.
// Alias sources in v0:
//   1. generated from stocks_master (official name, suffix-stripped short name)
//   2. KNOWN_ALIASES_V0: a small, hand-checked list for verification tickers (no AI-generated aliases)
// Matching is span-based: the longest alias wins an overlapping span, so "日立建機" never counts as
// "日立", and a negative context ("リチウムイオン") suppresses the alias inside it.
// Confirmation policy (N5-B, after the 2026-09-30 production canary confirmed 7504 "高速" from
// "高速取引" and 9246 "プロジェクト" from "…プロジェクト（PIP）"): a dictionary hit that is not
// hand-reviewed (a generated short name, or a short kanji official name embedded in a longer kanji
// word) is only a candidate, unless the text also carries corroboration (ticker code, structured
// ticker, a reviewed alias, a second alias, an explicit "株式会社" next to the name). Candidates are
// never dropped: recall is kept, only the confirmed tier is made stricter.
import type { TickerCandidate, TickerMatchType } from "./types.ts";

export type StockMasterRow = {
  ticker_code: string;
  company_name: string;
  market?: string | null;
  is_listed?: boolean | null;
};

export type AliasStrength = "EXACT_COMPANY_NAME" | "STRONG_ALIAS" | "WEAK_ALIAS";

export type AliasKind =
  | "official_name"
  | "short_name"
  | "english_name"
  | "abbreviation"
  | "former_name"
  | "brand"
  | "subsidiary"
  | "product"
  | "service"
  | "key_person"
  | "common_alias";

export type AliasEntry = {
  ticker: string;
  company_name: string;
  alias: string; // NFKC-normalized surface form
  strength: AliasStrength;
  kind: AliasKind;
  origin: "stocks_master" | "generated" | "known_alias_v0";
  /** Weak aliases are confirmed only when one of these also appears in the text. */
  context_terms: string[];
  /** Occurrences inside these phrases are ignored. */
  negative_terms: string[];
};

export type KnownAliasSeed = {
  ticker: string;
  aliases: Array<{
    alias: string;
    strength: Exclude<AliasStrength, "EXACT_COMPANY_NAME">;
    kind: AliasKind;
    context_terms?: string[];
    negative_terms?: string[];
  }>;
  /** Treat the official name itself as weak (it is an ordinary word or shared with a group company). */
  demote_official_name?: { context_terms: string[] };
  negative_terms?: string[];
};

/**
 * Hand-checked v0 seed for verification tickers. Every ticker was confirmed to exist in
 * stocks_master (read-only, 2026-09-28). Keep this list small and factual; the design for
 * scaling aliases (EDINET code list, Wikidata, manual review) is in company_news_non_ir_design.md.
 */
export const KNOWN_ALIASES_V0: readonly KnownAliasSeed[] = [
  {
    ticker: "8136",
    aliases: [
      { alias: "Sanrio", strength: "STRONG_ALIAS", kind: "english_name" },
      { alias: "ハローキティ", strength: "STRONG_ALIAS", kind: "brand" },
      { alias: "Hello Kitty", strength: "STRONG_ALIAS", kind: "brand" },
      { alias: "サンリオピューロランド", strength: "STRONG_ALIAS", kind: "service" },
      { alias: "Sanrio Puroland", strength: "STRONG_ALIAS", kind: "service" },
    ],
  },
  {
    ticker: "7203",
    aliases: [
      { alias: "トヨタ", strength: "STRONG_ALIAS", kind: "short_name" },
      { alias: "Toyota", strength: "STRONG_ALIAS", kind: "english_name" },
      { alias: "レクサス", strength: "STRONG_ALIAS", kind: "brand" },
      { alias: "Lexus", strength: "STRONG_ALIAS", kind: "brand" },
    ],
  },
  {
    ticker: "6758",
    aliases: [
      { alias: "ソニー", strength: "STRONG_ALIAS", kind: "short_name" },
      { alias: "Sony", strength: "STRONG_ALIAS", kind: "english_name" },
      { alias: "プレイステーション", strength: "STRONG_ALIAS", kind: "product" },
      { alias: "PlayStation", strength: "STRONG_ALIAS", kind: "product" },
    ],
  },
  {
    ticker: "7974",
    aliases: [
      { alias: "Nintendo", strength: "STRONG_ALIAS", kind: "english_name" },
      { alias: "ニンテンドースイッチ", strength: "STRONG_ALIAS", kind: "product" },
      { alias: "Nintendo Switch", strength: "STRONG_ALIAS", kind: "product" },
    ],
  },
  {
    ticker: "9984",
    aliases: [
      { alias: "ソフトバンクG", strength: "STRONG_ALIAS", kind: "abbreviation" },
      { alias: "SoftBank Group", strength: "STRONG_ALIAS", kind: "english_name" },
      { alias: "SoftBank", strength: "WEAK_ALIAS", kind: "common_alias", context_terms: ["Son", "Vision Fund", "ビジョン・ファンド", "孫正義"] },
      { alias: "孫正義", strength: "WEAK_ALIAS", kind: "key_person" },
    ],
  },
  {
    // The official name "ソフトバンク" is also everyday shorthand for SoftBank Group (9984).
    ticker: "9434",
    aliases: [{ alias: "SoftBank Corp", strength: "STRONG_ALIAS", kind: "english_name" }],
    demote_official_name: { context_terms: ["携帯", "通信料金", "PayPay", "ワイモバイル", "LINEMO"] },
  },
  {
    ticker: "9983",
    aliases: [
      { alias: "ユニクロ", strength: "STRONG_ALIAS", kind: "brand" },
      { alias: "UNIQLO", strength: "STRONG_ALIAS", kind: "brand" },
      { alias: "Uniqlo", strength: "STRONG_ALIAS", kind: "brand" },
      { alias: "ジーユー", strength: "STRONG_ALIAS", kind: "brand" },
      { alias: "Fast Retailing", strength: "STRONG_ALIAS", kind: "english_name" },
    ],
  },
  {
    ticker: "8035",
    aliases: [
      { alias: "Tokyo Electron", strength: "STRONG_ALIAS", kind: "english_name" },
      { alias: "東エレク", strength: "STRONG_ALIAS", kind: "abbreviation" },
      { alias: "TEL", strength: "WEAK_ALIAS", kind: "abbreviation", context_terms: ["半導体", "製造装置", "semiconductor", "chip"] },
    ],
  },
  {
    ticker: "4661",
    aliases: [
      { alias: "東京ディズニーリゾート", strength: "STRONG_ALIAS", kind: "service" },
      { alias: "東京ディズニーランド", strength: "STRONG_ALIAS", kind: "service" },
      { alias: "東京ディズニーシー", strength: "STRONG_ALIAS", kind: "service" },
      { alias: "ディズニー", strength: "WEAK_ALIAS", kind: "common_alias", context_terms: ["舞浜", "東京ディズニー", "入園者"] },
    ],
  },
  {
    ticker: "9432",
    aliases: [
      { alias: "日本電信電話", strength: "STRONG_ALIAS", kind: "former_name" },
      { alias: "NTTドコモ", strength: "STRONG_ALIAS", kind: "subsidiary" },
      { alias: "ドコモ", strength: "STRONG_ALIAS", kind: "subsidiary" },
    ],
  },
  {
    ticker: "8306",
    aliases: [
      { alias: "三菱UFJ", strength: "STRONG_ALIAS", kind: "short_name" },
      { alias: "MUFG", strength: "STRONG_ALIAS", kind: "abbreviation" },
    ],
  },
  {
    ticker: "4689",
    aliases: [
      { alias: "LY Corporation", strength: "STRONG_ALIAS", kind: "english_name" },
      { alias: "LINE", strength: "WEAK_ALIAS", kind: "service", context_terms: ["LINEヤフー", "メッセージアプリ", "LINEアプリ"] },
      { alias: "ヤフー", strength: "WEAK_ALIAS", kind: "service", context_terms: ["LINEヤフー", "Yahoo!ショッピング", "PayPay"] },
    ],
  },
  {
    // "BASE" is an ordinary English word; the official name alone never confirms.
    ticker: "4477",
    aliases: [],
    demote_official_name: { context_terms: ["ネットショップ", "BASE株式会社", "Pay ID", "ネットショップ作成"] },
  },
  {
    ticker: "8267",
    aliases: [{ alias: "AEON", strength: "STRONG_ALIAS", kind: "english_name" }],
    negative_terms: ["リチウムイオン", "イオン交換", "イオン化", "水素イオン", "陽イオン", "陰イオン", "マイナスイオン", "イオン電池", "イオンエンジン", "イオン濃度"],
  },
  {
    ticker: "6857",
    aliases: [{ alias: "Advantest", strength: "STRONG_ALIAS", kind: "english_name" }],
  },
  {
    ticker: "6501",
    aliases: [
      { alias: "日立", strength: "STRONG_ALIAS", kind: "short_name" },
      { alias: "Hitachi", strength: "STRONG_ALIAS", kind: "english_name" },
    ],
  },
  {
    ticker: "7267",
    aliases: [
      { alias: "ホンダ", strength: "STRONG_ALIAS", kind: "short_name" },
      { alias: "Honda", strength: "STRONG_ALIAS", kind: "english_name" },
    ],
  },
  {
    ticker: "6861",
    aliases: [
      { alias: "KEYENCE", strength: "STRONG_ALIAS", kind: "english_name" },
      { alias: "Keyence", strength: "STRONG_ALIAS", kind: "english_name" },
    ],
  },
];

export function normalizeAliasText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

const CORPORATE_FORMS = [/^株式会社\s*/, /\s*株式会社$/, /[（(]株[)）]/g];
const GROUP_SUFFIXES = ["ホールディングス", "HOLDINGS", "HD", "グループ本社", "フィナンシャル・グループ", "フィナンシャルグループ", "グループ"];

function stripCorporateForms(name: string): string {
  let value = name;
  for (const pattern of CORPORATE_FORMS) value = value.replace(pattern, "");
  return value.trim();
}

/** Short forms such as "ソニーグループ" -> "ソニー", "○○ホールディングス" -> "○○". */
export function generatedShortNames(officialName: string): string[] {
  const base = stripCorporateForms(normalizeAliasText(officialName));
  const out = new Set<string>();
  for (const suffix of GROUP_SUFFIXES) {
    if (base.endsWith(suffix) && base.length > suffix.length) out.add(base.slice(0, -suffix.length).replace(/[・\s]+$/, ""));
  }
  out.delete(base);
  return [...out].filter((value) => value.length > 0);
}

function isAscii(value: string): boolean {
  return /^[\x20-\x7e]+$/.test(value);
}

const KATAKANA_ONLY = /^[\p{Script=Katakana}ー・]+$/u;
const KATAKANA_CHAR = /[\p{Script=Katakana}ー]/u;

/** Katakana-only names of <= 3 characters are usually ordinary words (キング, リズム, ベース, レイ). */
function isShortKatakanaWord(value: string): boolean {
  return KATAKANA_ONLY.test(value) && [...value].length <= 3;
}

const HAN_ONLY = /^\p{Script=Han}+$/u;
const HAN_CHAR = /\p{Script=Han}/u;

/** A short (<= 3 characters) all-kanji name is usually an ordinary word (高速, 大和, 東北). */
function isShortHanName(value: string): boolean {
  return HAN_ONLY.test(value) && [...value].length <= 3;
}

export type AliasIndex = {
  entries: AliasEntry[];
  /** entries grouped by first character (for fast scanning), longest alias first. */
  byFirstChar: Map<string, AliasEntry[]>;
  tickers: Map<string, string>; // ticker -> company name
  warnings: string[];
};

export function buildAliasIndex(
  rows: readonly StockMasterRow[],
  seeds: readonly KnownAliasSeed[] = KNOWN_ALIASES_V0,
): AliasIndex {
  const warnings: string[] = [];
  const listed = rows.filter((row) => row.is_listed !== false);
  const tickers = new Map(listed.map((row) => [row.ticker_code, normalizeAliasText(row.company_name)]));
  const seedByTicker = new Map(seeds.map((seed) => [seed.ticker, seed]));
  const entries: AliasEntry[] = [];

  const officialOwner = new Map<string, string>(); // official alias -> ticker
  for (const row of listed) officialOwner.set(stripCorporateForms(normalizeAliasText(row.company_name)), row.ticker_code);

  for (const row of listed) {
    const name = normalizeAliasText(row.company_name);
    const seed = seedByTicker.get(row.ticker_code);
    const negatives = seed?.negative_terms ?? [];
    const official = stripCorporateForms(name);
    const demoted = seed?.demote_official_name;
    // Reviewed (seeded) tickers keep their official name; unreviewed short katakana words do not confirm.
    const weakOfficial = !!demoted || (!seed && isShortKatakanaWord(official));
    entries.push({
      ticker: row.ticker_code,
      company_name: name,
      alias: official,
      strength: weakOfficial ? "WEAK_ALIAS" : "EXACT_COMPANY_NAME",
      kind: "official_name",
      origin: "stocks_master",
      context_terms: demoted?.context_terms ?? [],
      negative_terms: negatives,
    });
    for (const short of generatedShortNames(name)) {
      if ([...short].length < 2) continue; // "宝" from 宝ホールディングス matches everything
      const owner = officialOwner.get(short);
      if (owner && owner !== row.ticker_code) continue; // another company's exact name wins
      entries.push({
        ticker: row.ticker_code,
        company_name: name,
        alias: short,
        // Unreviewed: never confirms on its own, however long (see the header comment and matchTickers).
        strength: "WEAK_ALIAS",
        kind: "short_name",
        origin: "generated",
        context_terms: [],
        negative_terms: negatives,
      });
    }
  }

  for (const seed of seeds) {
    const company = tickers.get(seed.ticker);
    if (!company) {
      warnings.push(`seed ticker ${seed.ticker} not in stocks_master (listed): skipped`);
      continue;
    }
    for (const item of seed.aliases) {
      entries.push({
        ticker: seed.ticker,
        company_name: company,
        alias: normalizeAliasText(item.alias),
        strength: item.strength,
        kind: item.kind,
        origin: "known_alias_v0",
        context_terms: item.context_terms ?? [],
        negative_terms: [...(item.negative_terms ?? []), ...(seed.negative_terms ?? [])],
      });
    }
  }

  // A hand-checked seed alias outranks another company's generated short name
  // ("ソニー" is Sony Group's, not a stripped form of "ソニーフィナンシャルグループ").
  const seedOwners = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (entry.origin !== "known_alias_v0") continue;
    const set = seedOwners.get(entry.alias) ?? new Set<string>();
    set.add(entry.ticker);
    seedOwners.set(entry.alias, set);
  }
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    const seeded = seedOwners.get(entry.alias);
    if (entry.origin === "generated" && seeded && !seeded.has(entry.ticker)) entries.splice(i, 1);
  }

  // The same surface form owned by several companies can never confirm a single ticker.
  const owners = new Map<string, Set<string>>();
  for (const entry of entries) {
    const set = owners.get(entry.alias) ?? new Set<string>();
    set.add(entry.ticker);
    owners.set(entry.alias, set);
  }
  for (const entry of entries) {
    if ((owners.get(entry.alias)?.size ?? 0) > 1 && entry.strength !== "WEAK_ALIAS") {
      if (entry.strength === "EXACT_COMPANY_NAME") warnings.push(`official name "${entry.alias}" shared by several tickers: demoted`);
      entry.strength = "WEAK_ALIAS";
    }
  }

  const deduped = new Map<string, AliasEntry>();
  for (const entry of entries) {
    if (!entry.alias) continue;
    const key = `${entry.ticker}\u0000${entry.alias}`;
    const existing = deduped.get(key);
    if (!existing || rank(entry.strength) > rank(existing.strength)) deduped.set(key, entry);
  }
  const finalEntries = [...deduped.values()];
  const byFirstChar = new Map<string, AliasEntry[]>();
  for (const entry of finalEntries) {
    const first = entry.alias[0];
    const list = byFirstChar.get(first) ?? [];
    list.push(entry);
    byFirstChar.set(first, list);
  }
  for (const list of byFirstChar.values()) list.sort((a, b) => b.alias.length - a.alias.length);
  return { entries: finalEntries, byFirstChar, tickers, warnings };
}

function rank(strength: AliasStrength): number {
  return strength === "EXACT_COMPANY_NAME" ? 3 : strength === "STRONG_ALIAS" ? 2 : 1;
}

const ALNUM = /[A-Za-z0-9]/;

type Span = { start: number; end: number; entry: AliasEntry };

function findSpans(text: string, index: AliasIndex): Span[] {
  const spans: Span[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const candidates = index.byFirstChar.get(text[i]);
    if (!candidates) continue;
    for (const entry of candidates) {
      if (!text.startsWith(entry.alias, i)) continue;
      const end = i + entry.alias.length;
      if (isAscii(entry.alias)) {
        // ASCII aliases need word boundaries: "LINE" must not hit "LINEAR", "TEL" not "HOTEL".
        if ((i > 0 && ALNUM.test(text[i - 1])) || (end < text.length && ALNUM.test(text[end]))) continue;
      } else if (KATAKANA_CHAR.test(entry.alias[0]) && i > 0 && KATAKANA_CHAR.test(text[i - 1])) {
        continue; // "データベース" is not "ベース", "ツーリズム" is not "リズム"
      } else if (KATAKANA_CHAR.test(entry.alias.at(-1) ?? "") && end < text.length && KATAKANA_CHAR.test(text[end])) {
        continue; // "リコール" is not "リコー", "ワーキング" handled above
      }
      spans.push({ start: i, end, entry });
    }
  }
  // Longest span wins; equal spans keep every owner (ambiguity is resolved by strength later).
  spans.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const kept: Span[] = [];
  for (const span of spans) {
    const overlapsLonger = kept.some((other) =>
      span.start < other.end && other.start < span.end && (other.end - other.start) > (span.end - span.start)
    );
    if (!overlapsLonger) kept.push(span);
  }
  return kept.filter((span) =>
    !span.entry.negative_terms.some((negative) => {
      for (let from = Math.max(0, span.start - negative.length); from <= span.start; from += 1) {
        const at = text.indexOf(negative, from);
        if (at !== -1 && at <= span.start && at + negative.length >= span.end) return true;
      }
      return false;
    })
  );
}

const CODE_PATTERNS: readonly RegExp[] = [
  /(?<![0-9A-Z])(\d{4}|\d{3}[A-Z])\.T\b/g, // 7203.T
  /TYO:\s?(\d{4}|\d{3}[A-Z])\b/g,
  /証券コード[：:\s]*(\d{4}|\d{3}[A-Z])/g,
  /東証(?:プライム|スタンダード|グロース)?[・:：\s]*(\d{4}|\d{3}[A-Z])(?![0-9])/g,
  /[（(]\s*(\d{4}|\d{3}[A-Z])\s*[)）]/g, // (7203) — year-like values need corroboration
];

function tickerCodeMatches(text: string, index: AliasIndex): Map<string, boolean> {
  const found = new Map<string, boolean>(); // ticker -> needs corroboration
  CODE_PATTERNS.forEach((pattern, patternIndex) => {
    for (const match of text.matchAll(pattern)) {
      const code = match[1];
      if (!index.tickers.has(code)) continue;
      const parenthetical = patternIndex === CODE_PATTERNS.length - 1;
      const yearLike = /^(19|20)\d{2}$/.test(code);
      const needsCorroboration = parenthetical && yearLike;
      found.set(code, (found.get(code) ?? true) && needsCorroboration);
    }
  });
  return found;
}

/** True when a short all-kanji alias sits inside a longer run of kanji ("高速取引", "日本高速"). */
function isEmbeddedShortHanName(span: Span, text: string): boolean {
  if (!isShortHanName(span.entry.alias)) return false;
  const before = span.start > 0 ? text[span.start - 1] : "";
  const after = span.end < text.length ? text[span.end] : "";
  return HAN_CHAR.test(before) || HAN_CHAR.test(after);
}

/** An explicit company form right next to the name ("株式会社○○", "○○株式会社", "○○(株)") is corroboration. */
function hasCompanyFormContext(text: string, span: Span): boolean {
  return /(株式会社|\(株\))\s*$/.test(text.slice(Math.max(0, span.start - 8), span.start)) ||
    /^\s*(株式会社|\(株\))/.test(text.slice(span.end, span.end + 8));
}

const SCORE: Record<TickerMatchType, number> = {
  EXACT_COMPANY_NAME: 1,
  TICKER_CODE: 0.95,
  STRONG_ALIAS: 0.9,
  WEAK_ALIAS: 0.4,
};

export type MatchInput = { title: string; summary?: string | null; structured_ticker?: string | null };

/**
 * Returns every ticker supported by the text. `confirmed` needs at least one non-weak match, a
 * structured ticker, or a weak alias corroborated by its context terms / a second weak alias.
 */
export function matchTickers(input: MatchInput, index: AliasIndex): TickerCandidate[] {
  const title = normalizeAliasText(input.title);
  const summary = normalizeAliasText(input.summary ?? "");
  const fullText = `${title}\n${summary}`;
  type Acc = { types: Set<TickerMatchType>; aliases: Set<string>; weakAliases: Set<string>; inTitle: boolean; contextHit: boolean; companyContext: boolean };
  const acc = new Map<string, Acc>();
  const get = (ticker: string): Acc => {
    let value = acc.get(ticker);
    if (!value) {
      value = { types: new Set(), aliases: new Set(), weakAliases: new Set(), inTitle: false, contextHit: false, companyContext: false };
      acc.set(ticker, value);
    }
    return value;
  };

  for (const [text, inTitle] of [[title, true], [summary, false]] as const) {
    if (!text) continue;
    for (const span of findSpans(text, index)) {
      const item = get(span.entry.ticker);
      // An official short kanji name inside a longer kanji word ("高速" in "高速取引") is not a mention.
      const strength = span.entry.strength === "EXACT_COMPANY_NAME" && isEmbeddedShortHanName(span, text)
        ? "WEAK_ALIAS"
        : span.entry.strength;
      item.types.add(strength);
      item.aliases.add(span.entry.alias);
      if (strength === "WEAK_ALIAS") {
        item.weakAliases.add(span.entry.alias);
        if (span.entry.context_terms.some((term) => fullText.includes(normalizeAliasText(term)))) item.contextHit = true;
        if (hasCompanyFormContext(text, span)) item.companyContext = true;
      }
      item.inTitle ||= inTitle;
    }
  }

  const codes = tickerCodeMatches(fullText, index);
  for (const [code, needsCorroboration] of codes) {
    if (needsCorroboration && !acc.has(code)) continue;
    const item = get(code);
    item.types.add("TICKER_CODE");
    item.aliases.add(code);
  }
  if (input.structured_ticker && index.tickers.has(input.structured_ticker)) {
    const item = get(input.structured_ticker);
    item.types.add("TICKER_CODE");
    item.aliases.add(input.structured_ticker);
    item.inTitle = true;
  }

  const out: TickerCandidate[] = [];
  for (const [ticker, item] of acc) {
    const types = [...item.types];
    const onlyWeak = types.every((type) => type === "WEAK_ALIAS");
    const confirmed = !onlyWeak || item.contextHit || item.companyContext || item.weakAliases.size >= 2;
    const basis: TickerCandidate["confirmation_basis"] = !confirmed
      ? null
      : types.includes("EXACT_COMPANY_NAME") || types.includes("STRONG_ALIAS")
      ? "strong_match"
      : types.includes("TICKER_CODE")
      ? "ticker_code"
      : item.contextHit || item.companyContext
      ? "weak_with_context"
      : "multiple_weak";
    const base = Math.max(...types.map((type) => SCORE[type]));
    const score = Math.min(1, base + (item.inTitle ? 0.05 : 0) + (onlyWeak && confirmed ? 0.3 : 0));
    out.push({
      ticker,
      company_name: index.tickers.get(ticker) ?? ticker,
      status: confirmed ? "confirmed" : "candidate",
      confirmation_basis: basis,
      match_types: types,
      matched_aliases: [...item.aliases],
      in_title: item.inTitle,
      score: Math.round(score * 100) / 100,
    });
  }
  // More than 10 companies in one headline is a market round-up, not company news.
  const confirmedCount = out.filter((candidate) => candidate.status === "confirmed").length;
  if (confirmedCount > 10) {
    for (const candidate of out) {
      candidate.status = "candidate";
      candidate.confirmation_basis = null;
    }
  }
  return out.sort((a, b) => b.score - a.score || a.ticker.localeCompare(b.ticker));
}
