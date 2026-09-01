import { pathToFileURL } from "node:url";
import {
  generateMorningGreetingImageWithOpenAi,
  OPENAI_MORNING_GREETING_IMAGE_ENDPOINT,
} from "../supabase/functions/x-test-post/morning_greeting_image_logic.ts";
import {
  YUME_CANONICAL_REFERENCE_BUCKET,
  YUME_CANONICAL_REFERENCE_PATH,
} from "../supabase/functions/x-test-post/yume_reference_logic.ts";

export const MORNING_GREETING_GENERATED_PREFIX = "generated";
export const MORNING_GREETING_WORKFLOW_THEME_NAME = "防災の日";
export const MORNING_GREETING_WORKFLOW_VISUAL_THEME =
  "防災の日を自然に意識した朝の挨拶。明るい朝の場面で、防災リュック、懐中電灯、保存水などの防災用品を自然に配置する。災害被害や不安を描かず、文字、ロゴ、ロボット、株価、チャート、宣伝文は入れない。";

export type MorningGreetingImageWorkflowResult = {
  success: true;
  skipped: boolean;
  output_storage_path: string;
  image_api_called: 0 | 1;
  retry_count: 0;
  x_api_called: 0;
  scheduled_posts_changed: 0;
};

export class MorningGreetingImageWorkflowError extends Error {
  readonly imageApiCalled: number;

  constructor(message: string, imageApiCalled: number) {
    super(message);
    this.name = "MorningGreetingImageWorkflowError";
    this.imageApiCalled = imageApiCalled;
  }
}

function encodeObjectPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function storageObjectUrl(supabaseUrl: string, objectPath: string): string {
  return `${supabaseUrl.trim().replace(/\/$/u, "")}/storage/v1/object/${
    encodeURIComponent(YUME_CANONICAL_REFERENCE_BUCKET)
  }/${encodeObjectPath(objectPath)}`;
}

function serviceRoleHeaders(serviceRoleKey: string): Record<string, string> {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };
}

export function resolveJstDate(now: Date = new Date()): string {
  if (!Number.isFinite(now.getTime())) throw new Error("MORNING_GREETING_DATE_INVALID");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function buildMorningGreetingGeneratedPath(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error("MORNING_GREETING_DATE_INVALID");
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error("MORNING_GREETING_DATE_INVALID");
  }
  const path = `${MORNING_GREETING_GENERATED_PREFIX}/${date}.png`;
  if (path === YUME_CANONICAL_REFERENCE_PATH || !path.startsWith(`${MORNING_GREETING_GENERATED_PREFIX}/`)) {
    throw new Error("MORNING_GREETING_CANONICAL_OVERWRITE_BLOCKED");
  }
  return path;
}

export async function runMorningGreetingImageWorkflow(args: {
  supabaseUrl: string;
  serviceRoleKey: string;
  openAiApiKey: string;
  date?: string;
  fetchImpl?: typeof fetch;
}): Promise<MorningGreetingImageWorkflowResult> {
  if (!args.supabaseUrl.trim()) throw new Error("MORNING_GREETING_SUPABASE_URL_MISSING");
  if (!args.serviceRoleKey.trim()) throw new Error("MORNING_GREETING_SERVICE_ROLE_KEY_MISSING");
  if (!args.openAiApiKey.trim()) throw new Error("MORNING_GREETING_OPENAI_API_KEY_MISSING");
  const fetchImpl = args.fetchImpl ?? fetch;
  const date = args.date?.trim() || resolveJstDate();
  const outputObjectPath = buildMorningGreetingGeneratedPath(date);
  const outputStoragePath = `storage://${YUME_CANONICAL_REFERENCE_BUCKET}/${outputObjectPath}`;
  const outputUrl = storageObjectUrl(args.supabaseUrl, outputObjectPath);
  let imageApiCalled = 0;

  const guardedFetch: typeof fetch = async (input, init) => {
    if (String(input) === OPENAI_MORNING_GREETING_IMAGE_ENDPOINT) {
      imageApiCalled += 1;
      if (imageApiCalled > 1) throw new Error("MORNING_GREETING_IMAGE_API_CALL_LIMIT_EXCEEDED");
    }
    return await fetchImpl(input, init);
  };

  try {
    const existing = await fetchImpl(outputUrl, {
      headers: { ...serviceRoleHeaders(args.serviceRoleKey), Range: "bytes=0-0" },
    });
    if (existing.ok || existing.status === 206) {
      return {
        success: true,
        skipped: true,
        output_storage_path: outputStoragePath,
        image_api_called: 0,
        retry_count: 0,
        x_api_called: 0,
        scheduled_posts_changed: 0,
      };
    }
    if (existing.status !== 404) {
      throw new Error(`MORNING_GREETING_OUTPUT_EXISTENCE_CHECK_FAILED:${existing.status}`);
    }

    const generated = await generateMorningGreetingImageWithOpenAi({
      supabaseUrl: args.supabaseUrl,
      serviceRoleKey: args.serviceRoleKey,
      openAiApiKey: args.openAiApiKey,
      date,
      themeName: MORNING_GREETING_WORKFLOW_THEME_NAME,
      visualTheme: MORNING_GREETING_WORKFLOW_VISUAL_THEME,
      fetchImpl: guardedFetch,
    });
    const upload = await fetchImpl(outputUrl, {
      method: "POST",
      headers: {
        ...serviceRoleHeaders(args.serviceRoleKey),
        "Content-Type": generated.content_type,
        "x-upsert": "false",
      },
      body: generated.bytes,
    });
    if (!upload.ok) throw new Error(`MORNING_GREETING_IMAGE_UPLOAD_FAILED:${upload.status}`);

    return {
      success: true,
      skipped: false,
      output_storage_path: outputStoragePath,
      image_api_called: 1,
      retry_count: 0,
      x_api_called: 0,
      scheduled_posts_changed: 0,
    };
  } catch (error) {
    throw new MorningGreetingImageWorkflowError(
      error instanceof Error ? error.message : String(error),
      imageApiCalled,
    );
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`MORNING_GREETING_ENV_MISSING:${name}`);
  return value;
}

async function main(): Promise<void> {
  try {
    const result = await runMorningGreetingImageWorkflow({
      supabaseUrl: requiredEnvironment("SUPABASE_URL"),
      serviceRoleKey: requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
      openAiApiKey: requiredEnvironment("OPENAI_API_KEY"),
      date: process.env.MORNING_GREETING_DATE,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    const safe = error instanceof MorningGreetingImageWorkflowError
      ? { success: false, error: error.message, image_api_called: error.imageApiCalled }
      : { success: false, error: error instanceof Error ? error.message : String(error) };
    console.error(JSON.stringify(safe));
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
