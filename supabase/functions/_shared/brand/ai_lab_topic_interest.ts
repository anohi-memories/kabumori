// Task46: whether a dev-diary topic has something an ordinary X reader would want to read.
//
// The user judged recent drafts "そもそも内容があんまり": the topic, not only the voice, was weak.
// `assessAiLabTopicValue` (Task39) keeps out internal reports and credential talk. This second,
// provider-independent judgement asks for a story in the recorded facts: something that went wrong
// or got stuck, something noticed that was not expected, or a deliberate choice. A topic with none
// of these, a promotional one, or a one-signal topic told as a work report is held, never padded.
//
// Every signal is matched in the fact lines only (できごと / 詰まったこと / 決めたこと); the 切り口
// line, any draft and any model output are never read, so a model cannot raise a topic's value by
// writing a better story. The same seed always gives the same audit, whichever text pattern
// (Claude→Claude, Sol→Sol, Luna→Sol) runs afterwards. This is a heuristic: a pass is not a proof
// that a topic is interesting, and the audit lists what it matched so a person can disagree.

const FACT_LINE = /^[ \t]*(できごと|詰まったこと|決めたこと)[:：][ \t]*(.+)$/gmu;

/**
 * Something that went wrong or got stuck. A clause that only guards against it (「〜した場合」
 * 「〜ないよう」「〜可能性」「〜そうなので」) is a precaution, not an event, and does not count; a near miss
 * that did happen (「消えそうになった」) does.
 */
const FAILURE_OR_SNAG =
  /(?:間違え|失敗|不具合|問題を見つけ|問題が見つか|壊れ|消え(?:て|た|そうになっ)|消してしま|置き忘れ|忘れて|二重|押せてしま|動かな|届かな|伝わらな|読めな|重なっ|重なり|崩れ|矛盾|すり抜け|見落とし|混ざ|食い違|詰ま|時間がかか|うまくいっていな|嘘|うそ|不自然|迷っ|同じ[^、。]{0,12}(?:続いて|続けて|並んで|重複))(?![^、。]{0,12}?(?:場合|ないよう|ないため|可能性|そう(?:だ|なので|なら)))/gu;
/** Something noticed that was not expected. */
const SURPRISE =
  /実は|気づ|分かった|わかった|思ったが|思ったけど|意外|想定(?:と違|外|していな|していたのと違)|ように見えてしま|同じに見え|後から届|正しくても|普通でも|通っても/gu;
/** A deliberate choice or trade-off: doing less, separating, putting one thing before another. */
const INGENUITY =
  /ではなく|代わりに|より先に|より[「」]?[^\s、。]{0,12}を?優先|を優先|分け|とどめ|逃がし|だけを|だけ[^\s、。]{0,6}(?:する|にし|解約|直)|一度まとめて|1か所|してみた|止め|停止|先に作|前に[^、。]{0,12}(?:読む|取る|見る|確かめ|書く)/gu;
/** A detail a reader can hold on to: a counted number, or a quoted phrase. */
const CONCRETE_DETAIL = /\d+\s*(?:分|秒|時間|件|個|回|枚|%|％|倍|つ|テーマ)|「[^」]{2,}」/gu;
/** Something a reader can see or touch (same scope as the Task39 value filter). */
const READER_SCENE =
  /画面|表示|ボタン|見た目|押し|タップ|色|イラスト|グラフ|文字|タイトル|改行|見出し|通知|写真|画像|カード|リンク|メッセージ|入力/gu;

/** Advertising: a reader is asked to buy, try or look forward to something. */
const PROMOTIONAL =
  /ぜひ|おすすめ|オススメ|お試し|使ってみて|ダウンロード|リリースしました|新登場|お楽しみに|好評|大幅に?(?:向上|改善)|フォロー/u;
/** "Made it with AI" as the whole point. */
const AI_MADE = /AI(?:で|に|を使って)[^。]{0,20}(?:作っ|作ら|作成|生成|書かせ|書いても|実装)/u;
/** Report-register verbs (報告書調) that describe work done rather than something that happened. */
const REPORT_TONE =
  /実施|完了|対応した|整備|試作|設計にし|実装|導入|を行っ|行った|進めた|整えた|まとめた|確認した|改善した/gu;

export type AiLabTopicInterestSignal = "FAILURE_OR_SNAG" | "SURPRISE" | "INGENUITY";
export type AiLabTopicInterestWeakness =
  | "NO_STORY"
  | "PROMOTIONAL"
  | "AI_MADE_REPORT"
  | "REPORT_TONE"
  | "REPEATED_STRUCTURE";

export type AiLabTopicInterest = {
  readonly postable: boolean;
  /** high: two or more story signals and a detail or scene; medium: postable otherwise; weak: held. */
  readonly tier: "high" | "medium" | "weak";
  readonly signals: readonly AiLabTopicInterestSignal[];
  readonly weaknesses: readonly AiLabTopicInterestWeakness[];
  /** Fragments of the source fact lines that each signal matched (never model text). */
  readonly evidence: Readonly<Record<AiLabTopicInterestSignal | "CONCRETE_DETAIL" | "READER_SCENE", readonly string[]>>;
  /** One short Japanese line a person can check against the source. */
  readonly summary: string;
};

