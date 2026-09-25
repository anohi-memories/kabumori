import assert from "node:assert/strict";
import test from "node:test";
import {
  type BrandOperationalSettings,
  resolveBrandContext,
} from "./brand_context.ts";
import {
  AiLabConfirmedPostCompletionError,
  dispatchAiLabScheduledBrandPost,
} from "./ai_lab_scheduled_brand_post.ts";
import { fingerprintText } from "./cross_brand_dedupe.ts";
import type { BrandPostDraft } from "./brand_post_generator.ts";

const settings: BrandOperationalSettings = {
  brand_id: "ai_salaryman_lab",
  fixed_hashtags: [],
  note_url: null,
  image_policy: {},
  enabled_post_types: ["brand_post"],
};

function context(publishMode: "live" | "dry_run" = "live") {
  return resolveBrandContext(
    {
      id: "ai_salaryman_lab",
      display_name: "fixture",
      is_active: true,
      publish_mode: publishMode,
      code_profile_key: "ai_salaryman_lab_v1",
    },
    {
      id: "ai_salaryman_lab_x",
      brand_id: "ai_salaryman_lab",
      platform: "x",
      handle: "kaishain_ai_lab",
      publish_enabled: true,
      oauth_client_ref: "default",
    },
    settings,
  );
}

function draft(text: string): BrandPostDraft {
  return {
    brandId: "ai_salaryman_lab",
    postType: "brand_post",
    text,
    model: "fixture",
    inputTokens: 1,
    outputTokens: 1,
    apiCostUsd: 0,
    characterCount: Array.from(text).length,
  };
}

function baseArgs(
  overrides: Partial<Parameters<typeof dispatchAiLabScheduledBrandPost>[0]> =
    {},
) {
  return {
    context: context(),
    postType: "brand_post",
    scheduledPostId: "schedule-fixture",
    openAiApiKey: "fixture-only",
    loadRecentFingerprints: async () => [],
    publishText: async () => ({ data: { id: "x-post-fixture" } }),
    completePublishedPost: async () => ({ fingerprintPersisted: true }),
    generate: async (
      { context: brand, postType }: {
        context: ReturnType<typeof context>;
        postType: string;
      },
    ) => draft(`${brand.brand.id}:${postType}`),
    ...overrides,
  };
}

test("dry_run never enters the scheduled X dispatcher", async () => {
  let fingerprintsRead = 0;
  let generated = 0;
  let published = 0;
  await assert.rejects(
    () =>
      dispatchAiLabScheduledBrandPost(baseArgs({
        context: context("dry_run"),
        loadRecentFingerprints: async () => {
          fingerprintsRead += 1;
          return [];
        },
        generate: async () => {
          generated += 1;
          return draft("fixture");
        },
        publishText: async () => {
          published += 1;
          return { data: { id: "should-not-post" } };
        },
      })),
    { message: "BRAND_PUBLISH_MODE_DRY_RUN" },
  );
  assert.deepEqual({ fingerprintsRead, generated, published }, {
    fingerprintsRead: 0,
    generated: 0,
    published: 0,
  });
});

test("dispatch independently blocks 281 code points before the X callback", async () => {
  let published = 0;
  await assert.rejects(
    () =>
      dispatchAiLabScheduledBrandPost(baseArgs({
        generate: async () => draft("あ".repeat(281)),
        publishText: async () => {
          published += 1;
          return { data: { id: "should-not-post" } };
        },
      })),
    { message: "BRAND_POST_LENGTH_LIMIT_EXCEEDED" },
  );
  assert.equal(published, 0);
});

test("a confirmed 280-code-point post completes once even when fingerprint persistence reports false", async () => {
  const text = "あ".repeat(280);
  const order: string[] = [];
  let completedArgs: {
    scheduledPostId: string;
    xPostId: string;
    normalizedTextSha256: string;
  } | null = null;
  const result = await dispatchAiLabScheduledBrandPost(baseArgs({
    generate: async () => draft(text),
    publishText: async (sentText: string) => {
      order.push("publish");
      assert.equal(sentText, text);
      return { data: { id: "x-post-fixture" } };
    },
    completePublishedPost: async (args: NonNullable<typeof completedArgs>) => {
      order.push("complete");
      completedArgs = args;
      return { fingerprintPersisted: false };
    },
  }));

  assert.deepEqual(order, ["publish", "complete"]);
  assert.deepEqual(result, {
    brandId: "ai_salaryman_lab",
    postType: "brand_post",
    characterCount: 280,
    xPostId: "x-post-fixture",
    fingerprintPersisted: false,
  });
  assert.deepEqual(completedArgs, {
    scheduledPostId: "schedule-fixture",
    xPostId: "x-post-fixture",
    normalizedTextSha256: await fingerprintText(text),
  });
});

