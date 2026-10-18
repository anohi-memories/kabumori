// Offline contract of docs/common-account/brand-owner-epoch.md and of the candidate it describes. The document makes claims that must stay true of THIS checkout: the
// candidate's shape and ACL, the list of membership writers, that the candidate is not in the migration path and its rollback keeps the history, the pinned sources,
// the test count, and that nothing is secret-shaped, a project host or unfinished. Pure file reads.
//
//   deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/owner_epoch_doc_test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { projectRefsIn } from './guard.ts';
import { secretFindings } from './inventory.ts';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));
const exists = (path: string) => { try { Deno.statSync(new URL(path, root)); return true; } catch { return false; } };
const DOC = 'docs/common-account/brand-owner-epoch.md';
const CANDIDATE = 'supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql';
const ROLLBACK = 'supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch_rollback.sql';
const doc = read(DOC);
const candidate = read(CANDIDATE);
const noComments = (sql: string) => sql.split('\n').map((line) => line.replace(/--.*$/u, '')).join('\n');
const code = noComments(candidate);
type Source = { id: string; pr: string; commit: string; path: string; blob: string; present: string[]; absent: string[] };
const provenance = JSON.parse(read('docs/common-account/brand-owner-epoch-provenance.json')) as { sources: Source[] };

test('the document has its sections, findings and the verdicts', () => {
  for (let n = 1; n <= 10; n += 1) assert.match(doc, new RegExp(`^## ${n}\\. `, 'mu'), `section ${n}`);
  for (let n = 1; n <= 5; n += 1) assert.ok(doc.includes(`**L-${n}**`), `L-${n}`);
  for (const phrase of ['NOT_VERIFIED', 'TEST-ONLY', 'Codex Sol (high)', '#233', '#282', '#279', 'NULL', 'monotonic', 'rollback', 'A→B→A', 'owner→admin→owner', 'exactly one', 'reconcil',
    'managed_auth_delete', 'IDP_PREPAUSE_BLOCKED', 'POSTONA_END_SOURCE_ENABLED', 'HOLD', 'SIMULATED', 'ready, not done']) assert.ok(doc.includes(phrase), phrase);
  assert.match(doc, /Production is \*\*NO_GO\*\*/u);
  assert.match(doc, /Apply needs the independent focused Codex Sol/u);
});

test('the candidate has the shape the document quotes: owner-only definer functions, the two triggers, the history guard, the reconciliation and the postconditions', () => {
  for (const fn of [
    'private.account_lifecycle_brand_owner_epoch(p_brand_id text)', 'private.account_lifecycle_brand_owner_epoch_covered()', 'private.account_lifecycle_brand_owner_epoch_resync(p_brand_id text)',
  ]) {
    assert.ok(code.includes(`create function ${fn}`), fn);
    assert.ok(doc.includes(fn.replace(/\(.*$/u, '(')), `${fn} is in the document`);
  }
  assert.match(code, /create function private\.account_lifecycle_brand_owner_epoch\(p_brand_id text\)\nreturns bigint language plpgsql stable security definer set search_path = '' as \$\$/u);
  assert.match(code, /create function private\.account_lifecycle_brand_owner_epoch_resync\(p_brand_id text\)\nreturns bigint language plpgsql volatile security definer set search_path = '' as \$\$/u);
  assert.ok(code.includes('create trigger account_lifecycle_owner_epoch_row after insert or update or delete on public.brand_memberships'));
  assert.ok(code.includes('create trigger account_lifecycle_owner_epoch_truncate after truncate on public.brand_memberships'));
  assert.ok(code.includes('before update or delete on private.account_lifecycle_brand_owner_epochs') && code.includes('before truncate on private.account_lifecycle_brand_owner_epochs'));
  assert.ok(code.includes('epoch bigint not null check (epoch >= 1)'), 'the first generation is 1');
  assert.ok(!/references\s+public\.brands/u.test(code), 'no foreign key to brands: the history outlives the workspace');
  assert.ok(code.includes('lock table public.brand_memberships in share row exclusive mode;'));
  assert.ok(code.includes('revoke all on table private.account_lifecycle_brand_owner_epochs from public, anon, authenticated, service_role;'));
  assert.ok(/revoke all on function[\s\S]*account_lifecycle_brand_owner_epoch_resync\(text\) from public, anon, authenticated, service_role;/u.test(code));
  assert.ok(!/\bgrant\b/iu.test(code), 'the candidate grants nothing to anyone');
  for (const marker of ['OWNER_EPOCH_ALREADY_APPLIED', 'OWNER_EPOCH_PRECONDITION_API_ROLE_CAN_WRITE_MEMBERSHIPS', 'OWNER_EPOCH_POSTCONDITION_FUNCTION_ACL', 'OWNER_EPOCH_HISTORY_IS_APPEND_ONLY', 'OWNER_EPOCH_COVERAGE_BROKEN']) assert.ok(code.includes(marker), marker);
  // not inferred from anything else
  for (const banned of ['max(updated_at)', 'now()', 'xmin', 'md5(', 'sha256']) assert.ok(!code.includes(banned), `the candidate does not use ${banned}`);
});

test('the candidate is a candidate: not in the migration path, and its rollback keeps the history', () => {
  for (const entry of Deno.readDirSync(new URL('supabase/migrations/', root))) assert.ok(!/owner_epoch/u.test(entry.name), `${entry.name} is in the migration path`);
  assert.ok(candidate.includes('NOT in supabase/migrations/'));
  const rollback = noComments(read(ROLLBACK));
  assert.ok(!/drop\s+table/iu.test(rollback), 'the rollback does not drop the history');
  assert.ok(rollback.includes('drop trigger if exists account_lifecycle_owner_epoch_row on public.brand_memberships;'));
  assert.ok(rollback.includes('drop function if exists private.account_lifecycle_brand_owner_epoch(text);'));
  assert.ok(!rollback.includes('history_guard'), 'the history guard stays');
});

test('the writers of public.brand_memberships are exactly the ones the document lists, and none of them is edited by this task', () => {
  const WRITE = /\b(insert\s+into|update|delete\s+from|truncate(?:\s+table)?)\s+(?:only\s+)?(?:public\.)?brand_memberships\b/iu;
  const writers: string[] = [];
  for (const entry of Deno.readDirSync(new URL('supabase/migrations/', root))) {
    if (entry.isFile && entry.name.endsWith('.sql') && WRITE.test(noComments(read(`supabase/migrations/${entry.name}`)))) writers.push(entry.name);
  }
  assert.deepEqual(writers.sort(), ['20260919120000_social_mobile_x_oauth_onboarding.sql', '20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql'], 'only inserts, only the two onboarding versions');
  for (const name of writers) {
    const text = noComments(read(`supabase/migrations/${name}`));
    assert.ok(!/(update|delete\s+from|truncate)\s+(?:public\.)?brand_memberships/iu.test(text), `${name}: no update / delete / truncate of memberships`);
  }
  const saga = read('supabase/migrations/20260928160000_social_mobile_account_deletion_candidate.sql');
  assert.ok(saga.includes('delete from public.brands where id = v_workspace;') && saga.includes('Cascades brand_memberships'), 'the deletion saga removes memberships by cascade');
  for (const name of ['20260919120000_social_mobile_x_oauth_onboarding.sql', '20260928160000_social_mobile_account_deletion_candidate.sql']) assert.ok(doc.includes(name.slice(0, 14)), `${name} is named`);
  // no function or app code writes memberships (outside a disposable proof)
  const walk = (dir: string): string[] => {
    let entries: Deno.DirEntry[] = [];
    try { entries = [...Deno.readDirSync(new URL(`${dir}/`, root))]; } catch { return []; }
    return entries.flatMap((entry) => entry.name === 'node_modules' ? [] : entry.isDirectory ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]);
  };
  for (const path of [...walk('supabase/functions'), ...walk('apps/social-mobile/src')]) {
    if (!/\.(ts|tsx|sql)$/u.test(path) || /_test\.|\.test\.|proof|fixture/u.test(path)) continue;
    assert.ok(!WRITE.test(noComments(read(path))), `${path} writes memberships`);
  }
});

