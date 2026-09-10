import assert from "node:assert/strict";
import test from "node:test";
import { resolveBrandContext, type BrandOperationalSettings } from "./brand_context.ts";
import { buildBrandDryRunPreview } from "./dry_run.ts";
import { assertBrandPublishAllowed } from "./publish_guard.ts";
import { loadVaultBackedXTokens } from "./token_loader.ts";

const settings: BrandOperationalSettings = {
  brand_id: "ai_salaryman_lab",
  fixed_hashtags: [],
  note_url: null,
  image_policy: {},
  enabled_post_types: ["profile_preview"],
};

function aiLabContext(mode: "disabled" | "dry_run" | "live" = "dry_run") {
  return resolveBrandContext(
    {
      id: "ai_salaryman_lab",
      display_name: "AIサラリーマン研究所",
      is_active: mode !== "disabled",
      publish_mode: mode,
      code_profile_key: "ai_salaryman_lab_v1",
    },
    {
      id: "ai_salaryman_lab_x",
      brand_id: "ai_salaryman_lab",
      platform: "x",
      handle: "ai_salaryman_lab",
      publish_enabled: false,
      oauth_client_ref: "default",
    },
    settings,
  );
}

test("AI Salaryman Lab resolves a separate dry-run profile without Kabumori tags or voice", () => {
  const preview = buildBrandDryRunPreview(aiLabContext(), "profile_preview");
  assert.equal(preview.brandId, "ai_salaryman_lab");
  assert.deepEqual(preview.fixedHashtags, []);
  assert.equal(preview.xTokenLoaderCalled, 0);
  assert.equal(preview.xApiCalled, 0);
  assert.doesNotMatch(preview.promptPreamble, /かぶモリ/u);
  assert.doesNotMatch(preview.voiceInstructions.join("\n"), /20代女性|株が好き/u);
});

test("AI Salaryman Lab dry-run cannot publish and disabled Mio-shaped contexts fail closed", () => {
  assert.throws(() => assertBrandPublishAllowed(aiLabContext()), { message: "BRAND_PUBLISH_MODE_DRY_RUN" });
  assert.throws(() => buildBrandDryRunPreview(aiLabContext("disabled"), "profile_preview"), {
    message: "BRAND_DISABLED",
  });
});

test("unconfigured or mismatched Vault references fail before exposing a token", async () => {
  let reads = 0;
  const vault = { readSecret: async () => { reads += 1; return "fixture-only"; } };
  await assert.rejects(
    () => loadVaultBackedXTokens({ context: aiLabContext("live"), tokenReference: null, vault }),
    { message: "BRAND_VAULT_TOKEN_NOT_CONFIGURED" },
  );
  assert.equal(reads, 0);
  await assert.rejects(
    () => loadVaultBackedXTokens({
      context: aiLabContext("live"),
      tokenReference: {
        socialAccountId: "different_account",
        accessTokenSecretRef: "test-access-ref",
        refreshTokenSecretRef: "test-refresh-ref",
      },
      vault,
    }),
    { message: "BRAND_VAULT_ACCOUNT_MISMATCH" },
  );
  assert.equal(reads, 0);
});
