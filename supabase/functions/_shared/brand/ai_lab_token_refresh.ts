import { BrandContextError } from "./brand_context.ts";

export type AiLabTokenPair = {
  accessToken: string;
  refreshToken: string;
};

export type AiLabRefreshContext = {
  brandId: string;
  socialAccountId: string;
  handle: string;
};

export type AiLabVaultTokenReference = {
  socialAccountId: string;
  accessTokenSecretRef: string;
  refreshTokenSecretRef: string;
};

export type AiLabPublishResult = {
  status: number;
  body: unknown;
};

export type PersistAiLabTokens = (args: {
  tokenReference: AiLabVaultTokenReference;
  tokens: AiLabTokenPair;
  expectedRefreshToken: string;
  refreshTokenRotated: boolean;
}) => Promise<void>;

export type RefreshAiLabTokensArgs = {
  context: AiLabRefreshContext;
  tokenReference: AiLabVaultTokenReference;
  currentTokens: AiLabTokenPair;
  clientId: string;
  clientSecret: string;
  tokenEndpoint: string;
  persist: PersistAiLabTokens;
  fetchImpl?: typeof fetch;
};

export type PublishAiLabWithRefreshArgs = RefreshAiLabTokensArgs & {
  publish: (accessToken: string) => Promise<AiLabPublishResult>;
};

export type PublishAiLabWithRefreshResult = {
  publishResult: AiLabPublishResult;
  tokens: AiLabTokenPair;
  refreshExecuted: boolean;
};

function assertAiLabScope(
  context: AiLabRefreshContext,
  tokenReference: AiLabVaultTokenReference,
): void {
  if (
    context.brandId !== "ai_salaryman_lab" ||
    context.socialAccountId !== "ai_salaryman_lab_x" ||
    context.handle !== "kaishain_ai_lab" ||
    tokenReference.socialAccountId !== "ai_salaryman_lab_x"
  ) {
    throw new BrandContextError("AI_LAB_REFRESH_SCOPE_MISMATCH");
  }
  if (
    !/^[0-9a-f-]{36}$/iu.test(tokenReference.accessTokenSecretRef) ||
    !/^[0-9a-f-]{36}$/iu.test(tokenReference.refreshTokenSecretRef)
  ) {
    throw new BrandContextError("AI_LAB_REFRESH_TOKEN_REFERENCE_INVALID");
  }
}

function assertTokenPair(tokens: AiLabTokenPair): void {
  if (!tokens.accessToken || !tokens.refreshToken) {
    throw new Error("AI_LAB_REFRESH_TOKEN_MISSING");
  }
}

/**
 * Exchanges the AI Lab refresh token once. The caller owns the Vault writer so
 * this module cannot accidentally select another brand or token store.
 */
export async function refreshAiLabTokens({
  context,
  tokenReference,
  currentTokens,
  clientId,
  clientSecret,
  tokenEndpoint,
  persist,
  fetchImpl = fetch,
}: RefreshAiLabTokensArgs): Promise<AiLabTokenPair> {
  assertAiLabScope(context, tokenReference);
  assertTokenPair(currentTokens);
  if (!clientId || !clientSecret || !tokenEndpoint) {
    throw new Error("AI_LAB_REFRESH_NOT_CONFIGURED");
  }

  let response: Response;
  try {
    response = await fetchImpl(tokenEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: currentTokens.refreshToken,
        client_id: clientId,
      }),
    });
  } catch {
    throw new Error("AI_LAB_TOKEN_REFRESH_FAILED:network");
  }
  if (!response.ok) {
    throw new Error(`AI_LAB_TOKEN_REFRESH_FAILED:${response.status}`);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await response.json() as Record<string, unknown>;
  } catch {
    throw new Error("AI_LAB_TOKEN_REFRESH_INVALID_RESPONSE");
  }
  const accessToken = payload.access_token;
  if (typeof accessToken !== "string" || !accessToken) {
    throw new Error("AI_LAB_TOKEN_REFRESH_INVALID_RESPONSE");
  }
  const rotatedRefreshToken = payload.refresh_token;
  const refreshToken =
    typeof rotatedRefreshToken === "string" && rotatedRefreshToken
      ? rotatedRefreshToken
      : currentTokens.refreshToken;
  const tokens = { accessToken, refreshToken };

  // Persist before retrying X. If Vault persistence is uncertain, fail closed
  // rather than posting with a token that cannot be recovered on the next run.
  try {
    await persist({
      tokenReference,
      tokens,
      expectedRefreshToken: currentTokens.refreshToken,
      refreshTokenRotated: refreshToken !== currentTokens.refreshToken,
    });
  } catch (error) {
    if (
      error instanceof Error && error.message === "AI_LAB_TOKEN_REFRESH_STALE"
    ) {
      throw error;
    }
    throw new Error("AI_LAB_TOKEN_PERSIST_FAILED");
  }
  return tokens;
}

/**
 * Sends one publish request and, only for the first 401, refreshes once and
 * retries that same request once. Network/unknown completion errors are thrown
 * without retry so the caller's completion guard can prevent duplicates.
 */
export async function publishAiLabWithRefresh({
  publish,
  ...refreshArgs
}: PublishAiLabWithRefreshArgs): Promise<PublishAiLabWithRefreshResult> {
  assertAiLabScope(refreshArgs.context, refreshArgs.tokenReference);
  assertTokenPair(refreshArgs.currentTokens);
  let tokens = refreshArgs.currentTokens;
  let result: AiLabPublishResult;
  try {
    result = await publish(tokens.accessToken);
  } catch {
    throw new Error("AI_LAB_PUBLISH_UNCERTAIN");
  }
  if (result.status >= 200 && result.status < 300) {
    return { publishResult: result, tokens, refreshExecuted: false };
  }
  if (result.status !== 401) {
    throw new Error(`AI_LAB_PUBLISH_FAILED:${result.status}`);
  }

  tokens = await refreshAiLabTokens({
    ...refreshArgs,
    currentTokens: tokens,
  });
  try {
    result = await publish(tokens.accessToken);
  } catch {
    throw new Error("AI_LAB_PUBLISH_UNCERTAIN");
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`AI_LAB_PUBLISH_FAILED:${result.status}`);
  }
  return { publishResult: result, tokens, refreshExecuted: true };
}
