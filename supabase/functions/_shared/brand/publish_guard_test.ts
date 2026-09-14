import assert from "node:assert/strict";
import test from "node:test";
import { resolveBrandContext, type BrandOperationalSettings } from "./brand_context.ts";
import { assertBrandPublishAllowed } from "./publish_guard.ts";

// assertBrandPublishAllowed is the gate x-test-post runs immediately after claiming any scheduled row
// and before loadBrandXTokens or any post_type branch (index.ts, right after claim_due_post). These
// cases enumerate every brand/account state it must fail closed on, plus the one shape that must pass.

const settings: BrandOperationalSettings = {
  brand_id: "ai_salaryman_lab", fixed_hashtags: [], note_url: null, image_policy: {}, enabled_post_types: [],
};

function context(overrides: {
  isActive?: boolean;
  publishMode?: "disabled" | "dry_run" | "live";
  publishEnabled?: boolean;
  noAccount?: boolean;
} = {}) {
  return resolveBrandContext(
    {
      id: "ai_salaryman_lab", display_name: "AIサラリーマン研究所",
      is_active: overrides.isActive ?? true,
      publish_mode: overrides.publishMode ?? "live",
      code_profile_key: "ai_salaryman_lab_v1",
    },
    overrides.noAccount ? null : {
      id: "ai_salaryman_lab_x", brand_id: "ai_salaryman_lab", platform: "x", handle: "kaishain_ai_lab",
      publish_enabled: overrides.publishEnabled ?? true,
      oauth_client_ref: "default",
    },
    settings,
  );
}

test("a brand-disabled context is rejected regardless of publish_mode or account state", () => {
  assert.throws(() => assertBrandPublishAllowed(context({ isActive: false, publishMode: "live", publishEnabled: true })), { message: "BRAND_DISABLED" });
});

test("dry_run and disabled publish_mode are each rejected with their own distinct code", () => {
  assert.throws(() => assertBrandPublishAllowed(context({ publishMode: "dry_run" })), { message: "BRAND_PUBLISH_MODE_DRY_RUN" });
  assert.throws(() => assertBrandPublishAllowed(context({ publishMode: "disabled" })), { message: "BRAND_PUBLISH_MODE_DISABLED" });
});

test("live publish_mode with publish_enabled=false, or with no social account at all, is still rejected", () => {
  assert.throws(() => assertBrandPublishAllowed(context({ publishMode: "live", publishEnabled: false })), { message: "BRAND_X_ACCOUNT_DISABLED" });
  assert.throws(() => assertBrandPublishAllowed(context({ publishMode: "live", noAccount: true })), { message: "BRAND_X_ACCOUNT_DISABLED" });
});

test("only is_active=true + publish_mode=live + publish_enabled=true passes", () => {
  assert.doesNotThrow(() => assertBrandPublishAllowed(context({ publishMode: "live", publishEnabled: true })));
});
