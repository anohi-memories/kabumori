// Offline contract of docs/common-account/m2-ai-consult-authorization-gap.md (F5 M2). The document makes claims that must stay true of THIS checkout:
// the F5 objects and grants it quotes exist exactly so, the live consult handler really names none of F5's objects, the sources are pinned, the test
// count is the real one, the harness is test-only, and nothing is secret-shaped, a project host or unfinished. Pure file reads.
//
//   deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/m2_contract_doc_test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { projectRefsIn } from './guard.ts';
import { secretFindings } from './inventory.ts';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));
const exists = (path: string) => { try { Deno.statSync(new URL(path, root)); return true; } catch { return false; } };
const DOC = 'docs/common-account/m2-ai-consult-authorization-gap.md';
const doc = read(DOC);
type Source = { id: string; pr: string; commit: string; path: string; blob: string; present: string[]; absent: string[] };
const provenance = JSON.parse(read('docs/common-account/m2-ai-consult-authz-provenance.json')) as { sources: Source[] };
const P1 = read('supabase/migrations/20261001150000_common_account_lifecycle_foundation.sql');
const noComments = (sql: string) => sql.split('\n').map((line) => line.replace(/--.*$/u, '')).join('\n');

test('the document has its sections, gaps, options and the verdicts', () => {
  for (let n = 1; n <= 10; n += 1) assert.match(doc, new RegExp(`^## ${n}\\. `, 'mu'), `section ${n}`);
  for (let n = 1; n <= 10; n += 1) assert.ok(doc.includes(`**G-${n}**`), `G-${n}`);
  for (const phrase of ['NOT_VERIFIED', 'Option A', 'Option B', 'proposal only', 'not created', 'Sol (high)', '#233', '#269', '#273', '#264', '#275', 'HOLD', 'x_autopost',
    'managed_auth_delete', 'IDP_PREPAUSE_BLOCKED', 'POSTONA_END_SOURCE_ENABLED', 'confused deputy', 'in-flight', 'M8']) assert.ok(doc.includes(phrase), phrase);
  assert.match(doc, /Production is \*\*NO_GO\*\*/u);
  assert.match(doc, /No Phase 13 gate \(PG1 to PG7\) is opened|none of which is opened/u);
});

test('the F5 grants, policies and functions the document quotes exist exactly so in the F5 chain', () => {
  const code = noComments(P1);
  assert.ok(code.includes('grant select (user_id, status, lifecycle_version, created_at, updated_at)\n  on table public.common_accounts to authenticated;'));
  assert.ok(code.includes('grant select (user_id, service_key, status, activated_at, ended_at, updated_at)\n  on table public.service_entitlements to authenticated;'));
  for (const policy of ['common_accounts_select_own', 'service_entitlements_select_own']) assert.ok(code.includes(`create policy ${policy}`), policy);
  assert.ok(code.includes('revoke all on table public.service_entitlements from public, anon, authenticated, service_role;'), 'service_role has no direct access');
  assert.ok(doc.includes('common_accounts(user_id, status, lifecycle_version, created_at, updated_at)'));
  assert.ok(doc.includes('service_entitlements(user_id, service_key, status, activated_at, ended_at, updated_at)'));
  // the freeze and the account freeze make the status visible in the same function that records the operation (the claim of section 3)
  assert.match(code, /update public\.service_entitlements set status = 'deleting', updated_at = now\(\)/u);
  assert.match(code, /update public\.common_accounts set status = 'deleting'/u);
  const chain = [
    '20261010051938_common_account_service_write_guard', '20261012130000_common_account_core_service_fence', '20261012230000_common_account_service_brand_state',
  ].map((name) => noComments(read(`supabase/migrations/${name}.sql`))).join('\n');
  for (const fn of ['private.account_lifecycle_assert_active_service_write', 'private.account_lifecycle_service_state_refusal', 'private.account_lifecycle_service_state_readonly',
    'private.account_lifecycle_brand_owner', 'public.common_account_brand_service_state']) {
    assert.ok(doc.includes(fn), `${fn} is in the document`);
    assert.ok(chain.includes(`create function ${fn}(`), `${fn} exists in the chain`);
  }
  assert.ok(chain.includes('grant execute on function public.common_account_brand_service_state(text, text) to service_role;'));
  // the membership RLS the live handler relies on
  const members = read('supabase/migrations/20260918120000_social_mobile_brand_memberships.sql');
  assert.ok(members.includes('create policy social_mobile_membership_self_select') && members.includes('create policy social_mobile_member_select_brands'));
});

