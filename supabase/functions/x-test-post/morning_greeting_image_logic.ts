import type {
  MorningGreetingImageGenerationContext,
  YumeCanonicalReference,
} from "./yume_reference_logic.ts";
import {
  buildMorningGreetingImageGenerationContext,
  fetchYumeCanonicalReference,
  resolveYumeCanonicalReference,
  YUME_CANONICAL_REFERENCE_BUCKET,
  YUME_CANONICAL_REFERENCE_PATH,
} from "./yume_reference_logic.ts";

export const OPENAI_MORNING_GREETING_IMAGE_ENDPOINT = "https://api.openai.com/v1/images/edits";
export const OPENAI_MORNING_GREETING_IMAGE_MODEL = "gpt-image-2";
export const MORNING_GREETING_IMAGE_TEST_MODE = "test_morning_greeting_image";
export const MORNING_GREETING_IMAGE_TEST_OUTPUT_PREFIX = "test-output";
export const MORNING_GREETING_IMAGE_TEST_DATE = "2026-09-01";
export const MORNING_GREETING_IMAGE_TEST_THEME_NAME = "防災の日";
export const MORNING_GREETING_IMAGE_TEST_VISUAL_THEME =
  "防災の日を自然に意識した朝の挨拶。明るい朝の室内で、防災リュック、懐中電灯、保存水などの防災用品を自然に配置する。怖い災害表現は使わない。";

export type MorningGreetingImageGenerationMetadata = {
  date: string;
  theme_name: string | null;
  canonical_reference_path: string;
  visual_theme: string;
  requested_size: "1024x1024";
  prompt: string;
};

export type MorningGreetingGeneratedImage = {
  bytes: Uint8Array;
  content_type: "image/png";
  metadata: MorningGreetingImageGenerationMetadata & {
    api_endpoint: string;
    model: string;
    api_call_count: 1;
    canonical_reference_supplied: true;
  };
};

export type MorningGreetingImageTestResult = {
  success: true;
  output_storage_path: string;
  image_api_called: 1;
  x_api_called: 0;
  scheduled_posts_changed: 0;
  retry_count: 0;
  generation_metadata: MorningGreetingGeneratedImage["metadata"];
};

export class MorningGreetingImageTestError extends Error {
  readonly imageApiCalled: number;

  constructor(message: string, imageApiCalled: number) {
    super(message);
    this.name = "MorningGreetingImageTestError";
    this.imageApiCalled = imageApiCalled;
  }
}

