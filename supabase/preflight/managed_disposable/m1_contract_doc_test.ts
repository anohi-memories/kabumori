// Offline contract of docs/common-account/m1-manual-x-publish-auth-contract.md (F5 M1). The document makes claims that must stay true of THIS
// checkout: the F5 functions and fixed codes it names exist, F5's own functions take only lifecycle locks, the sources it cites are pinned, the
// number of tests it reports is the real one, and nothing in it is secret-shaped, a project host or unfinished. Pure file reads.
//
//   deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/m1_contract_doc_test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { projectRefsIn } from './guard.ts';
import { secretFindings } from './inventory.ts';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));
const exists = (path: string) => { try { Deno.statSync(new URL(path, root)); return true; } catch { return false; } };
const DOC = 'docs/common-account/m1-manual-x-publish-auth-contract.md';
const doc = read(DOC);
type Source = { id: string; pr: string; commit: string; path: string; blob: string; present: string[] };
const provenance = JSON.parse(read('docs/common-account/m1-manual-x-publish-provenance.json')) as { sources: Source[] };
const CHAIN = [
  '20261001150000_common_account_lifecycle_foundation', '20261006230000_common_account_service_start_intent', '20261009120000_common_account_deletion_completion',
  '20261010051938_common_account_service_write_guard', '20261012130000_common_account_core_service_fence', '20261012230000_common_account_service_brand_state',
  '20261013120000_common_account_service_deletion_ownership', '20261013140000_common_account_service_reconciliation_facts',
  '20261015090000_common_account_enrollment_session_fence', '20261015120000_common_account_x_unconfirmed_snapshot_record',
].map((name) => `supabase/migrations/${name}.sql`);
const noComments = (sql: string) => sql.split('\n').map((line) => line.replace(/--.*$/u, '')).join('\n');

test('the document has its sections, its findings and the decision on Issue #267', () => {
  for (let n = 1; n <= 10; n += 1) assert.match(doc, new RegExp(`^## ${n}\\. `, 'mu'), `section ${n}`);
  for (const id of ['M1-F1', 'M1-F2', 'M1-F3', 'M1-F4', 'M1-F5', 'M1-F6', 'M1-F7']) assert.ok(doc.includes(`**${id}**`), id);
  for (const phrase of ['ACK_WITH_CONDITIONS', 'NOT_VERIFIED', 'SIMULATED', 'PG1 to PG7', '#233', '#269', '#267', 'KNOWN LIMIT', 'no lock spans', 'x_autopost',
    'managed_auth_delete', 'IDP_PREPAUSE_BLOCKED', 'POSTONA_END_SOURCE_ENABLED', 'R2′']) assert.ok(doc.includes(phrase), phrase);
  assert.match(doc, /Production is \*\*NO_GO\*\*/u);
  assert.match(doc, /none is opened here|opened by anything here/u);
  for (const condition of ['(C1)', '(C2)', '(C3)', '(C4)']) assert.ok(doc.includes(condition), condition);
});

