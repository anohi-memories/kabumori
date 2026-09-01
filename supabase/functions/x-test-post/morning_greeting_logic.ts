import { KABUMORI_VOICE } from "../_shared/kabumori_voice.ts";

export type MorningGreetingThemeType = "special_day" | "seasonal" | "weekday" | "generic";
export type MorningGreetingThemeConfidence = "high" | "medium";

export type MorningGreetingTheme = {
  theme_type: MorningGreetingThemeType;
  theme_name: string | null;
  reason: string;
  confidence: MorningGreetingThemeConfidence;
  visual_theme: string;
};

export type MorningGreetingResult = MorningGreetingTheme & {
  generated_text: string;
  model: "gpt-5.6-luna";
  input_tokens: number;
  output_tokens: number;
};

type MajorThemeDefinition = {
  name: string;
  visualTheme: string;
};

const MODEL = "gpt-5.6-luna" as const;
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const MORNING_GREETING_MIN_CHARACTERS = 100;
export const MORNING_GREETING_MAX_CHARACTERS = 180;

// Deliberately small, stable allowlist. Minor commemorative days never become
// themes merely because a model or search result mentions them.
const FIXED_MAJOR_THEMES: Readonly<Record<string, MajorThemeDefinition>> = {
  "01-01": { name: "元日", visualTheme: "お正月の朝、しめ飾り、湯気の立つお茶、やわらかい初日の光" },
  "02-14": { name: "バレンタインデー", visualTheme: "落ち着いた色のチョコレート、小さなリボン、朝のテーブル" },
  "03-03": { name: "ひな祭り", visualTheme: "桃の花、ひな祭りの小物、春らしい淡い色の朝" },
  "05-05": { name: "こどもの日", visualTheme: "青空を泳ぐこいのぼり、新緑、明るい朝" },
  "07-07": { name: "七夕", visualTheme: "笹飾り、短冊、星のモチーフ、夏の朝" },
  "09-01": { name: "防災の日", visualTheme: "防災リュック、ヘルメット、懐中電灯、防災用品" },
  "10-31": { name: "ハロウィン", visualTheme: "小さなかぼちゃ飾り、秋色の小物、朝の窓辺" },
  "12-25": { name: "クリスマス", visualTheme: "小さなクリスマスツリー、温かい飲み物、冬の朝" },
  "12-31": { name: "大晦日", visualTheme: "年越し前の静かな朝、カレンダー、温かいお茶" },
};

function parseCalendarDate(date: string): { year: number; month: number; day: number; weekday: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (!match) throw new Error("MORNING_GREETING_INVALID_DATE");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const checked = new Date(Date.UTC(year, month - 1, day));
  if (
    checked.getUTCFullYear() !== year ||
    checked.getUTCMonth() !== month - 1 ||
    checked.getUTCDate() !== day
  ) {
    throw new Error("MORNING_GREETING_INVALID_DATE");
  }
  return { year, month, day, weekday: checked.getUTCDay() };
}

function nthWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
  occurrence: number,
): number {
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((weekday - firstWeekday + 7) % 7) + (occurrence - 1) * 7;
}

