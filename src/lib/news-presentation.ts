// Turns a stored important-news row into what the app shows: a Japanese title,
// a short list summary and an in-app detail body.
//
// Everything here is deterministic and reuses text that already exists; it never
// calls an AI and never adds a fact. Copy is chosen, most trustworthy first:
//   1. verified_post  - the Japanese post text generated at publish time, which
//                       the RPC returns only when its Fact check passed.
//   2. disclosure     - a Japanese disclosure (TDnet) with the PDF letterhead and
//                       character spacing removed.
//   3. japanese_body  - any other Japanese stored summary, markup removed.
//   4. original_only  - nothing Japanese is available (e.g. an English wire item
//                       whose generated text failed the Fact check). The original
//                       title and an excerpt of the original text are shown,
//                       clearly marked, rather than inventing a translation.
//
// This module has no imports so it can be tested with Deno and bundled by Metro.

export type NewsPresentationInput = {
  title: string;
  summary: string | null;
  verified_text?: string | null;
  source_type?: string | null;
  source_url: string | null;
  company_name: string;
  matched_sector?: string | null;
  relevance_reason?: string | null;
};

export type NewsTextOrigin = 'verified_post' | 'disclosure' | 'japanese_body' | 'original_only';

export type NewsPresentation = {
  title: string;
  /** False when no Japanese title exists and the original title is shown. */
  titleIsJapanese: boolean;
  /** The stored title, shown as 原題 when it differs from the display title. */
  originalTitle: string;
  listSummary: string;
  keyPoints: string[];
  detailParagraphs: string[];
  /** Excerpt of the original-language text, only when nothing Japanese exists. */
  originalExcerpt: string | null;
  marketRelation: string | null;
  sourceLabel: string | null;
  sourceUrl: string | null;
  origin: NewsTextOrigin;
};

export const TITLE_MAX = 60;
export const LIST_SUMMARY_MAX = 200;
export const DETAIL_MAX = 800;
export const ORIGINAL_EXCERPT_MAX = 600;

const JAPANESE = /[぀-ヿ㐀-鿿]/u;
const CJK = '\\u3000-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';
const SPACE_TOUCHING_CJK = new RegExp(`(?<=[${CJK}])[ \\t]+|[ \\t]+(?=[${CJK}])`, 'gu');
const LEADING_LABELS = /^\s*(?:【(?:重大)?速報】\s*)+/u;
const TRAILING_SOURCE = /\s*出典\s*[:：]\s*\S+\s*$/u;
const SENTENCE_END = new Set(['。', '！', '？', '!', '?']);
const OPENING = new Set(['（', '(', '「', '『', '【', '［', '[']);
const CLOSING = new Set(['）', ')', '」', '』', '】', '］', ']']);
const NUMBER_CHAR = /[0-9０-９,，.．]/u;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', yen: '¥',
};

export function isJapanese(value: string | null | undefined): boolean {
  return typeof value === 'string' && JAPANESE.test(value);
}

