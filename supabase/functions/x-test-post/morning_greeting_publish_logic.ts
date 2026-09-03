import {
  morningGreetingStorageObjectUrl,
  resolveMorningGreetingJstDate,
  runMorningGreetingPayloadDryRun,
  type MorningGreetingPayloadDryRunResult,
} from "./morning_greeting_payload_logic.ts";
import {
  MORNING_GREETING_PUBLISH_CLAIM_POST_TYPE,
  claimPublishSlot,
  completePublishSlot,
  failPublishSlot,
} from "./publish_claim_logic.ts";

export const MORNING_GREETING_MANUAL_PUBLISH_MODE = "publish_morning_greeting_manual";
const X_MEDIA_UPLOAD_URL = "https://api.x.com/2/media/upload";
const X_POST_URL = "https://api.x.com/2/tweets";

type FetchLike = typeof fetch;

export type MorningGreetingManualPublishResult = {
  success: true;
  skipped: boolean;
  already_posted: boolean;
  date_jst: string;
  text: string | null;
  theme: string | null;
  image_path: string;
  image_exists: boolean;
  theme_match: boolean;
  payload_ready: boolean;
  image_upload_succeeded: boolean;
  x_api_called: number;
  x_post_api_called: number;
  x_posted: boolean;
  x_post_id: string | null;
  retry_count: 0;
};

export class MorningGreetingManualPublishError extends Error {
  readonly imageUploadSucceeded: boolean;
  readonly xApiCalled: number;
  readonly xPostApiCalled: number;
  readonly xPosted: boolean;
  readonly xPostId: string | null;

  constructor(message: string, diagnostics: {
    imageUploadSucceeded: boolean;
    xApiCalled: number;
    xPostApiCalled: number;
    xPosted: boolean;
    xPostId: string | null;
  }) {
    super(message);
    this.name = "MorningGreetingManualPublishError";
    this.imageUploadSucceeded = diagnostics.imageUploadSucceeded;
    this.xApiCalled = diagnostics.xApiCalled;
    this.xPostApiCalled = diagnostics.xPostApiCalled;
    this.xPosted = diagnostics.xPosted;
    this.xPostId = diagnostics.xPostId;
  }
}

