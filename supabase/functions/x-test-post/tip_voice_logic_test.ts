import assert from "node:assert/strict";
import test from "node:test";
import {
  TIP_VOICE_RULES,
  tipGenerationRules,
  tipVoiceEvaluationRules,
} from "./tip_voice_logic.ts";

const combinedRules = (difficulty: "初級" | "中級" | "実践") =>
  [...TIP_VOICE_RULES, ...tipGenerationRules(difficulty)].join("\n");

test("all difficulty levels enforce one post and one central point", () => {
  for (const difficulty of ["初級", "中級", "実践"] as const) {
    assert.match(combinedRules(difficulty), /1投稿1ポイント/);
    assert.match(combinedRules(difficulty), /postsは1件/);
  }
});

test("tip rules suppress routine summaries", () => {
  assert.match(TIP_VOICE_RULES.join("\n"), /まとめ文を毎回付けず/);
  assert.match(TIP_VOICE_RULES.join("\n"), /整理しやすいです/);
});

test("tip rules suppress unnecessary exception lists", () => {
  assert.match(TIP_VOICE_RULES.join("\n"), /意味を誤解する場合だけ/);
  assert.match(combinedRules("中級"), /全部を順番に解説しません/);
});

test("fabricated investment experience remains forbidden", () => {
  assert.match(TIP_VOICE_RULES.join("\n"), /実体験、保有、売買、利益、損失を作りません/);
  assert.match(tipVoiceEvaluationRules("tip").join("\n"), /本人の投資行動/);
});

test("short complete posts are explicitly allowed", () => {
  assert.match(combinedRules("初級"), /100文字未満も許可/);
  assert.match(tipVoiceEvaluationRules("tip").join("\n"), /文字数や絵文字数だけ/);
});

test("tip-only evaluation rules do not affect other post types", () => {
  for (const postType of ["interaction", "useful_tip", "morning_report", "close_report", "us_premarket_report", "breaking_news"]) {
    assert.deepEqual(tipVoiceEvaluationRules(postType), []);
  }
  assert.notDeepEqual(tipVoiceEvaluationRules("tip"), []);
});
