// Static contract tests: the runtime behaviour is covered in delete_logic_test.ts, but these pin
// properties of the entry point and the migration that a future edit could silently break.
import assert from 'node:assert/strict';
import test from 'node:test';

const indexSource = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
const logicSource = await Deno.readTextFile(new URL('./delete_logic.ts', import.meta.url));
const migrationSource = await Deno.readTextFile(
  new URL('../../migrations/20260924100000_ensure_my_profile.sql', import.meta.url),
);

test('the entry point never reads the request body', () => {
  // The account to delete must come only from the verified token. Reading the body at all would be
  // the first step towards trusting a client-supplied id.
  assert.ok(!/req\.(json|text|formData|arrayBuffer|blob)\s*\(/.test(indexSource));
  assert.ok(!/new URL\(req\.url\)\.searchParams/.test(indexSource));
});

test('only the delete call uses the service role key, and it is never echoed', () => {
  assert.equal(indexSource.match(/SUPABASE_SERVICE_ROLE_KEY/g)?.length, 1);
  assert.ok(!/console\.(log|info|warn|error|debug)/.test(indexSource));
  assert.ok(!/console\.(log|info|warn|error|debug)/.test(logicSource));
  // Every error the client can see is one of two fixed codes -- never an interpolated message that
  // could carry a token, an id, or an upstream response body.
  const constructed = [...logicSource.matchAll(/new AccountDeleteError\(([^)]*)\)/g)]
    .map((match) => match[1].split(',')[0].trim());
  assert.deepEqual([...new Set(constructed)].sort(), ['AUTH_REQUIRED', 'FAILED']);
  assert.ok(!/json\(\{[^}]*serviceRoleKey/.test(indexSource));
});

test('the caller token is presented only to the auth verification endpoint', () => {
  // The caller's bearer value is forwarded exactly once, to /auth/v1/user. The admin delete hop
  // authenticates as the service role instead, so a user token can never reach the admin API.
  assert.equal(logicSource.match(/Bearer \$\{token\}/g)?.length, 1);
  assert.equal(logicSource.match(/Bearer \$\{serviceRoleKey\}/g)?.length, 1);
  const adminLine = logicSource
    .split('\n')
    .findIndex((line) => line.includes('/auth/v1/admin/users/'));
  const userLine = logicSource.split('\n').findIndex((line) => line.includes('/auth/v1/user'));
  assert.ok(userLine > -1 && adminLine > userLine, 'verification must happen before deletion');
});

test('success is reported only after the delete call resolves', () => {
  const successIndex = indexSource.indexOf('success: true');
  const awaitIndex = indexSource.indexOf('await deleteOwnAccount');
  assert.ok(awaitIndex > -1 && successIndex > awaitIndex);
});

test('the profile RPC takes no id argument and derives the user from auth.uid()', () => {
  assert.match(migrationSource, /create or replace function public\.ensure_my_profile\(\)/);
  assert.match(migrationSource, /v_user_id uuid := \(select auth\.uid\(\)\)/);
  assert.match(migrationSource, /insert into public\.profiles \(id\)\s*\n\s*values \(v_user_id\)/);
  assert.match(migrationSource, /on conflict \(id\) do nothing/);
  // No argument exists that a caller could use to name a different account.
  assert.ok(!/ensure_my_profile\(\s*p_/.test(migrationSource));
});

test('the profile RPC is executable only by authenticated callers', () => {
  assert.match(
    migrationSource,
    /revoke all on function public\.ensure_my_profile\(\) from public, anon, authenticated, service_role;/,
  );
  assert.match(migrationSource, /grant execute on function public\.ensure_my_profile\(\) to authenticated;/);
  assert.match(migrationSource, /security invoker/);
  assert.match(migrationSource, /set search_path = ''/);
  assert.match(migrationSource, /raise exception 'AUTHENTICATION_REQUIRED'/);
});

test('the migration only adds a function and changes no table or policy', () => {
  for (const forbidden of [
    /create table/i,
    /alter table/i,
    /drop table/i,
    /create policy/i,
    /drop policy/i,
    /create trigger/i,
    /alter\s+.*\bauth\./i,
    /delete from/i,
    /update public\./i,
  ]) {
    assert.ok(!forbidden.test(migrationSource), `migration must not contain ${forbidden}`);
  }
});
