// G6-25 (2026-10-29): the REFERENCE caller of POST /functions/v1/postona-post-assist for G1 (the POSTONA app). G6 owns this
// file and its contract test (postona_post_assist_client_contract_test.ts); it is NOT app code. G1 copies it into the app
// (apps/social-mobile/src/data/, the same shape as consult-client.ts) and wires it to its own screen; G6 never edits the app.
// Plain TypeScript (no Deno / React Native API), so the same file runs in the app and in the test.
//
// What the screen may rely on:
//   * candidates are only ever shown for editing: every one is editable and must be confirmed by the person; nothing is
//     posted from here (posting stays on the existing publish screen, after the person's own confirmation);
//   * one Idempotency-Key per press of the button; the same key only when the state says retry_same_key;
//   * anything that does not match the contract exactly is shown as "unavailable", never as a candidate.

/** The slice of the Supabase client this needs (supabase-js FunctionsClient.invoke), as consult-client.ts. */
export type PostAssistFunctionsClient = {
  functions: {
    invoke: (name: string, options: { body: Record<string, unknown>; headers: Record<string, string> }) => Promise<{ data: unknown; error: unknown }>;
  };
};

export const POST_ASSIST_FUNCTION = "postona-post-assist";
export type PostAssistPlatform = "x" | "threads";
export type PostAssistInput =
  | Readonly<{ brandId: string; mode: "draft"; platform: PostAssistPlatform; notes: string }>
  | Readonly<{ brandId: string; mode: "refine"; platform: PostAssistPlatform; draft: string; instruction: string }>
  | Readonly<{ brandId: string; mode: "hashtags"; platform: PostAssistPlatform; draft: string }>;
export type PostAssistCandidate = Readonly<{
  platform: PostAssistPlatform;
  text: string;
  hashtags: readonly string[];
  length: number;
  limit: number;
  editable: true;
  requiresUserConfirmation: true;
}>;
/** What the screen shows. `retry_same_key` is the only state in which the same Idempotency-Key may be sent again. */
export type PostAssistUiState =
  | Readonly<{ kind: "candidates"; candidates: readonly PostAssistCandidate[]; notice: string }>
  | Readonly<{ kind: "relogin" }> // 401 (the endpoint's or Supabase's gateway's): sign in again
  | Readonly<{ kind: "not_available" }> // 403: not signed in / expired / another workspace / no plan / stopped (a new key after refreshing the session)
  | Readonly<{ kind: "retry_same_key" }> // 409 IN_PROGRESS, or 503 with retry_same_key: wait a little, same key
  | Readonly<{ kind: "new_key_needed"; code: string }> // 409 OPERATION_REUSED, 502: the result is stored for that key; a retry needs a new key
  | Readonly<{ kind: "quota" }> // 429
  | Readonly<{ kind: "invalid_input" }> // 400 / 405 / 415: fix the input (an app bug for 405 / 415)
  | Readonly<{ kind: "unavailable" }>; // 503 without retry, 403 ORIGIN_REFUSED, anything unexpected: nothing to show

const CANDIDATE_KEYS = "editable,hashtags,length,limit,platform,requiresUserConfirmation,text";
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/u;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A new key for one press of the button (the app passes its own random UUID source). */
export function newPostAssistKey(uuid: () => string): string {
  const key = `pa-${uuid()}`;
  if (!IDEMPOTENCY_KEY.test(key)) throw new Error("POST_ASSIST_KEY_INVALID");
  return key;
}

/** The request body: exactly the fields of the mode, nothing else (no user id, no session id, no token). */
export function buildPostAssistBody(input: PostAssistInput): Record<string, string> {
  const base = { brand_id: input.brandId, mode: input.mode, platform: input.platform };
  if (input.mode === "draft") return { ...base, notes: input.notes };
  if (input.mode === "refine") return { ...base, draft: input.draft, instruction: input.instruction };
  return { ...base, draft: input.draft };
}

