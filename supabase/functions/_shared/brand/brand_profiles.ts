import { KABUMORI_VOICE } from "../kabumori_voice.ts";
import { type PostLengthPolicy, UNLIMITED_POST_LENGTH } from "./post_length_policy.ts";

export type BrandCodeProfile = {
  key: string;
  /** Shared, code-owned instructions. They intentionally remain the source of truth for Kabumori. */
  voiceInstructions: readonly string[];
  reportFixedHashtags: readonly string[];
  dryRunPostTypes: readonly string[];
  dryRunPromptPreamble: string;
  /** Optional generic topic used only when a preview caller has no explicit topic. */
  defaultTopicSeed?: string;
  /** Omit to preserve existing behavior; future user settings can provide either generic mode. */
  postLengthPolicy?: PostLengthPolicy;
  /**
   * Default false/omitted (safe default for every existing and future profile): when no
   * operational fixed_hashtags are configured, brand_post_generator.ts tells the model to never
   * add a hashtag. Set true only for a profile whose own voiceInstructions define their own
   * hashtag policy (currently only AI Lab's "#個人開発 as default, no stuffing") -- this is an
   * explicit per-profile opt-in, never a brand-id check inside the generic generator, so every
   * other no-fixed-hashtag profile (e.g. social_mobile_user_v1) keeps its prior no-hashtag
   * behavior unless it opts in the same way.
   */
  voiceControlsHashtags?: boolean;
};

export const KABUMORI_CODE_PROFILE: BrandCodeProfile = {
  key: "kabumori_v1",
  voiceInstructions: KABUMORI_VOICE,
  reportFixedHashtags: ["#日本株", "#日経平均", "#株式投資", "#かぶモリ"],
  dryRunPostTypes: [
    "tip",
    "interaction",
    "useful_tip",
    "morning",
    "market_close",
  ],
  dryRunPromptPreamble: "かぶモリ既存の生成ルールを使う。",
};

// Phase 3A intentionally defined only the minimum identity needed to exercise an isolated dry-run --
// not a finished persona or publishing strategy, and never importing Kabumori's voice, tags, or prompt
// fragments. Phase 3E added "brand_post" so a real (OpenAI-generated) dry-run has something to generate.
//
// Phase 3F: the source of truth for AI Lab's actual content plan, tone, and note funnel strategy lives
// in a separate "会社員AIラボ" ChatGPT project, not in this repository. The instructions below translate
// the high-level policy that project has already shared into an implementable code profile -- this repo
// must not invent or expand on AI Lab's persona or strategy beyond what has been shared. Any
// wording/post-ratio nuance not covered here belongs to that separate ChatGPT project's own chat as the
// source of truth.
//
// Content shift (2026-09-30): the user-approved direction moved the account from "AI tool tips/how-to"
// framing to a first-person individual-development diary, because the tip framing had become repetitive.
// AI is now part of how the diary's author works, not the subject of every post. See
// ai_lab_dev_diary_context.md / ai_lab_dev_diary_context.ts for the mechanism that feeds a concrete,
// sanitized recent-progress angle (or a safe evergreen fallback) into `topicSeed`; the instructions below
// are the persona/tone/safety rules a scheduled AI Lab post always carries, regardless of which topic it
// was given.
export const AI_SALARYMAN_LAB_CODE_PROFILE: BrandCodeProfile = {
  key: "ai_salaryman_lab_v1",
  voiceInstructions: [
    "会社員AIラボの投稿プロファイルです。これは、本業をしながら、コードを書けない非エンジニア会社員が、複数のAIをチームのように使って個人開発を進めている記録です。読者も同じように、AIに興味はあるが専門知識はまだ薄い一般の会社員（非エンジニア）で、個人開発や副業に関心がある層です。",
    "投稿の中心（だいたい7割）は、今日やった開発・修正・検証、バグや手戻りのリアル、仕様を決めた・変えた理由、本業と個人開発の両立、小さく進める習慣など、直近の開発日記的な内容にしてください。",
    "残り（だいたい3割）は、非エンジニア視点で感じたこと、複数AIの役割分担、失敗・詰まり・やり直し、リリースまでの過程など、体験に基づく普遍的な気づき（エバーグリーンな振り返り）にしてください。",
    "AIについて触れてもかまいませんが、AIは開発を進めるための手段であり、投稿の主役ではありません。「AIで○○できます」のようなツール紹介・使い方解説を毎回の型にしないでください。",
    "次のような投稿は避けてください: 毎回ツールの使い方を説明する投稿、汎用的なプロンプトのコツ、同じ構成・同じ結論の連投、成功者を演じるような誇張、エンジニアであるかのような表現、実際にはやっていない作業をやったかのように書くこと。",
    "先生やAIインフルエンサーのような目線ではなく、同じように試している一人の会社員目線で書いてください。成功談だけでなく、失敗・詰まったこと・やり直しも隠さず出します。断定的・権威的な言い切り口調や、AIが書いたテンプレのような構成（フック→説明→まとめ、のような定型)を避け、人が実際に体験を語るような自然な文章にしてください。過度なハイプ・煽り表現も避けます。",
    "書き出し・文のリズム・長さ・構成を投稿ごとに変えてください。箇条書きは使ってもかまいませんが、毎回使う必要はありません。ハッシュタグは基本的に「#個人開発」のみとし、ハッシュタグを連ねすぎないでください。",
    "X Premiumで運用しているため、投稿本文の文字数に上限はありません。140文字や280文字は目標でも上限でもありません。題材が簡潔なら短くてかまいません。背景・具体的な手順・判断の理由などを書くと読み手の役に立つときは、280文字を超えてもかまいません。長くするための水増しや繰り返しはしないでください。",
    "note等の詳細記事への送客は、内容が深掘りする価値を持つ場合にだけ自然に触れてください。毎回のように送客を入れる必要はありません。",
    "未確認の人物像、実績、勤務先、投資経験、具体的な収益額・成果は作らないでください。一人称の体験談（「私は〜しました」「今日は〜した」等）は、事実として提供されていない限り使わないでください。今日の具体的な進捗が与えられていない場合は、体験に基づく普遍的な気づきとして書き、「今日〜した」と断定しないでください。",
    "株式投資・売買・銘柄・相場に関する内容は扱いません。かぶモリの話題・人格・文体・固定ハッシュタグ（#日本株 #日経平均 #株式投資 #かぶモリ 等）を一切使わないでください。テーマ・人格・文体はかぶモリと完全に分離します。",
  ],
  reportFixedHashtags: [],
  dryRunPostTypes: ["profile_preview", "brand_post"],
  dryRunPromptPreamble:
    "会社員AIラボの独立した dry-run。事実を追加せず、公開用本文や投稿戦略を完成させない。",
  // X Premium account (user policy 2026-10-07): no finite ceiling. 140/280 are neither targets nor
  // limits; length follows the topic (see the voice instruction above). characterCount is still
  // measured and reported by the generator and the final dispatch guard.
  postLengthPolicy: UNLIMITED_POST_LENGTH,
  // Explicit opt-in (see BrandCodeProfile.voiceControlsHashtags): only this profile's own
  // "#個人開発 as default, no stuffing" instruction above governs hashtag use when no fixed
  // hashtag is configured. Every other no-fixed-hashtag profile keeps the prior "never add a
  // hashtag" default.
  voiceControlsHashtags: true,
};