test('every F5 function and fixed code the document names exists in the F5 chain, with the shape quoted', () => {
  const sql = CHAIN.map((path) => noComments(read(path))).join('\n');
  for (const fn of [
    'private.account_lifecycle_assert_active_service_write', 'private.account_lifecycle_service_state_refusal', 'private.account_lifecycle_service_state_readonly',
    'private.account_lifecycle_brand_owner', 'public.common_account_brand_service_state', 'private.account_lifecycle_assert_brand_service_active',
  ]) {
    assert.ok(doc.includes(fn), `${fn} is in the document`);
    assert.ok(sql.includes(`create function ${fn}(`), `${fn} exists in the chain`);
  }
  const codes = [...doc.matchAll(/`([A-Z][A-Z0-9_]{6,})`/gu)].map((match) => match[1])
    .filter((code) => /^(ACCOUNT_|SERVICE_|WORKSPACE_)/u.test(code));
  assert.ok(codes.length >= 8, `only ${codes.length} codes`);
  for (const code of new Set(codes)) assert.ok(sql.includes(`'${code}'`), `${code} is a fixed code of the chain`);
  assert.match(sql, /create function private\.account_lifecycle_brand_owner\(p_brand_id text\)\nreturns uuid language sql stable security definer/u);
  assert.match(sql, /create function private\.account_lifecycle_service_state_refusal\(p_user_id uuid, p_service_key text\)\nreturns text language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s'/u);
  assert.match(sql, /create function public\.common_account_brand_service_state\(p_brand_id text, p_service_key text default 'x_autopost'\)\nreturns text/u);
  assert.match(sql, /grant execute on function public\.common_account_brand_service_state\(text, text\) to service_role;/u);
  assert.ok(sql.includes("p_service_key not in ('kabumori', 'x_autopost')"), 'two service keys only');
});

test('F5 takes lifecycle locks only: no advisory lock, no table lock, and no row lock on a workspace table (the claim of the Issue #267 answer)', () => {
  const WORKSPACE = /\b(brands|brand_memberships|social_accounts|social_account_oauth_states|scheduled_posts|social_mobile_account_deletions)\b/u;
  let locks = 0;
  for (const path of CHAIN) {
    const sql = noComments(read(path));
    assert.ok(!/pg_advisory|pg_try_advisory/u.test(sql), `${path}: no advisory lock`);
    assert.ok(!/\block\s+table\b/iu.test(sql), `${path}: no table lock`);
    for (const match of sql.matchAll(/\bfor\s+(update|share|key\s+share)\b/giu)) {
      locks += 1;
      const before = sql.slice(Math.max(0, match.index! - 400), match.index);
      const lastFrom = before.lastIndexOf('from ');
      const target = lastFrom >= 0 ? before.slice(lastFrom, lastFrom + 80) : '';
      assert.ok(!WORKSPACE.test(target.split('\n')[0]), `${path}: a row lock on a workspace table (${target.split('\n')[0].trim()})`);
    }
  }
  assert.ok(locks >= 10, `only ${locks} row locks were inspected`);
});

test('the sources the document cites are pinned, the document names them, and its numbers are the real ones', () => {
  assert.ok(provenance.sources.length >= 10);
  for (const source of provenance.sources) {
    assert.match(source.blob, /^[0-9a-f]{40}$/u, source.id);
    assert.match(source.commit, /^[0-9a-f]{40}$/u, source.id);
    assert.ok(doc.includes(source.id) || /^(G4-|F3-|F4-|LIVE-|SHARED-)/u.test(source.id), source.id);
    if (source.pr.startsWith('PR')) assert.ok(doc.includes(`#${source.pr.slice(2)}`), `${source.pr} is named in the document`);
  }
  for (const id of ['LIVE-SEND-TIME-PERMISSION', 'F3-PUBLISH-ENTITLEMENT', 'G4-VERIFIED-PREDICATE-STUB', 'G4-CREDENTIAL-SOURCE-PORT']) assert.ok(doc.includes(id), `${id} is cited`);
  const heads = new Map(provenance.sources.filter((s) => s.pr.startsWith('PR')).map((s) => [s.pr, s.commit]));
  for (const [pr, commit] of heads) if (['PR263'].includes(pr)) assert.ok(doc.includes(commit), `${pr} head is quoted in full`);
  // the live function must not name F5 (the premise of finding M1-F1)
  const live = read('supabase/migrations/20261003090000_social_mobile_publish_permission_boundary.sql');
  const start = live.indexOf('create function public.assert_x_publish_permission_for_legacy_post(');
  const body = live.slice(start, live.indexOf('\n$$;', start));
  for (const needle of ['service_entitlements', 'account_lifecycle', 'common_account']) assert.ok(!body.includes(needle), needle);
  // the number of tests the document reports is the number of tests that exist
  const tests = (read('supabase/tests/common_account_m1_manual_x_publish_test.ts').match(/^test_\(/gmu) ?? []).length;
  assert.ok(doc.includes(`${tests} tests`), `the document should say ${tests} tests`);
  for (const path of ['supabase/tests/common_account_m1_manual_x_publish_run.sh', 'supabase/tests/common_account_m1_manual_x_publish_test.ts', 'supabase/tests/common_account_m1_manual_x_publish_fixture.sql',
    'supabase/tests/common_account_m1_manual_x_publish_mutations.py', 'supabase/tests/common_account_m1_provenance_check.py']) {
    assert.ok(exists(path), path);
    assert.ok(doc.includes(path.split('/').pop()!), `${path} is named`);
  }
});

test('the test model is test-only: no production file reaches it, it makes no network call and holds no secret', () => {
  const files = ['supabase/tests/common_account_m1_manual_x_publish_test.ts', 'supabase/tests/common_account_m1_manual_x_publish_fixture.sql'];
  const walk = (dir: string): string[] => {
    let entries: Deno.DirEntry[] = [];
    try {
      entries = [...Deno.readDirSync(new URL(`${dir}/`, root))];
    } catch {
      return [];   // a tree the caller did not copy (the mutation scripts copy only what they need)
    }
    return entries.flatMap((entry) => entry.name === 'node_modules' ? [] : entry.isDirectory ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]);
  };
  for (const path of [...walk('supabase/functions'), ...walk('apps/social-mobile/src')]) {
    if (!/\.(ts|tsx|sql|mjs)$/u.test(path)) continue;
    assert.ok(!read(path).includes('common_account_m1_'), `${path} names the M1 test model`);
    assert.ok(!read(path).includes('m1_fixture'), `${path} names the M1 fixture schema`);
  }
  const ts = read(files[0]);
  assert.match(ts, /globalThis\.fetch = \(\) =>|globalThis\.fetch = \(\(\) =>/u, 'fetch is replaced by a thrower');
  for (const file of files) {
    const text = read(file);
    assert.deepEqual(secretFindings(text), [], `${file}: nothing secret-shaped`);
    assert.deepEqual(projectRefsIn(text), [], `${file}: no project host`);
    assert.ok(!/https?:\/\//u.test(text), `${file}: no URL`);
  }
  assert.match(read(files[1]), /simulated boolean not null default true check \(simulated\)/u, 'a stored result is always simulated');
});

test('the document is clean: no URL, no secret-shaped text, no project host, nothing unfinished', () => {
  assert.deepEqual(secretFindings(doc), []);
  assert.deepEqual(projectRefsIn(doc), []);
  assert.ok(!/https?:\/\//u.test(doc), 'no URL');
  assert.ok(!/\bTODO\b|\bFIXME\b|\bTBD\b|@@RESULTS@@/u.test(doc), 'nothing unfinished');
});
