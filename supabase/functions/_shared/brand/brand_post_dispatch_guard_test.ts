import assert from "node:assert/strict";
import test from "node:test";
import {
  type BrandOperationalSettings,
  resolveBrandContext,
} from "./brand_context.ts";
import { assertAiLabBrandPostDispatchAllowed } from "./brand_post_dispatch_guard.ts";
import { UNLIMITED_POST_LENGTH } from "./post_length_policy.ts";

const settings: BrandOperationalSettings = {
  brand_id: "ai_salaryman_lab",
  fixed_hashtags: [],
  note_url: null,
  image_policy: {},
  enabled_post_types: ["brand_post"],
};

function context() {
  return resolveBrandContext(
    {
      id: "ai_salaryman_lab",
      display_name: "fixture",
      is_active: true,
      publish_mode: "live",
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

test("independent final guard permits 279/280 and rejects 281 code points", () => {
  const brand = context();
  assert.equal(
    assertAiLabBrandPostDispatchAllowed(brand, "brand_post", "あ".repeat(279)),
    279,
  );
  assert.equal(
    assertAiLabBrandPostDispatchAllowed(brand, "brand_post", "あ".repeat(280)),
    280,
  );
  assert.throws(
    () =>
      assertAiLabBrandPostDispatchAllowed(
        brand,
        "brand_post",
        "あ".repeat(281),
      ),
    { message: "BRAND_POST_LENGTH_LIMIT_EXCEEDED" },
  );
});

test("generic explicit unlimited mode bypasses only the finite character ceiling", () => {
  const brand = context();
  brand.codeProfile = {
    ...brand.codeProfile,
    postLengthPolicy: UNLIMITED_POST_LENGTH,
  };
  assert.equal(
    assertAiLabBrandPostDispatchAllowed(
      brand,
      "brand_post",
      "長文。".repeat(400),
    ),
    1200,
  );
  assert.throws(
    () => assertAiLabBrandPostDispatchAllowed(brand, "morning_report", "本文"),
    { message: "AI_LAB_POST_TYPE_NOT_ENABLED" },
  );
});

test("Kabumori account cannot enter the AI Lab brand_post boundary", () => {
  const brand = context();
  brand.socialAccount = {
    ...brand.socialAccount!,
    id: "kabumori_x",
    brand_id: "kabumori",
    handle: "yume_daka",
  };
  assert.throws(
    () => assertAiLabBrandPostDispatchAllowed(brand, "brand_post", "本文"),
    { message: "AI_LAB_DISPATCH_ACCOUNT_MISMATCH" },
  );
});