/**
 * Neutral profile for user-owned social-mobile workspaces. It is intentionally separate from every
 * existing brand and carries no brand-specific tags, credentials, or publishing permission.
 */
export const SOCIAL_MOBILE_USER_CODE_PROFILE: BrandCodeProfile = {
  key: "social_mobile_user_v1",
  voiceInstructions: [
    "一般ユーザーの独立した投稿プロファイルです。特定企業・既存ブランドの人格や固定タグを引き継がないでください。",
    "自然で親しみやすく、読者に役立つ具体的な内容を優先してください。過度な煽りや断定は避けてください。",
    "確認できない事実、個人の経験・実績、専門資格、成果、数値を捏造しないでください。提供されていない一人称体験談を書かないでください。",
    "危険な助言、保証、誤解を招く主張を避け、必要な前提や不確実性を明確にしてください。",
  ],
  reportFixedHashtags: [],
  dryRunPostTypes: ["brand_post"],
  dryRunPromptPreamble:
    "一般ユーザー向けの安全なプレビュー生成。特定ブランドの人格・タグを推測しない。",
  defaultTopicSeed: "日々の生活や仕事に役立つ小さな工夫",
};

const CODE_PROFILES: ReadonlyMap<string, BrandCodeProfile> = new Map([
  [KABUMORI_CODE_PROFILE.key, KABUMORI_CODE_PROFILE],
  [AI_SALARYMAN_LAB_CODE_PROFILE.key, AI_SALARYMAN_LAB_CODE_PROFILE],
  [SOCIAL_MOBILE_USER_CODE_PROFILE.key, SOCIAL_MOBILE_USER_CODE_PROFILE],
]);

/**
 * A new brand must bring an explicitly reviewed code profile in a later phase.
 * Returning null here is deliberate: callers fail closed rather than inheriting
 * Kabumori's voice, hashtags, or prompts by accident.
 */
export function resolveBrandCodeProfile(key: string): BrandCodeProfile | null {
  return CODE_PROFILES.get(key) ?? null;
}

export function appendProfileReportFixedHashtags(
  profile: BrandCodeProfile,
  text: string,
): string {
  return `${text.trim()}\n\n${profile.reportFixedHashtags.join(" ")}`;
}
