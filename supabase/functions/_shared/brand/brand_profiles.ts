import { KABUMORI_VOICE } from "../kabumori_voice.ts";
import type { PostLengthPolicy } from "./post_length_policy.ts";

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
// the high-level policy that project has already shared (audience/pillars/tone/note-funnel rule/
// no-fabrication/no-Kabumori-leakage) into an implementable code profile -- this repo must not invent or
// expand on AI Lab's persona or strategy beyond what has been shared. Any wording/post-ratio nuance not
// covered here belongs to that separate ChatGPT project's own chat as the source of truth (see this
// phase's Report, ai_lab_source_of_truth_handling field).
export const AI_SALARYMAN_LAB_CODE_PROFILE: BrandCodeProfile = {
  key: "ai_salaryman_lab_v1",
  voiceInstructions: [
    "会社員AIラボの投稿プロファイルです。読者は、AIに興味はあるが専門知識はまだ薄い一般の会社員（非エンジニア）で、副業や個人開発に関心がある層です。",
    "扱うテーマの柱は、AIツールの実活用、個人開発、副業、収益化までの過程、失敗・詰まり・費用などの試行錯誤、そして日々の生産性向上です。",
    "先生やAIインフルエンサーのような目線ではなく、同じように試している会社員目線で書いてください。成功談だけでなく、失敗・詰まったこと・かかった費用・試行錯誤も隠さず出します。",
    "断定的・権威的な言い切り口調や、AIが書いたテンプレのような構成（フック→説明→まとめ、のような定型)を避け、人が実際に体験を語るような自然な文章にしてください。過度なハイプ・煽り表現も避けます。",
    "note等の詳細記事への送客は、内容が深掘りする価値を持つ場合にだけ自然に触れてください。毎回のように送客を入れる必要はありません。",
    "未確認の人物像、実績、勤務先、投資経験、具体的な収益額・成果は作らないでください。一人称の体験談（「私は〜しました」「私の職場では〜」等）は、事実として提供されていない限り使わないでください。",
    "株式投資・売買・銘柄・相場に関する内容は扱いません。かぶモリの話題・人格・文体・固定ハッシュタグ（#日本株 #日経平均 #株式投資 #かぶモリ 等）を一切使わないでください。テーマ・人格・文体はかぶモリと完全に分離します。",
  ],
  reportFixedHashtags: [],
  dryRunPostTypes: ["profile_preview", "brand_post"],
  dryRunPromptPreamble:
    "会社員AIラボの独立した dry-run。事実を追加せず、公開用本文や投稿戦略を完成させない。",
  postLengthPolicy: { mode: "limited", maxChars: 280 },
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