test('the live consult handler asks F5 nothing, and the document says only what the code does', () => {
  const logic = read('supabase/functions/social-mobile-consult/logic.ts');
  for (const name of ['service_entitlements', 'common_accounts', 'x_autopost', 'account_lifecycle', 'common_account_brand_service_state']) assert.ok(!logic.includes(name), `the handler names ${name}`);
  for (const name of ['async function getUser(', 'async function assertOwnedSocialMobileWorkspace(', '"brand_memberships"', 'callOpenAiConsultModel']) assert.ok(logic.includes(name), name);
  const lineOf = (needle: string) => logic.slice(0, logic.indexOf(needle)).split('\n').length;
  for (const [needle, cited] of [['async function getUser(', ':198'], ['export function parseConsultRequest(', ':137'], ['async function assertOwnedSocialMobileWorkspace(', ':237'], ['export const callOpenAiConsultModel', ':474']] as const) {
    assert.equal(lineOf(needle), Number(cited.slice(1)), `${needle} is at ${cited}`);
    assert.ok(doc.includes(cited), `the document cites ${cited}`);
  }
});

test('the sources are pinned, the document names its neighbours, and its numbers are the real ones', () => {
  assert.ok(provenance.sources.length >= 8);
  for (const source of provenance.sources) {
    assert.match(source.blob, /^[0-9a-f]{40}$/u, source.id);
    assert.match(source.commit, /^[0-9a-f]{40}$/u, source.id);
  }
  assert.ok(provenance.sources.some((s) => s.id === 'LIVE-CONSULT-HANDLER' && s.absent.includes('service_entitlements')), 'the absence is pinned');
  const tests = (read('supabase/tests/common_account_m2_ai_consult_authz_test.ts').match(/^test_\(/gmu) ?? []).length;
  assert.ok(doc.includes(`${tests} tests`), `the document should say ${tests} tests`);
  for (const path of ['supabase/tests/common_account_m2_ai_consult_authz_run.sh', 'supabase/tests/common_account_m2_ai_consult_authz_test.ts', 'supabase/tests/common_account_m2_ai_consult_authz_fixture.sql',
    'supabase/tests/common_account_m2_ai_consult_authz_mutations.py', 'supabase/tests/common_account_m2_provenance_check.py']) {
    assert.ok(exists(path), path);
    assert.ok(doc.includes(path.split('/').pop()!), `${path} is named`);
  }
});

test('the harness is test-only: no production file reaches it, it makes no network call, creates no migration and holds no secret', () => {
  const walk = (dir: string): string[] => {
    let entries: Deno.DirEntry[] = [];
    try {
      entries = [...Deno.readDirSync(new URL(`${dir}/`, root))];
    } catch {
      return [];
    }
    return entries.flatMap((entry) => entry.name === 'node_modules' ? [] : entry.isDirectory ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]);
  };
  for (const path of [...walk('supabase/functions'), ...walk('apps/social-mobile/src')]) {
    if (!/\.(ts|tsx|sql|mjs)$/u.test(path)) continue;
    const text = read(path);
    assert.ok(!text.includes('common_account_m2_') && !text.includes('m2_fixture'), `${path} names the M2 harness`);
  }
  assert.ok(!exists('supabase/migrations/m2_ai_consult.sql'));
  const files = ['supabase/tests/common_account_m2_ai_consult_authz_test.ts', 'supabase/tests/common_account_m2_ai_consult_authz_fixture.sql'];
  assert.match(read(files[0]), /globalThis\.fetch = \(\(\) =>/u, 'fetch is replaced by a thrower');
  for (const file of files) {
    const text = read(file);
    assert.deepEqual(secretFindings(text.replace(/https:\/\/example\.invalid\//gu, '')), [], `${file}: nothing secret-shaped`);
    assert.deepEqual(projectRefsIn(text), [], `${file}: no project host`);
  }
  // the fixture creates a test schema and one probe function only; no grant to an API role
  const fixture = noComments(read(files[1]));
  assert.ok(!/\bgrant\b/iu.test(fixture), 'the fixture grants nothing');
  assert.ok((fixture.match(/create function/gu) ?? []).length === 1);
});

test('the document is clean: no URL, no secret-shaped text, no project host, nothing unfinished', () => {
  assert.deepEqual(secretFindings(doc), []);
  assert.deepEqual(projectRefsIn(doc), []);
  assert.ok(!/https?:\/\//u.test(doc), 'no URL');
  assert.ok(!/\bTODO\b|\bFIXME\b|\bTBD\b|@@RESULTS@@/u.test(doc), 'nothing unfinished');
});
