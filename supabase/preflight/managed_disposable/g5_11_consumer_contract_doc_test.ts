// Offline contract of docs/common-account/g5-11-session-verdict-consumer-contract.md: the four P3 items are each answered, the consumer contract
// C-1..C-5 and the assumptions A-1..A-5 are written down, the TEST-ONLY consumer in the PG17 suite keeps the contract (VOLATILE, the isolation guard,
// the verdict first, the re-authorization inside the read / write statement) while each anti-pattern breaks exactly one rule, the SQL candidate is
// untouched by this task, the document names its tests with the real counts, and nothing is secret-shaped, a project host or unfinished.
//
//   deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/g5_11_consumer_contract_doc_test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { projectRefsIn } from './guard.ts';
import { secretFindings } from './inventory.ts';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));
const DOC = 'docs/common-account/g5-11-session-verdict-consumer-contract.md';
const PG = 'supabase/tests/common_account_session_verdict_pg_test.ts';
const MUT = 'supabase/tests/common_account_session_verdict_mutations.py';
const SQL = 'supabase/candidates/common_account_authorization_verdict/003_session_verdict.sql';
const doc = read(DOC);
const pg = read(PG);

test('the document answers P3-1..P3-4 and writes down the contract and the assumptions', () => {
  for (let n = 1; n <= 7; n += 1) assert.match(doc, new RegExp(`^## ${n}\\. `, 'mu'), `section ${n}`);
  for (let n = 1; n <= 4; n += 1) assert.ok(doc.includes(`| P3-${n} `), `P3-${n}`);
  for (let n = 1; n <= 5; n += 1) assert.ok(doc.includes(`| C-${n} `) && doc.includes(`| A-${n} `), `C-${n} / A-${n}`);
  for (const phrase of ['NO_GO', 'NOT_VERIFIED', '6295813705', '6295863864', 'ceb77ce45f0e79510ac7551849288b17991f81d2', '#408', '6294869449', 'K5', 'VOLATILE',
    'READ COMMITTED', 'REPEATABLE READ', 'transaction_isolation', '0A000', 'clock_timestamp', 'banned_until', 'user / G1', 'residual window']) {
    assert.ok(doc.includes(phrase), phrase);
  }
});

test('the TEST-ONLY consumer keeps the contract; each anti-pattern breaks exactly one rule', () => {
  const body = (name: string) => {
    const start = pg.indexOf(`create or replace function sv_consumer.${name}(`);
    assert.ok(start > 0, name);
    return pg.slice(start, pg.indexOf('end $f$;', start));
  };
  for (const name of ['receipt', 'cancel']) {
    const b = body(name);
    assert.ok(/language plpgsql volatile security definer/u.test(b), `${name}: VOLATILE`);
    assert.ok(b.includes('${GUARD};') && b.includes('${FIRST};'), `${name}: the isolation guard and the verdict first`);
    assert.ok(b.indexOf('${GUARD};') < b.indexOf('${FIRST};'), `${name}: the guard before the verdict`);
    assert.ok(/(select|update)[^;]*and \$\{SV\}\(\) = 'active';/u.test(b), `${name}: re-authorized inside its read / write statement`);
  }
  assert.ok(/language plpgsql stable security definer/u.test(body('receipt_stable_anti')), 'anti 1 is STABLE');
  assert.ok(!body('receipt_noguard_anti').includes('${GUARD};'), 'anti 2 has no isolation guard');
  const anti3 = body('cancel_precheck_anti');
  assert.ok(anti3.includes('${GUARD};') && anti3.includes('${FIRST};') && !/update[^;]*\$\{SV\}/u.test(anti3), 'anti 3 checks first only');
  assert.ok(pg.includes("current_setting('transaction_isolation') <> 'read committed'"), 'the guard reads the isolation');
});

test('this task leaves the SQL candidate alone: 003 is the G5-10 file (STABLE, owner-only, clock_timestamp)', () => {
  const sql = read(SQL);
  assert.ok(sql.includes("returns text language plpgsql stable security definer set search_path = '' set row_security = off as $$"));
  assert.ok(sql.includes('s.not_after > pg_catalog.clock_timestamp()'));
  assert.ok(sql.includes('-- G5 SOURCE CANDIDATE (2026-10-21, Issue #320 G5-01 task 10).'), 'still the task-10 file');
});

test('the document names its tests with the real counts', () => {
  const tests = (pg.match(/^test_\(/gmu) ?? []).length;
  const mutants = (read(MUT).match(/^ {4}\(['"]/gmu) ?? []).length;
  assert.ok(doc.includes(`${tests} tests`), `the document should say ${tests} tests`);
  assert.ok(doc.includes(`${mutants}/${mutants} detected`), `the document should say ${mutants}/${mutants} detected`);
  for (const name of ['P3-1 the consumer contract', 'P3-2 the install refuses', 'P3-3 the expiry', 'P3-4 recorded as is']) assert.ok(pg.includes(`test_('${name}`), name);
  for (const m of ['a superuser owner is accepted', 'a VOLATILE auth.uid() is accepted', 'not_after is compared with the transaction start (now())']) assert.ok(read(MUT).includes(m), m);
});

test('quiet: nothing secret-shaped, no project host, no URL, nothing unfinished', () => {
  for (const [name, text] of [['doc', doc], ['pg', pg]] as const) {
    assert.deepEqual(secretFindings(text.replace(/https:\/\/example\.invalid\//gu, '')), [], `${name}: nothing secret-shaped`);
    assert.deepEqual(projectRefsIn(text), [], `${name}: no project host`);
  }
  assert.ok(!/https?:\/\//u.test(doc), 'no URL in the document');
  assert.ok(!/\bTODO\b|\bFIXME\b|\bTBD\b|@@[A-Z_]+@@/u.test(doc), 'nothing unfinished');
});
