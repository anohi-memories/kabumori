// Offline contract of docs/common-account/g5-02-authorization-verdict-rpc-preflight.md and of the model it describes
// (supabase/candidates/common_account_postona_authz/rpc_preflight.ts): the RPC shape and ACL the document states are the model's, the service key
// decision is the model's, NO SQL object of the proposal exists anywhere in this tree, the model is wired nowhere, the document names its tests with
// the real counts, and nothing is secret-shaped, a project host or unfinished. Pure file reads.
//
//   deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/g5_02_contract_doc_test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { projectRefsIn } from './guard.ts';
import { secretFindings } from './inventory.ts';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));
const exists = (path: string) => { try { Deno.statSync(new URL(path, root)); return true; } catch { return false; } };
const DOC = 'docs/common-account/g5-02-authorization-verdict-rpc-preflight.md';
const MODEL = 'supabase/candidates/common_account_postona_authz/rpc_preflight.ts';
const SUITE = 'supabase/tests/common_account_g5_02_rpc_preflight_test.ts';
const PG = 'supabase/tests/common_account_g5_02_rpc_preconditions_pg_test.ts';
const MUT = 'supabase/tests/common_account_g5_02_rpc_preflight_mutations.py';
const doc = read(DOC);
const model = read(MODEL);
const walk = (dir: string): string[] => {
  let entries: Deno.DirEntry[] = [];
  try { entries = [...Deno.readDirSync(new URL(`${dir}/`, root))]; } catch { return []; }
  return entries.flatMap((e) => e.name === 'node_modules' ? [] : e.isDirectory ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
};

test('the document has its sections, the invariants and the gates', () => {
  for (let n = 1; n <= 11; n += 1) assert.match(doc, new RegExp(`^## ${n}\\. `, 'mu'), `section ${n}`);
  for (let n = 1; n <= 10; n += 1) assert.ok(doc.includes(`**I-${n}**`), `I-${n}`);
  for (const phrase of ['NO_GO', 'NOT_VERIFIED', 'Codex Sol (high)', '#303', '#340', '#336', '#337', '#334', 'Issue #318', 'Issue #319', '6267545726', 'one snapshot',
    'Anti-enumeration', 'VOLATILE', 'K5', 'never `db push`']) assert.ok(doc.includes(phrase), phrase);
});

test('the shapes the document states are the model\'s: the RPC keys, the ACL per form, the Edge TTL, the service key, every worker code', () => {
  assert.ok(model.includes("export const RPC_KEYS = 'decision,entitlements,owner_epoch,reason,scope,session,subject,v';"));
  assert.ok(doc.includes('`decision, entitlements, owner_epoch, reason, scope, session,\n   subject, v`') || doc.includes('decision, entitlements, owner_epoch, reason, scope, session'), 'the document lists the RPC keys');
  assert.ok(model.includes('export const EDGE_TTL_MS = 60_000;') && doc.includes('an `allow` lives 60 s'));
  assert.ok(model.includes("export const POSTONA_POSTING_SERVICE_KEY = 'x_autopost' as const;") && doc.includes('**`x_autopost`**'));
  for (const sig of ['public.common_account_authorization_verdict(p_app text, p_feature text, p_brand_id text) returns jsonb',
    'private.account_lifecycle_worker_brand_verdict(p_brand_id text, p_service_key text, p_expected_owner_epoch bigint, p_bound_at timestamptz)',
    'public.common_account_worker_brand_verdict(']) assert.ok(doc.includes(sig), sig);
  const workerCodes = [...model.slice(model.indexOf('export function workerBrandVerdict')).matchAll(/return '([A-Z_]+)'/gu)].map((m) => m[1]);
  assert.ok(workerCodes.length >= 8);
  for (const code of workerCodes) assert.ok(doc.includes(code), `the document lists ${code}`);
  for (const code of ['RPC_NOT_DEPLOYED', 'RPC_FAILED', 'RPC_SHAPE', 'SCOPE_MISMATCH']) assert.ok(model.includes(`'${code}'`) && doc.includes(code), code);
});

test('the proposal exists as SQL only in its own candidate directory (G5-03), never in the migration path; the model is wired nowhere', () => {
  for (const path of [...walk('supabase/migrations'), ...walk('supabase/candidates')].filter((p) => p.endsWith('.sql'))) {
    if (path.startsWith('supabase/candidates/common_account_authorization_verdict/')) continue;
    const text = read(path);
    assert.ok(!/common_account_authorization_verdict|worker_brand_verdict/u.test(text), `${path} defines a proposed object`);
  }
  for (const path of [...walk('supabase/functions'), ...walk('apps/social-mobile/src'), ...walk('src')]) {
    if (!/\.(ts|tsx|mjs|js|sql)$/u.test(path)) continue;
    assert.ok(!read(path).includes('rpc_preflight'), `${path} imports the model`);
  }
  assert.ok(!/create (or replace )?(function|view|table)|grant |revoke /iu.test(read(PG)), 'the PG17 suite creates and grants nothing');
  for (const banned of ['Deno.', 'fetch(', 'createClient', 'process.']) assert.ok(!model.includes(banned), `the model uses ${banned}`);
});

test('the document names its tests with the real counts and the files exist', () => {
  const suite = (read(SUITE).match(/^test\(/gmu) ?? []).length;
  const pg = (read(PG).match(/^test_\(/gmu) ?? []).length;
  const mutants = (read(MUT).match(/^ {4}\('/gmu) ?? []).length;
  assert.ok(doc.includes(`${suite} tests`), `the document should say ${suite} tests (model)`);
  assert.ok(doc.includes(`${pg} tests`), `the document should say ${pg} tests (PG17)`);
  assert.ok(doc.includes(`${mutants}/${mutants} detected`), `the document should say ${mutants}/${mutants} detected`);
  for (const path of [SUITE, PG, MUT, MODEL, 'supabase/tests/common_account_g5_02_rpc_preconditions_pg_run.sh']) {
    assert.ok(exists(path), path);
    assert.ok(doc.includes(path.split('/').pop()!), `${path} is named`);
  }
});

test('quiet: nothing secret-shaped, no project host, no URL, nothing unfinished', () => {
  for (const [name, text] of [['doc', doc], ['model', model], ['suite', read(SUITE)], ['pg', read(PG)]] as const) {
    assert.deepEqual(secretFindings(text.replace(/https:\/\/example\.invalid\//gu, '')), [], `${name}: nothing secret-shaped`);
    assert.deepEqual(projectRefsIn(text), [], `${name}: no project host`);
  }
  assert.ok(!/https?:\/\//u.test(doc), 'no URL in the document');
  assert.ok(!/\bTODO\b|\bFIXME\b|\bTBD\b|@@RESULTS@@/u.test(doc), 'nothing unfinished');
});
