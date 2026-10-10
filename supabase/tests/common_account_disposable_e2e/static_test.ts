// Static safety rules of the Phase 3c offline harness: no network, process, environment or Supabase-CLI path
// exists in its code; it imports nothing outside its own directory; the fingerprint SQL only reads; and the
// documented test invocation itself has no network permission.
import assert from 'node:assert/strict';
import test from 'node:test';

const here = new URL('./', import.meta.url);
const SOURCES = ['catalog.ts', 'guard.ts', 'redact.ts', 'evidence.ts', 'plan.ts', 'cli.ts'];
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:'"`])\/\/.*$/gmu, '$1');

test('the harness has no network, process, environment or dynamic-import path', async () => {
  const forbidden = /\bfetch\s*\(|Deno\.(connect|connectTls|listen|listenTls|serve|Command|run|env|openKv|resolveDns|startTls|dlopen|upgradeWebSocket|createHttpClient)\b|\bWebSocket\b|XMLHttpRequest|EventSource|sendBeacon|\bimport\s*\(|node:(http|https|http2|net|tls|dgram|dns|child_process|worker_threads|cluster)|npm:|jsr:|https?:\/\//u;
  for (const file of SOURCES) {
    const code = strip(await Deno.readTextFile(new URL(file, here)));
    assert.ok(!forbidden.test(code), `${file}: ${code.match(forbidden)?.[0]}`);
    for (const m of code.matchAll(/\bfrom\s+'([^']+)'/gu)) assert.ok(m[1].startsWith('./') && !m[1].includes('..'), `${file} imports ${m[1]}`);
  }
});

// The catalog's `what` / `pass` lines are PR121's experiment text quoted as data (E11 asks whether postgres can
// "DELETE FROM auth.users"); catalog_test pins them verbatim. Every other line, strings included, is scanned.
const withoutQuotedPr121 = (file: string, code: string) =>
  file === 'catalog.ts' ? code.split('\n').filter((line) => !/^\s{4}(what|pass): /u.test(line)).join('\n') : code;

test('no Supabase CLI remote command, Auth Admin call, SQL login delete, RPC or migration apply in the harness code', async () => {
  const dangerous = /supabase\s+(db\s+(push|reset|pull|dump|remote)|link|login|migration\s+(up|repair|fetch)|functions\s+deploy|secrets\s+(set|unset|list)|projects\s+(create|delete|list)|branches)|\/auth\/v1\/admin|admin\.(deleteUser|updateUserById|createUser)|deleteUser\(|delete\s+from\s+auth\.|\.rpc\(|\/rest\/v1\/|\/storage\/v1\/|ban_duration/iu;
  for (const file of SOURCES) {
    const code = withoutQuotedPr121(file, strip(await Deno.readTextFile(new URL(file, here))));
    assert.ok(!dangerous.test(code), `${file}: ${code.match(dangerous)?.[0]}`);
  }
});

test('the catalog fingerprint SQL only reads', async () => {
  const sql = (await Deno.readTextFile(new URL('catalog_fingerprint.sql', here))).replace(/--.*$/gmu, '');
  const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
  assert.ok(statements.length > 0);
  for (const statement of statements) {
    // Words inside string literals (privilege names such as 'DELETE') are data, not statements.
    const s = statement.replace(/'(?:[^']|'')*'/gu, "''");
    assert.match(s, /^(select|with)\b/iu, `not a read: ${s.slice(0, 60)}`);
    assert.ok(!/\b(insert|update|delete|truncate|merge|alter|create|drop|grant|revoke|copy|call|lock|vacuum|analyze|refresh|reindex|cluster|comment|security\s+label|set\s+role|set_config|pg_terminate_backend|pg_cancel_backend|dblink|lo_import|lo_export|pg_read_file|pg_ls_dir)\b/iu.test(s), `write-capable word in: ${s.slice(0, 80)}`);
    assert.ok(!/\bfor\s+(update|no\s+key\s+update|share|key\s+share)\b/iu.test(s), 'no row locks');
  }
});

test('the documented invocation has no network permission', () => {
  assert.notEqual(Deno.permissions.querySync({ name: 'net' }).state, 'granted');
  assert.notEqual(Deno.permissions.querySync({ name: 'run' }).state, 'granted');
  assert.notEqual(Deno.permissions.querySync({ name: 'env' }).state, 'granted');
});
