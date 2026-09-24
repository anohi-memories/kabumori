import assert from "node:assert/strict";
import test from "node:test";

const sql = await Deno.readTextFile(new URL("../../migrations/20260924170000_x_autopost_phase1e_claim_bound_credential_reader.sql", import.meta.url));
const code = sql.replace(/--.*$/gmu, "");
const dispatcher = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

test("Phase1E migration only adds the claim-bound reader", () => {
  assert.equal((code.match(/create function/giu) ?? []).length, 1);
  assert.doesNotMatch(code, /create\s+or\s+replace|alter\s+(table|function)|drop\s|insert\s+into|update\s+public|delete\s+from|create\s+(table|trigger|index)/iu);
  assert.match(code, /create function public\.read_x_publish_credential_for_claim_v2\(/u);
});

test("authority is the open pre-X attempt and the exact account by primary key", () => {
  assert.match(code, /where a\.id = p_attempt_id and a\.claim_token = p_claim_token/u);
  assert.match(code, /v_attempt\.phase <> 'pre_x'/u);
  assert.match(code, /v_attempt\.social_account_id <> p_social_account_id\s+or v_attempt\.brand_id <> p_expected_brand_id/u);
  assert.match(code, /s\.status = 'running'/u);
  assert.match(code, /where sa\.id = v_attempt\.social_account_id;/u);
  assert.doesNotMatch(code, /limit\s+1|order\s+by|brand_id\s*=\s*p_expected_brand_id\s+and\s+sa\.platform/iu);
});

test("every metadata check precedes the Vault read and only the access token leaves the database", () => {
  const vaultRead = code.indexOf("vault.decrypted_secrets");
  for (const check of ["X_ACCOUNT_NOT_FOUND", "X_ACCOUNT_NOT_X", "X_ACCOUNT_BRAND_MISMATCH", "X_ACCOUNT_NOT_VERIFIED", "X_ACCOUNT_PUBLISH_DISABLED", "X_CREDENTIAL_NOT_CONFIGURED"]) {
    const at = code.indexOf(check);
    assert.ok(at > 0 && at < vaultRead, check);
  }
  assert.doesNotMatch(code, /refresh_token|oauth_token_store|ai_salaryman_lab|x_oauth2|Deno/iu);
  assert.match(code, /returns table \(social_account_id text, brand_id text, platform_user_id text, access_token text\)/u);
});

test("errors are fixed codes and database errors are masked", () => {
  assert.match(code, /begin;\s+create function public\.read_x_publish_credential_for_claim_v2/u);
  assert.match(code, /to service_role;\s+commit;/u);
  assert.match(code, /from vault\.decrypted_secrets ds where ds\.id = v_access_secret_id;\s+exception when others then\s+raise exception 'X_CREDENTIAL_UNAVAILABLE'/u);
  assert.match(code, /when sqlstate 'P0001' then\s+raise;\s+when others then\s+raise exception 'X_CREDENTIAL_UNAVAILABLE'/u);
  assert.doesNotMatch(code, /raise exception '[^']*%/u);
});

test("security definer, empty search_path, service_role-only EXECUTE", () => {
  assert.match(code, /language plpgsql security definer set search_path = ''/u);
  assert.match(code, /from public, anon, authenticated;/u);
  assert.match(code, /to service_role;/u);
});

test("live dispatcher does not call the v2 reader or seam yet", () => {
  assert.doesNotMatch(dispatcher, /read_x_publish_credential_for_claim_v2|x_v2_claim_credentials|x_v2_one_request_provider/u);
});
