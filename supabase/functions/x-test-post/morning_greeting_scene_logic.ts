// Deterministic, date-seeded scene rotation for morning_greeting's daily image. Root cause of the
// 2026-09-02〜09-08 convergence (window + houseplant + mug + front-facing upper body, every day): the
// weekday/generic theme branches in morning_greeting_logic.ts fed the exact same fixed Japanese string
// into the image prompt's "Scene/backdrop and props" field every single day — the only per-day input the
// image model had was the canonical reference photo itself, which never changes by design (identity
// preservation).
//
// This module has no DB/history dependency at all (no migration needed): buildMorningGreetingScenePlan()
// is a pure function of the JST calendar date. Each axis rotates through a fixed-order candidate list
// indexed by (daysSinceEpoch + a per-axis offset) mod candidateCount. Every axis list below has at least 7
// entries, so any 7-consecutive-day window sees each candidate at most once — a strictly stronger
// guarantee than "no repeat within the last 7 days," and "no two consecutive days share a value" falls out
// automatically for any list with 2+ entries. Distinct per-axis offsets keep axes from all rotating in
// lockstep with each other.

export type MorningGreetingScenePlan = {
  location: string;
  activity: string;
  camera_angle: string;
  framing: string;
  prop: string;
  expression: string;
  outfit: string;
  weather_lighting: string;
  seasonal_element: string;
};

export function daysSinceEpoch(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (!match) throw new Error("MORNING_GREETING_SCENE_DATE_INVALID");
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (
    parsed.getUTCFullYear() !== Number(match[1]) ||
    parsed.getUTCMonth() !== Number(match[2]) - 1 ||
    parsed.getUTCDate() !== Number(match[3])
  ) {
    throw new Error("MORNING_GREETING_SCENE_DATE_INVALID");
  }
  return Math.floor(parsed.getTime() / 86_400_000);
}

function pickRotating<T>(candidates: readonly T[], dayIndex: number, axisOffset: number): T {
  const index = (((dayIndex + axisOffset) % candidates.length) + candidates.length) % candidates.length;
  return candidates[index];
}

const LOCATIONS = [
  "ベランダ", "住宅街の朝の道", "近所の公園", "玄関", "リビングの窓際", "キッチン", "洗面所の鏡の前",
] as const;

const ACTIVITIES = [
  "朝日を浴びて伸びをする", "朝散歩をする", "靴を履いて出かける準備をする", "カーテンを開ける",
  "朝食を作る", "植物に水やりをする", "軽くストレッチをする", "洗濯物を干す", "読書をする",
] as const;

const CAMERA_ANGLES = [
  "正面", "やや斜め45度", "横顔中心のプロフィール", "少し高い位置からの見下ろし",
  "少し低い位置からの見上げ", "背後から振り返る構図", "手元にフォーカスした構図",
  "斜め後ろから覗き込むような構図",
] as const;

// Deliberately given a different length than the other axes (10, not 7): if every axis cycled with the
// same period, the *combined* 9-axis scene would repeat exactly every 7 days (day N and day N+7 would be
// pixel-for-pixel identical), which technically satisfies "no repeat within a 7-day window" but still
// feels repetitive week over week. Giving several axes distinct, largely coprime lengths (7/8/9/10/11/13
// across the axes below) pushes the combined cycle's true period out to their LCM — hundreds of years —
// while each individual axis on its own still trivially satisfies the 7-day non-repeat requirement.
const FRAMINGS = [
  "上半身バストアップ", "腰から上のミディアムショット", "全身が入るワイドショット",
  "手元と表情を含む近距離ショット", "背景を広く見せる引きの構図", "窓枠や玄関枠を活かしたフレーミング",
  "斜め構図で奥行きを出したショット", "縦長を活かした構図", "中央に人物を大きく配置した構図",
  "余白を活かしたミニマルな構図",
] as const;

const PROPS = [
  "マグカップ", "水差しとコップ", "折りたたみ傘", "トートバッグ", "じょうろ", "本",
  "マフラーやストール",
] as const;

const EXPRESSIONS = [
  "やわらかい笑顔", "目を細めた自然な笑顔", "ちょっと照れたような微笑み", "リラックスした穏やかな表情",
  "少し驚いたような明るい表情", "静かに微笑む横顔", "口角がふっと上がる自然な表情",
  "楽しそうにくすっと笑う表情", "少し眠たそうな柔らかい表情", "興味津々な表情", "晴れやかな笑顔",
] as const;

const OUTFITS = [
  "ベージュ系ニット", "淡いブルー系シャツ", "白系カットソー", "くすみピンク系カーディガン",
  "グレー系パーカー", "グリーン系ワンピース", "ラベンダー系トップス",
] as const;

