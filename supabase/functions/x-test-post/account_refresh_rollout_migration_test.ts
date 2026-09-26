import assert from "node:assert/strict";
import test from "node:test";

const read = async (name: string) =>
  (await Deno.readTextFile(new URL(`../../migrations/${name}`, import.meta.url))).replace(/--.*$/gmu, "");
const code = await read("20260926032054_x_account_refresh_rollout_authority.sql");
const core = await read("20260925140000_x_account_credential_refresh_core.sql");
const phase1i = await read("20260925150000_x_autopost_phase1i_account_refresh.sql");

function definition(source: string, name: string, kind = "create function"): string {
  const match = source.match(new RegExp(`${kind} public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, "u"));
  assert.ok(match, `missing ${name}`);
  return match[0];
}

test("one transaction, core required, not re-runnable, never re-creates core objects", () => {
  assert.match(code, /^\s*begin;/u);
  assert.match(code, /commit;\s*$/u);
  const first = code.search(/create table|create function|create or replace function|insert into/u);
  for (const pre of ["STAGE3A_PRECONDITION_REFRESH_CORE_MISSING", "STAGE3A_PRECONDITION_ALREADY_APPLIED"]) {
    assert.ok(code.indexOf(pre) > 0 && code.indexOf(pre) < first, pre);
  }
  assert.doesNotMatch(code, /create table public\.x_account_refresh_state_v2|\bdrop\s|alter table public\.(social_accounts|x_account_refresh_state_v2)/iu);
  // The only replaced live object is the legacy begin.
  assert.deepEqual(code.match(/create or replace function public\.[a-z_0-9]+/gu), ["create or replace function public.begin_x_account_refresh_legacy_post"]);
  assert.doesNotMatch(code, /ai_salaryman_lab|kabumori|oauth_token_store|limit\s+1|order by sa\.created_at/iu);
});

test("legacy begin = live core begin + one authority check before the Vault read", () => {
  const live = definition(core, "begin_x_account_refresh_legacy_post");
  const next = definition(code, "begin_x_account_refresh_legacy_post", "create or replace function");
  const check = "  v_block := public.x_account_refresh_authority(v_account.id);\n"
    + "  if v_block is not null then raise exception '%', v_block using errcode = 'P0001'; end if;\n";
  const expected = live.replace("create function", "create or replace function")
    .replace("        v_lease uuid;\nbegin", "        v_lease uuid;\n        v_block text;\nbegin")
    .replace("    raise exception 'X_REFRESH_ALREADY_USED_FOR_ATTEMPT' using errcode = 'P0001';\n  end if;\n",
      "    raise exception 'X_REFRESH_ALREADY_USED_FOR_ATTEMPT' using errcode = 'P0001';\n  end if;\n  \n" + check);
  assert.equal(next.replace(/\n\s*\n/gu, "\n"), expected.replace(/\n\s*\n/gu, "\n"));
  assert.ok(next.indexOf("x_account_refresh_authority") < next.indexOf("vault.decrypted_secrets"));
});

test("authority predicate: exact account only, rollout row required, pilot gates, never reads Vault", () => {
  const authority = definition(code, "x_account_refresh_authority");
  assert.match(authority, /stable security definer set search_path = ''/u);
  assert.doesNotMatch(authority, /decrypted_secrets|vault\./u);
  assert.match(authority, /from public\.x_account_refresh_rollout r where r\.social_account_id = v_account\.id/u);
  assert.match(authority, /if not found or v_rollout\.mode = 'off' then return 'X_REFRESH_ROLLOUT_OFF'/u);
  for (const c of ["X_REFRESH_PILOT_EXPIRED", "X_REFRESH_PILOT_LIMIT_REACHED", "X_REFRESH_PILOT_BLOCKED_BY_ERROR",
    "X_ACCOUNT_PUBLISH_DISABLED", "X_ACCOUNT_NOT_VERIFIED", "X_REFRESH_SECRET_REF_SHARED", "X_REFRESH_CREDENTIAL_NOT_CONFIGURED",
    "X_REFRESH_IN_PROGRESS", "X_REFRESH_BLOCKED_UNCERTAIN", "X_REFRESH_REAUTH_REQUIRED"]) {
    assert.match(authority, new RegExp(`'${c}'`, "u"), c);
  }
  assert.doesNotMatch(authority, /\bbrand_id\b|\bhandle\b|email|order by|\blimit\s+\d/u);
});

test("Phase1I v2 begin calls the same predicate before its Vault read", () => {
  const begin = definition(phase1i, "begin_x_account_refresh_v2");
  const at = begin.indexOf("public.x_account_refresh_authority(v_account.id)");
  assert.ok(at > 0 && at < begin.indexOf("vault.decrypted_secrets"));
});

test("setter: the only mutation path, validated; pilot is time-boxed with a refresh budget", () => {
  const setter = definition(code, "set_x_account_refresh_rollout");
  assert.match(setter, /p_mode not in \('off', 'pilot', 'enabled'\)/u);
  assert.match(setter, /p_pilot_expires_at > now\(\) \+ interval '30 days'/u);
  assert.match(setter, /p_pilot_refresh_budget < 1 or p_pilot_refresh_budget > 24/u);
  assert.match(setter, /v_generation \+ p_pilot_refresh_budget/u);
  for (const c of ["X_REFRESH_CLIENT_NOT_CONFIGURED", "X_REFRESH_CREDENTIAL_NOT_CONFIGURED", "X_REFRESH_SECRET_REF_SHARED"]) {
    assert.match(setter, new RegExp(c, "u"));
  }
});

test("health contract has no secret ids, tokens or lease tokens; stale resolution never returns to idle", () => {
  const health = definition(code, "get_x_account_refresh_health");
  const columns = health.slice(health.indexOf("returns table ("), health.indexOf(") language sql"));
  assert.doesNotMatch(columns, /secret_id|token|lease_token/u);
  assert.match(health, /stuck_refreshing|interval '10 minutes'/u);
  const resolve = definition(code, "resolve_stale_x_account_refresh_lease");
  assert.match(resolve, /set status = 'uncertain'/u);
  assert.doesNotMatch(resolve, /status = 'idle'/u);
  assert.match(resolve, /p_min_age < interval '5 minutes'/u);
});

test("grandfathering is data-driven: proven clean committed refresh only", () => {
  assert.match(code, /'enabled', 'GRANDFATHERED_PROVEN_REFRESH'[\s\S]*where st\.generation > 0 and st\.status = 'idle' and st\.last_error_code is null/u);
});

test("ACL: rollout table read-only for service_role; setter/health service_role only; predicate/resolver closed", () => {
  assert.match(code, /revoke all on public\.x_account_refresh_rollout from public, anon, authenticated, service_role;\s+grant select on public\.x_account_refresh_rollout to service_role;/u);
  const grant = code.slice(code.lastIndexOf("grant execute on function"));
  assert.match(grant, /set_x_account_refresh_rollout[\s\S]*get_x_account_refresh_health/u);
  assert.doesNotMatch(grant, /x_account_refresh_authority|resolve_stale/u);
  for (const def of code.match(/create (or replace )?function public\.[\s\S]*?\n\$\$;/gu) ?? []) {
    assert.match(def, /security definer set search_path = ''/u);
  }
  assert.doesNotMatch(code, /grant [^;]* to (anon|authenticated)/u);
});
