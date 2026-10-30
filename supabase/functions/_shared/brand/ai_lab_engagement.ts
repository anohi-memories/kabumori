import { BrandContextError } from "./brand_context.ts";
import { generateBrandPost } from "./brand_post_generator.ts";
import { aiLabDiversityInstructions } from "./ai_lab_theme_guard.ts";

export type AiLabEngagementMode =
  | "regular"
  | "experience"
  | "opinion"
  | "choices";

/**
 * Reuse the existing read-only schedule ordinal: three spaced slots per ten, independent of the
 * diary/evergreen topic balance. Skipped/failed slots mean published posts can differ from 30%.
 * Invalid ordinals keep the regular voice instead of manufacturing a new schedule or random choice.
 */
export function aiLabEngagementMode(
  rotationIndex: number,
): AiLabEngagementMode {
  if (!Number.isSafeInteger(rotationIndex) || rotationIndex < 0) {
    return "regular";
  }
  switch (rotationIndex % 10) {
    case 2:
      return "experience";
    case 5:
      return "opinion";
    case 8:
      return "choices";
    default:
      return "regular";
  }
}

function engagementInstructions(mode: AiLabEngagementMode): readonly string[] {
  if (mode === "regular") return [];
  const format = {
    experience:
      "今回は、読者自身の経験や工夫を気軽に聞ける質問形式にしてください。専門知識がなくても、一言や短い経験談で返せる具体的な問いを1つに絞ってください。",
    opinion:
      "今回は、読者の考えや好みを聞く意見募集の形式にしてください。正解当てや専門知識のテストにせず、何について意見を聞きたいかが伝わる具体的な問いを1つに絞ってください。",
    choices:
      "今回は、本文中に2〜4個の短く分かりやすい選択肢を示し、読者が選んで返せる形式にしてください。選択肢だけでも返せて、自由な回答もできる自然な聞き方にします。Xの投票機能を作成した・投票を設置したとは書かないでください。",
  }[mode];
  return [
    "この投稿は読者と交流する枠です。与えられた題材を保ち、最初から読者が自分の経験や考えを話せる構成にしてください。自分語りの末尾に「皆さんはどうですか？」だけを機械的に足す形にはしないでください。",
    format,
    "同じように試している一人の会社員として自然に呼びかけ、回答・いいね・拡散を強要したり、反応を煽ったりしないでください。問いのために本人の体験・進捗・失敗・実績を作らず、未提供の事実や悩みを本人のものとして断定しないでください。既存の人格・題材方針・文字数・ハッシュタグ方針は維持してください。",
  ];
}

type ScheduledGenerationArgs =
  & Pick<
    Parameters<typeof generateBrandPost>[0],
    "openAiApiKey" | "context" | "postType"
  >
  & { topicSeed: string; retryViolations: readonly string[] };

/** Pin the format once for this dispatch, including all content-diversity retries. */
export function createAiLabScheduledPostGenerator(
  rotationIndex: number,
  generate: typeof generateBrandPost = generateBrandPost,
) {
  const engagement = engagementInstructions(aiLabEngagementMode(rotationIndex));
  return ({ retryViolations, ...args }: ScheduledGenerationArgs) => {
    if (args.context.brand.id !== "ai_salaryman_lab") {
      throw new BrandContextError("AI_LAB_ENGAGEMENT_BRAND_MISMATCH");
    }
    return generate({
      ...args,
      extraInstructions: [
        ...aiLabDiversityInstructions(retryViolations),
        ...engagement,
      ],
    });
  };
}