const WEATHER_LIGHTING = [
  "晴れた朝の柔らかい光", "少し曇った落ち着いた朝の光", "雨上がりの澄んだ空気感", "朝もやのやわらかい光",
  "澄み切った朝の光", "やわらかく差し込む逆光", "淡い朝焼けの光", "曇り空越しの均一な光",
  "朝日が斜めに差し込む光",
] as const;

type SeasonBucket = "spring" | "summer" | "autumn" | "winter";

function seasonBucketForMonth(month: number): SeasonBucket {
  if (month >= 3 && month <= 5) return "spring";
  if (month >= 6 && month <= 8) return "summer";
  if (month >= 9 && month <= 11) return "autumn";
  return "winter";
}

const SEASONAL_ELEMENTS: Readonly<Record<SeasonBucket, readonly string[]>> = {
  spring: [
    "やわらかな新緑", "咲き始めた花", "軽やかな春の風", "淡い春の光", "つぼみのふくらむ枝",
    "春らしい薄手の羽織り", "花びらが一枚舞う様子",
  ],
  summer: [
    "青々とした緑", "涼しげな風鈴", "麦わら帽子", "冷たい麦茶", "うちわ", "夏らしい強い朝日",
    "涼しげな氷入りのグラス",
  ],
  autumn: [
    "色づき始めた葉", "金木犀の香りを感じる仕草", "秋らしい薄手の上着", "実りの季節を感じる果物",
    "澄んだ秋の空気", "紅葉した葉が一枚舞う様子", "温かみのある秋色の小物",
  ],
  winter: [
    "白い息", "温かいマフラー", "湯気の立つ飲み物", "冬の澄んだ朝の光", "手袋", "こたつやひざ掛け",
    "静かな雪の気配",
  ],
};

// Small, mutually distinct prime-ish offsets so axes don't all shift together on the same days even
// though they share the same underlying day index.
const AXIS_OFFSETS = {
  location: 0, activity: 3, cameraAngle: 5, framing: 7, prop: 11,
  expression: 13, outfit: 17, weatherLighting: 19, seasonalElement: 2,
} as const;

export function buildMorningGreetingScenePlan(date: string): MorningGreetingScenePlan {
  const dayIndex = daysSinceEpoch(date);
  const month = Number(/^\d{4}-(\d{2})-\d{2}$/u.exec(date)?.[1]);
  const seasonalCandidates = SEASONAL_ELEMENTS[seasonBucketForMonth(month)];
  return {
    location: pickRotating(LOCATIONS, dayIndex, AXIS_OFFSETS.location),
    activity: pickRotating(ACTIVITIES, dayIndex, AXIS_OFFSETS.activity),
    camera_angle: pickRotating(CAMERA_ANGLES, dayIndex, AXIS_OFFSETS.cameraAngle),
    framing: pickRotating(FRAMINGS, dayIndex, AXIS_OFFSETS.framing),
    prop: pickRotating(PROPS, dayIndex, AXIS_OFFSETS.prop),
    expression: pickRotating(EXPRESSIONS, dayIndex, AXIS_OFFSETS.expression),
    outfit: pickRotating(OUTFITS, dayIndex, AXIS_OFFSETS.outfit),
    weather_lighting: pickRotating(WEATHER_LIGHTING, dayIndex, AXIS_OFFSETS.weatherLighting),
    seasonal_element: pickRotating(seasonalCandidates, dayIndex, AXIS_OFFSETS.seasonalElement),
  };
}

// Weekday/generic days (no memorial or seasonal-event theme): every axis is free to rotate, since there
// is no fixed thematic anchor to preserve.
export function renderFullScenePlanVisualTheme(plan: MorningGreetingScenePlan): string {
  return [
    `${plan.location}で${plan.activity}場面`,
    `${plan.camera_angle}からの${plan.framing}`,
    plan.prop,
    plan.expression,
    plan.outfit,
    plan.weather_lighting,
    plan.seasonal_element,
  ].join("、");
}

// Special-day/seasonal-event days: the theme's own visualTheme text (props, setting, motifs specific to
// that occasion — e.g. "しめ飾り、湯気の立つお茶" for New Year) is a fixed anchor that must not be
// replaced, so only the day-varying *composition* axes (activity, camera framing, expression) are layered
// on top of it. Location/prop/season are left to the anchor text since it already encodes them.
export function renderThemeSyncedVisualTheme(anchorVisualTheme: string, plan: MorningGreetingScenePlan): string {
  return [
    anchorVisualTheme,
    `${plan.activity}場面`,
    `${plan.camera_angle}からの${plan.framing}`,
    plan.expression,
  ].join("、");
}
