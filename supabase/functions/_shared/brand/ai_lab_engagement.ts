import { BrandContextError } from "./brand_context.ts";
import { generateBrandPost } from "./brand_post_generator.ts";
import { aiLabDiversityInstructions } from "./ai_lab_theme_guard.ts";
import { postCharacterCount } from "./post_length_policy.ts";
import {
  type AiLabEngagementDraft,
  AiLabEngagementGenerationError,
  type AiLabEngagementMode,
} from "./ai_lab_engagement_guard.ts";

export type { AiLabEngagementMode } from "./ai_lab_engagement_guard.ts";

const POLL_OUTPUT_SCHEMA = {
  name: "ai_lab_native_poll",
  schema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description:
          "短い質問本文。選択肢は含めず、ハッシュタグ込み最大120文字・空行込み4行以内。",
      },
      poll_options: {
        type: "array",
        items: { type: "string" },
        description: "投票ボタンのラベル。2〜4個、各1〜25文字、重複なし。",
      },
    },
    required: ["text", "poll_options"],
    additionalProperties: false,
  },
};

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
  if (mode === "regular") {
    return [
      "通常投稿は一つの具体的な話題と気づき一つに絞り、200〜300文字程度を目安に自然に書いてください。必要な具体的事実が多い場合は長くてもかまいません。同じ結論を言い換えて繰り返したり、一般論の説明を重ねたり、毎回きれいな教訓で締めたりしないでください。",
      "本人の非エンジニア属性やAIを使っている前提を毎回説明し直す必要はありません。提供された出来事・判断を中心にし、未提供の体験・最近の考えの変化・習慣・近況を補わないでください。具体的事実がない題材では、本人の開発日記を作らず題材に対する短い観察に留めてください。",
    ];
  }
  const format = {
    experience:
      "今回は、読者自身の経験や工夫を気軽に聞ける質問形式にしてください。専門知識がなくても、一言や短い経験談で返せる具体的な問いを1つに絞ってください。",
    opinion:
      "今回は、読者の考えや好みを聞く意見募集の形式にしてください。正解当てや専門知識のテストにせず、何について意見を聞きたいかが伝わる具体的な問いを1つに絞ってください。",
    choices:
      "今回はXの投票機能を使います。textには短い問いだけを書き、poll_optionsにはタップして回答できる2〜4個の選択肢を別々に入れてください。各選択肢は25文字以内・重複なし。本文にA/B/Cや選択肢の一覧を書かないでください。投票期間は24時間です。",
  }[mode];
  return [
    "この投稿は読者と交流する枠です。与えられた題材を保ち、最初から読者が自分の経験や考えを話せる構成にしてください。自分語りの末尾に「皆さんはどうですか？」だけを機械的に足す形にはしないでください。",
    format,
    "交流枠だけは短さを優先します。本文は60〜100文字を目安にし、ハッシュタグ込みで最大120文字、空行も含め4行以内にしてください。前置き・自分語り・背景説明を削り、短い問いがすぐ見える文章にします。通常投稿の文字数無制限方針より、この交流枠の短さの指定を優先してください。",
    "同じように試している一人の会社員として自然に呼びかけ、回答・いいね・拡散を強要したり、反応を煽ったりしないでください。問いのために本人の体験・進捗・失敗・実績を作らず、未提供の事実や悩みを本人のものとして断定しないでください。既存の人格・題材・ハッシュタグ方針は維持してください。",
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
  const mode = aiLabEngagementMode(rotationIndex);
  const engagement = engagementInstructions(mode);
  return ({ retryViolations, ...args }: ScheduledGenerationArgs) => {
    if (args.context.brand.id !== "ai_salaryman_lab") {
      throw new BrandContextError("AI_LAB_ENGAGEMENT_BRAND_MISMATCH");
    }
    const pending = generate({
      ...args,
      ...(mode === "choices" ? { outputSchema: POLL_OUTPUT_SCHEMA } : {}),
      extraInstructions: [
        ...aiLabDiversityInstructions(retryViolations),
        ...engagement,
        ...(retryViolations.some((code) => /^(ENGAGEMENT_|POLL_)/u.test(code))
          ? [
            "直前の案は長さ・行数または投票形式が不適切でした。本文120文字・空行込み4行以内、選択肢はpoll_optionsに2〜4個・各25文字以内・重複なしで、指定形式を守って書き直してください。",
          ]
          : []),
      ],
    });
    if (mode === "regular") return pending;
    return pending.then((draft): AiLabEngagementDraft => {
      if (mode !== "choices") return { ...draft, engagementMode: mode };
      let parsed: unknown;
      try {
        parsed = JSON.parse(draft.text);
      } catch {
        throw new AiLabEngagementGenerationError();
      }
      if (
        typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
      ) throw new AiLabEngagementGenerationError();
      const poll = parsed as Record<string, unknown>;
      if (
        Object.keys(poll).length !== 2 || typeof poll.text !== "string" ||
        !poll.text.trim() ||
        !Array.isArray(poll.poll_options) || poll.poll_options.some((option) =>
          typeof option !== "string"
        )
      ) {
        throw new AiLabEngagementGenerationError();
      }
      const text = poll.text.trim();
      return {
        ...draft,
        text,
        characterCount: postCharacterCount(text),
        engagementMode: mode,
        pollOptions: poll.poll_options,
      };
    });
  };
}
