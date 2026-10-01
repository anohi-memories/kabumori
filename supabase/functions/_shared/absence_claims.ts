// Unscoped "there is no material / no news" claims. Pure: no I/O.
//
// A report may say that something specific could not be confirmed ("東京市場の値動きの理由を説明する
// ニュースは確認できません", "この銘柄の個別ニュースはありません"). It may not say, without a scope, that
// there is no material at all while its input holds news: on 2026-09-30 the app's close report was
// withheld after writing 「個別材料が含まれていない入力」 with market and watch-list news in the input.

const ABSENCE = /(?:^|[、。\s「はもに]|目立った|特段の|特に|大きな|新たな|明確な)(?:個別の?)?(?:材料|ニュース|手がかり)(?:は|が|も)?(?:特に)?(?:ない|無い|なく|ありません|ありませんでした|なかった|見当たりません|見当たらない|確認できません|確認できない|確認されていません|含まれていません|含まれていない|含まれておらず)/u;

function quote(sentence: string): string {
  const characters = Array.from(sentence);
  return `「${characters.length > 44 ? `${characters.slice(0, 44).join("")}…` : sentence}」`;
}

/**
 * Sentences that claim an unscoped absence of material while evidence exists. A statement limited by
 * a qualifier ("〜に関するニュースは…", "〜を説明する材料は…", "この銘柄の個別ニュースは…") is not matched.
 */
export function falseAbsenceClaims(texts: readonly string[], hasEvidence: boolean): string[] {
  if (!hasEvidence) return [];
  const sentences = texts.flatMap((text) => text.normalize("NFKC").split(/[。!?\n]/u)).map((part) => part.trim()).filter(Boolean);
  return [...new Set(sentences.filter((sentence) => {
    // A local absence can follow は/に (which also starts an unscoped claim). Do not confuse it
    // with "入力には材料がない"; only an explicit subject/topic qualifies the absence.
    return [...sentence.matchAll(new RegExp(ABSENCE.source, "gu"))].some((match) => {
      const prefix = match[0].startsWith("、") ? "" : sentence.slice(0, match.index).split(/[、]|ですが|けれど|一方/u).pop() ?? "";
      const qualified = /(?:この|当該|その)(?:保有|監視)?銘柄(?:に|について)|[^、。\s]+について/u.test(prefix);
      return !qualified || /入力|市場全体|全体/u.test(prefix);
    });
  }).map(quote))];
}
