import assert from "node:assert/strict";
import test from "node:test";

const dispatcher = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const migration = (await Deno.readTextFile(
  new URL("../../migrations/20260927101423_vault_account_brand_post_completion.sql", import.meta.url),
)).replace(/--.*$/gmu, "");

function brandPostRoute(): string {
  const start = dispatcher.indexOf('if (scheduledPost.post_type === "brand_post") {');
  const end = dispatcher.indexOf("// Shared market report consumer", start);
  assert.ok(start > 0 && end > start);
  return dispatcher.slice(start, end);
}

test("brand_post routing: AI Lab keeps its dispatcher; every other Vault-backed brand uses the account-bound path", () => {
  const route = brandPostRoute();
  const generic = route.indexOf("dispatchVaultAccountScheduledBrandPost({");
  const aiLab = route.indexOf("dispatchAiLabScheduledBrandPost({");
  assert.ok(generic > 0 && aiLab > generic);
  const genericBlock = route.slice(0, aiLab);
  assert.match(genericBlock, /if \(brandContext\.brand\.id !== "ai_salaryman_lab"\) \{/u);
  // The exact account the X port was bound to; refused before any dispatch when absent.
  assert.match(genericBlock, /if \(!xAuth\.vaultAccount \|\| !vaultAccountId\) throw new Error\("VAULT_BRAND_POST_ACCOUNT_REQUIRED"\);/u);
  assert.ok(genericBlock.indexOf("VAULT_BRAND_POST_ACCOUNT_REQUIRED") < genericBlock.indexOf("dispatchVaultAccountScheduledBrandPost({"));
  assert.match(genericBlock, /socialAccountId: vaultAccountId/u);
  assert.match(genericBlock, /completeVaultAccountBrandPost\(/u);
  assert.match(genericBlock, /publishText: \(text\) => postToX\(xAuth, text\)/u);
  assert.doesNotMatch(genericBlock, /recordAndCompleteAiLabBrandPost|oauth_token_store|X_OAUTH2_/u);
  // A confirmed X write whose completion is unconfirmed is never failed (and replayed).
  assert.match(genericBlock, /VaultAccountConfirmedPostCompletionError\) \{\s+\/\/[^\n]*\n\s+aiLabXPostConfirmedWithoutCompletion = true;/u);
  // AI Lab block is still the reviewed one.
  const aiLabBlock = route.slice(aiLab);
  assert.match(aiLabBlock, /completePublishedPost: \(args\) => recordAndCompleteAiLabBrandPost\(/u);
  assert.equal((dispatcher.match(/dispatchAiLabScheduledBrandPost\(\{/gu) ?? []).length, 1);
  assert.doesNotMatch(dispatcher, /AI_LAB_DISPATCH_BRAND_MISMATCH/u);
});

test("Kabumori never reaches the account-bound path (no Vault account on the legacy auth context)", () => {
  const start = dispatcher.indexOf("if (brandContext.brand.id !== LEGACY_KABUMORI_BRAND_ID) {");
  const legacy = dispatcher.indexOf('const xAccessToken = Deno.env.get("X_OAUTH2_ACCESS_TOKEN");', start);
  assert.ok(start > 0 && legacy > start);
  assert.doesNotMatch(dispatcher.slice(legacy, dispatcher.indexOf("})();", legacy)), /vaultAccount/u);
});

test("completion migration: exact account of the post's brand, brand_post only, no Kabumori, idempotent, service_role only", () => {
  assert.match(migration, /^\s*begin;/u);
  assert.match(migration, /commit;\s*$/u);
  for (const pre of ["STAGE3B_PRECONDITION_MISSING", "STAGE3B_PRECONDITION_ALREADY_APPLIED"]) assert.match(migration, new RegExp(pre, "u"));
  assert.doesNotMatch(migration, /create or replace|\bdrop\s|alter table|ai_salaryman_lab|limit\s+1|order by/iu);
  assert.match(migration, /v_post\.post_type is distinct from 'brand_post' or v_post\.brand_id = 'kabumori'/u);
  assert.match(migration, /count\(\*\) from public\.social_accounts sa where sa\.brand_id = v_post\.brand_id and sa\.platform = 'x'\) <> 1/u);
  assert.match(migration, /v_account\.id is distinct from p_social_account_id[\s\S]*X_CLAIM_ACCOUNT_MISMATCH/u);
  assert.match(migration, /values \(v_post\.brand_id, v_account\.id, 'brand_post', p_normalized_text_sha256, p_x_post_id\)/u);
  assert.match(migration, /if v_post\.status <> 'running' then\s+raise exception 'VAULT_BRAND_POST_NOT_RUNNING'/u);
  assert.match(migration, /security definer set search_path = ''/u);
  assert.match(migration, /from public, anon, authenticated, service_role;\s+grant execute on function public\.complete_vault_account_brand_post\(uuid, text, text, text\) to service_role;/u);
});
