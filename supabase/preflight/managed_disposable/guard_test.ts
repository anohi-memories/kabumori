// Target guard of the managed-disposable harness: every refusal is its own code, a dry run needs nothing, execution
// needs everything. Synthetic refs only (20 lowercase characters, none a real project).
import assert from 'node:assert/strict';
import test from 'node:test';

import { ENV, type Env, makeRedactor, parseDbUrl, parseHostedUrl, projectRefsIn, resolveTarget, scanSqlForForeignTargets } from './guard.ts';

const DISPOSABLE = 'aaaaaaaaaaaaaaaaaaaa';
const OTHER_TEST = 'bbbbbbbbbbbbbbbbbbbb';
const PRODUCTION = 'cccccccccccccccccccc';
const REPO_ONLY = 'dddddddddddddddddddd';

const full = (over: Env = {}): Env => ({
  [ENV.projectRef]: DISPOSABLE,
  [ENV.allowlist]: `${DISPOSABLE},${OTHER_TEST}`,
  [ENV.denylist]: PRODUCTION,
  [ENV.apiUrl]: `https://${DISPOSABLE}.supabase.co`,
  [ENV.confirm]: DISPOSABLE,
  [ENV.publishableKey]: 'sb_publishable_synthetic_key_value',
  [ENV.serviceKey]: 'sb_secret_synthetic_key_value_1234',
  [ENV.dbUrl]: `postgresql://postgres:synthetic-password@db.${DISPOSABLE}.supabase.co:5432/postgres`,
  [ENV.baselineSha256]: 'f'.repeat(64),
  [ENV.baselinePath]: '/tmp/synthetic-baseline.sql',
  [ENV.inventorySha256]: 'e'.repeat(64),
  [ENV.emailDomain]: 'accept.example.test',
  ...over,
});
const codes = (env: Env, options = { execute: true, repositoryRefs: [REPO_ONLY] }) => {
  const decision = resolveTarget(env, options);
  return decision.ok ? [] : decision.failures.map((f) => f.code).sort();
};

test('a complete, allowlisted, non-production target is accepted', () => {
  const decision = resolveTarget(full(), { execute: true, repositoryRefs: [REPO_ONLY] });
  assert.equal(decision.ok, true);
  if (decision.ok) {
    assert.equal(decision.target.projectRef, DISPOSABLE);
    assert.equal(decision.target.baseUrl, `https://${DISPOSABLE}.supabase.co`);
    assert.equal(decision.target.dbHost, `db.${DISPOSABLE}.supabase.co`);
  }
});

test('a dry run needs no project, no secret and no confirmation, and says so', () => {
  const decision = resolveTarget({}, { execute: false });
  // nothing configured: the allowlist / deny list / ref rules still report (an execution would be refused)
  assert.equal(decision.ok, false);
  const minimal = resolveTarget({
    [ENV.projectRef]: DISPOSABLE, [ENV.allowlist]: DISPOSABLE, [ENV.denylist]: PRODUCTION, [ENV.apiUrl]: `https://${DISPOSABLE}.supabase.co`,
  }, { execute: false });
  assert.equal(minimal.ok, true);
  if (minimal.ok) assert.ok(minimal.warnings.some((w) => /dry run/u.test(w)));
});