export function buildMorningGreetingImagePrompt(args: {
  date: string;
  themeName: string | null;
  reference: YumeCanonicalReference;
  context: MorningGreetingImageGenerationContext;
}): MorningGreetingImageGenerationMetadata {
  if (args.context.canonical_reference_path !== args.reference.canonical_reference_path) {
    throw new Error("MORNING_GREETING_IMAGE_REFERENCE_MISMATCH");
  }
  if (!args.context.visual_theme.trim()) throw new Error("MORNING_GREETING_IMAGE_VISUAL_THEME_MISSING");
  const themeLabel = args.themeName ?? "通常の自然な朝";
  const prompt = [
    "Use case: identity-preserve",
    "Asset type: square illustration for a friendly morning post on X",
    `Primary request: Use the supplied canonical reference image as the highest-priority identity reference for Yume. Create one new illustration for ${args.date}, ${themeLabel}.`,
    "Input image: the canonical reference image defines Yume herself. Preserve her facial features, warm brown eyes, medium-long to long softly wavy brown hair with side-parted bangs, young-adult age impression, friendly overall warmth, illustration style, and character identity.",
    "Only Yume appears. Her clothing, accessories, expression, pose, background, props, and composition may change for today's theme.",
    `Scene/backdrop and props: ${args.context.visual_theme}. Follow only this date-derived visual theme. Yume looks cheerful, natural, and positive.`,
    "Composition: polished square SNS illustration, one person, clear focal point, comfortable spacing, naturally connected to the canonical reference style.",
    "Lighting/mood: bright morning light, reassuring, approachable, and upbeat.",
    "Constraints: preserve Yume's identity from the reference. Do not copy the original clothing, jewelry, pose, background, or composition unless they fit naturally.",
    "Avoid: other people, robots, stock-market objects, books about stocks, monitors, charts, logos, text, captions, speech bubbles, watermarks, disaster damage, collapsed streets, fear, injury, panic, dark or threatening atmosphere.",
    "No text anywhere in the image.",
  ].join("\n");
  return {
    date: args.date,
    theme_name: args.themeName,
    canonical_reference_path: args.reference.canonical_reference_path,
    visual_theme: args.context.visual_theme,
    requested_size: "1024x1024",
    prompt,
  };
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function generateMorningGreetingImageWithOpenAi(args: {
  supabaseUrl: string;
  serviceRoleKey: string;
  openAiApiKey: string;
  date: string;
  themeName: string | null;
  visualTheme: string;
  fetchImpl?: typeof fetch;
}): Promise<MorningGreetingGeneratedImage> {
  if (!args.openAiApiKey.trim()) throw new Error("MORNING_GREETING_IMAGE_OPENAI_AUTH_MISSING");
  const fetchImpl = args.fetchImpl ?? fetch;
  const reference = resolveYumeCanonicalReference();
  const canonical = await fetchYumeCanonicalReference(
    args.supabaseUrl,
    args.serviceRoleKey,
    reference,
    fetchImpl,
  );
  const context = buildMorningGreetingImageGenerationContext(args.visualTheme, reference);
  const generation = buildMorningGreetingImagePrompt({
    date: args.date,
    themeName: args.themeName,
    reference,
    context,
  });

  const form = new FormData();
  form.set("model", OPENAI_MORNING_GREETING_IMAGE_MODEL);
  form.set("prompt", generation.prompt);
  form.set("size", generation.requested_size);
  form.set("quality", "high");
  form.set("output_format", "png");
  form.set("n", "1");
  form.set("image", new Blob([canonical.bytes], { type: canonical.contentType }), "yume-reference.png");

  const response = await fetchImpl(OPENAI_MORNING_GREETING_IMAGE_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${args.openAiApiKey}` },
    body: form,
  });
  if (!response.ok) throw new Error(`MORNING_GREETING_IMAGE_OPENAI_FAILED:${response.status}`);
  const payload = await response.json() as { data?: Array<{ b64_json?: unknown }> };
  const encoded = payload.data?.[0]?.b64_json;
  if (typeof encoded !== "string" || encoded.length === 0) {
    throw new Error("MORNING_GREETING_IMAGE_OPENAI_OUTPUT_MISSING");
  }
  const bytes = decodeBase64(encoded);
  if (bytes.length === 0) throw new Error("MORNING_GREETING_IMAGE_OPENAI_OUTPUT_EMPTY");
  return {
    bytes,
    content_type: "image/png",
    metadata: {
      ...generation,
      api_endpoint: OPENAI_MORNING_GREETING_IMAGE_ENDPOINT,
      model: OPENAI_MORNING_GREETING_IMAGE_MODEL,
      api_call_count: 1,
      canonical_reference_supplied: true,
    },
  };
}

function encodeStorageObjectPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function buildMorningGreetingImageTestOutputPath(nowIso: string): string {
  const parsed = new Date(nowIso);
  if (!Number.isFinite(parsed.getTime())) throw new Error("MORNING_GREETING_IMAGE_TEST_TIME_INVALID");
  const filename = parsed.toISOString().replace(/[:.]/gu, "-");
  const path = `${MORNING_GREETING_IMAGE_TEST_OUTPUT_PREFIX}/${filename}.png`;
  if (path === YUME_CANONICAL_REFERENCE_PATH ||
    !path.startsWith(`${MORNING_GREETING_IMAGE_TEST_OUTPUT_PREFIX}/`)) {
    throw new Error("MORNING_GREETING_IMAGE_CANONICAL_OVERWRITE_BLOCKED");
  }
  return path;
}

export async function runMorningGreetingImageTest(args: {
  supabaseUrl: string;
  serviceRoleKey: string;
  openAiApiKey: string;
  nowIso?: string;
  fetchImpl?: typeof fetch;
}): Promise<MorningGreetingImageTestResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  let imageApiCalled = 0;
  const guardedFetch: typeof fetch = async (input, init) => {
    if (String(input) === OPENAI_MORNING_GREETING_IMAGE_ENDPOINT) {
      imageApiCalled += 1;
      if (imageApiCalled > 1) throw new Error("MORNING_GREETING_IMAGE_API_CALL_LIMIT_EXCEEDED");
    }
    return await fetchImpl(input, init);
  };

  try {
    const generated = await generateMorningGreetingImageWithOpenAi({
      supabaseUrl: args.supabaseUrl,
      serviceRoleKey: args.serviceRoleKey,
      openAiApiKey: args.openAiApiKey,
      date: MORNING_GREETING_IMAGE_TEST_DATE,
      themeName: MORNING_GREETING_IMAGE_TEST_THEME_NAME,
      visualTheme: MORNING_GREETING_IMAGE_TEST_VISUAL_THEME,
      fetchImpl: guardedFetch,
    });
    const outputObjectPath = buildMorningGreetingImageTestOutputPath(
      args.nowIso ?? new Date().toISOString(),
    );
    const uploadUrl = `${args.supabaseUrl.replace(/\/$/u, "")}/storage/v1/object/${
      encodeURIComponent(YUME_CANONICAL_REFERENCE_BUCKET)
    }/${encodeStorageObjectPath(outputObjectPath)}`;
    const uploadResponse = await fetchImpl(uploadUrl, {
      method: "POST",
      headers: {
        apikey: args.serviceRoleKey,
        Authorization: `Bearer ${args.serviceRoleKey}`,
        "Content-Type": generated.content_type,
        "x-upsert": "false",
      },
      body: generated.bytes,
    });
    if (!uploadResponse.ok) {
      throw new Error(`MORNING_GREETING_IMAGE_TEST_UPLOAD_FAILED:${uploadResponse.status}`);
    }
    return {
      success: true,
      output_storage_path:
        `storage://${YUME_CANONICAL_REFERENCE_BUCKET}/${outputObjectPath}`,
      image_api_called: 1,
      x_api_called: 0,
      scheduled_posts_changed: 0,
      retry_count: 0,
      generation_metadata: generated.metadata,
    };
  } catch (error) {
    throw new MorningGreetingImageTestError(
      error instanceof Error ? error.message : String(error),
      imageApiCalled,
    );
  }
}
