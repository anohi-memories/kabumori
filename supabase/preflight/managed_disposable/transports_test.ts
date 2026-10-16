// The real transports are only exercised for what they would send: a database URL becomes libpq environment
// variables (never argv), reads are read-only sessions, a probe carries the disposable setting, an applied file goes
// through stdin exactly as the digest-checked bytes.
import assert from 'node:assert/strict';
import test from 'node:test';

import { psqlInvocation } from './transports.ts';

const URL_ = 'postgresql://postgres.aaaaaaaaaaaaaaaaaaaa:synthetic-password@aws-0-eu-west-1.pooler.supabase.com:6543/postgres';

test('the password is in the child environment, never in an argument', () => {
  for (const mode of ['read', 'apply', 'probe', 'hold'] as const) {
    const invocation = psqlInvocation(URL_, mode, 'select 1');
    assert.ok(!invocation.args.join(' ').includes('synthetic-password'), mode);
    assert.ok(!invocation.args.join(' ').includes('pooler.supabase.com'), mode);
    assert.equal(invocation.env.PGPASSWORD, 'synthetic-password');
    assert.equal(invocation.env.PGUSER, 'postgres.aaaaaaaaaaaaaaaaaaaa');
    assert.equal(invocation.env.PGHOST, 'aws-0-eu-west-1.pooler.supabase.com');
    assert.equal(invocation.env.PGPORT, '6543');
    assert.equal(invocation.env.PGSSLMODE, 'require');
  }
});

test('reads are read-only sessions; a probe also carries its disposable setting; apply and probe read the file from stdin', () => {
  const read = psqlInvocation(URL_, 'read', 'select 1');
  assert.match(read.env.PGOPTIONS, /default_transaction_read_only=on/u);
  assert.deepEqual(read.args.slice(-2), ['-c', 'select 1']);
  const probe = psqlInvocation(URL_, 'probe', 'select 2;');
  assert.match(probe.env.PGOPTIONS, /default_transaction_read_only=on/u);
  assert.match(probe.env.PGOPTIONS, /kabumori\.disposable_probe=yes/u);
  assert.equal(probe.stdin, 'select 2;');
  const apply = psqlInvocation(URL_, 'apply', 'begin; select 3; commit;');
  assert.doesNotMatch(apply.env.PGOPTIONS, /read_only/u);
  assert.match(apply.env.PGOPTIONS, /lock_timeout=5000/u);
  assert.equal(apply.stdin, 'begin; select 3; commit;');
  assert.ok(apply.args.includes('ON_ERROR_STOP=1') && apply.args.includes('-f') && apply.args.includes('-'));
});

test('a value that is not a postgres URL is refused', () => {
  assert.throws(() => psqlInvocation('https://example.test', 'read', 'select 1'));
  assert.throws(() => psqlInvocation('not a url', 'read', 'select 1'));
});