function candidateOf(v: unknown, platform: PostAssistPlatform): PostAssistCandidate | null {
  if (!isRecord(v) || Object.keys(v).sort().join(",") !== CANDIDATE_KEYS) return null;
  if (v.platform !== platform || v.editable !== true || v.requiresUserConfirmation !== true) return null;
  if (typeof v.text !== "string" || v.text === "" || !Array.isArray(v.hashtags) || !v.hashtags.every((h) => typeof h === "string")) return null;
  if (typeof v.length !== "number" || typeof v.limit !== "number" || v.length > v.limit) return null;
  return Object.freeze({ platform, text: v.text, hashtags: Object.freeze([...(v.hashtags as string[])]), length: v.length, limit: v.limit, editable: true, requiresUserConfirmation: true });
}

/** The answer (status + JSON body) -> what the screen shows. */
export function postAssistStateOf(status: number, body: unknown, platform: PostAssistPlatform): PostAssistUiState {
  if (status === 200) {
    if (!isRecord(body) || Object.keys(body).sort().join(",") !== "candidates,notice" || typeof body.notice !== "string" || !Array.isArray(body.candidates)) return { kind: "unavailable" };
    const candidates = body.candidates.map((c) => candidateOf(c, platform));
    if (candidates.length === 0 || candidates.some((c) => c === null)) return { kind: "unavailable" };
    return Object.freeze({ kind: "candidates", candidates: Object.freeze(candidates as PostAssistCandidate[]), notice: body.notice });
  }
  // G6-26: a 401 means "sign in again" whoever answered it. With verify_jwt on (the deploy default), Supabase's gateway answers an expired
  // or broken token itself, with its own body ({code,message,msg}), before the endpoint runs.
  if (status === 401) return { kind: "relogin" };
  if (!isRecord(body) || Object.keys(body).sort().join(",") !== "error,retry_same_key" || typeof body.error !== "string" || typeof body.retry_same_key !== "boolean") {
    return { kind: "unavailable" };
  }
  const code = body.error;
  if (status === 403 && code === "POST_ASSIST_NOT_ENTITLED") return { kind: "not_available" };
  if (status === 409 && code === "POST_ASSIST_IN_PROGRESS" && body.retry_same_key) return { kind: "retry_same_key" };
  if (status === 503 && body.retry_same_key) return { kind: "retry_same_key" };
  if ((status === 409 && code === "POST_ASSIST_OPERATION_REUSED") || (status === 502 && /^POST_ASSIST_AI_(UNKNOWN|FAILED|UNUSABLE)$/u.test(code))) {
    return { kind: "new_key_needed", code };
  }
  if (status === 429 && code === "POST_ASSIST_QUOTA_EXCEEDED") return { kind: "quota" };
  if ([400, 405, 415].includes(status) && /^POST_ASSIST_(REQUEST_INVALID|IDEMPOTENCY_KEY_REQUIRED)$/u.test(code)) return { kind: "invalid_input" };
  return { kind: "unavailable" };
}

/**
 * One request. The access token is the person's own (the Supabase session's access_token); the Edge Function never takes a
 * user id from the app. Never throws.
 */
export async function requestPostAssist(
  client: PostAssistFunctionsClient,
  accessToken: string,
  idempotencyKey: string,
  input: PostAssistInput,
): Promise<PostAssistUiState> {
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) return { kind: "invalid_input" };
  try {
    const { data, error } = await client.functions.invoke(POST_ASSIST_FUNCTION, {
      body: buildPostAssistBody(input),
      headers: { Authorization: `Bearer ${accessToken}`, "Idempotency-Key": idempotencyKey },
    });
    if (!error) return postAssistStateOf(200, data, input.platform);
    // supabase-js: a non-2xx answer is an error whose context is the Response; its body carries the endpoint's code.
    const context = (error as { context?: unknown }).context;
    if (!(context instanceof Response)) return { kind: "unavailable" };
    let body: unknown = null;
    try {
      body = await context.clone().json();
    } catch { /* no JSON body */ }
    return postAssistStateOf(context.status, body, input.platform);
  } catch {
    return { kind: "unavailable" };
  }
}
