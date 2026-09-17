import {
  type AiLabTokenPair,
  type AiLabVaultTokenReference,
  type PersistAiLabTokens,
} from "./ai_lab_token_refresh.ts";

type SqlSession = {
  unsafe<T = unknown>(query: string, values?: readonly unknown[]): Promise<T>;
};

export type AiLabVaultSqlClient = SqlSession & {
  begin<T>(callback: (transaction: SqlSession) => Promise<T>): Promise<T>;
  end(): Promise<void>;
};

export type AiLabVaultSqlFactory = (
  databaseUrl: string,
) => Promise<AiLabVaultSqlClient>;

const AI_LAB_LOCK_KEY = "kabumori:ai_salaryman_lab_x:vault-token-rotation";

function assertReference(reference: AiLabVaultTokenReference): void {
  if (
    reference.socialAccountId !== "ai_salaryman_lab_x" ||
    !/^[0-9a-f-]{36}$/iu.test(reference.accessTokenSecretRef) ||
    !/^[0-9a-f-]{36}$/iu.test(reference.refreshTokenSecretRef)
  ) {
    throw new Error("AI_LAB_REFRESH_TOKEN_REFERENCE_INVALID");
  }
}

function assertTokens(tokens: AiLabTokenPair): void {
  if (!tokens.accessToken || !tokens.refreshToken) {
    throw new Error("AI_LAB_REFRESH_TOKEN_MISSING");
  }
}

/**
 * Opens a short-lived direct Postgres connection. Vault's SQL API is private
 * and is intentionally not exposed through a public PostgREST writer RPC.
 */
async function defaultSqlFactory(
  databaseUrl: string,
): Promise<AiLabVaultSqlClient> {
  if (!databaseUrl) throw new Error("AI_LAB_VAULT_WRITER_NOT_CONFIGURED");
  const module = await import("npm:postgres@3.4.5");
  const postgres = module.default as unknown as (
    url: string,
    options?: Record<string, unknown>,
  ) => AiLabVaultSqlClient;
  return postgres(databaseUrl, { max: 1, idle_timeout: 5 });
}

/**
 * Creates the AI Lab-only Vault writer used after a successful X refresh.
 *
 * The advisory transaction lock serializes refreshes across Edge isolates.
 * Re-reading the refresh secret while holding that lock provides a guarded
 * compare-and-set: a second refresher with an old token fails before writing.
 * Both Vault updates are in the same transaction, and the refresh secret is
 * not touched when X did not rotate it.
 */
export function createAiLabVaultTokenPersistence({
  databaseUrl,
  sqlFactory = defaultSqlFactory,
}: {
  databaseUrl: string;
  sqlFactory?: AiLabVaultSqlFactory;
}): PersistAiLabTokens {
  return async ({
    tokenReference,
    tokens,
    expectedRefreshToken,
    refreshTokenRotated,
  }) => {
    assertReference(tokenReference);
    assertTokens(tokens);
    if (!expectedRefreshToken) {
      throw new Error("AI_LAB_REFRESH_TOKEN_MISSING");
    }

    let client: AiLabVaultSqlClient;
    try {
      client = await sqlFactory(databaseUrl);
    } catch {
      throw new Error("AI_LAB_TOKEN_PERSIST_FAILED");
    }

    let operationError: unknown = null;
    try {
      await client.begin(async (transaction) => {
        await transaction.unsafe(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [AI_LAB_LOCK_KEY],
        );
        const rows = await transaction.unsafe<
          Array<{ decrypted_secret?: unknown }>
        >(
          "select decrypted_secret from vault.decrypted_secrets where id = $1::uuid",
          [tokenReference.refreshTokenSecretRef],
        );
        const currentRefreshToken = rows[0]?.decrypted_secret;
        if (currentRefreshToken !== expectedRefreshToken) {
          throw new Error("AI_LAB_TOKEN_REFRESH_STALE");
        }

        await transaction.unsafe(
          "select vault.update_secret($1::uuid, $2::text)",
          [tokenReference.accessTokenSecretRef, tokens.accessToken],
        );
        if (refreshTokenRotated) {
          await transaction.unsafe(
            "select vault.update_secret($1::uuid, $2::text)",
            [tokenReference.refreshTokenSecretRef, tokens.refreshToken],
          );
        }
      });
    } catch (error) {
      operationError = error;
    }

    let closeError = false;
    try {
      await client.end();
    } catch {
      closeError = true;
    }

    if (
      operationError instanceof Error &&
      operationError.message === "AI_LAB_TOKEN_REFRESH_STALE"
    ) {
      throw operationError;
    }
    if (operationError || closeError) {
      throw new Error("AI_LAB_TOKEN_PERSIST_FAILED");
    }
  };
}
