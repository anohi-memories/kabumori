import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BrandContextError } from "../_shared/brand/brand_context.ts";
import {
  resolveOAuthCallbackConfig,
  resolveOAuthStartConfig,
} from "./account_config.ts";

test("Kabumori recovery requests only the scopes required by the existing posting path", () => {
  const config = resolveOAuthStartConfig("@Kabumori");
  assert.equal(config.brandId, "kabumori");
  assert.equal(config.socialAccountId, "kabumori_x");
  assert.equal(config.expectedHandle, "kabumori");
  assert.equal(
    config.scopes,
    "tweet.read users.read tweet.write media.write offline.access",
  );
  assert.equal(config.beginRpc, "begin_kabumori_oauth_recovery");
  assert.equal(config.tokenDestination, "legacy_store");
  assert.equal(config.publishMode, "live");
  assert.equal(config.publishEnabled, true);
});

test("AI Lab OAuth remains read-only and resolves to its existing Vault flow", () => {
  const config = resolveOAuthStartConfig("kaishain_ai_lab");
  assert.equal(config.scopes, "tweet.read users.read offline.access");
  assert.doesNotMatch(config.scopes, /tweet\.write|media\.write/u);
  assert.equal(config.tokenDestination, "vault");
  assert.equal(config.publishMode, "dry_run");
  assert.equal(config.publishEnabled, false);
});

test("start and callback routing reject every account outside the fixed allowlist", () => {
  assert.throws(
    () => resolveOAuthStartConfig("someone_else"),
    (error: unknown) =>
      error instanceof BrandContextError &&
      error.message === "OAUTH_HANDLE_NOT_ALLOWED",
  );
  assert.throws(
    () => resolveOAuthCallbackConfig("kabumori_x", "ai_salaryman_lab"),
    (error: unknown) =>
      error instanceof BrandContextError &&
      error.message === "OAUTH_STATE_ACCOUNT_NOT_ALLOWED",
  );
});

test("Kabumori recovery RPC migration is service-role-only and uses an empty search_path", async () => {
  const migration = await readFile(
    new URL(
      "../../migrations/20260912232914_add_kabumori_oauth_recovery_rpc.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const functionNames = [
    "begin_kabumori_oauth_recovery",
    "consume_kabumori_oauth_recovery_state",
    "complete_kabumori_oauth_recovery",
  ];
  for (const functionName of functionNames) {
    assert.match(
      migration,
      new RegExp(`create or replace function public\\.${functionName}\\(`, "u"),
    );
    assert.match(
      migration,
      new RegExp(
        `revoke all on function public\\.${functionName}\\([\\s\\S]*?from public, anon, authenticated;`,
        "u",
      ),
    );
    assert.match(
      migration,
      new RegExp(
        `grant execute on function public\\.${functionName}\\([\\s\\S]*?to service_role;`,
        "u",
      ),
    );
  }
  assert.equal((migration.match(/security definer/gu) ?? []).length, 3);
  assert.equal((migration.match(/set search_path = ''/gu) ?? []).length, 3);
  assert.doesNotMatch(
    migration,
    /publish_enabled\s*=\s*true|publish_mode\s*=\s*'live'/u,
  );
});

test("x-oauth-connect runtime contains no X post or media-upload endpoint", async () => {
  const runtimeFiles = [
    "index.ts",
    "account_config.ts",
    "kabumori_recovery.ts",
    "legacy_token_store.ts",
    "rpc.ts",
    "start_logic.ts",
  ];
  const runtimeSource = (
    await Promise.all(
      runtimeFiles.map((file) =>
        readFile(new URL(`./${file}`, import.meta.url), "utf8")
      ),
    )
  ).join("\n");
  const tweetCreatePath = new RegExp("/2/" + "tweets", "u");
  const mediaUploadPath = new RegExp("/2/" + "media", "u");
  const legacyMediaHost = new RegExp("upload\\." + "twitter\\.com", "u");

  assert.doesNotMatch(runtimeSource, tweetCreatePath);
  assert.doesNotMatch(runtimeSource, mediaUploadPath);
  assert.doesNotMatch(runtimeSource, legacyMediaHost);
});