/** Removes HTML/XML tags, comments, script/style blocks and decodes entities. */
export function stripMarkup(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  const withoutBlocks = value
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    // A tag cut off at the end of a stored excerpt.
    .replace(/<[a-zA-Z/!][^>]*$/g, ' ');
  const decoded = withoutBlocks
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+|#39);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
  return decoded
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function safeCodePoint(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function removeUrls(value: string): string {
  return value.replace(/https?:\/\/\S+/g, ' ');
}

function removePdfSpacing(value: string): string {
  return collapse(value).replace(SPACE_TOUCHING_CJK, '');
}

/** Splits on 。！？ outside brackets. */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let current = '';
  let depth = 0;
  for (const character of Array.from(text)) {
    current += character;
    if (OPENING.has(character)) depth += 1;
    else if (CLOSING.has(character)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && SENTENCE_END.has(character)) {
      if (current.trim()) sentences.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) sentences.push(current.trim());
  return sentences;
}

/** Whole sentences within the limit; a forced cut never lands inside a number. */
export function fitText(text: string, max: number): string {
  const normalized = collapse(text);
  if (Array.from(normalized).length <= max) return normalized;
  let fitted = '';
  for (const sentence of splitSentences(normalized)) {
    const next = `${fitted}${sentence}`;
    if (Array.from(next).length > max) break;
    fitted = next;
  }
  if (fitted) return fitted;
  const characters = Array.from(normalized);
  let cut = max - 1;
  while (cut > 1 && NUMBER_CHAR.test(characters[cut - 1]) && NUMBER_CHAR.test(characters[cut])) cut -= 1;
  return `${characters.slice(0, cut).join('').trimEnd()}…`;
}

/** The verified post split into paragraphs, without its 【速報】 label and 出典 line. */
export function verifiedPostParagraphs(verifiedText: string | null | undefined): string[] {
  if (typeof verifiedText !== 'string') return [];
  const body = stripMarkup(verifiedText).replace(TRAILING_SOURCE, '').replace(LEADING_LABELS, '');
  return body
    .split(/\n+/)
    .map((paragraph) => collapse(removeUrls(paragraph)))
    .filter((paragraph) => paragraph.length > 0);
}

/**
 * Prose of a Japanese disclosure after its own headline (matched ignoring the
 * PDF's character spacing) or from the first 当社は/が. Null when neither exists.
 */
export function disclosureProse(body: string | null | undefined, headline: string): string | null {
  const text = stripMarkup(body);
  if (!text || !isJapanese(text)) return null;
  const compactChars: string[] = [];
  const originalIndex: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (/\s/.test(text[index])) continue;
    compactChars.push(text[index]);
    originalIndex.push(index);
  }
  const compact = compactChars.join('');
  const compactHeadline = headline.replace(/\s+/g, '');
  let start = -1;
  if (compactHeadline.length >= 6) {
    const at = compact.indexOf(compactHeadline);
    if (at >= 0) start = originalIndex[at + compactHeadline.length - 1] + 1;
  }
  if (start < 0) {
    const statement = text.search(/当\s*社\s*(?:グ\s*ル\s*ー\s*プ\s*)?[はが]/u);
    if (statement >= 0) start = statement;
  }
  if (start < 0) return null;
  const prose = removePdfSpacing(removeUrls(text.slice(start)));
  if (!prose.includes('。') || Array.from(prose).length < 15) return null;
  return prose;
}

function chunkParagraphs(text: string, sentencesPerParagraph = 2): string[] {
  const sentences = splitSentences(text);
  const paragraphs: string[] = [];
  for (let index = 0; index < sentences.length; index += sentencesPerParagraph) {
    paragraphs.push(sentences.slice(index, index + sentencesPerParagraph).join(''));
  }
  return paragraphs;
}

/** A title-sized headline from the first sentence of verified Japanese text. */
function headlineFrom(paragraphs: string[]): string | null {
  const first = splitSentences(paragraphs.join(''))[0];
  if (!first || !isJapanese(first)) return null;
  const trimmed = first.replace(/[。．]$/u, '');
  return fitText(trimmed, TITLE_MAX);
}

const THEME_LABELS: Record<string, string> = {
  oil_energy: '原油・エネルギー',
  shipping: '海運',
  semiconductors: '半導体',
  autos: '自動車',
  trade: '通商・関税',
  fx: '為替',
  rates: '金利',
};

/**
 * Why a market-wide item is in this user's feed. States the connection only;
 * it never says whether anything will rise or fall.
 */
export function marketRelationText(
  matchedSector: string | null | undefined,
  relevanceReason: string | null | undefined,
): string | null {
  if (!matchedSector) return null;
  const themes = (relevanceReason ?? '')
    .split(',')
    .map((theme) => THEME_LABELS[theme.trim()])
    .filter((label): label is string => !!label);
  const topic = themes.length ? `${themes.join('・')}に関するニュースです。` : '市場全体に関するニュースです。';
  return `${topic}登録している${matchedSector}の銘柄に関係する可能性があるため表示しています。`;
}

const SOURCE_LABELS: Array<[RegExp, string]> = [
  [/(^|\.)tdnet\.info$/, 'TDnet（適時開示）'],
  [/(^|\.)ustr\.gov$/, '米通商代表部（USTR）'],
  [/(^|\.)apnews\.com$/, 'AP通信'],
  [/(^|\.)reuters\.com$/, 'ロイター'],
  [/(^|\.)bloomberg\.com$/, 'ブルームバーグ'],
  [/(^|\.)nikkei\.com$/, '日本経済新聞'],
  [/(^|\.)mof\.go\.jp$/, '財務省'],
  [/(^|\.)boj\.or\.jp$/, '日本銀行'],
  [/(^|\.)federalreserve\.gov$/, '米連邦準備制度理事会（FRB）'],
  [/(^|\.)bls\.gov$/, '米労働統計局'],
  [/(^|\.)bea\.gov$/, '米経済分析局'],
  [/(^|\.)news\.un\.org$/, '国連ニュース'],
  [/(^|\.)eia\.gov$/, '米エネルギー情報局'],
  [/(^|\.)whitehouse\.gov$/, 'ホワイトハウス'],
  [/(^|\.)treasury\.gov$/, '米財務省'],
  [/(^|\.)(commerce\.gov|bis\.doc\.gov)$/, '米商務省'],
  [/(^|\.)state\.gov$/, '米国務省'],
  [/(^|\.)centcom\.mil$/, '米中央軍'],
  [/(^|\.)defense\.gov$/, '米国防総省'],
];

export function sourceLabelFor(sourceUrl: string | null | undefined): string | null {
  if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) return null;
  let host: string;
  try {
    host = new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  return SOURCE_LABELS.find(([pattern]) => pattern.test(host))?.[1] ?? host;
}

export function buildNewsPresentation(item: NewsPresentationInput): NewsPresentation {
  const originalTitle = collapse(stripMarkup(item.title)) || '（タイトルなし）';
  const verified = verifiedPostParagraphs(item.verified_text);
  const sourceUrl = item.source_url && /^https?:\/\//i.test(item.source_url) ? item.source_url : null;
  const base = {
    originalTitle,
    marketRelation: marketRelationText(item.matched_sector, item.relevance_reason),
    sourceLabel: sourceLabelFor(sourceUrl),
    sourceUrl,
  };

  const titleIsJapanese = isJapanese(originalTitle);
  const verifiedHeadline = titleIsJapanese ? null : headlineFrom(verified);
  const title = titleIsJapanese ? fitText(originalTitle, 120) : verifiedHeadline ?? originalTitle;

  if (verified.length > 0 && isJapanese(verified.join(''))) {
    const sentences = splitSentences(verified.join(''));
    // When the title was taken from the first sentence, the list summary starts after it.
    const summarySentences = verifiedHeadline && sentences.length > 1 ? sentences.slice(1) : sentences;
    return {
      ...base,
      title,
      titleIsJapanese: true,
      listSummary: fitText(summarySentences.join(''), LIST_SUMMARY_MAX),
      // A short post would repeat the title and the detail almost verbatim, so key
      // points are only drawn when there is enough text to summarise.
      keyPoints: sentences.length >= 4 ? sentences.slice(0, 3).map((s) => fitText(s, 120)) : [],
      detailParagraphs: verified,
      originalExcerpt: null,
      origin: 'verified_post',
    };
  }

  const prose = disclosureProse(item.summary, originalTitle);
  if (prose) {
    const detail = fitText(prose, DETAIL_MAX);
    const sentences = splitSentences(detail);
    return {
      ...base,
      title,
      titleIsJapanese,
      listSummary: fitText(prose, LIST_SUMMARY_MAX),
      keyPoints: sentences.length >= 3 ? sentences.slice(0, 2).map((s) => fitText(s, 120)) : [],
      detailParagraphs: chunkParagraphs(detail),
      originalExcerpt: null,
      origin: 'disclosure',
    };
  }

  const cleaned = collapse(removeUrls(stripMarkup(item.summary)));
  if (cleaned && isJapanese(cleaned)) {
    const japanese = removePdfSpacing(cleaned);
    const detail = fitText(japanese, DETAIL_MAX);
    return {
      ...base,
      title,
      titleIsJapanese,
      listSummary: fitText(japanese, LIST_SUMMARY_MAX),
      keyPoints: [],
      detailParagraphs: chunkParagraphs(detail),
      originalExcerpt: null,
      origin: 'japanese_body',
    };
  }

  // Nothing Japanese: say so instead of translating on the device.
  return {
    ...base,
    title,
    titleIsJapanese,
    listSummary: '',
    keyPoints: [],
    detailParagraphs: [],
    originalExcerpt: cleaned ? fitText(cleaned, ORIGINAL_EXCERPT_MAX) : null,
    origin: 'original_only',
  };
}
