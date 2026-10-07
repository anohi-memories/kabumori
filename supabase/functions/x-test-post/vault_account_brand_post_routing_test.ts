import assert from "node:assert/strict";
import test from "node:test";

const dispatcher = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const migration = (await Deno.readTextFile(
  new URL("../../migrations/20261006160000_vault_account_brand_post_completion.sql", import.meta.url),
)).replace(/--.*$/gmu, "");
const authority = (await Deno.readTextFile(
  new URL("../../migrations/20261006160200_x_account_publish_authority.sql", import.meta.url),
)).replace(/--.*$/gmu, "");
const reader = (await Deno.readTextFile(
  new URL("../../migrations/20261006160100_social_mobile_publish_settings_reader.sql", import.meta.url),
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
  assert.match(genericBlock, /const checkGenericPublishAuthority = \(\) => checkVaultAccountPublishAuthority\(\{\s+supabaseUrl,\s+serviceRoleKey,\s+scheduledPostId: scheduledPost\.id,\s+socialAccountId: vaultAccountId,\s+brandId: vaultBrandPostBrandId,/u);
  assert.match(genericBlock, /checkPublishAuthority: checkGenericPublishAuthority/u);
  // Settings are read only through the narrow RPC, bound to this running post and brand.
  assert.match(genericBlock, /loadContentSettings: \(\) => loadSocialMobileContentSettingsForPublish\(\{\s+supabaseUrl,\s+serviceRoleKey,\s+scheduledPostId: scheduledPost\.id,\s+brandId: vaultBrandPostBrandId,/u);
  assert.match(genericBlock, /completeVaultAccountBrandPost\(/u);
  assert.match(genericBlock, /publishText: \(text\) => postToX\(xAuth, text, undefined, undefined, checkGenericPublishAuthority\)/u);
  const postToX = dispatcher.slice(dispatcher.indexOf("async function postToX("), dispatcher.indexOf("async function postThreadToX("));
  assert.match(postToX, /auth\.vaultAccount\.send\(async \(accessToken\) => \{[\s\S]*?await beforeCreate\?\.\(\);\s+return requestXPost\(accessToken, text, replyToId, pollOptions, "manual"\);/u);
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
  assert.doesNotMatch(migration, /create or replace|\bdrop\s|alter table|limit\s+1|order by/iu);
  // Both specialised brands are refused explicitly (H1 P2: AI Lab's own row + account must not complete here).
  assert.match(migration, /v_post\.post_type is distinct from 'brand_post' or v_post\.brand_id in \('kabumori', 'ai_salaryman_lab'\)/u);
  assert.match(migration, /count\(\*\) from public\.social_accounts sa where sa\.brand_id = v_post\.brand_id and sa\.platform = 'x'\) <> 1/u);
  assert.match(migration, /v_account\.id is distinct from p_social_account_id[\s\S]*X_CLAIM_ACCOUNT_MISMATCH/u);
  assert.match(migration, /values \(v_post\.brand_id, v_account\.id, 'brand_post', p_normalized_text_sha256, p_x_post_id\)/u);
  assert.match(migration, /if v_post\.status <> 'running' then\s+raise exception 'VAULT_BRAND_POST_NOT_RUNNING'/u);
  assert.match(migration, /security definer set search_path = ''/u);
  assert.match(migration, /from public, anon, authenticated, service_role;\s+grant execute on function public\.complete_vault_account_brand_post\(uuid, text, text, text\) to service_role;/u);
});

test("publish authority migration: explicit per-account window/state, single predicate, invoker check, definer setter, least privilege", () => {
  assert.match(authority, /^\s*begin;/u);
  assert.match(authority, /commit;\s*$/u);
  for (const pre of ["STAGE3B_PUBLISH_PRECONDITION_MISSING", "STAGE3B_PUBLISH_PRECONDITION_ALREADY_APPLIED"]) assert.match(authority, new RegExp(pre, "u"));
  assert.doesNotMatch(authority, /create or replace|\bdrop\s|alter table public\.(social_accounts|x_account_refresh)|limit\s+1|order by/iu);
  assert.match(authority, /state text not null check \(state in \('enabled', 'off', 'revoked'\)\)/u);
  assert.match(authority, /expires_at <= starts_at \+ interval '30 days'/u);
  assert.match(authority, /revoke all on public\.x_account_publish_authority from public, anon, authenticated, service_role;\s+grant select on public\.x_account_publish_authority to service_role;/u);
  const check = authority.slice(authority.indexOf("create function public.check_x_account_publish_authority"), authority.indexOf("create function public.set_x_account_publish_authority"));
  assert.match(check, /stable security invoker set search_path = ''/u);
  for (const code of ["VAULT_PUBLISH_BRAND_NOT_ELIGIBLE", "VAULT_PUBLISH_POST_NOT_RUNNING", "X_CLAIM_ACCOUNT_MISMATCH", "VAULT_PUBLISH_BRAND_DISABLED",
    "X_ACCOUNT_PUBLISH_DISABLED", "VAULT_PUBLISH_POST_TYPE_NOT_ENABLED", "VAULT_PUBLISH_AUTHORITY_OFF", "VAULT_PUBLISH_AUTHORITY_REVOKED",
    "VAULT_PUBLISH_AUTHORITY_NOT_STARTED", "VAULT_PUBLISH_AUTHORITY_EXPIRED", "SOCIAL_MOBILE_AUTO_POST_NOT_CONSENTED"]) {
    assert.match(check, new RegExp(`'${code}'`, "u"), code);
  }
  assert.doesNotMatch(check, /x_account_refresh_rollout|decrypted_secrets|vault\./u, "refresh rollout is not a publish gate; no Vault");
  // Consent only through the narrow reader: no direct (or dynamic) read of the settings table.
  assert.match(check, /from public\.read_social_mobile_publish_settings\(p_scheduled_post_id, p_brand_id\) r;/u);
  assert.doesNotMatch(check, /from public\.social_mobile_content_settings|execute /iu);
  assert.doesNotMatch(authority, /grant [^;]*on (table )?public\.social_mobile_content_settings/iu);
  const setter = authority.slice(authority.indexOf("create function public.set_x_account_publish_authority"));
  assert.match(setter, /security definer set search_path = ''/u);
  assert.match(setter, /VAULT_PUBLISH_BRAND_NOT_ELIGIBLE/u);
  assert.match(authority, /from public, anon, authenticated, service_role;\s+grant execute on function public\.check_x_account_publish_authority\(uuid, text, text\),\s+public\.set_x_account_publish_authority\(text, text, text, timestamptz, timestamptz\)\s+to service_role;/u);
});

test("publish settings reader: running post of the exact brand, social_mobile_user_v1 only, definer owned by the table owner, service_role only", () => {
  assert.match(reader, /^\s*begin;/u);
  assert.match(reader, /commit;\s*$/u);
  for (const pre of ["PUBLISH_SETTINGS_READER_PRECONDITION_MISSING", "PUBLISH_SETTINGS_READER_PRECONDITION_ALREADY_APPLIED", "PUBLISH_SETTINGS_READER_POSTCONDITION_FAILED"]) {
    assert.match(reader, new RegExp(pre, "u"));
  }
  assert.doesNotMatch(reader, /create or replace|\bdrop\s|alter table|insert into|update public|delete from|grant [^;]*on (table )?public\.social_mobile_content_settings/iu);
  const fn = reader.slice(reader.indexOf("create function public.read_social_mobile_publish_settings"), reader.indexOf("$$;", reader.indexOf("create function public.read_social_mobile_publish_settings")));
  assert.match(fn, /language plpgsql stable security definer set search_path = ''/u);
  assert.match(fn, /v_post\.status is distinct from 'running' or v_post\.post_type is distinct from 'brand_post'\s+or v_post\.brand_id is distinct from p_brand_id/u);
  assert.match(fn, /v_profile is distinct from 'social_mobile_user_v1'/u);
  // Only the settings/persona columns; no identity, email, token or Vault data.
  assert.match(fn, /select s\.settings, s\.persona_profile, s\.persona_provenance, s\.persona_confirmed,\s+s\.persona_last_analyzed_at, s\.persona_last_analyzed_count/u);
  assert.doesNotMatch(fn, /user_id|email|token|vault|auth\./iu);
  assert.match(reader, /owner to %I/u);
  assert.match(reader, /from public, anon, authenticated, service_role;\s+grant execute on function public\.read_social_mobile_publish_settings\(uuid, text\) to service_role;/u);
});
