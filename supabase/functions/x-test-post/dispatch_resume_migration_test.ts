import assert from "node:assert/strict";
import test from "node:test";

const sql = await Deno.readTextFile(new URL("../../migrations/20260925120000_x_autopost_phase1h_dispatch_resume.sql", import.meta.url));
const code = sql.replace(/--.*$/gmu, "");

function definition(name: string): string {
  const match = code.match(new RegExp(`create function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, "u"));
  assert.ok(match, `missing ${name}`);
  return match[0];
}

test("one transaction, precondition first, additive; Phase1E reader untouched", () => {
  assert.match(code, /^\s*begin;/u);
  assert.match(code, /commit;\s*$/u);
  assert.ok(code.indexOf("PHASE1H_PRECONDITION_PHASE1E_1G_MISSING") < code.search(/create table|create function/u));
  assert.doesNotMatch(code, /create\s+or\s+replace|\bdrop\s|alter\s+function/iu);
  assert.doesNotMatch(code, /create\s+function\s+public\.read_x_publish_credential_for_claim_v2/iu);
});

test("snapshots are pre-X, plan-bound, shape-checked and immutable", () => {
  const snap = definition("record_v2_content_snapshot");
  assert.match(snap, /v_attempt\.phase <> 'pre_x'/u);
  assert.match(snap, /PROVIDER_STEP_PLAN_REQUIRED/u);
  assert.match(snap, /jsonb_array_length\(p_payload -> 'parts'\) <> v_plan\.expected_steps/u);
  assert.match(snap, /V2_CONTENT_SNAPSHOT_CONFLICT/u);
  assert.match(snap, /return 'already_recorded'/u);
});

test("tip / morning_greeting cannot start the provider without plan and snapshot", () => {
  const guard = definition("x_v2_require_plan_before_start");
  assert.match(guard, /old\.phase = 'pre_x' and new\.phase = 'provider_started'/u);
  assert.match(guard, /v_post_type in \('tip', 'morning_greeting'\)/u);
  assert.match(guard, /V2_CONTENT_SNAPSHOT_REQUIRED/u);
  assert.match(code, /before update of phase on public\.post_queue_attempts_v2/u);
});

test("resume is limited to provider-started attempts with every finished step confirmed and a next step left", () => {
  const resumable = definition("x_v2_attempt_resumable");
  assert.match(resumable, /a\.phase = 'provider_started' and a\.outcome is null/u);
  assert.match(resumable, /st\.phase <> 'finished' or st\.outcome <> 'provider_object_confirmed'/u);
  const reader = definition("read_x_publish_credential_for_resume_v2");
  assert.match(reader, /not public\.x_v2_attempt_resumable\(p_attempt_id\)/u);
  assert.match(reader, />= \(select p\.expected_steps/u);
  for (const check of ["X_ACCOUNT_NOT_X", "X_ACCOUNT_BRAND_MISMATCH", "X_ACCOUNT_NOT_VERIFIED", "X_ACCOUNT_PUBLISH_DISABLED", "X_CREDENTIAL_NOT_CONFIGURED"]) {
    assert.ok(reader.indexOf(check) > 0 && reader.indexOf(check) < reader.indexOf("vault.decrypted_secrets"), check);
  }
  assert.doesNotMatch(reader, /refresh_token|oauth_token_store|ai_salaryman_lab|limit\s+1/iu);
  assert.match(reader, /when others then raise exception 'X_CREDENTIAL_UNAVAILABLE'/u);
});

test("ACL: API RPCs service_role-only; helpers closed; snapshot table read-only", () => {
  const defs = code.match(/create function public\.[\s\S]*?\n\$\$;/gu) ?? [];
  assert.equal(defs.length, 5);
  for (const def of defs) assert.match(def, /security definer set search_path = ''/u);
  assert.match(code, /revoke all on public\.post_v2_content_snapshots from public, anon, authenticated, service_role;/u);
  assert.match(code, /from public, anon, authenticated, service_role;\s+grant execute on function/u);
  assert.doesNotMatch(code.slice(code.lastIndexOf("grant execute on function")), /x_v2_/u);
});
