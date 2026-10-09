// Static containment contract (no network, no database): the old self-service hard delete is gone, the
// only managed Auth delete in the Edge Functions sits behind the lifecycle orchestrator, the Kabumori
// client never holds an admin path, and the one remaining SQL login delete (the X saga's legacy
// social_and_login finalize) is pinned so that a new one cannot appear unnoticed. Runtime behavior is in
// lifecycle_logic_test.ts and http_test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, root));
const code = (source: string) => source.split('\n').filter((line) => !/^\s*\/\//u.test(line)).join('\n');

async function filesUnder(path: string, keep: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: URL, prefix: string) => {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory) await walk(new URL(`${entry.name}/`, dir), `${relative}/`);
      else if (entry.isFile && keep(entry.name)) out.push(relative);
    }
  };
  await walk(new URL(path, root), path);
  return out.sort();
}
const isSource = (name: string) => /\.(ts|tsx|js|mjs|html)$/u.test(name) && !/_test\.ts$|\.test\.(ts|mjs)$/u.test(name);

test('the only Auth Admin user endpoint in the Edge Functions is the lifecycle adapter of account-delete', async () => {
  const hits: string[] = [];
  for (const file of await filesUnder('supabase/functions/', isSource)) {
    const source = code(await read(file));
    if (/\/auth\/v1\/admin\/users|admin\.deleteUser|auth\.admin\./u.test(source)) hits.push(file);
  }
  assert.deepEqual(hits, ['supabase/functions/account-delete/http.ts']);
  const http = code(await read('supabase/functions/account-delete/http.ts'));
  // Built in one helper, used by exactly the two managed adapters (delete, read back).
  assert.equal(http.match(/\/auth\/v1\/admin\/users\//gu)?.length, 1);
  assert.equal(http.match(/adminUser\(userId\)/gu)?.length, 2);
  assert.match(http, /deleteLogin: async \(userId\) => \{\n\s+const response = await fetchImpl\(adminUser\(userId\), \{ method: 'DELETE', headers: service \}\);/u);
  assert.match(http, /loginState: async \(userId\) => \{\n\s+const response = await fetchImpl\(adminUser\(userId\), \{ headers: service \}\);/u);
});

test('the legacy direct delete is gone: no module deletes a login outside the lifecycle orchestrator', async () => {
  for (const file of await filesUnder('supabase/functions/', (name) => /\.ts$/u.test(name) && name !== 'wiring_test.ts')) {
    assert.ok(!/deleteOwnAccount|resolveCallerUserId/u.test(await read(file)), `${file} still has the legacy delete`);
  }
  const index = code(await read('supabase/functions/account-delete/index.ts'));
  assert.equal(index.trim(), "import { createHandler } from './http.ts';\n\nDeno.serve(createHandler(Deno.env));");
  const logic = code(await read('supabase/functions/account-delete/lifecycle_logic.ts'));
  assert.equal(logic.match(/deps\.deleteLogin\(/gu)?.length, 1, 'one call site');
  const deleteAt = logic.indexOf('deps.deleteLogin(');
  for (const precondition of [
    "call(deps, 'begin_account_deletion'",
    "call(deps, 'begin_service_deletion'",
    "call(deps, 'withdraw_kabumori'",
    'deps.revokeSessions(token)',
    "checkpoint('session_revocation')",
    'cleanStorage(deps, userId)',
    "checkpoint('storage_cleanup')",
    'const notReady = await prepare();',
    'const recheck = await storageInventory(deps, userId);',
    'const stale = await prepare();',
  ]) {
    const at = logic.indexOf(precondition);
    assert.ok(at > 0 && at < deleteAt, `${precondition} precedes the managed delete`);
  }
  assert.ok(logic.indexOf("call(deps, 'complete'") > deleteAt, 'the read-back follows it');
  // Success is only ever the verified read-back.
  assert.equal(logic.match(/outcome: 'deleted'/gu)?.length, 1);
  assert.match(logic, /if \(done\?\.status === 'completed' && done\.login_deleted === true\) \{\n\s+return \{ status: 200, body: \{ ok: true, outcome: 'deleted' \} \};/u);
});

test('routing refuses everything but the three lifecycle actions before any request', async () => {
  const http = code(await read('supabase/functions/account-delete/http.ts'));
  const guard = http.indexOf("return json({ ok: false, error: 'ACTION_REQUIRED' }, 400);");
  const firstFetch = http.indexOf('fetchImpl(');
  const envRead = http.indexOf("env.get('SUPABASE_URL')");
  assert.ok(guard > 0 && guard < envRead && guard < firstFetch);
  assert.match(http, /if \(action !== 'preview' && action !== 'withdraw_kabumori' && action !== 'delete_common_account'\) \{/u);
  assert.ok(!/console\./u.test(http) && !/console\./u.test(code(await read('supabase/functions/account-delete/lifecycle_logic.ts'))));
});

test('the person\'s token is sent only to Auth (user, logout) and to the X saga; the service key never to them', async () => {
  const http = code(await read('supabase/functions/account-delete/http.ts'));
  assert.equal(http.match(/Bearer \$\{token\}/gu)?.length, 1, 'one place builds the person\'s credential');
  assert.equal(http.match(/asPerson\(token\)/gu)?.length, 3);
  for (const target of [
    '`${supabaseUrl}/auth/v1/user`, { headers: asPerson(token) }',
    "`${supabaseUrl}/auth/v1/logout?scope=global`, { method: 'POST', headers: asPerson(token) }",
    "headers: { ...asPerson(token), 'Content-Type': 'application/json' }",
  ]) {
    assert.ok(http.includes(target), target);
  }
  assert.equal(http.match(/Bearer \$\{serviceKey\}/gu)?.length, 1);
});

test('the Kabumori client holds no admin path and sends an explicit action', async () => {
  for (const file of [...await filesUnder('src/', isSource), ...await filesUnder('apps/kabumori-web/', isSource)]) {
    const source = code(await read(file));
    assert.ok(!/service_role|SERVICE_ROLE|\/auth\/v1\/admin|auth\.admin\.|admin\.deleteUser/u.test(source), file);
  }
  const client = code(await read('src/lib/account-deletion-client.ts'));
  assert.match(client, /functions\/v1\/\$\{ACCOUNT_LIFECYCLE_FUNCTION\}/u);
  assert.match(client, /body: JSON\.stringify\(\{ \.\.\.payload, action \}\)/u);
});

test('the one SQL login delete left in the repository is the X saga\'s legacy finalize (inventoried, not used by this flow)', async () => {
  const hits: string[] = [];
  for (const file of await filesUnder('supabase/migrations/', (name) => name.endsWith('.sql'))) {
    const sql = (await read(file)).split('\n').filter((line) => !/^\s*--/u.test(line)).join('\n');
    if (/delete\s+from\s+auth\.users/iu.test(sql)) hits.push(file);
  }
  assert.deepEqual(hits, ['supabase/migrations/20260928160000_social_mobile_account_deletion_candidate.sql']);
  const adapter = code(await read('supabase/functions/account-delete/http.ts'));
  assert.match(adapter, /expected_scope: 'social_only'/u, 'the orchestrator only ever runs the saga in the scope that keeps the login');
});

test('the profile RPC takes no id argument and derives the user from auth.uid()', async () => {
  const migrationSource = await read('supabase/migrations/20260924100000_ensure_my_profile.sql');
  assert.match(migrationSource, /create or replace function public\.ensure_my_profile\(\)/);
  assert.match(migrationSource, /v_user_id uuid := \(select auth\.uid\(\)\)/);
  assert.ok(!/ensure_my_profile\(\s*p_/.test(migrationSource));
  assert.match(migrationSource, /grant execute on function public\.ensure_my_profile\(\) to authenticated;/);
});
