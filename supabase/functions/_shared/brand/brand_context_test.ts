import assert from "node:assert/strict";
import test from "node:test";
import {
  brandIdFromScheduledRow,
  resolveBrandContext,
  type BrandOperationalSettings,
  type BrandRecord,
} from "./brand_context.ts";
import { appendProfileReportFixedHashtags } from "./brand_profiles.ts";
import { assertBrandPublishAllowed } from "./publish_guard.ts";

const kabumori: BrandRecord = {
  id: "kabumori",
  display_name: "かぶモリ",
  is_active: true,
  publish_mode: "live",
  code_profile_key: "kabumori_v1",
};

const kabumoriX = {
  id: "kabumori_x",
  brand_id: "kabumori",
  platform: "x" as const,
  handle: "kabumori",
  publish_enabled: true,
  oauth_client_ref: "default",
};

const kabumoriSettings: BrandOperationalSettings = {
  brand_id: "kabumori",
  fixed_hashtags: ["#日本株", "#日経平均", "#株式投資", "#かぶモリ"],
  note_url: null,
  image_policy: {},
  enabled_post_types: ["tip", "morning_report"],
};

test("legacy scheduled rows default to Kabumori and retain its fixed hashtags", () => {
  const context = resolveBrandContext(kabumori, kabumoriX, kabumoriSettings);
  assert.equal(brandIdFromScheduledRow(undefined), "kabumori");
  assert.equal(
    appendProfileReportFixedHashtags(context.codeProfile, "本文"),
    "本文\n\n#日本株 #日経平均 #株式投資 #かぶモリ",
  );
  assert.doesNotThrow(() => assertBrandPublishAllowed(context));
});

test("unknown code profiles fail closed instead of inheriting Kabumori voice", () => {
  assert.throws(
    () => resolveBrandContext(
      { ...kabumori, id: "mio", code_profile_key: "mio_v1" },
      null,
      { ...kabumoriSettings, brand_id: "mio" },
    ),
    { message: "BRAND_CODE_PROFILE_NOT_FOUND" },
  );
});

test("disabled and dry-run brands cannot reach the publish boundary", () => {
  const disabled = resolveBrandContext(
    { ...kabumori, id: "ai_salaryman_lab", is_active: false },
    null,
    { ...kabumoriSettings, brand_id: "ai_salaryman_lab" },
  );
  assert.throws(() => assertBrandPublishAllowed(disabled), { message: "BRAND_DISABLED" });

  const dryRun = resolveBrandContext({ ...kabumori, publish_mode: "dry_run" }, kabumoriX, kabumoriSettings);
  assert.throws(() => assertBrandPublishAllowed(dryRun), { message: "BRAND_PUBLISH_MODE_DRY_RUN" });
});
