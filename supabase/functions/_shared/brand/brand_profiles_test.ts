import assert from "node:assert/strict";
import test from "node:test";
import { AI_SALARYMAN_LAB_CODE_PROFILE, KABUMORI_CODE_PROFILE } from "./brand_profiles.ts";
import { SOCIAL_MOBILE_USER_CODE_PROFILE, resolveBrandCodeProfile } from "./brand_profiles.ts";

const aiLabInstructions = AI_SALARYMAN_LAB_CODE_PROFILE.voiceInstructions.join("\n");

test("AI Lab profile reflects the shared brand policy's required elements (audience, pillars, tone, note-funnel rule)", () => {
  assert.match(aiLabInstructions, /会社員（非エンジニア）/u, "audience: non-engineer office workers");
  assert.match(aiLabInstructions, /副業や個人開発/u, "audience: side-business / indie-dev curious");
  assert.match(aiLabInstructions, /AIツールの実活用/u, "pillar: AI tool use");
  assert.match(aiLabInstructions, /個人開発/u, "pillar: indie development");
  assert.match(aiLabInstructions, /副業/u, "pillar: side business");
  assert.match(aiLabInstructions, /収益化までの過程/u, "pillar: monetization journey");
  assert.match(aiLabInstructions, /失敗・詰まり・費用/u, "pillar: failure/friction/cost, not just success stories");
  assert.match(aiLabInstructions, /生産性/u, "pillar: productivity");
  assert.match(aiLabInstructions, /会社員目線/u, "tone: fellow-experimenter, not a teacher/influencer");
  assert.match(aiLabInstructions, /テンプレ/u, "tone: avoid AI-template-sounding phrasing");
  assert.match(
    aiLabInstructions,
    /note等の詳細記事への送客は、内容が深掘りする価値を持つ場合にだけ/u,
    "note-funnel rule: link out only when the content warrants it, not on every post",
  );
});

test("AI Lab profile forbids fabricated personal experience, employer, track record, and earnings claims", () => {
  assert.match(aiLabInstructions, /未確認の人物像、実績、勤務先、投資経験、具体的な収益額・成果は作らないでください/u);
  assert.match(aiLabInstructions, /一人称の体験談.*事実として提供されていない限り使わないでください/u);
});

test("AI Lab profile fully separates from Kabumori: no stock/investment topics, no Kabumori persona/voice/fixed hashtags", () => {
  assert.match(aiLabInstructions, /株式投資・売買・銘柄・相場に関する内容は扱いません/u);
  assert.match(aiLabInstructions, /かぶモリの話題・人格・文体・固定ハッシュタグ/u);
  for (const kabumoriTag of KABUMORI_CODE_PROFILE.reportFixedHashtags) {
    assert.ok(
      aiLabInstructions.includes(kabumoriTag),
      `expected the AI Lab profile to explicitly name Kabumori's fixed hashtag ${kabumoriTag} as forbidden`,
    );
  }
  assert.equal(AI_SALARYMAN_LAB_CODE_PROFILE.reportFixedHashtags.length, 0);
});

test("AI Lab code profile never imports or reuses Kabumori's voice module", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./brand_profiles.ts", import.meta.url), "utf8");
  const aiLabSection = source.slice(source.indexOf("AI_SALARYMAN_LAB_CODE_PROFILE"));
  assert.doesNotMatch(aiLabSection, /KABUMORI_VOICE/u);
});

test("general-user profile is neutral, isolated, and has no fixed hashtags or publishing switch", () => {
  assert.equal(resolveBrandCodeProfile("social_mobile_user_v1"), SOCIAL_MOBILE_USER_CODE_PROFILE);
  assert.deepEqual(SOCIAL_MOBILE_USER_CODE_PROFILE.dryRunPostTypes, ["brand_post"]);
  assert.deepEqual(SOCIAL_MOBILE_USER_CODE_PROFILE.reportFixedHashtags, []);
  assert.equal(SOCIAL_MOBILE_USER_CODE_PROFILE.defaultTopicSeed, "日々の生活や仕事に役立つ小さな工夫");
  const instructions = SOCIAL_MOBILE_USER_CODE_PROFILE.voiceInstructions.join("\n");
  assert.match(instructions, /一人称体験談を書かない/u);
  assert.match(instructions, /特定企業・既存ブランドの人格や固定タグを引き継がない/u);
  assert.doesNotMatch(instructions, /#日本株|#日経平均|#かぶモリ/u);
  assert.equal(resolveBrandCodeProfile("missing_profile"), null);
});
