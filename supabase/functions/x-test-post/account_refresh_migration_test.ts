import assert from "node:assert/strict";
import test from "node:test";

const sql = await Deno.readTextFile(new URL("../../migrations/20260925150000_x_autopost_phase1i_account_refresh.sql", import.meta.url));
const code = sql.replace(/--.*$/gmu, "");
const dispatcher = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function definition(name: string): string {
  const match = code.match(new RegExp(`create function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, "u"));
  assert.ok(match, `missing ${name}`);
  return match[0];
}

test("one transaction, preconditions first, additive only", () => {
  assert.match(code, /^\s*begin;/u);
  assert.match(code, /commit;\s*$/u);
  const first = code.search(/create table|create function|create trigger/u);
  for (const pre of ["PHASE1I_PRECONDITION_PHASE1H_OR_VAULT_MISSING", "PHASE1I_PRECONDITION_REFRESH_CORE_MISSING",
    "PHASE1I_PRECONDITION_SOCIAL_ACCOUNTS_SHAPE"]) {
    assert.ok(code.indexOf(pre) > 0 && code.indexOf(pre) < first, pre);
  }
  assert.doesNotMatch(code, /create\s+or\s+replace|\bdrop\s|alter\s+function|alter\s+table\s+public\.social_accounts/iu);
  // Builds on the core's one lease table; only the attempt FK is added.
  assert.doesNotMatch(code, /create table/iu);
  assert.match(code, /alter table public\.x_account_refresh_state_v2\s+add constraint x_account_refresh_state_v2_lease_attempt_fkey\s+foreign key \(lease_attempt_id\) references public\.post_queue_attempts_v2 \(id\);/u);
});

test("begin: exact claim authority, account checks, shared-ref refusal, single-flight lease; secret read last", () => {
  const begin = definition("begin_x_account_refresh_v2");
  assert.match(begin, /a\.id = p_attempt_id and a\.claim_token = p_claim_token for update/u);
  assert.match(begin, /v_attempt\.phase <> 'pre_x' or v_attempt\.outcome is not null/u);
  assert.match(begin, /where sa\.id = v_attempt\.social_account_id for update/u);
  const secretRead = begin.indexOf("vault.decrypted_secrets");
  for (const check of ["X_REFRESH_ACCOUNT_MISMATCH", "X_ACCOUNT_NOT_X", "X_ACCOUNT_BRAND_MISMATCH", "X_ACCOUNT_NOT_VERIFIED",
    "X_ACCOUNT_PUBLISH_DISABLED", "X_REFRESH_CREDENTIAL_NOT_CONFIGURED", "X_REFRESH_SECRET_REF_SHARED",
    "X_REFRESH_IN_PROGRESS", "X_REFRESH_BLOCKED_UNCERTAIN", "X_REFRESH_REAUTH_REQUIRED"]) {
    const at = begin.indexOf(check);
    assert.ok(at > 0 && at < secretRead, check);
  }
  assert.doesNotMatch(begin, /oauth_token_store|limit\s+1|ai_salaryman_lab|order\s+by/iu);
  assert.match(begin, /returns table \(lease_token uuid, oauth_client_ref text, refresh_token text\)/u);
  assert.match(begin, /lease_kind = 'v2_attempt'/u);
});

test("commit: lease holder only, same account only, account unchanged, Vault writes masked and atomic", () => {
  const commit = definition("commit_x_account_refresh_v2");
  assert.match(commit, /v_state\.lease_token is distinct from p_lease_token/u);
  assert.match(commit, /return 'lease_lost'/u);
  assert.match(commit, /v_account\.updated_at is distinct from v_state\.account_updated_at/u);
  assert.match(commit, /lock table public\.social_accounts in share row exclusive mode/u);
  assert.match(commit, /st\.lease_token = p_lease_token and st\.lease_kind = 'v2_attempt'/u);
  assert.match(commit, /v_state\.lease_kind is distinct from 'v2_attempt'/u);
  assert.match(commit, /v_account\.vault_access_token_secret_id is distinct from v_state\.leased_access_secret_id/u);
  assert.match(commit, /v_account\.vault_refresh_token_secret_id is distinct from v_state\.leased_refresh_secret_id/u);
  assert.match(commit, /v_attempt\.phase is distinct from 'pre_x'/u);
  assert.match(commit, /v_post\.status is distinct from 'running'/u);
  assert.match(commit, /return 'account_changed'/u);
  assert.match(commit, /perform vault\.update_secret\(v_account\.vault_access_token_secret_id, p_access_token\)/u);
  assert.match(commit, /if p_refresh_token is not null then\s+perform vault\.update_secret\(v_account\.vault_refresh_token_secret_id, p_refresh_token\)/u);
  assert.match(commit, /exception when others then\s+raise exception 'X_REFRESH_PERSIST_FAILED'/u);
  assert.doesNotMatch(commit, /secret_id\s*=\s*p_|p_[a-z_]*secret_id/u);
});

test("release comes from the core; guards", () => {
  assert.doesNotMatch(code, /create function public\.release_x_account_refresh_v2/u);
  const guard = definition("x_v2_block_provider_during_refresh");
  assert.match(guard, /old\.phase = 'pre_x' and new\.phase = 'provider_started'/u);
  assert.match(guard, /for share/u);
  assert.match(code, /before update of phase on public\.post_queue_attempts_v2/u);
  assert.match(code, /before insert on public\.post_provider_steps_v2/u);
});

test("ACL: two RPCs service_role-only, guard closed", () => {
  const defs = code.match(/create function public\.[\s\S]*?\n\$\$;/gu) ?? [];
  assert.equal(defs.length, 3);
  for (const def of defs) assert.match(def, /security definer set search_path = ''/u);
  assert.match(code, /public\.commit_x_account_refresh_v2\(uuid, text, text, text, integer\)\s+to service_role;/u);
  assert.match(code, /from public, anon, authenticated, service_role;\s+grant execute on function/u);
  assert.doesNotMatch(code.slice(code.lastIndexOf("grant execute on function")), /x_v2_/u);
});

test("live dispatcher never uses the v2-attempt refresh (the legacy path uses the core via vault_account_auth)", () => {
  assert.doesNotMatch(dispatcher, /begin_x_account_refresh_v2|commit_x_account_refresh_v2|refreshXAccountPreX|createXAccountRefreshRpcLedger/u);
});
