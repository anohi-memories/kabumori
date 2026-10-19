// Offline contract of docs/common-account/g5-01-postona-entitlement-auth-boundary.md and of the reference it describes
// (supabase/candidates/common_account_postona_authz/verdict.ts): the claims that must stay true of THIS checkout -- the wire keys and codes the
// document lists, that the reference is pure and wired nowhere, that the document names its tests with the real counts, and that nothing is
// secret-shaped, a project host or unfinished. Pure file reads.
//
//   deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/g5_01_contract_doc_test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { projectRefsIn } from './guard.ts';
import { secretFindings } from './inventory.ts';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));
const exists = (path: string) => { try { Deno.statSync(new URL(path, root)); return true; } catch { return false; } };
const DOC = 'docs/common-account/g5-01-postona-entitlement-auth-boundary.md';
const REF = 'supabase/candidates/common_account_postona_authz/verdict.ts';
const PURE = 'supabase/tests/common_account_g5_01_authz_test.ts';
const PG = 'supabase/tests/common_account_g5_01_authz_pg_test.ts';
const doc = read(DOC);
const ref = read(REF);
const walk = (dir: string): string[] => {
  let entries: Deno.DirEntry[] = [];
  try { entries = [...Deno.readDirSync(new URL(`${dir}/`, root))]; } catch { return []; }
  return entries.flatMap((e) => e.name === 'node_modules' ? [] : e.isDirectory ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
};

test('the document has its sections, the verdicts and the hand-off owners', () => {
  for (let n = 1; n <= 11; n += 1) assert.match(doc, new RegExp(`^## ${n}\\. `, 'mu'), `section ${n}`);
  for (const phrase of ['NO_GO', 'NOT_VERIFIED', 'Codex Sol (high)', '#303', '#336', '#285', 'G3 / F3', 'G4 / F4', 'G6 / F6', 'G1 / F1', 'DESIGN ONLY', 'not created',
    'one statement', 'existence oracle', 'A -> B -> A', 'lifecycle_version', 'TOCTOU', 'K5']) assert.ok(doc.includes(phrase), phrase);
});

test('the wire the document quotes is the one the reference emits: keys, token shape, TTL and every refusal code', () => {
  assert.ok(ref.includes("export const WIRE_KEYS = 'decision,entitlements,expires_at_ms,issued_at_ms,owner_epoch,reason,scope,session,subject,v';"));
  assert.ok(ref.includes('return `g5oe:${ownerEpoch}:${lifecycleVersion}`;') && doc.includes('g5oe:<F5 brand owner epoch>:<owner lifecycle_version>'));
  assert.ok(ref.includes('export const ALLOW_TTL_MS = 60_000;') && doc.includes('at most 60 s'));
  const codes = [...ref.matchAll(/refusal\(scope, '(?:deny|unknown|pending)', '([A-Z_]+)'/gu)].map((m) => m[1]);
  const policyCodes = [...ref.matchAll(/return '([A-Z_]+)';/gu)].map((m) => m[1]);
  for (const code of new Set([...codes, ...policyCodes])) {
    if (code === 'FACTS_UNAVAILABLE' || code === 'BRAND_UNREADABLE' || code === 'ENTITLEMENTS_UNREADABLE' || code === 'BRAND_NOT_EXPECTED') continue; // internal read failures
    assert.ok(doc.includes(code), `the document lists ${code}`);
  }
  for (const code of ['AUTH_UNAVAILABLE_BEFORE_SEND', 'AUTH_CHANGED_BEFORE_SEND']) assert.ok(ref.includes(`'${code}'`) && doc.includes(code), code);
});

test('the reference is pure and wired nowhere: no import, no I/O, no network; no Edge function or app file names it', () => {
  assert.ok(!/^import /mu.test(ref), 'no import');
  for (const banned of ['Deno.', 'fetch(', 'process.', 'require(', 'createClient', 'supabase.', 'XMLHttpRequest', 'WebSocket']) assert.ok(!ref.includes(banned), banned);
  for (const path of [...walk('supabase/functions'), ...walk('apps/social-mobile/src'), ...walk('src')]) {
    if (!/\.(ts|tsx|mjs|js|sql)$/u.test(path)) continue;
    const text = read(path);
    assert.ok(!text.includes('common_account_postona_authz') && !text.includes('g5oe:'), `${path} uses the reference`);
  }
  for (const entry of Deno.readDirSync(new URL('supabase/migrations/', root))) assert.ok(!/authorization_verdict|postona_authz/u.test(entry.name), `${entry.name} is a migration of this task`);
  assert.ok(!read(PG).match(/create (or replace )?function/iu), 'the PG suite creates no function: the facts read is a plain SELECT');
});

test('the document names its tests with the real counts and the files exist', () => {
  const pure = (read(PURE).match(/^test\(/gmu) ?? []).length;
  const pg = (read(PG).match(/^test_\(/gmu) ?? []).length;
  assert.ok(doc.includes(`${pure} tests`), `the document should say ${pure} tests (pure)`);
  assert.ok(doc.includes(`${pg} tests`), `the document should say ${pg} tests (PG17)`);
  const mutants = (read('supabase/tests/common_account_g5_01_authz_mutations.py').match(/^ {4}\('/gmu) ?? []).length;
  assert.ok(doc.includes(`${mutants}/${mutants} detected`), `the document should say ${mutants}/${mutants} detected`);
  for (const path of [PURE, PG, 'supabase/tests/common_account_g5_01_authz_pg_run.sh', 'supabase/tests/common_account_g5_01_authz_mutations.py', REF]) {
    assert.ok(exists(path), path);
    assert.ok(doc.includes(path.split('/').pop()!), `${path} is named`);
  }
});

test('quiet: nothing secret-shaped, no project host, no URL, nothing unfinished', () => {
  for (const [name, text] of [['doc', doc], ['reference', ref], ['pure', read(PURE)], ['pg', read(PG)]] as const) {
    assert.deepEqual(secretFindings(text.replace(/https:\/\/example\.invalid\//gu, '')), [], `${name}: nothing secret-shaped`);
    assert.deepEqual(projectRefsIn(text), [], `${name}: no project host`);
  }
  assert.ok(!/https?:\/\//u.test(doc), 'no URL in the document');
  assert.ok(!/\bTODO\b|\bFIXME\b|\bTBD\b|@@RESULTS@@/u.test(doc), 'nothing unfinished');
});