test('the sources are pinned, the document names them, and its numbers are the real ones', () => {
  assert.ok(provenance.sources.length >= 9);
  for (const source of provenance.sources) {
    assert.match(source.blob, /^[0-9a-f]{40}$/u, source.id);
    assert.match(source.commit, /^[0-9a-f]{40}$/u, source.id);
  }
  const grants = provenance.sources.find((s) => s.id === 'MEMBERSHIPS-TABLE-GRANTS');
  assert.ok(grants && grants.absent.includes('revoke truncate'), 'the TRUNCATE gap is pinned as an absence');
  const tests = (read('supabase/tests/common_account_owner_epoch_test.ts').match(/^test_\(/gmu) ?? []).length;
  assert.ok(doc.includes(`${tests} tests`), `the document should say ${tests} tests`);
  for (const path of ['supabase/tests/common_account_owner_epoch_run.sh', 'supabase/tests/common_account_owner_epoch_test.ts', 'supabase/tests/common_account_owner_epoch_mutations.py',
    'supabase/tests/common_account_owner_epoch_provenance_check.py', CANDIDATE, ROLLBACK]) {
    assert.ok(exists(path), path);
    assert.ok(doc.includes(path.split('/').pop()!), `${path} is named`);
  }
});

test('the harness is test-only and quiet: no network, no secret, no project host; no production file names it', () => {
  const ts = read('supabase/tests/common_account_owner_epoch_test.ts');
  assert.match(ts, /globalThis\.fetch = \(\(\) =>/u);
  for (const [name, text] of [['test', ts], ['candidate', candidate], ['doc', doc]] as const) {
    assert.deepEqual(secretFindings(text.replace(/https:\/\/example\.invalid\//gu, '')), [], `${name}: nothing secret-shaped`);
    assert.deepEqual(projectRefsIn(text), [], `${name}: no project host`);
  }
  assert.ok(!/https?:\/\//u.test(doc), 'no URL in the document');
  assert.ok(!/\bTODO\b|\bFIXME\b|\bTBD\b|@@RESULTS@@/u.test(doc), 'nothing unfinished');
  for (const dir of ['supabase/functions', 'apps/social-mobile/src']) {
    const walk = (d: string): string[] => {
      let entries: Deno.DirEntry[] = [];
      try { entries = [...Deno.readDirSync(new URL(`${d}/`, root))]; } catch { return []; }
      return entries.flatMap((entry) => entry.name === 'node_modules' ? [] : entry.isDirectory ? walk(`${d}/${entry.name}`) : [`${d}/${entry.name}`]);
    };
    for (const path of walk(dir)) {
      if (!/\.(ts|tsx|sql|mjs)$/u.test(path)) continue;
      assert.ok(!read(path).includes('account_lifecycle_brand_owner_epoch'), `${path} names the owner epoch`);
    }
  }
});