function supabaseHeaders(serviceRoleKey: string): Record<string, string> {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

function publishedReceiptUrl(supabaseUrl: string, dateJst: string): string {
  return `${supabaseUrl.replace(/\/$/u, "")}/storage/v1/object/morning-greeting-assets/published/${
    encodeURIComponent(`${dateJst}.json`)
  }`;
}

async function previouslyPublishedPostId(args: {
  supabaseUrl: string;
  serviceRoleKey: string;
  dateJst: string;
  fetchImpl: FetchLike;
}): Promise<string | null> {
  const response = await args.fetchImpl(
    publishedReceiptUrl(args.supabaseUrl, args.dateJst),
    {
      headers: {
        ...supabaseHeaders(args.serviceRoleKey),
        Range: "bytes=0-1023",
      },
    },
  );
  if (response.ok || response.status === 206) {
    const receipt = await responseJson(response) as { x_post_id?: unknown } | null;
    if (typeof receipt?.x_post_id !== "string" || !receipt.x_post_id) {
      throw new Error("MORNING_GREETING_PUBLISH_RECEIPT_INVALID");
    }
    return receipt.x_post_id;
  }
  const errorText = await response.text();
  const isMissing = response.status === 404 || (
    response.status === 400 && /object\s+not\s+found/iu.test(errorText)
  );
  if (isMissing) return null;
  throw new Error(`MORNING_GREETING_DUPLICATE_CHECK_FAILED:${response.status}`);
}

function responseDataId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const data = (value as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const id = (data as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function runMorningGreetingManualPublish(args: {
  supabaseUrl: string;
  serviceRoleKey: string;
  openAiApiKey: string;
  xAccessToken: string;
  now?: Date;
  fetchImpl?: FetchLike;
  buildPayload?: (args: {
    supabaseUrl: string;
    serviceRoleKey: string;
    openAiApiKey: string;
    now?: Date;
    fetchImpl?: FetchLike;
  }) => Promise<MorningGreetingPayloadDryRunResult>;
}): Promise<MorningGreetingManualPublishResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const dateJst = resolveMorningGreetingJstDate(args.now);
  const imagePath = `storage://morning-greeting-assets/generated/${dateJst}.png`;
  let imageUploadSucceeded = false;
  let xApiCalled = 0;
  let xPostApiCalled = 0;
  let xPosted = false;
  let xPostId: string | null = null;
  let claimed = false;

  try {
    const existingPostId = await previouslyPublishedPostId({
      supabaseUrl: args.supabaseUrl,
      serviceRoleKey: args.serviceRoleKey,
      dateJst,
      fetchImpl,
    });
    if (existingPostId) {
      return {
        success: true,
        skipped: true,
        already_posted: true,
        date_jst: dateJst,
        text: null,
        theme: null,
        image_path: imagePath,
        image_exists: true,
        theme_match: true,
        payload_ready: false,
        image_upload_succeeded: false,
        x_api_called: 0,
        x_post_api_called: 0,
        x_posted: false,
        x_post_id: existingPostId,
        retry_count: 0,
      };
    }

    // The atomic DB claim, not the Storage receipt check above, is what actually guarantees at most one
    // execution ever reaches the X API calls below for this date — the receipt check is TOCTOU-racy on
    // its own and kept only for backward compatibility.
    const claim = await claimPublishSlot({
      supabaseUrl: args.supabaseUrl,
      serviceRoleKey: args.serviceRoleKey,
      postType: MORNING_GREETING_PUBLISH_CLAIM_POST_TYPE,
      dateJst,
      executionId: crypto.randomUUID(),
      fetcher: fetchImpl,
    });
    if (!claim.claimed) throw new Error("MORNING_GREETING_PUBLISH_ALREADY_CLAIMED");
    claimed = true;

    const payload = await (args.buildPayload ?? runMorningGreetingPayloadDryRun)({
      supabaseUrl: args.supabaseUrl,
      serviceRoleKey: args.serviceRoleKey,
      openAiApiKey: args.openAiApiKey,
      now: args.now,
      fetchImpl,
    });
    if (!payload.image_exists) throw new Error("MORNING_GREETING_IMAGE_NOT_FOUND");
    if (!payload.theme_match) throw new Error("MORNING_GREETING_THEME_MISMATCH");
    if (!payload.payload_ready) throw new Error("MORNING_GREETING_PAYLOAD_NOT_READY");

    const imageResponse = await fetchImpl(
      morningGreetingStorageObjectUrl(args.supabaseUrl, dateJst),
      { headers: supabaseHeaders(args.serviceRoleKey) },
    );
    if (!imageResponse.ok) throw new Error(`MORNING_GREETING_IMAGE_DOWNLOAD_FAILED:${imageResponse.status}`);
    const imageBytes = await imageResponse.arrayBuffer();
    if (imageBytes.byteLength === 0) throw new Error("MORNING_GREETING_IMAGE_EMPTY");

    const form = new FormData();
    form.append("media", new Blob([imageBytes], { type: "image/png" }), `${dateJst}.png`);
    form.append("media_category", "tweet_image");
    xApiCalled += 1;
    const mediaResponse = await fetchImpl(X_MEDIA_UPLOAD_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${args.xAccessToken}` },
      body: form,
    });
    const mediaBody = await responseJson(mediaResponse);
    if (!mediaResponse.ok) throw new Error(`MORNING_GREETING_MEDIA_UPLOAD_FAILED:${mediaResponse.status}`);
    const mediaId = responseDataId(mediaBody);
    if (!mediaId) throw new Error("MORNING_GREETING_MEDIA_ID_MISSING");
    imageUploadSucceeded = true;

    xApiCalled += 1;
    xPostApiCalled += 1;
    const postResponse = await fetchImpl(X_POST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.xAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: payload.text,
        made_with_ai: true,
        media: { media_ids: [mediaId] },
      }),
    });
    const postBody = await responseJson(postResponse);
    if (!postResponse.ok) throw new Error(`MORNING_GREETING_X_POST_FAILED:${postResponse.status}`);
    xPostId = responseDataId(postBody);
    if (!xPostId) throw new Error("MORNING_GREETING_X_POST_ID_MISSING");
    xPosted = true;

    // The DB claim is the authoritative "this date is published" record; it is updated before the legacy
    // Storage receipt so that record stays correct even if the receipt write below fails.
    await completePublishSlot({
      supabaseUrl: args.supabaseUrl,
      serviceRoleKey: args.serviceRoleKey,
      postType: MORNING_GREETING_PUBLISH_CLAIM_POST_TYPE,
      dateJst,
      xPostId,
      fetcher: fetchImpl,
    });

    const recordResponse = await fetchImpl(
      publishedReceiptUrl(args.supabaseUrl, dateJst),
      {
        method: "POST",
        headers: {
          ...supabaseHeaders(args.serviceRoleKey),
          "Content-Type": "application/json",
          "x-upsert": "false",
        },
        body: JSON.stringify({
          date_jst: dateJst,
          x_post_id: xPostId,
          recorded_at: new Date().toISOString(),
        }),
      },
    );
    if (!recordResponse.ok) {
      throw new Error(`MORNING_GREETING_X_POST_RECORD_FAILED:${recordResponse.status}`);
    }

    return {
      success: true,
      skipped: false,
      already_posted: false,
      date_jst: dateJst,
      text: payload.text,
      theme: payload.theme,
      image_path: payload.image_path,
      image_exists: true,
      theme_match: true,
      payload_ready: true,
      image_upload_succeeded: true,
      x_api_called: xApiCalled,
      x_post_api_called: xPostApiCalled,
      x_posted: true,
      x_post_id: xPostId,
      retry_count: 0,
    };
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    // Best-effort only: if the row already transitioned to 'published' this is a safe no-op (the
    // status=publishing filter matches nothing), and a failure to record 'failed' here must never mask
    // the original error or be treated as license to retry.
    if (claimed && code !== "MORNING_GREETING_PUBLISH_ALREADY_CLAIMED") {
      try {
        await failPublishSlot({
          supabaseUrl: args.supabaseUrl,
          serviceRoleKey: args.serviceRoleKey,
          postType: MORNING_GREETING_PUBLISH_CLAIM_POST_TYPE,
          dateJst,
          errorCode: code,
          fetcher: fetchImpl,
        });
      } catch { /* best-effort; the original error below still surfaces */ }
    }
    throw new MorningGreetingManualPublishError(
      code,
      { imageUploadSucceeded, xApiCalled, xPostApiCalled, xPosted, xPostId },
    );
  }
}
