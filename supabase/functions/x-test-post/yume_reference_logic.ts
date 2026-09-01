export const YUME_CANONICAL_REFERENCE_BUCKET = "morning-greeting-assets";
export const YUME_CANONICAL_REFERENCE_PATH = "canonical/yume-reference.png";

export type YumeCanonicalReference = {
  bucket: string;
  object_path: string;
  canonical_reference_path: string;
};

export type MorningGreetingImageGenerationContext = {
  canonical_reference_path: string;
  visual_theme: string;
  image_generation_context: string;
};

function validatedStoragePart(value: string | null | undefined, code: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new Error(code);
  if (
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.includes("..") ||
    normalized.includes("\\") ||
    /^https?:\/\//iu.test(normalized)
  ) {
    throw new Error(code);
  }
  return normalized;
}

export function resolveYumeCanonicalReference(config: {
  bucket?: string | null;
  objectPath?: string | null;
} = {}): YumeCanonicalReference {
  const bucket = validatedStoragePart(
    config.bucket === undefined ? YUME_CANONICAL_REFERENCE_BUCKET : config.bucket,
    "YUME_CANONICAL_REFERENCE_BUCKET_MISSING",
  );
  const objectPath = validatedStoragePart(
    config.objectPath === undefined ? YUME_CANONICAL_REFERENCE_PATH : config.objectPath,
    "YUME_CANONICAL_REFERENCE_PATH_MISSING",
  );
  if (!/\.(?:png|jpe?g|webp)$/iu.test(objectPath)) {
    throw new Error("YUME_CANONICAL_REFERENCE_IMAGE_TYPE_INVALID");
  }
  return {
    bucket,
    object_path: objectPath,
    canonical_reference_path: `storage://${bucket}/${objectPath}`,
  };
}

export function buildMorningGreetingImageGenerationContext(
  visualTheme: string,
  reference: YumeCanonicalReference = resolveYumeCanonicalReference(),
): MorningGreetingImageGenerationContext {
  const normalizedVisualTheme = visualTheme.trim();
  if (!normalizedVisualTheme) throw new Error("MORNING_GREETING_VISUAL_THEME_MISSING");
  return {
    canonical_reference_path: reference.canonical_reference_path,
    visual_theme: normalizedVisualTheme,
    image_generation_context: [
      "添付されたcanonical reference imageをユメちゃんの人物同一性に関する最優先の参照にする。",
      "顔、髪型、基本的な雰囲気を文章から作り直さず、参照画像との一貫性を維持する。",
      `その日の変更対象は背景、小物、場面を中心としたvisual theme「${normalizedVisualTheme}」に限定する。`,
    ].join("\n"),
  };
}

function encodedObjectPath(path: string): string {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

export async function fetchYumeCanonicalReference(
  supabaseUrl: string,
  serviceRoleKey: string,
  reference: YumeCanonicalReference = resolveYumeCanonicalReference(),
  fetchImpl: typeof fetch = fetch,
): Promise<{ bytes: Uint8Array; contentType: string; reference: YumeCanonicalReference }> {
  const normalizedUrl = supabaseUrl.trim().replace(/\/$/u, "");
  if (!/^https:\/\//u.test(normalizedUrl)) throw new Error("YUME_CANONICAL_REFERENCE_SUPABASE_URL_INVALID");
  if (!serviceRoleKey.trim()) throw new Error("YUME_CANONICAL_REFERENCE_AUTH_MISSING");
  const url = `${normalizedUrl}/storage/v1/object/${encodeURIComponent(reference.bucket)}/${encodedObjectPath(reference.object_path)}`;
  const response = await fetchImpl(url, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });
  if (response.status === 404) throw new Error("YUME_CANONICAL_REFERENCE_NOT_FOUND");
  if (!response.ok) throw new Error(`YUME_CANONICAL_REFERENCE_FETCH_FAILED:${response.status}`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (!new Set(["image/png", "image/jpeg", "image/webp"]).has(contentType)) {
    throw new Error("YUME_CANONICAL_REFERENCE_CONTENT_TYPE_INVALID");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error("YUME_CANONICAL_REFERENCE_EMPTY");
  if (bytes.length > 10 * 1024 * 1024) throw new Error("YUME_CANONICAL_REFERENCE_TOO_LARGE");
  return { bytes, contentType, reference };
}