test('execution refuses each missing piece with its own code', () => {
  const cases: [Env, string][] = [
    [full({ [ENV.projectRef]: undefined }), 'TARGET_REF_MISSING'],
    [full({ [ENV.projectRef]: 'short' }), 'TARGET_REF_MALFORMED'],
    [full({ [ENV.allowlist]: undefined }), 'ALLOWLIST_MISSING'],
    [full({ [ENV.allowlist]: `${DISPOSABLE},not-a-ref` }), 'ALLOWLIST_MALFORMED'],
    [full({ [ENV.denylist]: undefined }), 'DENYLIST_MISSING'],
    [full({ [ENV.denylist]: 'nope' }), 'DENYLIST_MALFORMED'],
    [full({ [ENV.apiUrl]: undefined }), 'API_URL_MISSING'],
    [full({ [ENV.confirm]: undefined }), 'CONFIRM_MISSING'],
    [full({ [ENV.publishableKey]: undefined }), 'PUBLISHABLE_KEY_MISSING'],
    [full({ [ENV.serviceKey]: undefined }), 'SERVICE_KEY_MISSING'],
    [full({ [ENV.dbUrl]: undefined }), 'DB_URL_MISSING'],
    [full({ [ENV.emailDomain]: undefined }), 'EMAIL_DOMAIN_MISSING'],
    [full({ [ENV.baselineSha256]: undefined }), 'BASELINE_DIGEST_MISSING'],
    [full({ [ENV.baselinePath]: undefined }), 'BASELINE_PATH_MISSING'],
    [full({ [ENV.inventorySha256]: undefined }), 'INVENTORY_DIGEST_MISSING'],
    [full({ [ENV.inventorySha256]: 'not-a-digest' }), 'INVENTORY_DIGEST_MISSING'],
    [full({ [ENV.inventorySha256]: 'E'.repeat(64) }), 'INVENTORY_DIGEST_MISSING'],
  ];
  for (const [env, code] of cases) assert.ok(codes(env).includes(code), `${code}: ${codes(env).join(',')}`);
});

test('a project that is not on the allowlist, or is production, is refused', () => {
  assert.deepEqual(codes(full({ [ENV.projectRef]: PRODUCTION, [ENV.apiUrl]: `https://${PRODUCTION}.supabase.co`, [ENV.confirm]: PRODUCTION, [ENV.dbUrl]: `postgres://postgres:x@db.${PRODUCTION}.supabase.co/postgres` })),
    ['TARGET_IS_PRODUCTION', 'TARGET_NOT_ALLOWLISTED']);
  // production even when somebody put it on the allowlist: the whole configuration is refused
  const polluted = codes(full({ [ENV.projectRef]: PRODUCTION, [ENV.allowlist]: `${DISPOSABLE},${PRODUCTION}`, [ENV.apiUrl]: `https://${PRODUCTION}.supabase.co`, [ENV.confirm]: PRODUCTION, [ENV.dbUrl]: `postgres://postgres:x@db.${PRODUCTION}.supabase.co/postgres` }));
  assert.ok(polluted.includes('TARGET_IS_PRODUCTION') && polluted.includes('ALLOWLIST_CONTAINS_PRODUCTION'), polluted.join(','));
  // a ref the repository names is production even if the deny list forgot it
  const repoNamed = codes(full({ [ENV.projectRef]: REPO_ONLY, [ENV.allowlist]: REPO_ONLY, [ENV.apiUrl]: `https://${REPO_ONLY}.supabase.co`, [ENV.confirm]: REPO_ONLY, [ENV.dbUrl]: `postgres://postgres:x@db.${REPO_ONLY}.supabase.co/postgres` }));
  assert.ok(repoNamed.includes('TARGET_IS_PRODUCTION'), repoNamed.join(','));
  // an allowlist that is polluted refuses even an otherwise good target
  assert.ok(codes(full({ [ENV.allowlist]: `${DISPOSABLE},${PRODUCTION}` })).includes('ALLOWLIST_CONTAINS_PRODUCTION'));
});

test('the API URL must be exactly https://<ref>.supabase.co and name the target', () => {
  for (const url of [
    `http://${DISPOSABLE}.supabase.co`, `https://${DISPOSABLE}.supabase.co:8443`, `https://user:pw@${DISPOSABLE}.supabase.co`,
    `https://${DISPOSABLE}.supabase.co/rest/v1`, `https://${DISPOSABLE}.supabase.co?x=1`, `https://${DISPOSABLE}.supabase.co.evil.example`,
    `https://evil.example/${DISPOSABLE}.supabase.co`, 'https://localhost', '', 'not a url',
  ]) assert.ok(codes(full({ [ENV.apiUrl]: url })).some((c) => c === 'API_URL_INVALID' || c === 'API_URL_MISSING'), url);
  assert.ok(codes(full({ [ENV.apiUrl]: `https://${OTHER_TEST}.supabase.co` })).includes('API_URL_REF_MISMATCH'));
  assert.deepEqual(parseHostedUrl(`https://${DISPOSABLE}.supabase.co/`), { ref: DISPOSABLE, base: `https://${DISPOSABLE}.supabase.co` });
});

