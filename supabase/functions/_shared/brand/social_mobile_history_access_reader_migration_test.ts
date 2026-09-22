import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../../../migrations/20260923120000_social_mobile_history_access_token_reader.sql", import.meta.url);

test("history token RPC is server-only, access-only, owner-bound, and fail-closed", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const createFunctionBody = sql.match(/create function public\.read_social_mobile_history_access_token[\s\S]*?\n\$\$;/iu)?.[0];
  assert.ok(createFunctionBody);
  assert.match(createFunctionBody, /security definer/iu);
  assert.match(createFunctionBody, /set search_path = ''/iu);
  assert.match(createFunctionBody, /p_user_id uuid,\s*p_social_account_id text/iu);
  assert.match(createFunctionBody, /bm\.user_id = p_user_id[\s\S]*?bm\.role = 'owner'/iu);
  assert.match(createFunctionBody, /v_x_account_count <> 1/iu);
  assert.match(createFunctionBody, /v_verified_x_account_count <> 1/iu);
  assert.match(createFunctionBody, /sa\.connection_status = 'identity_verified'/iu);
  assert.match(createFunctionBody, /sa\.platform = 'x'/iu);
  assert.match(createFunctionBody, /sa\.vault_access_token_secret_id/iu);
  assert.match(createFunctionBody, /vault\.decrypted_secrets/iu);
  assert.doesNotMatch(createFunctionBody, /vault_refresh_token_secret_id/iu);
  assert.doesNotMatch(createFunctionBody, /p_vault_secret_id|p_secret_id|p_secret_ref/iu);
  assert.match(sql, /SOCIAL_MOBILE_HISTORY_READER_RPC_ALREADY_EXISTS/iu);
  assert.match(sql, /revoke all on function public\.read_social_mobile_history_access_token\(uuid, text\)\s+from public, anon, authenticated, service_role/iu);
  assert.match(sql, /grant execute on function public\.read_social_mobile_history_access_token\(uuid, text\)\s+to service_role/iu);

  const ownerCheck = createFunctionBody.indexOf("join public.brand_memberships");
  const accessRefRead = createFunctionBody.indexOf("select sa.vault_access_token_secret_id");
  const plaintextRead = createFunctionBody.indexOf("from vault.decrypted_secrets");
  assert.ok(ownerCheck >= 0 && ownerCheck < accessRefRead && accessRefRead < plaintextRead);
});
