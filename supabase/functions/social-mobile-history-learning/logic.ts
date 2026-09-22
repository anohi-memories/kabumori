/**
 * Phase 16 source candidate: server-side, read-only X history learning.
 *
 * The mobile client supplies only the Auth bearer, an optional workspace
 * selector, and a fresh explicit consent action. Every identity used for the
 * X request is resolved from trusted server-side records.
 */

import {
  HistoryAccessTokenReadError,
  readVerifiedHistoryAccessToken,
  type TrustedHistoryAccountBinding,
} from "../_shared/brand/social_mobile_history_access_reader.ts";

export const MAX_HISTORY_POSTS = 50;
export const MAX_HISTORY_PAGES = 2;

type JsonRecord = Record<string, unknown>;

export type HistoryLearningRequest = {
  authorization?: string;
  requestedWorkspaceId?: string | null;
  explicitConsent?: boolean;
};

export type AuthUser = { id: string };
export type OwnerMembership = { workspaceId: string; role: string };
export type TrustedWorkspace = { id: string; ownerUserId: string };
export type TrustedXAccount = {
  id: string;
  workspaceId: string;
  platform: string;
  connectionStatus: string;
  platformUserId: string | null;
  handle: string | null;
  accessTokenSecretRef: string | null;
};

export type XHistoryPost = {
  id: string;
  text: string;
  created_at?: string;
  in_reply_to_user_id?: string;
  referenced_tweets?: Array<{ type?: string }>;
};

export type XHistoryPage = {
  data?: XHistoryPost[];
  meta?: { next_token?: string; result_count?: number };
};

export type HistoryLearningDependencies = {
  readAuthUser: (bearer: string) => Promise<AuthUser | null>;
  readOwnerMemberships: (userId: string, bearer: string) => Promise<OwnerMembership[]>;
  readWorkspace: (workspaceId: string, bearer: string) => Promise<TrustedWorkspace | null>;
  readXAccounts: (workspaceId: string, bearer: string) => Promise<TrustedXAccount[]>;
  readAccessToken: (secretRef: string) => Promise<string | null>;
  fetchXPage: (input: {
    platformUserId: string;
    accessToken: string;
    paginationToken?: string;
  }) => Promise<XHistoryPage>;
  now?: () => string;
};

export type PersonaProposal = {
  confirmed: false;
  provenance: "past_post_analysis";
  tone: "short" | "long" | "mixed";
  punctuationEmoji: string;
  recurringVocabulary: string[];
  hashtagHabits: string;
  ctaStyle: string;
  analyzedPostCount: number;
  analyzedAt: string;
};

export type HistoryLearningResult = {
  success: true;
  status: "history_learning_proposal";
  targetHandle: string | null;
  analyzedPostCount: number;
  maxPosts: number;
  maxPages: number;
  persona: PersonaProposal;
  xApiCalled: true;
};

export class HistoryLearningError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = "HistoryLearningError";
  }
}

function bearerFromHeader(value: string | undefined): string {
  const match = /^Bearer\s+([^\s]+)$/iu.exec(value?.trim() ?? "");
  if (!match?.[1]) throw new HistoryLearningError("AUTH_REQUIRED", 401);
  return match[1];
}

function assertTrustedAccount(accounts: TrustedXAccount[], workspaceId: string): TrustedXAccount {
  const xAccounts = accounts.filter((account) => account.platform === "x" && account.workspaceId === workspaceId);
  const verified = accounts.filter((account) =>
    account.workspaceId === workspaceId &&
    account.platform === "x" &&
    account.connectionStatus === "identity_verified" &&
    typeof account.platformUserId === "string" && account.platformUserId.trim() &&
    typeof account.accessTokenSecretRef === "string" && account.accessTokenSecretRef.trim()
  );
  if (xAccounts.length !== 1 || verified.length !== 1) {
    throw new HistoryLearningError("HISTORY_ACCOUNT_NOT_CONFIGURED", 409);
  }
  return verified[0];
}

function normalizePosts(page: XHistoryPage): XHistoryPost[] {
  if (!Array.isArray(page.data)) return [];
  return page.data.filter((post) => {
    if (!post || typeof post.id !== "string" || typeof post.text !== "string") return false;
    if (post.in_reply_to_user_id) return false;
    return !(post.referenced_tweets ?? []).some((reference) => reference?.type === "retweeted");
  }).map((post) => ({
    id: post.id,
    text: post.text.slice(0, 4000),
    created_at: post.created_at,
  }));
}

