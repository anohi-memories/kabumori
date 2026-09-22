import assert from "node:assert/strict";
import test from "node:test";
import {
  SOCIAL_MOBILE_USER_DEFAULTS,
  isSocialMobileContentSettings,
  isSocialMobilePersonaProfile,
  normalizeSocialMobileContentSettings,
  socialMobileGenerationGuidance,
} from "./social_mobile_content_settings.ts";

test("first-run content and planning defaults are conservative and never enable publishing", () => {
  assert.equal(
    SOCIAL_MOBILE_USER_DEFAULTS.preferredTone,
    "自然で親しみやすく、押しつけない",
  );
  assert.equal(SOCIAL_MOBILE_USER_DEFAULTS.locale, "ja-JP");
  assert.equal(SOCIAL_MOBILE_USER_DEFAULTS.approvalMode, "manual_review");
  assert.equal(SOCIAL_MOBILE_USER_DEFAULTS.livePublishingEnabled, false);
  assert.equal(
    SOCIAL_MOBILE_USER_DEFAULTS.generationWindow.timezone,
    "Asia/Tokyo",
  );
  assert.equal(
    SOCIAL_MOBILE_USER_DEFAULTS.generationWindow.startLocal,
    "09:00",
  );
  assert.equal(SOCIAL_MOBILE_USER_DEFAULTS.generationWindow.endLocal, "24:00");
  assert.equal(
    SOCIAL_MOBILE_USER_DEFAULTS.generationWindow.defaultGenerationLocal,
    "17:00",
  );
  assert.equal(
    SOCIAL_MOBILE_USER_DEFAULTS.generationWindow.generationDayOffset,
    -1,
  );
});

test("generation guidance is bounded and includes only content preferences", () => {
  const guidance = socialMobileGenerationGuidance({
    ...SOCIAL_MOBILE_USER_DEFAULTS,
    preferredTone: "A".repeat(500),
    themes: Array.from(
      { length: 20 },
      (_, index) => `${index}-${"T".repeat(150)}`,
    ),
    optionalNgWords: ["N".repeat(120)],
    notes: "M".repeat(500),
  });
  assert.ok(guidance[0].length < 150);
  assert.ok(
    guidance.find((item) => item.startsWith("扱うテーマ候補:"))!.length < 900,
  );
  assert.ok(
    guidance.find((item) => item.startsWith("避ける語句:"))!.length < 100,
  );
  assert.ok(
    guidance.find((item) => item.startsWith("利用者メモ"))!.length < 400,
  );
  assert.equal(
    guidance.some((item) => /publish|投稿予定を作る|X API/iu.test(item)),
    false,
  );
});

test("persisted settings are validated conservatively and can never enable publishing", () => {
  assert.equal(isSocialMobileContentSettings(SOCIAL_MOBILE_USER_DEFAULTS), true);
  assert.equal(isSocialMobileContentSettings({ ...SOCIAL_MOBILE_USER_DEFAULTS, frequencyTargetPerWeek: 99 }), false);
  assert.equal(isSocialMobileContentSettings({ ...SOCIAL_MOBILE_USER_DEFAULTS, livePublishingEnabled: true }), false);
  assert.equal(normalizeSocialMobileContentSettings({ ...SOCIAL_MOBILE_USER_DEFAULTS, notes: "N".repeat(5000) }).notes, SOCIAL_MOBILE_USER_DEFAULTS.notes);
});

test("persona profile keeps provenance and rejects token/post history payloads", () => {
  assert.equal(isSocialMobilePersonaProfile({ source: "conversation", confirmed: true }), true);
  assert.equal(isSocialMobilePersonaProfile({ source: "past_post_analysis", confirmed: true, sentenceLength: "short" }), true);
  assert.equal(isSocialMobilePersonaProfile({ source: "conversation", confirmed: true, access_token: "secret" }), false);
  assert.equal(isSocialMobilePersonaProfile({ source: "conversation", confirmed: true, posts: ["raw"] }), false);
});