export const AI_LAB_TOPIC_INTEREST_HELD = "AI_LAB_TOPIC_INTEREST_HELD";

const SIGNAL_LABEL: Record<AiLabTopicInterestSignal, string> = {
  FAILURE_OR_SNAG: "失敗・詰まり",
  SURPRISE: "気づき・意外性",
  INGENUITY: "工夫・選択",
};
const WEAKNESS_LABEL: Record<AiLabTopicInterestWeakness, string> = {
  NO_STORY: "失敗も気づきも工夫も無い進捗の列挙",
  PROMOTIONAL: "宣伝調",
  AI_MADE_REPORT: "「AIで作った」という報告",
  REPORT_TONE: "報告書調",
  REPEATED_STRUCTURE: "同じ内容の言い直し",
};

const unique = (values: readonly string[]) => [...new Set(values)];
const matches = (pattern: RegExp, text: string) => unique(text.match(pattern) ?? []);

function bigrams(text: string): Set<string> {
  const chars = [...text.replace(/[\s、。「」]/gu, "")];
  const grams = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i += 1) grams.add(chars[i] + chars[i + 1]);
  return grams;
}

/** Two fact lines that mostly restate each other (character-bigram overlap of the shorter line). */
function restates(a: string, b: string): boolean {
  const x = bigrams(a);
  const y = bigrams(b);
  const small = x.size <= y.size ? x : y;
  const large = small === x ? y : x;
  if (small.size < 6) return false;
  let shared = 0;
  for (const gram of small) if (large.has(gram)) shared += 1;
  return shared / small.size >= 0.6;
}

/**
 * Judge a dev-diary topic seed (the text built by `diaryUnitsFor`). A seed with no fact lines is not a
 * diary topic and is not judged here (evergreen seeds are curated separately).
 *
 * Held (weak) when the facts carry no story signal, when they read as an advertisement, or when the
 * only story signal sits inside a work report, an "I made it with AI" report or a restated line.
 */
export function assessAiLabTopicInterest(seed: string): AiLabTopicInterest {
  const lines = [...seed.matchAll(FACT_LINE)].map(([, , value]) => value);
  const empty = { FAILURE_OR_SNAG: [], SURPRISE: [], INGENUITY: [], CONCRETE_DETAIL: [], READER_SCENE: [] };
  if (lines.length === 0) {
    return { postable: true, tier: "medium", signals: [], weaknesses: [], evidence: empty, summary: "日記の題材ではない（判定対象外）" };
  }
  const all = lines.join("\n");
  const evidence = {
    FAILURE_OR_SNAG: matches(FAILURE_OR_SNAG, all),
    SURPRISE: matches(SURPRISE, all),
    INGENUITY: matches(INGENUITY, all),
    CONCRETE_DETAIL: matches(CONCRETE_DETAIL, all),
    READER_SCENE: matches(READER_SCENE, all),
  };
  const signals = (["FAILURE_OR_SNAG", "SURPRISE", "INGENUITY"] as const).filter((s) => evidence[s].length > 0);

  const weaknesses: AiLabTopicInterestWeakness[] = [];
  if (signals.length === 0) weaknesses.push("NO_STORY");
  if (PROMOTIONAL.test(all)) weaknesses.push("PROMOTIONAL");
  if (AI_MADE.test(all)) weaknesses.push("AI_MADE_REPORT");
  if ((all.match(REPORT_TONE) ?? []).length >= 2) weaknesses.push("REPORT_TONE");
  if (lines.some((a, i) => lines.slice(i + 1).some((b) => restates(a, b)))) weaknesses.push("REPEATED_STRUCTURE");

  // A story signal can carry a report-like or repetitive topic only when there is more than one.
  const held = signals.length === 0 || weaknesses.includes("PROMOTIONAL") ||
    (signals.length === 1 && weaknesses.length > 0);
  const tier = held
    ? "weak"
    : signals.length >= 2 && (evidence.CONCRETE_DETAIL.length > 0 || evidence.READER_SCENE.length > 0)
    ? "high"
    : "medium";
  const shown = (s: AiLabTopicInterestSignal) => `${SIGNAL_LABEL[s]}「${evidence[s].slice(0, 2).join("」「")}」`;
  const summary = held
    ? `保留: ${weaknesses.map((w) => WEAKNESS_LABEL[w]).join("・")}` +
      (signals.length && !weaknesses.includes("PROMOTIONAL") ? `（${signals.map(shown).join("、")}だけでは足りない）` : "")
    : `採用(${tier === "high" ? "高" : "中"}): ${signals.map(shown).join("、")}` +
      (weaknesses.length ? `／注意: ${weaknesses.map((w) => WEAKNESS_LABEL[w]).join("・")}` : "");
  return { postable: !held, tier, signals, weaknesses, evidence, summary };
}
