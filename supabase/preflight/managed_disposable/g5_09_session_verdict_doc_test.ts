// Offline contract of docs/common-account/g5-09-session-verdict-interface.md and the model it names
// (supabase/candidates/common_account_postona_authz/session_verdict.ts): the three answers and the options table, the proposed interface is NOT created
// anywhere (no SQL, no migration, no Edge, no G3 file), the model has no network / clock / database, the document names its tests with the real counts,
// and nothing is secret-shaped, a project host or unfinished. Pure file reads.
//
//   deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/g5_09_session_verdict_doc_test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { projectRefsIn } from './guard.ts';
import { secretFindings } from './inventory.ts';
import { SESSION_VERDICTS } from '../../candidates/common_account_postona_authz/session_verdict.ts';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));
const DOC = 'docs/common-account/g5-09-session-verdict-interface.md';
const MODEL = 'supabase/candidates/common_account_postona_authz/session_verdict.ts';
const SUITE = 'supabase/tests/common_account_g5_09_session_verdict_test.ts';
const MUT = 'supabase/tests/common_account_g5_09_session_verdict_mutations.py';
const doc = read(DOC);
const model = read(MODEL);
const walk = (dir: string): string[] => {
  let entries: Deno.DirEntry[] = [];
  try { entries = [...Deno.readDirSync(new URL(`${dir}/`, root))]; } catch { return []; }
  return entries.flatMap((e) => e.name === 'node_modules' ? [] : e.isDirectory ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
};

test('the document has its sections, answers the three questions and keeps the gates', () => {
  for (let n = 1; n <= 10; n += 1) assert.match(doc, new RegExp(`^## ${n}\\. `, 'mu'), `section ${n}`);
  for (const q of ['Q1', 'Q2', 'Q3']) assert.ok(doc.includes(`| ${q}`), q);
  for (const phrase of ['6292793871', 'f34aab9714f5d4f11388609262d5f64cdcce5ed9', 'ce9a8eee0cc042be8c7a42981a7ddae631e41d91', '#392', '#399', '6294606412',
    'NO_GO', 'NOT_VERIFIED', 'Codex Sol (high)', 'K5', 'session_not_found', 'not_after', 'read_workspace', 'edgeClaimsForDb', 'reservationPersonGate',
    'private.account_lifecycle_session_verdict()', 'DEFERRED_BY_USER']) {
    assert.ok(doc.includes(phrase), phrase);
  }
  for (const option of ['A: R1 `read_workspace`', 'B: session-only verdict (recommended)', 'C1: `assert_active_service_write`', 'C2: `enrollment_fence(uid, true)`']) {
    assert.ok(doc.includes(option), option);
  }
  for (const code of SESSION_VERDICTS.filter((c) => c !== 'SESSION_UNKNOWN')) assert.ok(doc.includes(`'${code}'`), `the interface names ${code}`);
});

test('the interface is proposed, not created: no SQL, migration, Edge or G3 file names it', () => {
  for (const path of [...walk('supabase/migrations'), ...walk('supabase/candidates'), ...walk('supabase/functions'), ...walk('apps')]) {
    if (!/\.(sql|ts|tsx|js|mjs)$/u.test(path) || path === MODEL) continue;
    assert.ok(!read(path).includes('account_lifecycle_session_verdict'), `${path} names the proposed function`);
  }
});

test('the model is pure: no network, no clock of its own, no database, no environment', () => {
  const code = model.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
  for (const banned of ['fetch(', 'Date.now', 'new Date', 'Deno.', 'postgres', 'queryArray', 'set_config', 'import(']) assert.ok(!code.includes(banned), banned);
  assert.match(code, /^import \{ type ClaimSources, principalFromClaims \} from '\.\/rpc_preflight\.ts';$/mu, 'the claim rules are R1\'s reference, not a copy');
});

test('the document names its tests with the real counts', () => {
  const tests = (read(SUITE).match(/^test\(/gmu) ?? []).length;
  const mutants = (read(MUT).match(/^ {4}\(['"]/gmu) ?? []).length;
  assert.ok(doc.includes(`${tests} passed`), `the document should say ${tests} passed`);
  assert.ok(doc.includes(`${mutants}/${mutants} detected`), `the document should say ${mutants}/${mutants} detected`);
});

test('quiet: nothing secret-shaped, no project host, no URL, nothing unfinished', () => {
  for (const [name, text] of [['doc', doc], ['model', model], ['suite', read(SUITE)]] as const) {
    assert.deepEqual(secretFindings(text.replace(/https:\/\/example\.invalid\//gu, '')), [], `${name}: nothing secret-shaped`);
    assert.deepEqual(projectRefsIn(text), [], `${name}: no project host`);
  }
  assert.ok(!/https?:\/\//u.test(doc), 'no URL in the document');
  assert.ok(!/\bTODO\b|\bFIXME\b|\bTBD\b|@@[A-Z0-9_]+@@/u.test(doc), 'nothing unfinished');
});
