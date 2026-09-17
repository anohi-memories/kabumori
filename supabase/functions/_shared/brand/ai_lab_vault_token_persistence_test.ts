import assert from "node:assert/strict";
import test from "node:test";
import {
  type AiLabVaultSqlClient,
  createAiLabVaultTokenPersistence,
} from "./ai_lab_vault_token_persistence.ts";
import type { AiLabVaultTokenReference } from "./ai_lab_token_refresh.ts";

const reference: AiLabVaultTokenReference = {
  socialAccountId: "ai_salaryman_lab_x",
  accessTokenSecretRef: "11111111-1111-4111-8111-111111111111",
  refreshTokenSecretRef: "22222222-2222-4222-8222-222222222222",
};

type FakeState = {
  refreshToken: string;
  accessToken: string;
  updates: Array<{ reference: string; value: string }>;
  tail: Promise<void>;
};

function fakeFactory(state: FakeState) {
  return async (_databaseUrl: string): Promise<AiLabVaultSqlClient> => ({
    async begin<T>(callback: (transaction: AiLabVaultSqlClient) => Promise<T>) {
      let release!: () => void;
      const previous = state.tail;
      state.tail = new Promise<void>((resolve) => release = resolve);
      await previous;
      try {
        return await callback(this);
      } finally {
        release();
      }
    },
    async unsafe<T = unknown>(query: string, values: readonly unknown[] = []) {
      if (query.includes("decrypted_secret")) {
        return [{ decrypted_secret: state.refreshToken }] as T;
      }
      if (query.includes("vault.update_secret")) {
        const [secretReference, value] = values;
        const update = {
          reference: String(secretReference),
          value: String(value),
        };
        state.updates.push(update);
        if (update.reference === reference.accessTokenSecretRef) {
          state.accessToken = update.value;
        }
        if (update.reference === reference.refreshTokenSecretRef) {
          state.refreshToken = update.value;
        }
        return [] as T;
      }
      return [] as T;
    },
    async end() {},
  });
}

function state(): FakeState {
  return {
    refreshToken: "old-refresh",
    accessToken: "old-access",
    updates: [],
    tail: Promise.resolve(),
  };
}

test("writer updates the fixed access ref and rotated refresh ref in one transaction", async () => {
  const shared = state();
  const persist = createAiLabVaultTokenPersistence({
    databaseUrl: "postgres://fixture",
    sqlFactory: fakeFactory(shared),
  });
  await persist({
    tokenReference: reference,
    tokens: { accessToken: "new-access", refreshToken: "new-refresh" },
    expectedRefreshToken: "old-refresh",
    refreshTokenRotated: true,
  });
  assert.deepEqual(shared.updates, [
    { reference: reference.accessTokenSecretRef, value: "new-access" },
    { reference: reference.refreshTokenSecretRef, value: "new-refresh" },
  ]);
  assert.equal(shared.refreshToken, "new-refresh");
});

test("writer preserves the refresh ref when X did not rotate it", async () => {
  const shared = state();
  const persist = createAiLabVaultTokenPersistence({
    databaseUrl: "postgres://fixture",
    sqlFactory: fakeFactory(shared),
  });
  await persist({
    tokenReference: reference,
    tokens: { accessToken: "new-access", refreshToken: "old-refresh" },
    expectedRefreshToken: "old-refresh",
    refreshTokenRotated: false,
  });
  assert.deepEqual(shared.updates, [
    { reference: reference.accessTokenSecretRef, value: "new-access" },
  ]);
  assert.equal(shared.refreshToken, "old-refresh");
});

test("writer rejects a stale refresh token before changing either ref", async () => {
  const shared = state();
  shared.refreshToken = "already-rotated";
  const persist = createAiLabVaultTokenPersistence({
    databaseUrl: "postgres://fixture",
    sqlFactory: fakeFactory(shared),
  });
  await assert.rejects(
    () =>
      persist({
        tokenReference: reference,
        tokens: {
          accessToken: "unsafe-access",
          refreshToken: "unsafe-refresh",
        },
        expectedRefreshToken: "old-refresh",
        refreshTokenRotated: true,
      }),
    { message: "AI_LAB_TOKEN_REFRESH_STALE" },
  );
  assert.deepEqual(shared.updates, []);
});

test("concurrent refreshes serialize and the stale writer cannot overwrite the winner", async () => {
  const shared = state();
  const persist = createAiLabVaultTokenPersistence({
    databaseUrl: "postgres://fixture",
    sqlFactory: fakeFactory(shared),
  });
  const attempts = await Promise.allSettled([
    persist({
      tokenReference: reference,
      tokens: { accessToken: "winner-access", refreshToken: "winner-refresh" },
      expectedRefreshToken: "old-refresh",
      refreshTokenRotated: true,
    }),
    persist({
      tokenReference: reference,
      tokens: { accessToken: "stale-access", refreshToken: "stale-refresh" },
      expectedRefreshToken: "old-refresh",
      refreshTokenRotated: true,
    }),
  ]);
  assert.equal(
    attempts.filter((attempt) => attempt.status === "fulfilled").length,
    1,
  );
  assert.equal(
    attempts.filter((attempt) => attempt.status === "rejected").length,
    1,
  );
  const rejected = attempts.find((attempt) => attempt.status === "rejected");
  assert.equal(
    rejected?.status === "rejected" ? rejected.reason.message : "",
    "AI_LAB_TOKEN_REFRESH_STALE",
  );
  assert.equal(shared.refreshToken, "winner-refresh");
  assert.equal(
    shared.updates.filter((update) =>
      update.reference === reference.refreshTokenSecretRef
    ).length,
    1,
  );
});
