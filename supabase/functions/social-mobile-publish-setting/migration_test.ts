// Source-side contract between the publish-permission migration and the two pieces of Edge code that
// call it (no database, no network). The behavior itself is proven on a disposable PostgreSQL by
// supabase/tests/social_mobile_publish_permission_run.sh (+ _mutations.sh).
import assert from "node:assert/strict";
import test from "node:test";
import { BLOCKED_REASONS } from "./logic.ts";
import { parseDecision, PUBLISH_SETTING_RPC } from "./http.ts";

const MIGRATION = new URL("../../migrations/20261003090000_social_mobile_publish_permission_boundary.sql", import.meta.url);
const sql = await Deno.readTextFile(MIGRATION);
/** SQL without comments. */
const code = sql.split("\n").map((line) => line.replace(/--.*$/u, "")).join("\n");

function functionBody(name: string): string {
  const start = code.indexOf(`create function public.${name}(`);
  assert.ok(start >= 0, name);
  const end = code.indexOf("\n$$;", start);
  assert.ok(end > start, name);
  return code.slice(start, end);
}
const toggle = functionBody(PUBLISH_SETTING_RPC);
const permission = functionBody("assert_x_publish_permission_for_legacy_post");

test("the switch has exactly the three arguments the Edge function sends: no user id, no brand id", () => {
  assert.match(
    toggle,
    /^create function public\.set_social_account_publish_enabled\(\s*p_social_account_id text, p_desired_enabled boolean, p_expected_current_enabled boolean\s*\) returns jsonb/u,
  );
  assert.doesNotMatch(toggle.slice(0, toggle.indexOf("returns jsonb")), /p_user|p_brand|uuid/u);
  assert.match(toggle, /v_user uuid := auth\.uid\(\);/u, "the caller comes from the JWT");
});

test("both functions are SECURITY DEFINER with an empty search_path; the switch bounds its lock waits", () => {
  for (const body of [toggle, permission]) {
    assert.match(body, /language plpgsql security definer\s+set search_path = ''/u);
  }
  assert.match(toggle, /set lock_timeout = '3s'/u);
});

test("least privilege: everything revoked first; the switch only for authenticated, the check only for service_role", () => {
  const grants = code.slice(code.indexOf("revoke all on function public.set_social_account_publish_enabled"));
  assert.match(
    grants,
    /^revoke all on function public\.set_social_account_publish_enabled\(text, boolean, boolean\),\s+public\.assert_x_publish_permission_for_legacy_post\(uuid, text, text\)\s+from public, anon, authenticated, service_role;/u,
  );
  assert.deepEqual(
    [...grants.matchAll(/grant execute on function public\.(\w+)\([^)]*\) to ([\w, ]+);/gu)].map((match) => [match[1], match[2]]),
    [["set_social_account_publish_enabled", "authenticated"], ["assert_x_publish_permission_for_legacy_post", "service_role"]],
  );
  assert.equal((code.match(/\bgrant\b/giu) ?? []).length, 2, "no other grant in the file");
});

test("H2 F2: creator = the helper's owner and no superuser; extra grantees removed from these two functions only; exact and effective postcondition before COMMIT", () => {
  const at = (needle: string) => {
    const index = code.indexOf(needle);
    assert.ok(index >= 0, needle);
    return index;
  };
  const order = [
    at("raise exception 'PUBLISH_PERMISSION_PRECONDITION_OWNER'"),
    at("create function public.set_social_account_publish_enabled("),
    at("create function public.assert_x_publish_permission_for_legacy_post("),
    at("from public, anon, authenticated, service_role;"),
    at("execute format('revoke all on function %s from %s'"),
    at("grant execute on function public.set_social_account_publish_enabled"),
    at("raise exception 'PUBLISH_PERMISSION_EFFECTIVE_ACL'"),
    code.lastIndexOf("commit;"),
  ];
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  // The owner check compares the creator with the exact-account helper's owner and refuses a superuser.
  const precondition = code.slice(code.indexOf("do $$"), code.indexOf("create function"));
  assert.match(precondition, /'public\.x_legacy_post_account\(uuid,text,text,boolean\)'::regprocedure\)\s+is distinct from \(select r\.oid from pg_catalog\.pg_roles r where r\.rolname = current_user\) then\s+raise exception 'PUBLISH_PERMISSION_PRECONDITION_OWNER';/u);
  assert.match(precondition, /rolsuper from pg_catalog\.pg_roles r where r\.rolname = current_user\) is distinct from false then\s+raise exception 'PUBLISH_PERMISSION_PRECONDITION_OWNER';/u);
  // The clean-up revokes only on the two new functions (constant signatures), never elsewhere.
  const cleanup = code.slice(at("execute format('revoke all on function %s from %s'") - 900, at("grant execute on function public.set_social_account_publish_enabled"));
  assert.match(cleanup, /values \('public\.set_social_account_publish_enabled\(text,boolean,boolean\)'\),\s+\('public\.assert_x_publish_permission_for_legacy_post\(uuid,text,text\)'\)\) f \(signature\)/u);
  // The postcondition checks direct ACL, the app roles' effective privileges, and every other role.
  const post = code.slice(at("grant execute on function public.assert_x_publish_permission_for_legacy_post"), code.lastIndexOf("commit;"));
  for (const needle of [
    "a.is_grantable", "has_function_privilege('anon', v_switch, 'execute')", "has_function_privilege('authenticated', v_check, 'execute')",
    "has_function_privilege('service_role', v_switch, 'execute')", "from pg_catalog.pg_roles r", "pg_has_role(r.oid, v_owner, 'usage')",
  ]) assert.ok(post.includes(needle), needle);
  // No global default-privilege change, no role membership change, no table privilege.
  assert.doesNotMatch(code, /alter default privileges|\bgrant\s+(?!execute on function)|\brevoke\s+(?!all on function)/iu);
});

