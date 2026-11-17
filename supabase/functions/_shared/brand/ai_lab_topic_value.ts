// Task39: whether a dev-diary topic is worth a post at all.
//
// The user rejected the Task38 real post about 2026-09-30 not only for its voice
// but because the topic itself was weak: an internal work report (運用・進捗),
// account details a reader cannot follow (X認証・既存の接続), and a check that
// simply finished. This judgement is shared by both providers and runs before
// any provider call. It never invents value: a weak topic is held, not padded.
//
// The rule is a small, documented heuristic over the topic's fact lines only
// (できごと / 詰まったこと / 決めたこと; never the 切り口 line). It does not
// prove a topic interesting; it only keeps the clearly weak ones out.

/** Something a reader can see or touch: a screen, a button, a text, a chart. */
const READER_VISIBLE =
  /画面|表示|ボタン|見た目|押し|押下|押せ|タップ|色|イラスト|グラフ|文字|タイトル|改行|見出し|要約|読める|読みやす|読みづら|読みにく|読みたく|見づら|見え|一目|通知|写真|画像|カード|リンク|メッセージ|入力|使いやす|使いづら|迷わ|迷っ/gu;
/** Vocabulary of an internal work report that outsiders cannot picture. */
const INTERNAL_PROCESS =
  /運用|進捗|共有メモ|下調べ|テスト用|本番|環境|設定|連携|土台|仕組み|処理|正本|直書き|ファイル|競合テスト|同時実行|判定|実データ|整えた|進め/gu;
/** Account and credential specifics that only make sense inside the project. */
const OPAQUE_ACCOUNT =
  /認証|既存の接続|接続と重な|OAuth|トークン|鍵|権限|担当者か/gu;
/** A check that merely ran or finished. */
const CONFIRMATION =
  /(?:確認|点検|検証|テスト)(?:を進め|した|を終え|が終わ|まで(?:し|行っ))/u;

const FACT_LINE = /^[ \t]*(できごと|詰まったこと|決めたこと)[:：][ \t]*(.+)$/gmu;

export type AiLabTopicValueReason =
  | "NO_READER_VISIBLE_EVENT"
  | "INTERNAL_WORK_REPORT"
  | "OPAQUE_ACCOUNT_DETAIL"
  | "CONFIRMATION_ONLY";

export type AiLabTopicValue =
  | { readonly postable: true; readonly reasons: readonly [] }
  | { readonly postable: false; readonly reasons: readonly AiLabTopicValueReason[] };

export const AI_LAB_TOPIC_VALUE_HELD = "AI_LAB_TOPIC_VALUE_HELD";

/**
 * Judge a dev-diary topic seed (the text built by `diaryUnitsFor`). A seed with
 * no fact lines is not a diary topic and is not judged here (evergreen seeds are
 * curated separately).
 *
 * Held when nothing in the facts is reader-visible and the facts are an internal
 * report or project-only account detail, or when the event is only a finished
 * check with nothing that went wrong and nothing decided.
 */
export function assessAiLabTopicValue(seed: string): AiLabTopicValue {
  const facts = new Map<string, string>();
  for (const [, label, value] of seed.matchAll(FACT_LINE)) facts.set(label, value);
  if (facts.size === 0) return { postable: true, reasons: [] };
  const all = [...facts.values()].join("\n");
  const count = (pattern: RegExp) => all.match(pattern)?.length ?? 0;
  const reasons: AiLabTopicValueReason[] = [];
  if (count(READER_VISIBLE) === 0) {
    const internal = count(INTERNAL_PROCESS) >= 2;
    const opaque = count(OPAQUE_ACCOUNT) >= 1;
    if (internal || opaque) {
      reasons.push("NO_READER_VISIBLE_EVENT");
      if (internal) reasons.push("INTERNAL_WORK_REPORT");
      if (opaque) reasons.push("OPAQUE_ACCOUNT_DETAIL");
    }
  }
  const changed = facts.get("できごと") ?? "";
  if (
    CONFIRMATION.test(changed) && !facts.has("詰まったこと") && !facts.has("決めたこと")
  ) reasons.push("CONFIRMATION_ONLY");
  return reasons.length ? { postable: false, reasons } : { postable: true, reasons: [] };
}
