// 会社員AIラボ（ai_salaryman_lab）専用: 汎用テーマの連投・同一書き出しの連投を止める応急ガード。
//
// 背景: 「コードを書かない日」「調査・比較だけの日」「手戻りを減らす時間」のように、表現だけ違う
// 同じ結論の投稿が短時間に連続した。投稿本文はDBに残らない（残るのは完全一致用のハッシュのみ）ため、
// 過去投稿との比較はハッシュでは出来ない。そこでここでは
//   1. 汎用テーマを「意味のカテゴリ」として表現違いも含めて検出する（正規表現）
//   2. 生成された本文がそのカテゴリに当たったら、題材（seed）自体がそのテーマでない限り弾く
//   3. 書き出し「個人開発は、」系を弾く
//   4. 直近投稿の本文が呼び出し側から渡された場合（将来の履歴ソース用）は、同テーマ・高類似を弾く
// を純関数として提供する。DB・ネットワークには一切触れず、他ブランドからは import されない。

/** 数日単位でクールダウンさせる汎用テーマ。id は seed/本文/直近投稿で共通に使う。 */
export const AI_LAB_GENERIC_THEME_IDS = [
  "no_code_day",
  "research_only_day",
  "rework_reduction",
  "unglamorous_work",
  "looks_no_progress",
  "ai_trial_error",
  "solo_dev_hard",
] as const;
export type AiLabGenericThemeId = (typeof AI_LAB_GENERIC_THEME_IDS)[number];

const GENERIC_THEME_PATTERNS: Readonly<Record<AiLabGenericThemeId, readonly RegExp[]>> = {
  // 「コードを書かない日」「コードを書かず…」「今日は1行も書いていない」
  no_code_day: [
    /コード(を|は|が)?(1行も|一行も)?(書(か|け)(ない|なかった|ず)|書いて(い)?ない)/u,
    /書かない日/u,
    /1行も書(か|い)/u,
  ],
  // 「調査だけで1日」「下調べだけ」「仕様を決めるために調べる・比較する」
  research_only_day: [
    /(調査|調べ物|調べる|調べ|下調べ|リサーチ|比較|情報収集)(だけ|のみ)/u,
    /(1日|一日|丸一日|今日)[^。]{0,10}(調査|下調べ|調べ物|リサーチ|比較)(で|に)?(終わ|つぶれ|潰れ|費や)/u,
    /(仕様|方針|やり方)を決める(ため|ために)[^。]{0,12}(調べ|比較|調査)/u,
  ],
  // 「手戻りを減らす」
  rework_reduction: [
    /手戻り(を|が|は)?(減ら|防|少な|なくす|無くす|減る|削減)/u,
    /手戻り[^。]{0,6}時間/u,
  ],
  // 「地味な作業」
  unglamorous_work: [/地味/u],
  // 「進んでいないように見える」
  looks_no_progress: [
    /進んで(い)?ない(よう|ように|みたい|感じ|気が)/u,
    /進捗(が)?(ない|ゼロ|なさそう)(よう|ように)/u,
  ],
  // 「AIと試行錯誤」
  ai_trial_error: [/試行錯誤/u],
  // 「個人開発は大変」
  solo_dev_hard: [
    /個人開発(って|は|も|では|とは)?[^。]{0,8}(大変|しんどい|難しい|むずかしい|孤独)/u,
  ],
};

function normalizeForTheme(text: string): string {
  return text.normalize("NFKC").replace(/[\s　]+/gu, "");
}

/** 表現が違っても同じ意味カテゴリなら同じ id を返す。無ければ空。 */
export function detectGenericThemes(text: string): AiLabGenericThemeId[] {
  const normalized = normalizeForTheme(text);
  return AI_LAB_GENERIC_THEME_IDS.filter((id) =>
    GENERIC_THEME_PATTERNS[id].some((pattern) => pattern.test(normalized))
  );
}

