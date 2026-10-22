// Offline contract of docs/security/managed-readonly-audit-gates-20261022.md and of the audit file it describes
// (supabase/preflight/managed_readonly_audit/audit.sql): the gates G0..G6, the sections S0..S12 on both sides, the never-read list, the STOP list,
// the approval template, the managed unknowns M-1..M-8, the Data API status and G3's query note; and, statically, that the SQL is one READ ONLY
// transaction ending in ROLLBACK, guards S0 at run time, writes nothing, names no password / Vault / secret source, and prints only allowlisted
// role settings. Pure file reads.
//
//   deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/g5_18_managed_audit_doc_test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { projectRefsIn } from './guard.ts';
import { secretFindings } from './inventory.ts';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));
const doc = read('docs/security/managed-readonly-audit-gates-20261022.md');
const sqlText = read('supabase/preflight/managed_readonly_audit/audit.sql');
const code = sqlText.split('\n').filter((l) => !l.trim().startsWith('--') && !l.trim().startsWith('\\echo')).map((l) => l.replace(/--.*$/u, '')).join('\n');

test('the document has its sections, gates, the approval template and the STOP list', () => {
  for (let n = 1; n <= 9; n += 1) assert.match(doc, new RegExp(`^## ${n}\\. `, 'mu'), `section ${n}`);
  for (let g = 0; g <= 6; g += 1) assert.ok(doc.includes(`| G${g} |`), `G${g}`);
  for (let m = 1; m <= 8; m += 1) assert.ok(doc.includes(`| M-${m} |`), `M-${m}`);
  for (const p of ['common-account-g5-managed-readonly-preflight-security-gates-20261022', 'NO_GO', 'NOT_VERIFIED', '#432', '本番の読み取りだけの監査を許可します',
    'ON_ERROR_STOP', 'sha256', 'do not retry by another path', '6330443480', 'G6-16', 'idle']) assert.ok(doc.includes(p), p);
});

test('the sections S0..S12 exist in the SQL and in the document', () => {
  for (const s of ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S8b', 'S9', 'S10', 'S11', 'S12']) {
    assert.ok(sqlText.includes(`\\echo '## ${s} `), `SQL ${s}`);
  }
  for (const s of ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12']) assert.ok(doc.includes(`| ${s} |`), `doc ${s}`);
  assert.ok(sqlText.includes("\\echo '## END (rolled back; nothing was written)'"));
});

test('statically read-only: one READ ONLY transaction, a run-time S0 guard, ROLLBACK, no write or side-effect statement', () => {
  const statements = code.split(/;\s*\n/u).map((s) => s.trim()).filter(Boolean);
  assert.equal(statements.filter((s) => /^begin read only$/iu.test(s.split('\n').pop()!.trim())).length, 1, 'exactly one BEGIN READ ONLY');
  assert.ok(/^rollback;$/mu.test(code), 'ends with ROLLBACK');
  assert.ok(!/^commit;?$/imu.test(code), 'no COMMIT');
  assert.ok(code.includes("select 1 / (case when pg_catalog.current_setting('transaction_read_only') = 'on' then 1 else 0 end) as read_only_guard;"), 'the S0 guard is evaluated at run time');
  for (const banned of [/\binsert\b/iu, /\bupdate\b/iu, /\bdelete\b/iu, /\bcreate\b/iu, /\balter\b/iu, /\bdrop\b/iu, /\bgrant\b/iu, /\brevoke\b/iu, /\btruncate\b/iu,
    /\bcopy\b/iu, /\bcall\b/iu, /^\s*do\b/imu, /\bvacuum\b/iu, /\block\s+table\b/iu, /\bnotify\b/iu, /\bnextval\b/iu, /\bsetval\b/iu, /\bpg_sleep\b/iu, /\bdblink\b/iu]) {
    assert.ok(!banned.test(code), `banned: ${banned}`);
  }
});

test('no secret source is named; role settings are allowlisted; nothing secret-shaped or a project host', () => {
  for (const banned of ['pg_authid', 'rolpassword', 'vault', 'decrypted', 'jwt_secret', 'pg_shadow', 'pg_user_mapping', 'statements']) {
    assert.ok(!code.toLowerCase().includes(banned), banned);
  }
  assert.ok(code.includes("x ~ '^(pgrst\\.db_schemas|pgrst\\.db_extra_search_path|default_transaction_isolation|default_transaction_read_only|statement_timeout|search_path|row_security|session_replication_role)='"));
  assert.ok(code.includes('select m.version, m.name from supabase_migrations.schema_migrations m'), 'migration history: version and name only');
  for (const [name, text] of [['doc', doc], ['sql', sqlText]] as const) {
    assert.deepEqual(secretFindings(text), [], `${name}: nothing secret-shaped`);
    assert.deepEqual(projectRefsIn(text), [], `${name}: no project host`);
  }
});

test('the dry-run suite covers canaries, injected writes and the S0 stop; nothing unfinished', () => {
  const pg = read('supabase/tests/common_account_managed_audit_pg_test.ts');
  for (const c of ['CANARY-ROW-SECRET-1', 'CANARY-FN-SECRET-3', 'CANARY-ROLE-SECRET-4', 'CANARY-COMMENT-5', 'CANARY-STMT-6']) assert.ok(pg.includes(c), c);
  assert.ok(pg.includes("t.replace('begin read only;', 'begin;')") && pg.includes('read-only transaction'));
  assert.ok(!/https?:\/\//u.test(doc) && !/\bTODO\b|\bFIXME\b|\bTBD\b|@@[A-Z0-9_]+@@/u.test(doc), 'no URL, nothing unfinished');
});