function majorThemeForDate(date: string): MajorThemeDefinition | null {
  const { year, month, day } = parseCalendarDate(date);
  const fixedKey = `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (FIXED_MAJOR_THEMES[fixedKey]) return FIXED_MAJOR_THEMES[fixedKey];
  if (month === 5 && day === nthWeekdayOfMonth(year, 5, 0, 2)) {
    return { name: "母の日", visualTheme: "カーネーション、小さなメッセージカード、明るい朝のテーブル" };
  }
  if (month === 6 && day === nthWeekdayOfMonth(year, 6, 0, 3)) {
    return { name: "父の日", visualTheme: "落ち着いた色の小物、コーヒー、初夏の朝" };
  }
  if (month === 9 && day === nthWeekdayOfMonth(year, 9, 1, 3)) {
    return { name: "敬老の日", visualTheme: "秋の花、手紙、穏やかな朝の光" };
  }
  return null;
}

export function isVerifiedMajorTheme(date: string, themeName: string): boolean {
  return majorThemeForDate(date)?.name === themeName;
}

function seasonalTheme(month: number, day: number): MajorThemeDefinition | null {
  const key = month * 100 + day;
  if (key >= 320 && key <= 415) {
    return { name: "桜・花見シーズン", visualTheme: "桜の花びら、朝の窓辺、コーヒー、やわらかい春の光" };
  }
  if (key >= 429 && key <= 505) {
    return { name: "ゴールデンウィーク", visualTheme: "新緑、朝の旅行かばん、コーヒー、明るい休日の窓辺" };
  }
  if (key >= 813 && key <= 816) {
    return { name: "お盆", visualTheme: "夏の朝、涼しげな風鈴、落ち着いた和室、やわらかい光" };
  }
  if (key >= 1226 && key <= 1230) {
    return { name: "年末", visualTheme: "年末の朝、カレンダー、片づいた机、温かい飲み物" };
  }
  return null;
}

export function selectMorningGreetingTheme(date: string): MorningGreetingTheme {
  const { year, month, day, weekday } = parseCalendarDate(date);
  const major = majorThemeForDate(date);
  if (major) {
    return {
      theme_type: "special_day",
      theme_name: major.name,
      reason: "一般に広く知られ、日付との対応をコード側の限定リストで確認できるため",
      confidence: "high",
      visual_theme: major.visualTheme,
    };
  }

  const seasonal = seasonalTheme(month, day);
  if (seasonal) {
    return {
      theme_type: "seasonal",
      theme_name: seasonal.name,
      reason: "特定の記念日ではなく、日付から確認できる一般的な季節イベントの期間内であるため",
      confidence: "medium",
      visual_theme: seasonal.visualTheme,
    };
  }

  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const weekdayTheme = day === 1
    ? "月初"
    : day === lastDay
    ? "月末"
    : weekday === 1
    ? "週の始まり"
    : weekday === 5
    ? "金曜日"
    : weekday === 0 || weekday === 6
    ? "週末"
    : null;
  if (weekdayTheme) {
    return {
      theme_type: "weekday",
      theme_name: weekdayTheme,
      reason: "記念日を作らず、カレンダーから直接確認できる日の区切りを使うため",
      confidence: "high",
      visual_theme: "朝の窓辺、コーヒー、観葉植物、やわらかい朝日",
    };
  }

  return {
    theme_type: "generic",
    theme_name: null,
    reason: "広く知られた日付テーマがないため、記念日を使わない通常の朝の挨拶にする",
    confidence: "high",
    visual_theme: "朝の窓辺、コーヒー、観葉植物、やわらかい朝日",
  };
}

export function morningGreetingGenerationInstructions(theme: MorningGreetingTheme): string[] {
  return [
    ...KABUMORI_VOICE,
    "朝の短い挨拶投稿です。株の解説記事ではなく、普段のXで自然におはようと声をかける文章にしてください。",
    `本文は日本語で${MORNING_GREETING_MIN_CHARACTERS}〜${MORNING_GREETING_MAX_CHARACTERS}文字。明るめで柔らかく、かわいさや絵文字を盛りすぎません。`,
    "おはようの挨拶、確定済みテーマへの短い言及、自然な一言を入れますが、毎回同じ構成や締めに固定しません。",
    "テーマはプログラム側で確定済みです。別の記念日へ変更、追加、再解釈しないでください。theme_type、theme_name、visual_themeは入力値をそのまま返してください。",
    "本人の外出、買い物、食事、家族行事などの実体験を作りません。現在地や天気も入力にないため書きません。",
    "相場予想、株価方向の断定、売買推奨、投資助言、存在しないニュースや数値を追加しません。",
    theme.theme_name === null
      ? "今日は○○の日、○○記念日という表現は禁止です。無理に日付テーマを作らず、普通の朝として書いてください。"
      : `使用できるテーマ名は「${theme.theme_name}」だけです。一般的な範囲を超える由来や豆知識は追加しません。`,
    "ハッシュタグ、URL、画像の説明、生成手順は本文へ入れません。",
  ];
}

export function buildMorningGreetingRequest(date: string): { theme: MorningGreetingTheme; body: Record<string, unknown> } {
  const theme = selectMorningGreetingTheme(date);
  return {
    theme,
    body: {
      model: MODEL,
      store: false,
      reasoning: { effort: "low" },
      max_output_tokens: 700,
      instructions: morningGreetingGenerationInstructions(theme).join("\n"),
      input: JSON.stringify({ date, ...theme }),
      text: { format: { type: "json_schema", name: "morning_greeting", strict: true, schema: {
        type: "object",
        properties: {
          theme_type: { type: "string", enum: ["special_day", "seasonal", "weekday", "generic"] },
          theme_name: { type: ["string", "null"] },
          visual_theme: { type: "string" },
          generated_text: { type: "string" },
        },
        required: ["theme_type", "theme_name", "visual_theme", "generated_text"],
        additionalProperties: false,
      } } },
    },
  };
}

const EXPERIENCE_PATTERN = /私も[^。\n]{0,40}(?:しました|してきました|行きました|買いました|食べました|見ました)/u;
const WEATHER_PATTERN = /(?:今日は|今朝は)(?:全国的に)?(?:晴れ|雨|雪|曇り)|気温は?\s*\d/u;
const ADVICE_PATTERN = /(?:買い時|売り時|買うべき|売るべき|必ず上がる|必ず下がる)/u;
const MADE_UP_DAY_PATTERN = /今日は[^。\n]{1,24}(?:の日|記念日)/u;

export function validateMorningGreetingOutput(
  value: unknown,
  expectedTheme: MorningGreetingTheme,
): Omit<MorningGreetingResult, "model" | "input_tokens" | "output_tokens"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("MORNING_GREETING_SCHEMA_INVALID");
  }
  const output = value as Record<string, unknown>;
  const allowedKeys = new Set(["theme_type", "theme_name", "visual_theme", "generated_text"]);
  if (
    Object.keys(output).some((key) => !allowedKeys.has(key)) ||
    output.theme_type !== expectedTheme.theme_type ||
    output.theme_name !== expectedTheme.theme_name ||
    output.visual_theme !== expectedTheme.visual_theme ||
    typeof output.generated_text !== "string"
  ) {
    throw new Error("MORNING_GREETING_SCHEMA_INVALID");
  }
  const generatedText = output.generated_text.trim();
  const length = Array.from(generatedText).length;
  if (length < MORNING_GREETING_MIN_CHARACTERS || length > MORNING_GREETING_MAX_CHARACTERS) {
    throw new Error("MORNING_GREETING_TEXT_LENGTH_INVALID");
  }
  if (!/おはよう(?:ございます)?/u.test(generatedText)) {
    throw new Error("MORNING_GREETING_SALUTATION_MISSING");
  }
  if (
    expectedTheme.theme_name !== null &&
    ["special_day", "seasonal"].includes(expectedTheme.theme_type) &&
    !generatedText.includes(expectedTheme.theme_name)
  ) {
    throw new Error("MORNING_GREETING_THEME_MISSING");
  }
  const emojiCount = generatedText.match(/\p{Extended_Pictographic}/gu)?.length ?? 0;
  if (emojiCount > 4) throw new Error("MORNING_GREETING_EXCESSIVE_EMOJI");
  if (EXPERIENCE_PATTERN.test(generatedText)) throw new Error("MORNING_GREETING_FABRICATED_EXPERIENCE");
  if (WEATHER_PATTERN.test(generatedText)) throw new Error("MORNING_GREETING_UNVERIFIED_WEATHER");
  if (ADVICE_PATTERN.test(generatedText)) throw new Error("MORNING_GREETING_INVESTMENT_ADVICE");
  if (expectedTheme.theme_name === null && MADE_UP_DAY_PATTERN.test(generatedText)) {
    throw new Error("MORNING_GREETING_UNVERIFIED_SPECIAL_DAY");
  }
  if (/https?:\/\/|#[^\s#]+/u.test(generatedText)) throw new Error("MORNING_GREETING_UNEXPECTED_LINK_OR_TAG");
  return { ...expectedTheme, generated_text: generatedText };
}

function extractSingleOutputText(response: unknown): string {
  if (typeof response !== "object" || response === null) throw new Error("MORNING_GREETING_EMPTY_OUTPUT");
  if ((response as { status?: unknown }).status === "incomplete") throw new Error("MORNING_GREETING_INCOMPLETE");
  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) throw new Error("MORNING_GREETING_EMPTY_OUTPUT");
  const contents = output.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const content = (item as { content?: unknown }).content;
    return Array.isArray(content) ? content : [];
  });
  if (contents.some((item) => typeof item === "object" && item !== null && (item as { type?: unknown }).type === "refusal")) {
    throw new Error("MORNING_GREETING_REFUSAL");
  }
  const texts = contents.filter((item) =>
    typeof item === "object" && item !== null &&
    (item as { type?: unknown }).type === "output_text" &&
    typeof (item as { text?: unknown }).text === "string"
  ).map((item) => (item as { text: string }).text.trim()).filter(Boolean);
  if (texts.length === 0) throw new Error("MORNING_GREETING_EMPTY_OUTPUT");
  if (texts.length !== 1) throw new Error("MORNING_GREETING_MULTIPLE_OUTPUTS");
  return texts[0];
}

function responseUsage(response: unknown): { input: number; output: number } {
  if (typeof response !== "object" || response === null) return { input: 0, output: 0 };
  const usage = (response as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return { input: 0, output: 0 };
  const input = (usage as { input_tokens?: unknown }).input_tokens;
  const output = (usage as { output_tokens?: unknown }).output_tokens;
  return {
    input: typeof input === "number" ? input : 0,
    output: typeof output === "number" ? output : 0,
  };
}

export async function generateMorningGreeting(
  openAiApiKey: string,
  date: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MorningGreetingResult> {
  const request = buildMorningGreetingRequest(date);
  const response = await fetchImpl(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${openAiApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(request.body),
  });
  if (!response.ok) throw new Error(`MORNING_GREETING_OPENAI_FAILED:${response.status}`);
  const raw = await response.json();
  const outputText = extractSingleOutputText(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(outputText);
  } catch {
    throw new Error("MORNING_GREETING_JSON_PARSE_FAILED");
  }
  const validated = validateMorningGreetingOutput(parsed, request.theme);
  const usage = responseUsage(raw);
  return {
    ...validated,
    model: MODEL,
    input_tokens: usage.input,
    output_tokens: usage.output,
  };
}
