// Offline contract of docs/common-account/g5-06-brandless-oauth-bootstrap.md and of the reference it describes
// (supabase/candidates/common_account_postona_authz/bootstrap.ts): the features and codes the document lists are the model's, R1's feature list did
// not gain the bootstrap features, no SQL object of the proposal exists, the model is wired nowhere, the document names its tests with the real counts,
// and nothing is secret-shaped, a project host or unfinished. Pure file reads.
//
//   deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/g5_06_bootstrap_doc_test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { projectRefsIn } from './guard.ts';
import { secretFindings } from './inventory.ts';
import { POSTONA_FEATURES } from '../../candidates/common_account_postona_authz/verdict.ts';
import { BOOTSTRAP_FEATURES } from '../../candidates/common_account_postona_authz/bootstrap.ts';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));
const exists = (path: string) => { try { Deno.statSync(new URL(path, root)); return true; } catch { return false; } };
const DOC = 'docs/common-account/g5-06-brandless-oauth-bootstrap.md';
const MODEL = 'supabase/candidates/common_account_postona_authz/bootstrap.ts';
const SUITE = 'supabase/tests/common_account_g5_06_bootstrap_test.ts';
const MUT = 'supabase/tests/common_account_g5_06_bootstrap_mutations.py';
const doc = read(DOC);
const model = read(MODEL);
const walk = (dir: string): string[] => {
  let entries: Deno.DirEntry[] = [];
  try { entries = [...Deno.readDirSync(new URL(`${dir}/`, root))]; } catch { return []; }
  return entries.flatMap((e) => e.name === 'node_modules' ? [] : e.isDirectory ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
};

test('the document has its sections, the decision, the hand-offs and the gates', () => {
  for (let n = 1; n <= 11; n += 1) assert.match(doc, new RegExp(`^## ${n}\\. `, 'mu'), `section ${n}`);
  for (const phrase of ['NO_GO', 'NOT_VERIFIED', 'Codex Sol (high)', '#371', '#353', '#355', '6279536652', '6283895174', 'G4 / F3', 'G3 / F3', 'design only',
    'guardIrreversible', 'OWN_WORKSPACE_CONFLICT', 'BRAND_NOT_EXPECTED', 'social_mobile_account_deletion_workspace', 'L-6', 'K5']) assert.ok(doc.includes(phrase), phrase);
});

test('the features and codes the document states are the model\'s; R1\'s feature list did not gain them', () => {
  for (const f of BOOTSTRAP_FEATURES) {
    assert.ok(doc.includes(`\`${f}\``), f);
    assert.ok(!Object.hasOwn(POSTONA_FEATURES, f), `${f} is not an R1 feature`);
  }
  const codes = [...model.matchAll(/'(?:deny|unknown)', '([A-Z_]+)'/gu)].map((m) => m[1]);
  assert.ok(codes.length >= 4);
  for (const code of codes) assert.ok(doc.includes(code), `the document lists ${code}`);
  assert.ok(model.includes("owner_epoch: null, entitlements: person.entitlements,"), 'the allow carries no owner epoch');
  assert.ok(model.includes("scope: { app: 'postona', feature: scope.feature, brand_slug: null },"), 'the allow names no brand');
});

test('nothing of the proposal exists as SQL, and the model is wired nowhere', () => {
  for (const path of [...walk('supabase/migrations'), ...walk('supabase/candidates')].filter((p) => p.endsWith('.sql'))) {
    assert.ok(!/bootstrap_verdict|x_connect_bootstrap|threads_connect_bootstrap/u.test(read(path)), `${path} defines a proposed object`);
  }
  for (const path of [...walk('supabase/functions'), ...walk('apps/social-mobile/src'), ...walk('src')]) {
    if (!/\.(ts|tsx|mjs|js|sql)$/u.test(path)) continue;
    assert.ok(!/common_account_postona_authz\/bootstrap|_connect_bootstrap/u.test(read(path)), `${path} uses the model`);
  }
  for (const banned of ['Deno.', 'fetch(', 'createClient', 'process.']) assert.ok(!model.includes(banned), `the model uses ${banned}`);
});

test('the document names its tests with the real counts and the files exist', () => {
  const suite = (read(SUITE).match(/^test\(/gmu) ?? []).length;
  const mutants = (read(MUT).match(/^ {4}\(['"]/gmu) ?? []).length;
  assert.ok(doc.includes(`${suite} tests`), `the document should say ${suite} tests`);
  assert.ok(doc.includes(`${mutants}/${mutants} detected`), `the document should say ${mutants}/${mutants} detected`);
  for (const path of [SUITE, MUT, MODEL]) {
    assert.ok(exists(path), path);
    assert.ok(doc.includes(path.split('/').pop()!), `${path} is named`);
  }
});

test('quiet: nothing secret-shaped, no project host, no URL, nothing unfinished', () => {
  for (const [name, text] of [['doc', doc], ['model', model], ['suite', read(SUITE)]] as const) {
    assert.deepEqual(secretFindings(text.replace(/https:\/\/example\.invalid\//gu, '')), [], `${name}: nothing secret-shaped`);
    assert.deepEqual(projectRefsIn(text), [], `${name}: no project host`);
  }
  assert.ok(!/https?:\/\//u.test(doc), 'no URL in the document');
  assert.ok(!/\bTODO\b|\bFIXME\b|\bTBD\b|@@RESULTS@@/u.test(doc), 'nothing unfinished');
});
