import assert from "node:assert/strict";
import test from "node:test";
import { resolveBrandContext, type BrandOperationalSettings, type BrandContext } from "./brand_context.ts";
import { assertBrandPublishAllowed } from "./publish_guard.ts";
import { loadBrandXTokens } from "./token_loader.ts";

// Reproduces the exact three-call sequence x-test-post/index.ts runs on every claimed scheduled row,
// right after claim_due_post() and before any post_type branch:
//   loadBrandContext(...) -> assertBrandPublishAllowed(context) -> loadBrandXTokens({ context, ... })
// claim_due_post() itself has no brand filter (it claims whichever row is due next, across all brands),
// so this shared gate -- run once per claimed row, before any generation or X call -- is what actually
// keeps a claimed AI Lab row from ever reaching Kabumori's legacy token store or the X write API, and
// what proves a claimed Kabumori row is unaffected by AI Lab's existence. loadBrandContext's own DB
// reads are skipped here in favor of resolveBrandContext (the same function it delegates to after
// fetching), so this stays a fast, deterministic unit test while still exercising production code.

type ScheduledRowShape = { brand: Parameters<typeof resolveBrandContext>[0]; account: Parameters<typeof resolveBrandContext>[1]; settings: BrandOperationalSettings };

const kabumoriRow: ScheduledRowShape = {
  brand: { id: "kabumori", display_name: "かぶモリ", is_active: true, publish_mode: "live", code_profile_key: "kabumori_v1" },
  account: { id: "kabumori_x", brand_id: "kabumori", platform: "x", handle: "yume_daka", publish_enabled: true, oauth_client_ref: "default" },
  settings: { brand_id: "kabumori", fixed_hashtags: [], note_url: null, image_policy: {}, enabled_post_types: [] },
};

const aiLabRow: ScheduledRowShape = {
  brand: { id: "ai_salaryman_lab", display_name: "AIサラリーマン研究所", is_active: true, publish_mode: "dry_run", code_profile_key: "ai_salaryman_lab_v1" },
  account: { id: "ai_salaryman_lab_x", brand_id: "ai_salaryman_lab", platform: "x", handle: "kaishain_ai_lab", publish_enabled: false, oauth_client_ref: "default" },
  settings: { brand_id: "ai_salaryman_lab", fixed_hashtags: [], note_url: null, image_policy: {}, enabled_post_types: [] },
};

async function runDispatchGate(row: ScheduledRowShape, fetchImpl: typeof fetch) {
  const context: BrandContext = resolveBrandContext(row.brand, row.account, row.settings);
  assertBrandPublishAllowed(context);
  return loadBrandXTokens({
    context, supabaseUrl: "https://example.test", serviceRoleKey: "fixture-only",
    clientSecret: "fixture-only", fallbackAccessToken: "fixture-only", fallbackRefreshToken: "fixture-only",
    fetchImpl,
  });
}

test("claim isolation: a due AI Lab row is rejected pre-network while a due Kabumori row is unaffected", async () => {
  let legacyStoreReads = 0;
  const fetchImpl: typeof fetch = async () => { legacyStoreReads += 1; return Response.json([]); };

  await assert.rejects(() => runDispatchGate(aiLabRow, fetchImpl), { message: "BRAND_PUBLISH_MODE_DRY_RUN" });
  assert.equal(legacyStoreReads, 0, "AI Lab's dry_run mode must stop the gate before the legacy token store is ever read");

  await assert.doesNotReject(() => runDispatchGate(kabumoriRow, fetchImpl));
  assert.equal(legacyStoreReads, 1, "Kabumori's own claimed row must still reach the legacy token store exactly once");
});

test("an AI Lab row cannot pass the gate even if publish_mode were live but the X account is not enabled", async () => {
  let legacyStoreReads = 0;
  const fetchImpl: typeof fetch = async () => { legacyStoreReads += 1; return Response.json([]); };
  const liveButDisabledAccount: ScheduledRowShape = {
    ...aiLabRow,
    brand: { ...aiLabRow.brand, publish_mode: "live" },
  };
  await assert.rejects(() => runDispatchGate(liveButDisabledAccount, fetchImpl), { message: "BRAND_X_ACCOUNT_DISABLED" });
  assert.equal(legacyStoreReads, 0);
});

test("an AI Lab row cannot reach the legacy token store even if the publish gate were somehow skipped", async () => {
  // Defense in depth: loadBrandXTokens independently refuses any non-Kabumori brand_id, so a bug in
  // (or future change to) assertBrandPublishAllowed alone could not make AI Lab read Kabumori's tokens.
  let legacyStoreReads = 0;
  const fetchImpl: typeof fetch = async () => { legacyStoreReads += 1; return Response.json([]); };
  const context = resolveBrandContext(aiLabRow.brand, aiLabRow.account, aiLabRow.settings);
  await assert.rejects(
    () => loadBrandXTokens({
      context, supabaseUrl: "https://example.test", serviceRoleKey: "fixture-only",
      clientSecret: "fixture-only", fallbackAccessToken: "fixture-only", fallbackRefreshToken: "fixture-only",
      fetchImpl,
    }),
    { message: "BRAND_TOKEN_RESOLVER_NOT_CONFIGURED" },
  );
  assert.equal(legacyStoreReads, 0);
});
