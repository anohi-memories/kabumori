import assert from "node:assert/strict";
import test from "node:test";
import { AI_SALARYMAN_LAB_CODE_PROFILE, KABUMORI_CODE_PROFILE } from "./brand_profiles.ts";
import { SOCIAL_MOBILE_USER_CODE_PROFILE, resolveBrandCodeProfile } from "./brand_profiles.ts";

const aiLabInstructions = AI_SALARYMAN_LAB_CODE_PROFILE.voiceInstructions.join("\n");

test("AI Lab profile reflects the diary-shift identity: non-engineer, development diary over AI tool tips", () => {
  assert.match(aiLabInstructions, /非エンジニア会社員/u, "identity: non-engineer office worker author");
  assert.match(aiLabInstructions, /複数のAIをチームのように使って個人開発/u, "identity: multiple AIs as a team, doing indie development");
  assert.match(aiLabInstructions, /会社員（非エンジニア）/u, "audience: non-engineer office workers");
  assert.match(aiLabInstructions, /個人開発や副業に関心がある層/u, "audience: side-business / indie-dev curious");
  assert.match(aiLabInstructions, /AIは開発を進めるための手段であり、投稿の主役ではありません/u, "AI is a means, not the topic of every post");
  assert.match(aiLabInstructions, /毎回ツールの使い方を説明する投稿/u, "avoid: AI-tool-tip framing every time");
});

test("AI Lab profile lists the diary content pillars and the roughly 70/30 recent-progress/evergreen balance", () => {
  for (const pillar of [
    "今日やった開発・修正・検証",
    "バグや手戻りのリアル",
    "仕様を決めた・変えた理由",
    "本業と個人開発の両立",
    "小さく進める習慣",
    "非エンジニア視点で感じたこと",
    "複数AIの役割分担",
    "失敗・詰まり・やり直し",
    "リリースまでの過程",
  ]) {
    assert.ok(aiLabInstructions.includes(pillar), `expected content pillar: ${pillar}`);
  }
  assert.match(aiLabInstructions, /だいたい7割/u, "recent-progress diary content is the majority");
  assert.match(aiLabInstructions, /だいたい3割/u, "evergreen reflection is the minority");
});

test("AI Lab profile keeps the fellow-experimenter tone, template-avoidance, hashtag discipline, and note-funnel rule", () => {
  assert.match(aiLabInstructions, /会社員目線/u, "tone: fellow-experimenter, not a teacher/influencer");
  assert.match(aiLabInstructions, /テンプレ/u, "tone: avoid AI-template-sounding phrasing");
  assert.match(aiLabInstructions, /書き出し・文のリズム・長さ・構成を投稿ごとに変えて/u, "vary opening/rhythm/length/structure");
  assert.match(aiLabInstructions, /箇条書きは使ってもかまいませんが、毎回使う必要はありません/u, "bullets optional, not mandatory");
  assert.match(aiLabInstructions, /「#個人開発」のみとし、ハッシュタグを連ねすぎないでください/u, "default hashtag #個人開発, no hashtag stuffing");
  assert.match(
    aiLabInstructions,
    /note等の詳細記事への送客は、内容が深掘りする価値を持つ場合にだけ/u,
    "note-funnel rule: link out only when the content warrants it, not on every post",
  );
});

test("AI Lab profile forbids fabricated personal experience, employer, track record, and earnings claims, and never fabricates a 'today' event without real progress", () => {
  assert.match(aiLabInstructions, /未確認の人物像、実績、勤務先、投資経験、具体的な収益額・成果は作らないでください/u);
  assert.match(aiLabInstructions, /一人称の体験談.*事実として提供されていない限り使わないでください/u);
  assert.match(
    aiLabInstructions,
    /今日の具体的な進捗が与えられていない場合は、体験に基づく普遍的な気づきとして書き、「今日〜した」と断定しないでください/u,
    "no-progress fallback must not fabricate a dated 'today' event",
  );
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