function derivePersona(posts: readonly XHistoryPost[], analyzedAt: string): PersonaProposal {
  const texts = posts.map((post) => post.text.trim()).filter(Boolean).slice(0, MAX_HISTORY_POSTS);
  const averageLength = texts.length ? texts.reduce((sum, text) => sum + text.length, 0) / texts.length : 0;
  const allText = texts.join(" ");
  const punctuationEmoji = [
    /[！!]/u.test(allText) ? "感嘆符" : "",
    /[？?]/u.test(allText) ? "疑問符" : "",
    /[☀️🌱😊✨]/u.test(allText) ? "絵文字" : "",
  ].filter(Boolean).join("・") || "標準的な句読点";
  // Keep vocabulary as short derived signals; never return a long contiguous
  // substring that could reconstruct a raw post body.
  const vocabulary = [...new Set((allText.match(/[ぁ-んァ-ヶ一-龠A-Za-z]{3,}/gu) ?? []).map((word) => word.slice(0, 6)))].slice(0, 20);
  const hashtags = [...new Set(texts.flatMap((text) => text.match(/#[\p{L}\p{N}_-]+/gu) ?? []))].slice(0, 20);
  return {
    confirmed: false,
    provenance: "past_post_analysis",
    tone: averageLength < 70 ? "short" : averageLength > 180 ? "long" : "mixed",
    punctuationEmoji,
    recurringVocabulary: vocabulary,
    hashtagHabits: hashtags.length ? hashtags.join(" ") : "ハッシュタグ少なめ",
    ctaStyle: texts.some((text) => /ぜひ|参考|チェック|教えて|どう思/iu.test(text)) ? "読者への問いかけ・行動提案あり" : "強いCTAは目立たない",
    analyzedPostCount: texts.length,
    analyzedAt,
  };
}

/**
 * Resolves all authority server-side and fetches only the verified account's
 * own posts. The access token is deliberately not present in the return type.
 */
export async function runHistoryLearning(
  input: HistoryLearningRequest,
  deps: HistoryLearningDependencies,
): Promise<HistoryLearningResult> {
  if (input.explicitConsent !== true) {
    throw new HistoryLearningError("HISTORY_CONSENT_REQUIRED", 400);
  }
  const bearer = bearerFromHeader(input.authorization);
  const authUser = await deps.readAuthUser(bearer);
  if (!authUser?.id) throw new HistoryLearningError("AUTH_REQUIRED", 401);

  const memberships = (await deps.readOwnerMemberships(authUser.id, bearer)).filter((row) => row.role === "owner" && row.workspaceId);
  const selectedWorkspaceId = input.requestedWorkspaceId?.trim() || null;
  if (selectedWorkspaceId && !memberships.some((row) => row.workspaceId === selectedWorkspaceId)) {
    throw new HistoryLearningError("HISTORY_WORKSPACE_FORBIDDEN", 403);
  }
  if (!selectedWorkspaceId && memberships.length !== 1) {
    throw new HistoryLearningError(memberships.length ? "HISTORY_WORKSPACE_SELECTION_REQUIRED" : "HISTORY_WORKSPACE_FORBIDDEN", memberships.length ? 409 : 403);
  }
  const workspaceId = selectedWorkspaceId ?? memberships[0].workspaceId;
  const workspace = await deps.readWorkspace(workspaceId, bearer);
  if (!workspace || workspace.ownerUserId !== authUser.id) {
    throw new HistoryLearningError("HISTORY_WORKSPACE_FORBIDDEN", 403);
  }
  const account = assertTrustedAccount(await deps.readXAccounts(workspaceId, bearer), workspaceId);
  let accessToken: string;
  try {
    const binding: TrustedHistoryAccountBinding = {
      accountId: account.id,
      workspaceId: workspace.id,
      platform: "x",
      connectionStatus: "identity_verified",
      platformUserId: account.platformUserId!,
      accessTokenSecretRef: account.accessTokenSecretRef!,
    };
    accessToken = await readVerifiedHistoryAccessToken(binding, {
      readAccessToken: deps.readAccessToken,
    });
  } catch (error) {
    if (error instanceof HistoryAccessTokenReadError) {
      throw new HistoryLearningError(error.code, error.code === "HISTORY_ACCOUNT_NOT_CONFIGURED" ? 409 : 503);
    }
    throw error;
  }

  const posts: XHistoryPost[] = [];
  let nextToken: string | undefined;
  for (let page = 0; page < MAX_HISTORY_PAGES && posts.length < MAX_HISTORY_POSTS; page += 1) {
    const result = await deps.fetchXPage({
      platformUserId: account.platformUserId!,
      accessToken,
      ...(nextToken ? { paginationToken: nextToken } : {}),
    });
    posts.push(...normalizePosts(result).slice(0, MAX_HISTORY_POSTS - posts.length));
    nextToken = result.meta?.next_token;
    if (!nextToken) break;
  }
  return {
    success: true,
    status: "history_learning_proposal",
    targetHandle: account.handle,
    analyzedPostCount: posts.length,
    maxPosts: MAX_HISTORY_POSTS,
    maxPages: MAX_HISTORY_PAGES,
    persona: derivePersona(posts, deps.now?.() ?? new Date().toISOString()),
    xApiCalled: true,
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeResponse(body: JsonRecord, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
  });
}

/** Provider failures are intentionally reduced to stable client-safe codes. */
export function normalizeXHistoryError(error: unknown): HistoryLearningError {
  const status = isRecord(error) && typeof error.status === "number" ? error.status : 0;
  if (status === 401 || status === 403) return new HistoryLearningError("X_HISTORY_UNAUTHORIZED", 502);
  if (status === 429) return new HistoryLearningError("X_HISTORY_RATE_LIMITED", 429);
  return new HistoryLearningError("X_HISTORY_UNAVAILABLE", 502);
}

/** Read-only X adapter. It is injected in tests and is not enabled by the
 * default Edge entrypoint below. */
export function createXHistoryPageFetcher(
  fetchImpl: typeof fetch = fetch,
  apiBaseUrl = "https://api.x.com",
): HistoryLearningDependencies["fetchXPage"] {
  return async ({ platformUserId, accessToken, paginationToken }) => {
    const url = new URL(`/2/users/${encodeURIComponent(platformUserId)}/tweets`, apiBaseUrl);
    url.searchParams.set("max_results", String(MAX_HISTORY_POSTS));
    url.searchParams.set("tweet.fields", "created_at,text,in_reply_to_user_id,referenced_tweets");
    url.searchParams.set("exclude", "replies,retweets");
    if (paginationToken) url.searchParams.set("pagination_token", paginationToken);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      });
    } catch {
      throw new HistoryLearningError("X_HISTORY_UNAVAILABLE", 502);
    }
    if (!response.ok) throw { status: response.status };
    try {
      const body: unknown = await response.json();
      return isRecord(body) ? body as unknown as XHistoryPage : { data: [] };
    } catch {
      throw new HistoryLearningError("X_HISTORY_BAD_RESPONSE", 502);
    }
  };
}

export async function handleHistoryLearningRequest(
  request: Request,
  deps: HistoryLearningDependencies,
): Promise<Response> {
  if (request.method === "OPTIONS") return new Response("ok", { status: 200 });
  if (request.method !== "POST") return safeResponse({ success: false, error: "METHOD_NOT_ALLOWED" }, 405);
  try {
    let body: unknown = {};
    try { body = await request.json(); } catch { throw new HistoryLearningError("REQUEST_BODY_INVALID", 400); }
    const bodyRecord = isRecord(body) ? body : {};
    const result = await runHistoryLearning({
      authorization: request.headers.get("Authorization") ?? undefined,
      requestedWorkspaceId: typeof bodyRecord.workspace_id === "string" ? bodyRecord.workspace_id : null,
      explicitConsent: bodyRecord.explicit_consent === true,
    }, deps);
    return safeResponse(result as unknown as JsonRecord);
  } catch (error) {
    const normalized = error instanceof HistoryLearningError ? error : normalizeXHistoryError(error);
    return safeResponse({ success: false, error: normalized.code }, normalized.status);
  }
}

/** No production Vault/X adapter is enabled by default in this source candidate. */
export function disabledHistoryLearningDependencies(): HistoryLearningDependencies {
  const unavailable = async () => null;
  return {
    readAuthUser: unavailable,
    readOwnerMemberships: async () => [],
    readWorkspace: unavailable,
    readXAccounts: async () => [],
    readAccessToken: unavailable,
    fetchXPage: async () => { throw new HistoryLearningError("X_HISTORY_UNAVAILABLE", 502); },
  };
}
