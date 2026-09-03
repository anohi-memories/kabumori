import {
  generateMorningGreeting,
  selectMorningGreetingTheme,
  type MorningGreetingResult,
  type MorningGreetingTheme,
} from "./morning_greeting_logic.ts";

export const MORNING_GREETING_PAYLOAD_TEST_MODE = "test_morning_greeting_payload";
export const MORNING_GREETING_ASSET_BUCKET = "morning-greeting-assets";
export const MORNING_GREETING_GENERATED_PREFIX = "generated";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

export type MorningGreetingPayloadDryRunResult = {
  success: true;
  date_jst: string;
  text: string;
  theme: MorningGreetingTheme["theme_type"];
  theme_name: string | null;
  visual_theme: string;
  image_path: string;
  image_exists: true;
  theme_match: true;
  payload_ready: true;
  openai_text_api_called: number;
  retry_count: number;
  x_api_called: 0;
  x_posted: false;
  payload: {
    text: string;
    image_path: string;
    scheduled_date: string;
    theme: MorningGreetingTheme["theme_type"];
  };
};

export class MorningGreetingPayloadDryRunError extends Error {
  readonly openAiTextApiCalled: number;
  readonly imageExists: boolean;
  readonly themeMatch: boolean;

  constructor(
    message: string,
    diagnostics: { openAiTextApiCalled: number; imageExists: boolean; themeMatch: boolean },
  ) {
    super(message);
    this.name = "MorningGreetingPayloadDryRunError";
    this.openAiTextApiCalled = diagnostics.openAiTextApiCalled;
    this.imageExists = diagnostics.imageExists;
    this.themeMatch = diagnostics.themeMatch;
  }
}

export function resolveMorningGreetingJstDate(now: Date = new Date()): string {
  if (!Number.isFinite(now.getTime())) throw new Error("MORNING_GREETING_REFERENCE_TIME_INVALID");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function morningGreetingImagePath(dateJst: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(dateJst)) throw new Error("MORNING_GREETING_DATE_INVALID");
  return `storage://${MORNING_GREETING_ASSET_BUCKET}/${MORNING_GREETING_GENERATED_PREFIX}/${dateJst}.png`;
}

export function morningGreetingThemesMatch(
  textTheme: MorningGreetingTheme,
  imageTheme: MorningGreetingTheme,
): boolean {
  return textTheme.theme_type === imageTheme.theme_type &&
    textTheme.theme_name === imageTheme.theme_name &&
    textTheme.visual_theme === imageTheme.visual_theme;
}

export function morningGreetingStorageObjectUrl(supabaseUrl: string, dateJst: string): string {
  const path = `${MORNING_GREETING_GENERATED_PREFIX}/${dateJst}.png`;
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${supabaseUrl.replace(/\/$/u, "")}/storage/v1/object/${
    encodeURIComponent(MORNING_GREETING_ASSET_BUCKET)
  }/${encodedPath}`;
}

export async function runMorningGreetingPayloadDryRun(args: {
  supabaseUrl: string;
  serviceRoleKey: string;
  openAiApiKey: string;
  now?: Date;
  fetchImpl?: typeof fetch;
  resolveImageTheme?: (dateJst: string) => MorningGreetingTheme;
}): Promise<MorningGreetingPayloadDryRunResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const dateJst = resolveMorningGreetingJstDate(args.now);
  const expectedTheme = selectMorningGreetingTheme(dateJst);
  let openAiTextApiCalled = 0;
  let imageExists = false;
  let themeMatch = false;

  // generateMorningGreeting may retry once, and only once, on a length-invalid result — so up to 2 calls
  // here is expected, not a runaway loop. Anything beyond that is not.
  const guardedFetch: typeof fetch = async (input, init) => {
    if (String(input) === OPENAI_RESPONSES_URL) {
      openAiTextApiCalled += 1;
      if (openAiTextApiCalled > 2) {
        throw new Error("MORNING_GREETING_TEXT_API_CALL_LIMIT_EXCEEDED");
      }
    }
    return await fetchImpl(input, init);
  };

  try {
    const greeting: MorningGreetingResult = await generateMorningGreeting(
      args.openAiApiKey,
      dateJst,
      guardedFetch,
    );
    if (openAiTextApiCalled < 1 || openAiTextApiCalled > 2) {
      throw new Error("MORNING_GREETING_TEXT_API_CALL_COUNT_INVALID");
    }

    const imageResponse = await fetchImpl(morningGreetingStorageObjectUrl(args.supabaseUrl, dateJst), {
      method: "GET",
      headers: {
        apikey: args.serviceRoleKey,
        Authorization: `Bearer ${args.serviceRoleKey}`,
        Range: "bytes=0-0",
      },
    });
    imageExists = imageResponse.ok || imageResponse.status === 206;
    if (!imageExists) throw new Error("MORNING_GREETING_IMAGE_NOT_FOUND");

    const imageTheme = (args.resolveImageTheme ?? selectMorningGreetingTheme)(dateJst);
    themeMatch = morningGreetingThemesMatch(greeting, imageTheme) &&
      morningGreetingThemesMatch(expectedTheme, imageTheme);
    if (!themeMatch) throw new Error("MORNING_GREETING_THEME_MISMATCH");

    const imagePath = morningGreetingImagePath(dateJst);
    return {
      success: true,
      date_jst: dateJst,
      text: greeting.generated_text,
      theme: greeting.theme_type,
      theme_name: greeting.theme_name,
      visual_theme: greeting.visual_theme,
      image_path: imagePath,
      image_exists: true,
      theme_match: true,
      payload_ready: true,
      openai_text_api_called: openAiTextApiCalled,
      retry_count: greeting.retry_count,
      x_api_called: 0,
      x_posted: false,
      payload: {
        text: greeting.generated_text,
        image_path: imagePath,
        scheduled_date: dateJst,
        theme: greeting.theme_type,
      },
    };
  } catch (error) {
    throw new MorningGreetingPayloadDryRunError(
      error instanceof Error ? error.message : String(error),
      { openAiTextApiCalled, imageExists, themeMatch },
    );
  }
}
