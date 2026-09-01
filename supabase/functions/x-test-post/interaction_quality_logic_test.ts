import assert from "node:assert/strict";
import test from "node:test";
import {
  isInteractionTopicAllowed,
  resolveJpxTradingDay,
  validateInteractionDraft,
} from "./interaction_quality_logic.ts";

const noHolidays = new Set<string>();

test("a normal JPX weekday remains available for interaction posts", () => {
  const day = resolveJpxTradingDay("2026-08-31T05:00:00.000Z", noHolidays);
  assert.deepEqual(day, { date: "2026-08-31", isTradingDay: true, reason: "weekday" });
  assert.equal(isInteractionTopicAllowed("今日の相場は強気？", "今日の値動きを聞く", day.isTradingDay), true);
  assert.equal(validateInteractionDraft("今日の相場、強気・弱気・様子見のどれに近いですか？📈", day).passed, true);
});

test("Saturday and Sunday are JPX closed days", () => {
  assert.equal(resolveJpxTradingDay("2026-08-29T05:00:00.000Z", noHolidays).reason, "weekend");
  assert.equal(resolveJpxTradingDay("2026-08-30T05:00:00.000Z", noHolidays).reason, "weekend");
});

test("a JPX holiday from the existing calendar is a closed day", () => {
  const day = resolveJpxTradingDay("2026-09-21T05:00:00.000Z", new Set(["2026-09-21"]));
  assert.deepEqual(day, { date: "2026-09-21", isTradingDay: false, reason: "holiday" });
});

test("same-day market topics and generated text are blocked on closed days", () => {
  const day = resolveJpxTradingDay("2026-08-30T05:00:00.000Z", noHolidays);
  assert.equal(isInteractionTopicAllowed("今日の相場はどうだった？", "今日の日経の印象を聞く", false), false);
  assert.deepEqual(
    validateInteractionDraft("今日の値動き、強気・弱気・様子見のどれに近いですか？", day).reasons,
    ["CLOSED_DAY_MARKET_ASSUMPTION"],
  );
  assert.equal(isInteractionTopicAllowed("株を始めたきっかけ", "最初のきっかけを聞く", false), true);
});

test("rephrasing the same topic into multiple main questions is rejected", () => {
  const day = resolveJpxTradingDay("2026-08-31T05:00:00.000Z", noHolidays);
  const result = validateInteractionDraft(
    "今日の相場、強気・弱気・様子見のどれに近いですか？\nどんな材料を軸に相場を見ていますか？",
    day,
  );
  assert.deepEqual(result.reasons, ["MULTIPLE_MAIN_QUESTIONS"]);
});

test("one main question with short option fragments remains valid", () => {
  const day = resolveJpxTradingDay("2026-08-30T05:00:00.000Z", noHolidays);
  const result = validateInteractionDraft(
    "来週の相場、最初にどこ見ます？👀\n日経先物？ 為替？ 米国株？ それとも気になる個別株？",
    day,
  );
  assert.equal(result.passed, true);
});
