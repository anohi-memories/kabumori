// The D-2 document makes claims that must stay true of this checkout: the paths it names exist, the scenarios and the NOT_VERIFIED list it
// promises are there, the numbers it quotes are the real ones, and nothing in it is secret-shaped or unfinished. Pure file reads.
import assert from 'node:assert/strict';
import test from 'node:test';

import { secretFindings } from '../inventory.ts';
import { projectRefsIn } from '../guard.ts';
import { RUNTIME_FILES, STAND_IN_DIR } from './exclusion.ts';
import { STAND_IN_BLOCK_REASONS } from './standin.ts';

const root = new URL('../../../../', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));
const exists = (path: string) => {
  try {
    Deno.statSync(new URL(path, root));
    return true;
  } catch {
    return false;
  }
};
const DOC = 'docs/common-account/phase13-d2-x-saga-standin.md';
const doc = read(DOC);

test('the document names only files that exist, and the runtime files it describes are the real ones', () => {
  let checked = 0;
  for (const match of doc.matchAll(/`([^`\n]+)`/gu)) {
    const token = match[1].replace(/:\d+$/u, '');
    if (!/^(?:supabase|docs|apps|\.agent)\//u.test(token) || /[*<>\s…]/u.test(token)) continue;
    checked += 1;
    assert.ok(exists(token) || token.endsWith('/'), `the document names ${token}, which does not exist`);
  }
  assert.ok(checked >= 6, `only ${checked} paths were checked`);
  for (const name of RUNTIME_FILES) assert.ok(doc.includes(`\`${name}\``), `${name} is described`);
  assert.ok(doc.includes(STAND_IN_DIR), 'the directory is named in full once');
  for (const name of ['standin.ts', 'harness.ts', 'tripwire.ts', 'exclusion.ts', 'standin_test.ts', 'lifecycle_scenarios_test.ts', 'exclusion_test.ts']) {
    assert.ok(exists(`${STAND_IN_DIR}/${name}`), name);
  }
  for (const path of ['supabase/tests/common_account_phase13_d2_standin_run.sh', 'supabase/tests/common_account_phase13_d2_standin_test.ts', 'supabase/tests/common_account_phase13_d2_mutations.py']) {
    assert.ok(exists(path), path);
  }
});

test('the document carries the scenarios, the exclusion rules, the markers, the NOT_VERIFIED list and the ownership of what remains', () => {
  for (const word of ['clean', 'blocked', 'in_progress', 'reconciliation_required', 'failed', 'stand_in_disabled', 'effects_performed', 'remote_x_verified', 'production_usable']) {
    assert.ok(doc.includes(word), word);
  }
  for (const reason of ['UNEXPECTED_DEPENDENT_DATA', 'POSTING_IN_PROGRESS', 'X_REVOKE_FAILED']) assert.ok(doc.includes(reason) && (reason === 'X_REVOKE_FAILED' || STAND_IN_BLOCK_REASONS.includes(reason as never)), reason);
  for (const rule of ['E1', 'E2', 'E3', 'E4', 'E5', 'E6']) assert.match(doc, new RegExp(`\\| ${rule} \\|`, 'u'), rule);
  for (const phrase of ['NOT_VERIFIED', 'managed M12', 'R2′', 'T13', '#233', 'never** a real revoke', 'NO_GO', 'managed_auth_delete', 'IDP_PREPAUSE_BLOCKED', 'toLifecycleResult', 'import type', 'a deployed Edge function', 'D-2_IMPLEMENTATION_GO', 'PASS_CONTRACT_REVIEW']) {
    assert.ok(doc.includes(phrase), phrase);
  }
  assert.match(doc, /\*\*not\*\* a deployed Edge function/u);
  assert.ok(doc.includes('The one conversion') || doc.includes('the one conversion'), 'the single conversion is named');
});

test('the document is clean: nothing secret-shaped, no project host, no unfinished marker', () => {
  assert.deepEqual(secretFindings(doc), []);
  assert.deepEqual(projectRefsIn(doc), []);
  assert.ok(!doc.includes('RESULTS_PENDING') && !/\bTODO\b|\bFIXME\b|\bTBD\b/u.test(doc), 'no unfinished marker');
});
