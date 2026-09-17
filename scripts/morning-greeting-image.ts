import { pathToFileURL } from "node:url";
import {
  generateMorningGreetingImageWithOpenAi,
  OPENAI_MORNING_GREETING_IMAGE_ENDPOINT,
} from "../supabase/functions/x-test-post/morning_greeting_image_logic.ts";
import {
  type MorningGreetingTheme,
  selectMorningGreetingTheme,
} from "../supabase/functions/x-test-post/morning_greeting_logic.ts";
import {
  YUME_CANONICAL_REFERENCE_BUCKET,
  YUME_CANONICAL_REFERENCE_PATH,
} from "../supabase/functions/x-test-post/yume_reference_logic.ts";

export const MORNING_GREETING_GENERATED_PREFIX = "generated";

export type MorningGreetingImageWorkflowResult = {
  success: true;
  skipped: boolean;
  output_storage_path: string;
  image_api_called: 0 | 1;
  retry_count: 0;
  x_api_called: 0;
  scheduled_posts_changed: 0;
  theme: MorningGreetingTheme;
};

export class MorningGreetingImageWorkflowError extends Error {
  readonly imageApiCalled: number;

  constructor(message: string, imageApiCalled: number) {
    super(message);
    this.name = "MorningGreetingImageWorkflowError";
    this.imageApiCalled = imageApiCalled;
  }
}

// Admin's morning_greeting toggle (apps/admin/src/lib/actions/system-toggle.ts) writes
// posting_windows.is_active for post_type='morning_greeting' -- that row is the existing source of
// truth for whether Kabumori's morning greeting is on at all, including its scheduled X post. This
// workflow runs on its own daily cron ahead of that post purely to pre-generate the day's image, so it
// must check the same source of truth before ever calling OpenAI: an admin turning the greeting off
// today only stopped the post, not this separate cron job, which kept billing OpenAI every morning
// regardless.
export type MorningGreetingEnablementResult = { enabled: boolean };

export class MorningGreetingEnablementCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MorningGreetingEnablementCheckError";
  }
}

export async function checkMorningGreetingEnabled({
  supabaseUrl,
  serviceRoleKey,
  fetchImpl = fetch,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
}): Promise<MorningGreetingEnablementResult> {
  const params = new URLSearchParams({
    select: "is_active",
    brand_id: "eq.kabumori",
    post_type: "eq.morning_greeting",
  });
  const url = `${supabaseUrl.trim().replace(/\/$/u, "")}/rest/v1/posting_windows?${params}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    });
  } catch (error) {
    throw new MorningGreetingEnablementCheckError(
      `MORNING_GREETING_ENABLEMENT_READ_FAILED:${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new MorningGreetingEnablementCheckError(`MORNING_GREETING_ENABLEMENT_READ_FAILED:${response.status}`);
  }

  let rows: unknown;
  try {
    rows = await response.json();
  } catch {
    throw new MorningGreetingEnablementCheckError("MORNING_GREETING_ENABLEMENT_RESPONSE_MALFORMED");
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    // Enablement is unknown, not "off" -- never treat a missing row as a safe default in either
    // direction. This must stop the workflow, not silently skip or silently generate.
    throw new MorningGreetingEnablementCheckError("MORNING_GREETING_ENABLEMENT_SETTING_NOT_FOUND");
  }

  const values = rows.map((row) => (row as { is_active?: unknown }).is_active);
  if (values.some((value) => typeof value !== "boolean")) {
    throw new MorningGreetingEnablementCheckError("MORNING_GREETING_ENABLEMENT_RESPONSE_MALFORMED");
  }
  // Today exactly one row exists for (kabumori, morning_greeting). If that were ever to change, do not
  // invent a resolution rule (e.g. "any true wins") -- only proceed when every matching row agrees.
  const distinctValues = new Set(values);
  if (distinctValues.size > 1) {
    throw new MorningGreetingEnablementCheckError("MORNING_GREETING_ENABLEMENT_AMBIGUOUS");
  }

  return { enabled: values[0] === true };
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

async function isStorageObjectMissing(response: Response): Promise<boolean> {
  if (response.status === 404) return true;
  if (response.status !== 400) return false;

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > 4096) return false;
  const body = await response.text();
  if (body.length > 4096) return false;

  const normalized = body.trim().toLowerCase();
  if (normalized === "object not found") return true;
  try {
    const payload = JSON.parse(body) as Record<string, unknown>;
    return [payload.message, payload.error, payload.code].some((value) =>
      typeof value === "string" && value.trim().toLowerCase() === "object not found"
    );
  } catch {
    return false;
  }
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
  const theme = selectMorningGreetingTheme(date);
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
        theme,
      };
    }
    if (!(await isStorageObjectMissing(existing))) {
      throw new Error(`MORNING_GREETING_OUTPUT_EXISTENCE_CHECK_FAILED:${existing.status}`);
    }

    const generated = await generateMorningGreetingImageWithOpenAi({
      supabaseUrl: args.supabaseUrl,
      serviceRoleKey: args.serviceRoleKey,
      openAiApiKey: args.openAiApiKey,
      date,
      themeName: theme.theme_name,
      visualTheme: theme.visual_theme,
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
      theme,
    };
  } catch (error) {
    throw new MorningGreetingImageWorkflowError(
      error instanceof Error ? error.message : String(error),
      imageApiCalled,
    );
  }
}

export type MorningGreetingImageJobResult =
  | { success: true; skipped: true; reason: "disabled"; image_api_called: 0 }
  | MorningGreetingImageWorkflowResult;

// The one entry point main() calls: gates on the admin's existing enablement source of truth before
// ever touching runMorningGreetingImageWorkflow (and therefore before it can call OpenAI or write
// Storage), so this single function is what "OFF -> zero OpenAI/Storage calls" actually tests against.
export async function runMorningGreetingImageJob(args: {
  supabaseUrl: string;
  serviceRoleKey: string;
  openAiApiKey: string;
  date?: string;
  fetchImpl?: typeof fetch;
}): Promise<MorningGreetingImageJobResult> {
  const enablement = await checkMorningGreetingEnabled({
    supabaseUrl: args.supabaseUrl,
    serviceRoleKey: args.serviceRoleKey,
    fetchImpl: args.fetchImpl,
  });
  if (!enablement.enabled) {
    return { success: true, skipped: true, reason: "disabled", image_api_called: 0 };
  }
  return await runMorningGreetingImageWorkflow(args);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`MORNING_GREETING_ENV_MISSING:${name}`);
  return value;
}

async function main(): Promise<void> {
  try {
    const result = await runMorningGreetingImageJob({
      supabaseUrl: requiredEnvironment("SUPABASE_URL"),
      serviceRoleKey: requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
      openAiApiKey: requiredEnvironment("OPENAI_API_KEY"),
      date: process.env.MORNING_GREETING_DATE,
    });
    if ("reason" in result && result.reason === "disabled") {
      console.log("morning greeting disabled; image generation skipped");
      return;
    }
    console.log(JSON.stringify(result));
  } catch (error) {
    // Covers both an unknown enablement result (missing/ambiguous row, non-2xx, malformed response,
    // network failure -- MorningGreetingEnablementCheckError) and a generation failure
    // (MorningGreetingImageWorkflowError). Neither ever falls through to a default success.
    const safe = error instanceof MorningGreetingImageWorkflowError
      ? { success: false, error: error.message, image_api_called: error.imageApiCalled }
      : { success: false, error: error instanceof Error ? error.message : String(error), image_api_called: 0 };
    console.error(JSON.stringify(safe));
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
