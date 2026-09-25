import assert from "node:assert/strict";
import test from "node:test";

const sql = await Deno.readTextFile(new URL("../../migrations/20260925140000_x_account_credential_refresh_core.sql", import.meta.url));
const code = sql.replace(/--.*$/gmu, "");
const phase1i = (await Deno.readTextFile(new URL("../../migrations/20260925150000_x_autopost_phase1i_account_refresh.sql", import.meta.url)))
  .replace(/--.*$/gmu, "");
const dispatcher = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function definition(name: string): string {
  const match = code.match(new RegExp(`create function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, "u"));
  assert.ok(match, `missing ${name}`);
  return match[0];
}

test("standalone on the production baseline: one transaction, preconditions first, additive only, no v2 dependency", () => {
  assert.match(code, /^\s*begin;/u);
  assert.match(code, /commit;\s*$/u);
  const first = code.search(/create table|create function|create trigger/u);
  for (const pre of ["CORE_PRECONDITION_VAULT_OR_QUEUE_MISSING", "CORE_PRECONDITION_SOCIAL_ACCOUNTS_SHAPE", "CORE_PRECONDITION_ALREADY_APPLIED"]) {
    assert.ok(code.indexOf(pre) > 0 && code.indexOf(pre) < first, pre);
  }
  assert.doesNotMatch(code, /create\s+or\s+replace|\bdrop\s|alter\s+function|alter\s+table\s+public\.(social_accounts|scheduled_posts)/iu);
  assert.doesNotMatch(code, /post_queue_attempts_v2|post_provider_steps_v2|scheduled_posts\.social_account_id|s\.social_account_id/u);
  assert.doesNotMatch(code, /oauth_token_store|ai_salaryman_lab|kabumori|limit\s+1|order\s+by/iu);
  // Phase1I is applied after it and reuses the same lease table.
  assert.match(phase1i, /PHASE1I_PRECONDITION_REFRESH_CORE_MISSING/u);
});

test("one lease table for both publish paths, lease shape enforced", () => {
  assert.equal((code.match(/create table/gu) ?? []).length, 1);
  assert.match(code, /lease_kind text check \(lease_kind in \('legacy_post', 'v2_attempt'\)\)/u);
  assert.match(code, /x_account_refresh_state_v2_lease_shape check/u);
  assert.match(code, /check \(\(status = 'refreshing'\) = \(lease_token is not null\)\)/u);
});

test("account derivation: running unbound post -> its brand's only X account -> must equal the caller's account", () => {
  const account = definition("x_legacy_post_account");
  assert.match(account, /v_post\.status is distinct from 'running' or v_post\.brand_id is distinct from p_brand_id/u);
  assert.match(account, /to_jsonb\(v_post\) ->> 'social_account_id'\) is not null/u);
  assert.match(account, /count\(\*\) from public\.social_accounts sa where sa\.brand_id = v_post\.brand_id and sa\.platform = 'x'\) <> 1/u);
  assert.match(account, /v_account\.id is distinct from p_social_account_id[\s\S]*X_CLAIM_ACCOUNT_MISMATCH/u);
  for (const check of ["X_ACCOUNT_NOT_VERIFIED", "X_ACCOUNT_PUBLISH_DISABLED", "X_CREDENTIAL_NOT_CONFIGURED", "X_REFRESH_SECRET_REF_SHARED"]) {
    assert.match(account, new RegExp(check, "u"));
  }
  assert.match(account, /vault_access_token_secret_id = v_account\.vault_refresh_token_secret_id/u);
  assert.doesNotMatch(account, /decrypted_secrets/u);
});

test("reader and begin refuse blocked accounts before any Vault read; begin: one refresh per post attempt", () => {
  for (const name of ["read_x_publish_credential_for_legacy_post", "begin_x_account_refresh_legacy_post"]) {
    const def = definition(name);
    const secretRead = def.indexOf("vault.decrypted_secrets");
    for (const check of ["x_legacy_post_account(", "X_REFRESH_IN_PROGRESS", "X_REFRESH_BLOCKED_UNCERTAIN", "X_REFRESH_REAUTH_REQUIRED"]) {
      const at = def.indexOf(check);
      assert.ok(at > 0 && at < secretRead, `${name}: ${check}`);
    }
  }
  const begin = definition("begin_x_account_refresh_legacy_post");
  assert.ok(begin.indexOf("X_REFRESH_ALREADY_USED_FOR_ATTEMPT") < begin.indexOf("vault.decrypted_secrets"));
  assert.ok(begin.indexOf("X_REFRESH_CLIENT_NOT_CONFIGURED") < begin.indexOf("vault.decrypted_secrets"));
  assert.match(begin, /legacy_refreshed_post_id = p_scheduled_post_id, legacy_refreshed_post_attempt = v_attempt/u);
  assert.match(begin, /x_legacy_post_account\(p_scheduled_post_id, p_social_account_id, p_brand_id, true\)/u);
});

test("commit: legacy lease holder only, exact snapshot rechecked under a self-conflicting lock, Vault writes masked", () => {
  const commit = definition("commit_x_account_refresh_legacy_post");
  assert.match(commit, /lock table public\.social_accounts in share row exclusive mode/u);
  assert.match(commit, /st\.lease_token = p_lease_token and st\.lease_kind = 'legacy_post'/u);
  for (const snap of ["v_post.attempt_count = v_state.lease_post_attempt", "v_account.updated_at is not distinct from v_state.account_updated_at",
    "v_account.oauth_client_ref is not distinct from v_state.leased_oauth_client_ref",
    "v_account.vault_access_token_secret_id is not distinct from v_state.leased_access_secret_id",
    "v_account.vault_refresh_token_secret_id is not distinct from v_state.leased_refresh_secret_id",
    "v_account.platform_user_id is not distinct from v_state.leased_platform_user_id", "v_account.publish_enabled is true"]) {
    assert.ok(commit.includes(snap), snap);
  }
  assert.match(commit, /return 'account_changed'/u);
  assert.match(commit, /perform vault\.update_secret\(v_account\.vault_access_token_secret_id, p_access_token\)/u);
  assert.match(commit, /if p_refresh_token is not null then\s+perform vault\.update_secret\(v_account\.vault_refresh_token_secret_id, p_refresh_token\)/u);
  assert.match(commit, /exception when others then\s+raise exception 'X_REFRESH_PERSIST_FAILED'/u);
  assert.doesNotMatch(commit, /secret_id\s*=\s*p_|p_[a-z_]*secret_id/u);
});

test("health: reauth -> connection_status 'failed' + code; reconnect (verified_at) resets; verified_at never set by refresh", () => {
  const mirror = definition("x_account_refresh_health_mirror");
  assert.match(mirror, /set connection_status = 'failed', last_connection_error_code = new\.last_error_code/u);
  assert.doesNotMatch(mirror, /verified_at|identity_verified/u);
  assert.match(code, /after update of status on public\.x_account_refresh_state_v2/u);
  assert.match(code, /after update of verified_at on public\.social_accounts\s+for each row when \(new\.connection_status = 'identity_verified' and new\.verified_at is distinct from old\.verified_at\)/u);
  const reset = definition("x_account_refresh_reset_on_reconnect");
  assert.match(reset, /st\.status in \('uncertain', 'reauth_required'\)/u);
  const unauthorized = definition("record_x_account_access_unauthorized");
  assert.match(unauthorized, /v_status <> 'idle' then return 'not_applicable'/u);
  assert.doesNotMatch(unauthorized, /connection_status|updated_at/u);
});

test("ACL: five RPCs service_role-only; internal and trigger functions closed; state table read-only", () => {
  const defs = code.match(/create function public\.[\s\S]*?\n\$\$;/gu) ?? [];
  assert.equal(defs.length, 9);
  for (const def of defs) assert.match(def, /security definer set search_path = ''/u);
  assert.match(code, /revoke all on public\.x_account_refresh_state_v2 from public, anon, authenticated, service_role;/u);
  const grant = code.slice(code.lastIndexOf("grant execute on function"));
  assert.doesNotMatch(grant, /x_legacy_post_account|health_mirror|reset_on_reconnect/u);
  assert.equal((grant.match(/public\.[a-z_]+\(/gu) ?? []).length, 5);
});

test("live dispatcher: every non-Kabumori brand uses the generic Vault account port; Kabumori legacy path unchanged", () => {
  const start = dispatcher.indexOf("if (brandContext.brand.id !== LEGACY_KABUMORI_BRAND_ID) {");
  const legacy = dispatcher.indexOf('const xAccessToken = Deno.env.get("X_OAUTH2_ACCESS_TOKEN");', start);
  assert.ok(start > 0 && legacy > start);
  const branch = dispatcher.slice(start, legacy).replace(/\/\/.*$/gmu, "");
  assert.match(branch, /VaultAccountXAuth\.load\(/u);
  assert.match(branch, /socialAccountId: brandContext\.socialAccount\.id/u);
  assert.match(branch, /xOAuthClientRegistryFromEnv\(/u);
  assert.match(branch, /refreshEnabled: Deno\.env\.get\("X_VAULT_ACCOUNT_REFRESH"\) === "enabled"/u);
  assert.match(branch, /X_VAULT_ACCOUNT_DIRECT_TOKEN_ACCESS_FORBIDDEN/u);
  assert.doesNotMatch(branch, /ai_salaryman_lab|loadAiLabVaultBackedXTokens|loadBrandXTokens|oauth_token_store|X_OAUTH2_/u);
  assert.doesNotMatch(dispatcher, /loadAiLabVaultBackedXTokens|brand\.id === "ai_salaryman_lab"\) \{\s*if \(scheduledPost\.post_type/u);
  // Credentials resolve before generation: the load happens inside the xAuth builder, before dispatch.
  assert.ok(dispatcher.indexOf("VaultAccountXAuth.load(") < dispatcher.indexOf("dispatchAiLabScheduledBrandPost({"));
  // postToX sends through the port first; the legacy 401 path stays for Kabumori.
  const post = dispatcher.slice(dispatcher.indexOf("async function postToX("), dispatcher.indexOf("async function postThreadToX("));
  assert.ok(post.indexOf("auth.vaultAccount.send(") < post.indexOf("await refreshXTokens(auth)"));
  assert.match(post, /throw new Error\("X_REQUEST_FAILED:401"\)[\s\S]*?await refreshXTokens/u);
});
