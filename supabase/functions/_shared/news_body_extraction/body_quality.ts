// Phase 6 (offline): shared quality gate for text that is about to be handed to the importance judgement / Fact
// check as the "body" of an official document. An empty or garbled body must be reported as missing, never passed on
// as if it were the document: handing the model a title and no facts makes every later check meaningless.
// Pure functions only: no fetching, no storage.

export type BodyQualityReason =
  | "ok"
  | "empty"
  | "too_short"
  | "garbled"
  | "no_japanese"
  | "only_boilerplate";

export type BodyQuality = {
  usable: boolean;
  reason: BodyQualityReason;
  chars: number;
  /** Share of letters that are CJK / kana (0..1). */
  cjkRatio: number;
  replacementChars: number;
};

export type BodyQualityOptions = {
  /** Minimum characters of real content. */
  minChars?: number;
  /** The text is expected to be Japanese (BOJ / MOF / TDnet); false for English sources (FOMC). */
  expectJapanese?: boolean;
};

const CJK = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]/gu;
const REPLACEMENT_OR_PRIVATE = /[�-]/gu;
const BOILERPLATE_LINE = /^(?:ホーム|トップ|ページの先頭へ|印刷|English|Share|Print|Back to top|Skip to main content)$/iu;

/** Spaces that PDF extraction inserts between every CJK character ("日 本 銀 行") are removed; real word gaps stay. */
export function collapseCjkSpacing(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/(?<=[぀-ヿ㐀-鿿\d])[ \t　]+(?=[぀-ヿ㐀-鿿\d])/gu, "")
    .replace(/(\d)[ \t]*([.,])[ \t]*(?=\d)/gu, "$1$2")
    // numbers and punctuation split by the same spacing: "0 . 75 %" -> "0.75%", "決定した 。" -> "決定した。"
    .replace(/(?<=\d)[ \t]+(?=[.,]\d)|(?<=[.,])[ \t]+(?=\d)|(?<=\d)[ \t]+(?=%)|(?<=[぀-ヿ㐀-鿿])[ \t]+(?=[%。、，．])|(?<=[%.])[ \t]+(?=[぀-ヿ㐀-鿿])/gu, "")
    .replace(/[ \t　]{2,}/gu, " ");
}

export function assessBodyText(raw: string | null | undefined, options: BodyQualityOptions = {}): BodyQuality {
  const minChars = options.minChars ?? 40;
  const expectJapanese = options.expectJapanese ?? true;
  const text = (raw ?? "").replaceAll("\u0000", "").trim();
  const meaningful = text.split(/\n+/u).map((line) => line.trim()).filter((line) => line && !BOILERPLATE_LINE.test(line)).join("\n");
  const chars = meaningful.length;
  const cjk = (meaningful.match(CJK) ?? []).length;
  const letters = (meaningful.match(/[\p{L}\p{N}]/gu) ?? []).length;
  const replacementChars = (text.match(REPLACEMENT_OR_PRIVATE) ?? []).length;
  const cjkRatio = letters > 0 ? cjk / letters : 0;
  const base = { chars, cjkRatio, replacementChars };
  if (text.length === 0) return { ...base, usable: false, reason: "empty" };
  if (chars === 0) return { ...base, usable: false, reason: "only_boilerplate" };
  if (replacementChars > 0 && replacementChars / Math.max(1, text.length) > 0.02) return { ...base, usable: false, reason: "garbled" };
  if (chars < minChars) return { ...base, usable: false, reason: "too_short" };
  if (expectJapanese && cjkRatio < 0.2) return { ...base, usable: false, reason: "no_japanese" };
  return { ...base, usable: true, reason: "ok" };
}