test('the confirmation must repeat the ref; the keys must be of the right kind; the database URL must name the target', () => {
  assert.ok(codes(full({ [ENV.confirm]: OTHER_TEST })).includes('CONFIRM_MISMATCH'));
  assert.ok(codes(full({ [ENV.publishableKey]: 'sb_secret_synthetic_key_value_1234' })).includes('PUBLISHABLE_KEY_WRONG_KIND'));
  const serviceJwt = `${btoa('{"alg":"HS256"}')}.${btoa('{"role":"service_role"}').replace(/=+$/u, '')}.signature`;
  assert.ok(codes(full({ [ENV.publishableKey]: serviceJwt })).includes('PUBLISHABLE_KEY_WRONG_KIND'));
  assert.ok(codes(full({ [ENV.serviceKey]: 'sb_publishable_synthetic_key_value' })).includes('SERVICE_KEY_NOT_A_SERVICE_KEY'));
  assert.ok(codes(full({ [ENV.dbUrl]: `postgres://postgres:x@db.${OTHER_TEST}.supabase.co/postgres` })).includes('DB_URL_REF_MISMATCH'));
  assert.ok(codes(full({ [ENV.dbUrl]: 'postgres://postgres:x@localhost:5432/postgres' })).includes('DB_URL_REF_MISMATCH'));
  assert.ok(codes(full({ [ENV.dbUrl]: 'mysql://x' })).includes('DB_URL_INVALID'));
  // the pooler form names the project in the user name
  assert.deepEqual(parseDbUrl(`postgresql://postgres.${DISPOSABLE}:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres`)?.refs, [DISPOSABLE]);
  assert.equal(codes(full({ [ENV.dbUrl]: `postgresql://postgres.${DISPOSABLE}:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres` })).length, 0);
});

test('test addresses must be on a controlled domain, never a public mail provider', () => {
  for (const domain of ['gmail.com', 'icloud.com', 'privaterelay.appleid.com', 'localhost', 'a b.test', '-x.test']) {
    assert.ok(codes(full({ [ENV.emailDomain]: domain })).includes('EMAIL_DOMAIN_NOT_CONTROLLED'), domain);
  }
});

test('project refs in repository text are found; foreign hosts, cron and database HTTP are findings', () => {
  assert.deepEqual(projectRefsIn(`select 'https://${PRODUCTION}.supabase.co/functions/v1/x'; -- ${REPO_ONLY}.supabase.co`), [PRODUCTION, REPO_ONLY]);
  assert.deepEqual(scanSqlForForeignTargets('select 1;', DISPOSABLE), []);
  const findings = scanSqlForForeignTargets(
    `select cron.schedule('j', '* * * * *', $$select net.http_post(url := 'https://${PRODUCTION}.supabase.co/functions/v1/x')$$);`, DISPOSABLE);
  assert.deepEqual(findings.map((f) => f.code).sort(), ['CRON_SCHEDULE', 'FOREIGN_PROJECT_HOST', 'HTTP_FROM_DATABASE']);
  // the target's own host is not foreign; a commented-out host is ignored; the finding never prints a whole ref
  assert.deepEqual(scanSqlForForeignTargets(`select 'https://${DISPOSABLE}.supabase.co'; -- ${PRODUCTION}.supabase.co`, DISPOSABLE), []);
  assert.ok(!JSON.stringify(findings).includes(PRODUCTION));
});

test('secrets never leave through a log line', () => {
  const redact = makeRedactor(['sb_secret_synthetic_key_value_1234', 'synthetic-password', 'opaque-value-with-no-known-shape']);
  const text = redact('key=sb_secret_synthetic_key_value_1234 url=postgresql://postgres:synthetic-password@db.x.supabase.co/postgres jwt=eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlMTIzNDU2 other=sb_publishable_abcdefghijkl');
  assert.ok(!/sb_secret_synthetic|synthetic-password|eyJhbGci|sb_publishable_abcdef/u.test(text), text);
  // a configured secret is removed whatever it looks like; a short value is not (it would mangle ordinary text)
  assert.equal(redact('token opaque-value-with-no-known-shape end'), 'token [REDACTED] end');
  assert.equal(makeRedactor(['abc'])('abc stays'), 'abc stays');
});