test("the migration creates two functions and nothing else: no table, policy, trigger, column or table grant", () => {
  assert.equal((code.match(/create (or replace )?function/giu) ?? []).length, 2);
  assert.doesNotMatch(code, /create or replace/iu, "never redefines an existing (live) function");
  assert.doesNotMatch(code, /create (table|policy|trigger|index|view|type)|alter table|drop |row level security|on table/iu);
  assert.match(code, /^\s*begin;/mu);
  assert.match(code.trimEnd(), /commit;$/u);
});

test("the switch writes one column of one table, once; the permission check writes nothing; neither touches Vault", () => {
  const writes = [...toggle.matchAll(/\b(insert into|delete from|update)\s+([\w.]+)/giu)].map((match) => `${match[1].toLowerCase()} ${match[2]}`);
  // "for update" row locks are not writes.
  assert.deepEqual(writes.filter((write) => !/^update (public\.social_accounts)$/u.test(write)), []);
  assert.equal(writes.length, 1);
  assert.match(toggle, /update public\.social_accounts sa\s+set publish_enabled = p_desired_enabled\s+where sa\.id = v_account\.id and sa\.brand_id = v_brand_id and sa\.publish_enabled = p_expected_current_enabled;/u);
  assert.doesNotMatch(permission, /\b(insert into|delete from|update public|for update|for share|lock table)\b/iu);
  for (const body of [toggle, permission]) {
    assert.doesNotMatch(body, /vault\.|decrypted_secret|oauth_token_store|auth\.users|scheduled_posts\s+set|execute\s/iu);
  }
});