test("confirmed X success plus uncertain completion fails closed without a retrying publish", async () => {
  let publishCount = 0;
  let completionCount = 0;
  await assert.rejects(
    () =>
      dispatchAiLabScheduledBrandPost(baseArgs({
        publishText: async () => {
          publishCount += 1;
          return { data: { id: "x-post-confirmed" } };
        },
        completePublishedPost: async () => {
          completionCount += 1;
          throw new Error("transport detail must not escape");
        },
      })),
    (error: unknown) => error instanceof AiLabConfirmedPostCompletionError,
  );
  assert.deepEqual({ publishCount, completionCount }, {
    publishCount: 1,
    completionCount: 1,
  });
});

test("exact cross-brand duplicate is blocked before X", async () => {
  const text = "日本語の短いテスト投稿です。";
  let published = 0;
  await assert.rejects(
    () =>
      dispatchAiLabScheduledBrandPost(baseArgs({
        generate: async () => draft(text),
        loadRecentFingerprints: async () => [{
          brandId: "kabumori",
          normalizedTextSha256: await fingerprintText(text),
          publishedAt: new Date().toISOString(),
        }],
        publishText: async () => {
          published += 1;
          return { data: { id: "should-not-post" } };
        },
      })),
    { message: "AI_LAB_CROSS_BRAND_DUPLICATE" },
  );
  assert.equal(published, 0);
});

test("x-test-post routes AI Lab (and every non-Kabumori brand) to the generic exact-account Vault port, never the legacy store", async () => {
  const source = await Deno.readTextFile(
    new URL("../../x-test-post/index.ts", import.meta.url),
  );
  const branchStart = source.indexOf(
    "if (brandContext.brand.id !== LEGACY_KABUMORI_BRAND_ID) {",
  );
  const legacyCredentialsStart = source.indexOf(
    'const xAccessToken = Deno.env.get("X_OAUTH2_ACCESS_TOKEN");',
    branchStart,
  );
  assert.ok(branchStart >= 0 && legacyCredentialsStart > branchStart);
  const vaultBranch = source.slice(branchStart, legacyCredentialsStart).replace(
    /\/\/.*$/gmu,
    "",
  );
  assert.match(vaultBranch, /VaultAccountXAuth\.load\(/u);
  // The AI Lab refresh dead-end is gone: no allowRefresh:false-only credential source.
  assert.doesNotMatch(vaultBranch, /loadAiLabVaultBackedXTokens/u);
  assert.doesNotMatch(
    vaultBranch,
    /loadBrandXTokens|oauth_token_store|X_OAUTH2_ACCESS_TOKEN/u,
  );

  const postStart = source.indexOf("async function postToX(");
  const postEnd = source.indexOf("async function postThreadToX(", postStart);
  const postImplementation = source.slice(postStart, postEnd);
  assert.match(postImplementation, /if \(auth\.vaultAccount\) \{[\s\S]*?auth\.vaultAccount\.send\(/u);
  // Kabumori's legacy refresh stays as it was.
  assert.match(
    postImplementation,
    /throw new Error\("X_REQUEST_FAILED:401"\)[\s\S]*?await refreshXTokens/u,
  );
});

test("normal and reserved-slot scheduled brand_post rows share the canonical AI Lab dispatcher", async () => {
  const source = await Deno.readTextFile(
    new URL("../../x-test-post/index.ts", import.meta.url),
  );
  const claim = source.indexOf("await claimDuePost(");
  const brandLoad = source.indexOf(
    "const brandContext = await loadBrandContext",
    claim,
  );
  const route = source.indexOf(
    'if (scheduledPost.post_type === "brand_post")',
    brandLoad,
  );
  const dispatch = source.indexOf("dispatchAiLabScheduledBrandPost({", route);
  const unsupported = source.indexOf("UNSUPPORTED_POST_TYPE", dispatch);

  assert.ok(claim >= 0);
  assert.ok(brandLoad > claim);
  assert.ok(route > brandLoad);
  assert.ok(dispatch > route);
  assert.ok(unsupported > dispatch);

  const canonicalRoute = source.slice(claim, unsupported);
  assert.doesNotMatch(canonicalRoute, /slot_no\s*[=!]==?\s*0/u);
  assert.equal(
    canonicalRoute.match(/dispatchAiLabScheduledBrandPost\(\{/gu)?.length,
    1,
    "every claimed AI Lab brand_post row must enter one canonical dispatcher regardless of slot",
  );
});

test("unknown scheduled post types remain fail-closed after the AI Lab route", async () => {
  const source = await Deno.readTextFile(
    new URL("../../x-test-post/index.ts", import.meta.url),
  );
  const aiLabRoute = source.indexOf(
    'if (scheduledPost.post_type === "brand_post")',
  );
  const unknownGuard = source.indexOf(
    "throw new Error(`UNSUPPORTED_POST_TYPE:${scheduledPost.post_type}`)",
  );
  assert.ok(aiLabRoute >= 0);
  assert.ok(unknownGuard > aiLabRoute);
});
