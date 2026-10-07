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

test("AI Lab final guard has no finite ceiling and returns the measured code-point count", () => {
  const brand = context();
  assert.equal(brand.codeProfile.postLengthPolicy, UNLIMITED_POST_LENGTH);
  for (const n of [1, 140, 279, 280, 281, 600]) {
    assert.equal(
      assertAiLabBrandPostDispatchAllowed(brand, "brand_post", "あ".repeat(n)),
      n,
    );
  }
  // 640 BMP characters + 1 astral emoji = 641 code points (642 UTF-16 units).
  assert.equal(
    assertAiLabBrandPostDispatchAllowed(
      brand,
      "brand_post",
      "あ".repeat(640) + "😀",
    ),
    641,
  );
});

test("unlimited length does not relax the post-type, enabled-type, or missing-policy checks", () => {
  const brand = context();
  const longText = "長文。".repeat(400);
  assert.throws(
    () => assertAiLabBrandPostDispatchAllowed(brand, "morning_report", longText),
    { message: "AI_LAB_POST_TYPE_NOT_ENABLED" },
  );
  const disabled = context();
  disabled.operationalSettings = {
    ...disabled.operationalSettings,
    enabled_post_types: [],
  };
  assert.throws(
    () => assertAiLabBrandPostDispatchAllowed(disabled, "brand_post", longText),
    { message: "AI_LAB_POST_TYPE_NOT_ENABLED" },
  );
  const noPolicy = context();
  noPolicy.codeProfile = { ...noPolicy.codeProfile, postLengthPolicy: undefined };
  assert.throws(
    () => assertAiLabBrandPostDispatchAllowed(noPolicy, "brand_post", "本文"),
    { message: "AI_LAB_LENGTH_POLICY_NOT_CONFIGURED" },
  );
});

test("a finite mode, if explicitly configured, is still enforced by the generic guard", () => {
  const brand = context();
  brand.codeProfile = {
    ...brand.codeProfile,
    postLengthPolicy: { mode: "limited", maxChars: 280 },
  };
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
  assert.throws(
    () =>
      assertAiLabBrandPostDispatchAllowed(
        brand,
        "brand_post",
        "長文。".repeat(400),
      ),
    { message: "AI_LAB_DISPATCH_ACCOUNT_MISMATCH" },
  );
});

test("every AI Lab account-binding field is still checked independently of length", () => {
  const longText = "長文。".repeat(400);
  const variants: Array<(b: ReturnType<typeof context>) => void> = [
    (b) => { b.brand = { ...b.brand, id: "kabumori" }; },
    (b) => { b.socialAccount = { ...b.socialAccount!, id: "other_x" }; },
    (b) => { b.socialAccount = { ...b.socialAccount!, brand_id: "kabumori" }; },
    (b) => { b.socialAccount = { ...b.socialAccount!, platform: "threads" as unknown as "x" }; },
    (b) => { b.socialAccount = { ...b.socialAccount!, handle: "yume_daka" }; },
    (b) => { b.socialAccount = null; },
  ];
  for (const mutate of variants) {
    const brand = context();
    mutate(brand);
    assert.throws(
      () => assertAiLabBrandPostDispatchAllowed(brand, "brand_post", longText),
      { message: "AI_LAB_DISPATCH_ACCOUNT_MISMATCH" },
    );
  }
});