test("lock order in the switch: table lock, then brand, membership, account; all re-read under lock before the decision", () => {
  const order = [
    "lock table public.social_accounts in row exclusive mode;",
    "from public.brands b where b.id = v_brand_id for share;",
    "where bm.brand_id = v_brand_id and bm.user_id = v_user for share;",
    "from public.social_accounts sa where sa.id = p_social_account_id for update;",
    "v_account.publish_enabled is distinct from p_expected_current_enabled",
    "update public.social_accounts sa",
  ].map((needle) => {
    const at = toggle.indexOf(needle);
    assert.ok(at >= 0, needle);
    return at;
  });
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("every status and reason the SQL can return is one the Edge function accepts, and nothing more", () => {
  const statuses = new Set([...toggle.matchAll(/'status', '(\w+)'/gu)].map((match) => match[1]));
  assert.deepEqual([...statuses].sort(), ["auth_required", "blocked", "busy", "forbidden", "invalid", "not_found", "stale", "unchanged", "updated"]);
  for (const status of statuses) {
    const sample = status === "blocked"
      ? { status, reason: "BRAND_INACTIVE" }
      : ["updated", "unchanged", "stale"].includes(status)
      ? { status, publish_enabled: true }
      : { status };
    assert.equal(parseDecision(sample).status, status);
  }
  const reasons = new Set([...toggle.matchAll(/then '([A-Z_]+)'|v_reason := '([A-Z_]+)'/gu)].map((match) => match[1] ?? match[2]));
  assert.deepEqual([...reasons].sort(), [...BLOCKED_REASONS].sort());
  // State is returned only together with updated / unchanged / stale, never with a refusal.
  for (const match of toggle.matchAll(/jsonb_build_object\(([^)]*)\)/gu)) {
    if (/publish_enabled/u.test(match[1])) assert.match(match[1], /'(updated|unchanged|stale)'/u, match[1]);
  }
});

test("the permission check answers 'authorized' or raises a fixed code; it reuses the exact-account contract and reads brand state in one statement", () => {
  assert.match(permission, /v_account := public\.x_legacy_post_account\(p_scheduled_post_id, p_social_account_id, p_brand_id, false\);/u);
  const codes = [...permission.matchAll(/then '([A-Za-z_]+)'|else '([a-z]+)'|raise exception '([A-Z_]+)'/gu)].map((match) => match[1] ?? match[2] ?? match[3]);
  for (const value of codes) assert.match(value, /^(authorized|[A-Z][A-Z0-9_]{1,99})$/u, value);
  for (const required of ["BRAND_DISABLED", "BRAND_PUBLISH_MODE_DISABLED", "BRAND_PUBLISH_MODE_DRY_RUN", "X_ACCOUNT_PUBLISH_DISABLED", "X_ACCOUNT_NOT_VERIFIED", "X_ACCOUNT_CONNECTION_DEGRADED", "SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS", "X_PUBLISH_PERMISSION_UNAVAILABLE"]) {
    assert.ok(codes.includes(required), required);
  }
  // One SELECT covers post, brand, account and refresh state: a single snapshot.
  assert.equal((permission.match(/\bselect case\b/giu) ?? []).length, 1);
  const statement = permission.slice(permission.indexOf("select case"), permission.indexOf("if not found"));
  for (const table of ["public.social_accounts sa", "public.scheduled_posts sp", "public.brands b", "public.x_account_refresh_state_v2 st"]) {
    assert.ok(statement.includes(table), table);
  }
});

test("H2 F1: the final pre-send statement itself requires every structural condition ON requires", () => {
  const statement = permission.slice(permission.indexOf("select case"), permission.indexOf("if not found"));
  for (const [onCondition, sendCondition] of [
    ["v_account.connection_status is distinct from 'identity_verified'", "sa.connection_status is distinct from 'identity_verified'"],
    ["nullif(btrim(v_account.platform_user_id), '') is null", "nullif(btrim(sa.platform_user_id), '') is null"],
    ["v_account.verified_at is null", "sa.verified_at is null then 'X_ACCOUNT_NOT_VERIFIED'"],
    ["v_account.vault_access_token_secret_id is null", "sa.vault_access_token_secret_id is null"],
    ["v_account.vault_access_token_secret_id = v_account.vault_refresh_token_secret_id", "sa.vault_access_token_secret_id = sa.vault_refresh_token_secret_id"],
    ["nullif(btrim(v_account.last_connection_error_code), '') is not null", "nullif(btrim(sa.last_connection_error_code), '') is not null then 'X_ACCOUNT_CONNECTION_DEGRADED'"],
    ["v_brand.is_active is distinct from true", "b.is_active is distinct from true"],
    ["v_brand.publish_mode is distinct from 'live'", "b.publish_mode is distinct from 'live'"],
  ]) {
    assert.ok(toggle.includes(onCondition), `ON: ${onCondition}`);
    assert.ok(statement.includes(sendCondition), `send: ${sendCondition}`);
  }
  // `refreshing` stays a non-refusal at send time (only the two blocked states refuse).
  assert.deepEqual([...statement.matchAll(/st\.status = '(\w+)'/gu)].map((match) => match[1]), ["uncertain", "reauth_required"]);
});

test("the Vault send adapter calls the permission check by the exact name and argument names the migration defines", async () => {
  const adapter = await Deno.readTextFile(new URL("../x-test-post/vault_account_auth.ts", import.meta.url));
  assert.match(adapter, /rpc\("assert_x_publish_permission_for_legacy_post", post\(ref\), "X_PUBLISH_PERMISSION_UNAVAILABLE"\)/u);
  assert.match(adapter, /p_scheduled_post_id: ref\.scheduledPostId, p_social_account_id: ref\.socialAccountId, p_brand_id: ref\.brandId/u);
  assert.match(permission, /^create function public\.assert_x_publish_permission_for_legacy_post\(\s*p_scheduled_post_id uuid, p_social_account_id text, p_brand_id text\s*\) returns text/u);
});

test("preconditions: refuses to apply without what it builds on, and refuses to apply twice", () => {
  for (const needle of [
    "to_regclass('public.brand_memberships') is null",
    "to_regclass('public.social_mobile_account_deletions') is null",
    "to_regclass('public.x_account_refresh_state_v2') is null",
    "to_regprocedure('public.x_legacy_post_account(uuid,text,text,boolean)') is null",
    "PUBLISH_PERMISSION_PRECONDITION_ALREADY_APPLIED",
    "PUBLISH_PERMISSION_PRECONDITION_ROLES",
    "PUBLISH_PERMISSION_PRECONDITION_OWNER",
  ]) assert.ok(code.includes(needle), needle);
});

test("H2 F3: the file tells the operator to deploy the guarded runtime first, never to apply first", () => {
  assert.doesNotMatch(sql, /Apply BEFORE deploying/u);
  assert.match(sql, /is deployed, read back and drained of older invocations FIRST/u);
  assert.match(sql, /social_mobile_publish_permission\.md, section 6/u);
});
