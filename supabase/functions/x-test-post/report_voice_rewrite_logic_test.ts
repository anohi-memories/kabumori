import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCloseReportVoiceRewriteRequestBody,
  buildMorningReportVoiceRewriteRequestBody,
  morningReportVoiceRewritePreservesFacts,
  morningReportVoiceRewriteSafetyIssues,
  parseMorningReportVoiceRewriteOutputText,
} from "./report_voice_rewrite_logic.ts";

test("the rewrite request forbids new facts/numbers/dates/proper nouns and preserves the fixed structure", () => {
  const body = buildMorningReportVoiceRewriteRequestBody("元の本文です。", ["気になるところですが不自然と判定されました"]);
  const instructions = String((body as { instructions: string }).instructions);
  assert.match(instructions, /新しい事実、数値、日時、固有名詞、因果関係を追加してはいけません/u);
  assert.match(instructions, /URL、ハッシュタグは追加しません/u);
  assert.match(instructions, /実在した個人の経験・保有・売買・損益・感情を新たに作りません/u);
  assert.match(instructions, /【朝刊】きょうの日本株、ここをチェック☀️/u);
  const input = JSON.parse((body as { input: string }).input);
  assert.equal(input.original_text, "元の本文です。");
  assert.deepEqual(input.voice_notes, ["気になるところですが不自然と判定されました"]);
});

test("parseMorningReportVoiceRewriteOutputText extracts the single output_text JSON payload", () => {
  const raw = {
    output: [{ content: [{ type: "output_text", text: JSON.stringify({ text: "書き直した本文です。" }) }] }],
  };
  assert.equal(parseMorningReportVoiceRewriteOutputText(raw), "書き直した本文です。");
});

test("parseMorningReportVoiceRewriteOutputText returns null on malformed or empty output", () => {
  assert.equal(parseMorningReportVoiceRewriteOutputText(null), null);
  assert.equal(parseMorningReportVoiceRewriteOutputText({}), null);
  assert.equal(parseMorningReportVoiceRewriteOutputText({ output: [] }), null);
  assert.equal(
    parseMorningReportVoiceRewriteOutputText({ output: [{ content: [{ type: "output_text", text: "not json" }] }] }),
    null,
  );
  assert.equal(
    parseMorningReportVoiceRewriteOutputText({
      output: [{ content: [{ type: "output_text", text: JSON.stringify({ text: "  " }) }] }],
    }),
    null,
  );
});

test("morningReportVoiceRewritePreservesFacts accepts a rewrite reusing only numbers already in the original", () => {
  const original = "日経平均は前日比300円高で推移しています。米国の半導体株が5%上昇しました。";
  const rewritten = "日経平均は前日比300円高で推移しています。米国の半導体株の強さが続くか注目したいところです。5%の上昇を見せた場面もありました。";
  assert.equal(morningReportVoiceRewritePreservesFacts(original, rewritten), true);
});

test("morningReportVoiceRewritePreservesFacts rejects a rewrite that introduces a new number", () => {
  const original = "日経平均は前日比300円高で推移しています。";
  const rewritten = "日経平均は前日比450円高で推移しています。";
  assert.equal(morningReportVoiceRewritePreservesFacts(original, rewritten), false);
});

test("morningReportVoiceRewritePreservesFacts rejects a rewrite that adds a brand-new date/number not present before", () => {
  const original = "米国市場は落ち着いた値動きでした。";
  const rewritten = "米国市場は9月8日に大きく動く見込みです。";
  assert.equal(morningReportVoiceRewritePreservesFacts(original, rewritten), false);
});

test("morningReportVoiceRewriteSafetyIssues flags URLs, hashtags, investment advice, and fabricated experience", () => {
  assert.deepEqual(morningReportVoiceRewriteSafetyIssues("普通の本文です。"), []);
  assert.deepEqual(morningReportVoiceRewriteSafetyIssues("詳しくはこちら https://example.com"), ["URL_OR_HASHTAG_DETECTED"]);
  assert.deepEqual(morningReportVoiceRewriteSafetyIssues("本文の最後 #日本株"), ["URL_OR_HASHTAG_DETECTED"]);
  assert.deepEqual(morningReportVoiceRewriteSafetyIssues("今すぐ買うべきです"), ["INVESTMENT_ADVICE_DETECTED"]);
  assert.deepEqual(morningReportVoiceRewriteSafetyIssues("私も今日買いました"), ["FABRICATED_EXPERIENCE_DETECTED"]);
});

test("the close_report rewrite request forbids new facts/numbers/dates/proper nouns and preserves the close_report fixed structure", () => {
  const body = buildCloseReportVoiceRewriteRequestBody("元の本文です。", ["気になるところですが不自然と判定されました"]);
  const instructions = String((body as { instructions: string }).instructions);
  assert.match(instructions, /新しい事実、数値、日時、固有名詞、因果関係を追加してはいけません/u);
  assert.match(instructions, /URL、ハッシュタグは追加しません/u);
  assert.match(instructions, /実在した個人の経験・保有・売買・損益・感情を新たに作りません/u);
  assert.match(instructions, /【大引け】きょうの日本株まとめ🌙/u);
  assert.match(instructions, /🔎 強かった・弱かったテーマ/u);
  assert.match(instructions, /👀 明日への注目点/u);
  // Confirms this is genuinely the close_report-specific builder, not a copy-paste of the morning one.
  assert.doesNotMatch(instructions, /【朝刊】きょうの日本株、ここをチェック☀️/u);
  const input = JSON.parse((body as { input: string }).input);
  assert.equal(input.original_text, "元の本文です。");
  assert.deepEqual(input.voice_notes, ["気になるところですが不自然と判定されました"]);
});

test("close_report and morning_report rewrite requests use distinct json_schema names so responses never cross-contaminate", () => {
  const morning = buildMorningReportVoiceRewriteRequestBody("本文", []);
  const close = buildCloseReportVoiceRewriteRequestBody("本文", []);
  const schemaName = (body: Record<string, unknown>): unknown =>
    ((body.text as { format?: { name?: unknown } }).format ?? {}).name;
  assert.equal(schemaName(morning), "morning_report_voice_rewrite");
  assert.equal(schemaName(close), "close_report_voice_rewrite");
});