// 書き出し「個人開発は、」「個人開発、」「個人開発では、」。ハッシュタグ(#個人開発)は先頭が # なので対象外。
const KOJIN_KAIHATSU_OPENER =
  /^[「『"“'‘【［\[（(]*個人開発(は|では|って|とは|も|、|,|，|:|：)/u;

export function startsWithKojinKaihatsuOpener(text: string): boolean {
  return KOJIN_KAIHATSU_OPENER.test(text.normalize("NFKC").trimStart());
}

function bigrams(text: string): Set<string> {
  const cleaned = text
    .normalize("NFKC")
    .replace(/#\S+/gu, "")
    .replace(/[\s　、。,.!?！？「」『』()（）\[\]【】・:：;；…\-ー]+/gu, "")
    .toLowerCase();
  const chars = Array.from(cleaned);
  const set = new Set<string>();
  for (let i = 0; i < chars.length - 1; i += 1) set.add(chars[i] + chars[i + 1]);
  return set;
}

/** 文字bigramのJaccard類似度（0〜1）。embedding等の外部基盤は使わない。 */
export function textSimilarity(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export const RECENT_POST_SIMILARITY_THRESHOLD = 0.4;

export type AiLabContentViolation =
  | "OPENER_KOJIN_KAIHATSU"
  | `GENERIC_THEME:${AiLabGenericThemeId}`
  | "RECENT_SAME_THEME"
  | "RECENT_SIMILAR_TEXT";

/**
 * 生成本文に対する応急チェック。違反コード（機械判定できる理由コード）の配列を返し、空なら合格。
 * - seedText: 今回渡した題材。題材自体が汎用テーマ（evergreen等）のときは、そのテーマだけ許可する。
 * - recentPostTexts: 直近の自分の投稿本文（呼び出し側が持っている場合のみ）。
 */
export function collectAiLabContentViolations({
  text,
  seedText = "",
  recentPostTexts = [],
}: {
  text: string;
  seedText?: string;
  recentPostTexts?: readonly string[];
}): AiLabContentViolation[] {
  const violations: AiLabContentViolation[] = [];
  if (startsWithKojinKaihatsuOpener(text)) violations.push("OPENER_KOJIN_KAIHATSU");

  const textThemes = detectGenericThemes(text);
  const allowed = new Set(detectGenericThemes(seedText));
  for (const id of textThemes) {
    if (!allowed.has(id)) violations.push(`GENERIC_THEME:${id}`);
  }

  if (recentPostTexts.length > 0) {
    const themes = new Set(textThemes);
    const sameTheme = recentPostTexts.some((recent) =>
      detectGenericThemes(recent).some((id) => themes.has(id))
    );
    if (sameTheme) violations.push("RECENT_SAME_THEME");
    const similar = recentPostTexts.some((recent) =>
      textSimilarity(text, recent) >= RECENT_POST_SIMILARITY_THRESHOLD
    );
    if (similar) violations.push("RECENT_SIMILAR_TEXT");
  }
  return violations;
}

const GENERIC_THEME_LABEL: Readonly<Record<AiLabGenericThemeId, string>> = {
  no_code_day: "コードを書かない日",
  research_only_day: "調査・下調べ・比較だけで終わる日",
  rework_reduction: "手戻りを減らす",
  unglamorous_work: "地味な作業",
  looks_no_progress: "進んでいないように見える",
  ai_trial_error: "AIとの試行錯誤",
  solo_dev_hard: "個人開発は大変",
};

/** 生成プロンプトへ足す、会社員AIラボ専用の追加指示。違反があった再生成時は具体的に名指しする。 */
export function aiLabDiversityInstructions(
  violations: readonly string[] = [],
): string[] {
  const lines = [
    "題材として渡された具体的な出来事（何を作った・直した・何に気づいた・なぜ止めたか）を中心に、その出来事自体を書いてください。出来事に触れない一般論だけの投稿にしないでください。",
    `次の汎用テーマは、題材として明示されていない限り書かないでください: ${
      AI_LAB_GENERIC_THEME_IDS.map((id) => GENERIC_THEME_LABEL[id]).join("／")
    }。表現を言い換えて同じ話をするのも不可です。`,
    "書き出しを「個人開発は、」「個人開発、」「個人開発では、」にしないでください。出来事や気づきそのものから書き始めてください。",
  ];
  if (violations.length > 0) {
    const themeLabels = violations.flatMap((violation) => {
      const id = violation.replace(/^GENERIC_THEME:/u, "") as AiLabGenericThemeId;
      return violation.startsWith("GENERIC_THEME:") && GENERIC_THEME_LABEL[id]
        ? [GENERIC_THEME_LABEL[id]]
        : [];
    });
    if (themeLabels.length > 0) {
      lines.push(
        `直前の案は汎用テーマ（${themeLabels.join("／")}）に寄っていたため不採用でした。その話題に一切触れず、題材の出来事だけで書き直してください。`,
      );
    }
    if (violations.includes("OPENER_KOJIN_KAIHATSU")) {
      lines.push(
        "直前の案は書き出しが「個人開発は」系でした。まったく別の書き出しにしてください。",
      );
    }
    if (
      violations.includes("RECENT_SAME_THEME") ||
      violations.includes("RECENT_SIMILAR_TEXT")
    ) {
      lines.push(
        "直前の案は最近の投稿と主題・内容が重なっていました。別の切り口・別の出来事で書き直してください。",
      );
    }
  }
  return lines;
}
