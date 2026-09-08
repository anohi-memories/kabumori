// Deterministic, date-seeded scene rotation for morning_greeting's daily image. Root cause of the
// 2026-09-02〜09-08 convergence (window + houseplant + mug + front-facing upper body, every day): the
// weekday/generic theme branches in morning_greeting_logic.ts fed the exact same fixed Japanese string
// into the image prompt's "Scene/backdrop and props" field every single day — the only per-day input the
// image model had was the canonical reference photo itself, which never changes by design (identity
// preservation).
//
// This module has no DB/history dependency at all (no migration needed): buildMorningGreetingScenePlan()
// is a pure function of the JST calendar date.
//
// K1 review of the first version of this file (independent rotation of location/activity/prop as three
// separate axes) rightly rejected it: independent axes can land on semantically incoherent combinations
// like "キッチンで洗濯物を干す" (doing laundry in the kitchen) or "洗面所の鏡の前で読書をする" (reading in
// front of the bathroom mirror). location + activity + prop are now a single atomic SCENE_TEMPLATES unit —
// each one hand-written as one plausible, coherent morning scene — so an incoherent combination is
// structurally impossible, not just statistically unlikely. camera_angle / framing / expression / outfit /
// weather_lighting stay independent, because posture, lighting, and clothing don't conflict with any of
// the scene templates below (a "少し低い位置からの見上げ" camera angle or a "淡いブルー系シャツ" outfit
// reads as natural for a park walk, a kitchen breakfast scene, or a balcony stretch alike).
//
// Anti-repeat guarantees: SCENE_TEMPLATES has 8 entries, so a simple (dayIndex + offset) mod 8 rotation
// means the *same template* (hence the same location/activity/prop) never appears on two consecutive
// days, and never repeats within any 7-consecutive-day window (8 >= 7). The remaining independent axes use
// deliberately different list lengths (8/10/11/7/9) so the combined 9-field scene's true repeat period is
// the LCM of all of them rather than a naive weekly cycle — see buildMorningGreetingScenePlan below.

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

export type MorningGreetingSceneTemplate = { location: string; activity: string; prop: string };

// Each entry is one hand-checked, coherent morning scene (location + activity + a prop that plausibly
// belongs to that activity in that location) — matching K1's reference list exactly.
export const MORNING_GREETING_SCENE_TEMPLATES: readonly MorningGreetingSceneTemplate[] = [
  { location: "ベランダ", activity: "軽くストレッチをする", prop: "タオル" },
  { location: "住宅街の朝の道", activity: "朝散歩をする", prop: "トートバッグ" },
  { location: "近所の公園", activity: "散歩の途中で少し伸びをする", prop: "水筒" },
  { location: "玄関", activity: "靴を履いて出かける準備をする", prop: "折りたたみ傘" },
  { location: "キッチン", activity: "朝食を作る", prop: "フライパンや調理器具" },
  { location: "リビングの窓際", activity: "読書をする", prop: "本" },
  { location: "ベランダの物干しスペース", activity: "洗濯物を干す", prop: "洗濯かご" },
  { location: "ベランダの植物の前", activity: "植物に水やりをする", prop: "じょうろ" },
] as const;

const CAMERA_ANGLES = [
  "正面", "やや斜め45度", "横顔中心のプロフィール", "少し高い位置からの見下ろし",
  "少し低い位置からの見上げ", "背後から振り返る構図", "手元にフォーカスした構図",
  "斜め後ろから覗き込むような構図",
] as const;

// Deliberately given a different length than the scene-template axis (10, not 8): if every axis cycled
// with the same period, the *combined* 9-field scene would repeat exactly every 8 days, which technically
// satisfies "no repeat within a 7-day window" but would still feel mechanically repetitive. Giving several
// axes distinct, largely coprime lengths (7/8/9/10/11 across the axes here) pushes the combined cycle's
// true period out to their LCM — tens of thousands of days — while each axis on its own still trivially
// satisfies the 7-day non-repeat requirement.
const FRAMINGS = [
  "上半身バストアップ", "腰から上のミディアムショット", "全身が入るワイドショット",
  "手元と表情を含む近距離ショット", "背景を広く見せる引きの構図", "窓枠や玄関枠を活かしたフレーミング",
  "斜め構図で奥行きを出したショット", "縦長を活かした構図", "中央に人物を大きく配置した構図",
  "余白を活かしたミニマルな構図",
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

// Small, mutually distinct offsets so axes don't all shift together on the same days even though they
// share the same underlying day index.
const AXIS_OFFSETS = {
  sceneTemplate: 0, cameraAngle: 5, framing: 7,
  expression: 13, outfit: 17, weatherLighting: 19, seasonalElement: 2,
} as const;

export function buildMorningGreetingScenePlan(date: string): MorningGreetingScenePlan {
  const dayIndex = daysSinceEpoch(date);
  const month = Number(/^\d{4}-(\d{2})-\d{2}$/u.exec(date)?.[1]);
  const seasonalCandidates = SEASONAL_ELEMENTS[seasonBucketForMonth(month)];
  const template = pickRotating(MORNING_GREETING_SCENE_TEMPLATES, dayIndex, AXIS_OFFSETS.sceneTemplate);
  return {
    location: template.location,
    activity: template.activity,
    prop: template.prop,
    camera_angle: pickRotating(CAMERA_ANGLES, dayIndex, AXIS_OFFSETS.cameraAngle),
    framing: pickRotating(FRAMINGS, dayIndex, AXIS_OFFSETS.framing),
    expression: pickRotating(EXPRESSIONS, dayIndex, AXIS_OFFSETS.expression),
    outfit: pickRotating(OUTFITS, dayIndex, AXIS_OFFSETS.outfit),
    weather_lighting: pickRotating(WEATHER_LIGHTING, dayIndex, AXIS_OFFSETS.weatherLighting),
    seasonal_element: pickRotating(seasonalCandidates, dayIndex, AXIS_OFFSETS.seasonalElement),
  };
}

// Weekday/generic days (no memorial or seasonal-event theme): the scene template (location+activity+prop)
// is used as one coherent unit, with the independently-rotating composition axes layered on top.
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
// that occasion — e.g. "しめ飾り、湯気の立つお茶" for New Year) is a fixed anchor that already describes a
// coherent mini-scene and must not be replaced. Only axes that are universally compatible with any anchor
// — camera framing and expression, never a rotated location/activity/prop that could clash with the
// anchor's own implied setting — are layered on top, so the result never contradicts the anchor.
export function renderThemeSyncedVisualTheme(anchorVisualTheme: string, plan: MorningGreetingScenePlan): string {
  return [
    anchorVisualTheme,
    `${plan.camera_angle}からの${plan.framing}`,
    plan.expression,
  ].join("、");
}
