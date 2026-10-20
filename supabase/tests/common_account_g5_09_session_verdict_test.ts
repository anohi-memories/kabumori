// G5-09: the session-only verdict for G3's reservation cancel / receipt (P7 of G3 PR #392) -- offline tests of the pure model
// supabase/candidates/common_account_postona_authz/session_verdict.ts. Contract: docs/common-account/g5-09-session-verdict-interface.md.
// No network, no database: a PASS proves the model and its agreement with R1's reference decide(), not any SQL or managed behaviour.
//
//   deno test --no-config --allow-read --allow-env supabase/tests/common_account_g5_09_session_verdict_test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANCELLABLE,
  edgeClaimsForDb,
  GATE_HTTP,
  type ReservationRow,
  reservationPersonGate,
  type SessionFacts,
  sessionVerdict,
  SESSION_VERDICTS,
} from '../candidates/common_account_postona_authz/session_verdict.ts';
import { type ClaimSources, principalFromClaims } from '../candidates/common_account_postona_authz/rpc_preflight.ts';
import { type AuthFacts, decide } from '../candidates/common_account_postona_authz/verdict.ts';

globalThis.fetch = (() => { throw new Error('the G5-09 tests make no network request'); }) as typeof fetch;

const NOW = 1_800_000_000_000;
const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const MY_SESSION = '33333333-3333-4333-8333-333333333333';
const OTHER_SESSION = '44444444-4444-4444-8444-444444444444';
const UNKNOWN_SESSION = '55555555-5555-4555-8555-555555555555';

const json = (o: Record<string, unknown>, authUid: string | null = ME): ClaimSources => ({ legacy: null, claimsJson: JSON.stringify(o), authUid });
const good = (extra: Record<string, unknown> = {}) => json({ sub: ME, role: 'authenticated', session_id: MY_SESSION, ...extra });
const legacy = (extra: Partial<{ sub: string | null; role: string | null; sessionId: string | null; isAnonymous: string | null }> = {}): ClaimSources =>
  ({ legacy: { sub: ME, role: 'authenticated', sessionId: MY_SESSION, ...extra }, claimsJson: null, authUid: ME });
const live: SessionFacts = { userExists: true, session: { userId: ME, notAfterMs: null } };
const world = (session: SessionFacts['session'], userExists = true): SessionFacts => ({ userExists, session });

/** A reservation store that counts reads and writes (the model of G3's 007 rows). */
function store(rows: Record<string, ReservationRow>) {
  const counts = { reads: 0, writes: 0 };
  return {
    counts,
    rows,
    act(op: 'receipt' | 'cancel', claims: ClaimSources, facts: SessionFacts | undefined, id: string) {
      const verdict = sessionVerdict(claims, facts, NOW);
      const caller = principalFromClaims(claims);
      const out = reservationPersonGate(op, verdict, 'refused' in caller ? '' : caller.userId, () => { counts.reads += 1; return rows[id] ?? null; });
      if ('proceed' in out && op === 'cancel') {
        counts.writes += 1;
        rows[id] = { ...rows[id], status: 'cancelled' };
      }
      return out;
    },
  };
}

// =============================================================================================================================================
test('G3 P7, the five cases of PR #392: each is refused with 401 before any reservation row is read; cancel writes nothing', () => {
  const cases: [string, ClaimSources, SessionFacts, string][] = [
    ['C1 signed out (the session row is gone)', good(), world(null), 'SESSION_REVOKED'],
    ['C2 expired (not_after in the past)', good(), world({ userId: ME, notAfterMs: NOW - 1 }), 'SESSION_EXPIRED'],
    ['C3 my subject, another person\'s live session', good({ session_id: OTHER_SESSION }), world({ userId: OTHER, notAfterMs: null }), 'SESSION_REVOKED'],
    ['C4 a session id that does not exist', good({ session_id: UNKNOWN_SESSION }), world(null), 'SESSION_REVOKED'],
    ['C5 an anonymous sign-in with my subject and a live session', good({ is_anonymous: true }), live, 'AUTH_REQUIRED'],
  ];
  for (const [label, claims, facts, code] of cases) {
    assert.equal(sessionVerdict(claims, facts, NOW), code, label);
    for (const op of ['receipt', 'cancel'] as const) {
      const s = store({ r1: { ownerUserId: ME, status: 'planned' } });
      const out = s.act(op, claims, facts, 'r1');
      assert.deepEqual(out, { refused: 'AUTH_REQUIRED' }, `${label} / ${op}`);
      assert.equal(GATE_HTTP.AUTH_REQUIRED, 401);
      assert.deepEqual([s.counts.reads, s.counts.writes, s.rows.r1.status], [0, 0, 'planned'], `${label} / ${op}: nothing read, nothing changed`);
    }
  }
  // the same person with a live session: both work
  const s = store({ r1: { ownerUserId: ME, status: 'planned' } });
  assert.deepEqual(s.act('receipt', good(), live, 'r1'), { proceed: true, userId: ME });
  assert.deepEqual(s.act('cancel', good(), live, 'r1'), { proceed: true, userId: ME });
  assert.equal(s.rows.r1.status, 'cancelled');
});

test('the subject: R1\'s claim rules exactly (both claim forms, anonymous both forms, role, malformed, sub != auth.uid(), no login)', () => {
  const refused: [string, ClaimSources, SessionFacts][] = [
    ['no claims at all', { legacy: null, claimsJson: null, authUid: null }, live],
    ['malformed JSON', { legacy: null, claimsJson: '{not json', authUid: ME }, live],
    ['a JSON array', { legacy: null, claimsJson: '[1]', authUid: ME }, live],
    ['role anon', good({ role: 'anon' }), live],
    ['role service_role', good({ role: 'service_role' }), live],
    ['no session_id', json({ sub: ME, role: 'authenticated' }), live],
    ['a malformed session_id', good({ session_id: 'abc' }), live],
    ['sub not a uuid', json({ sub: 'me', role: 'authenticated', session_id: MY_SESSION }, 'me'), live],
    ['is_anonymous "false" as a string', good({ is_anonymous: 'false' }), live],
    ['sub disagrees with auth.uid()', json({ sub: ME, role: 'authenticated', session_id: MY_SESSION }, OTHER), live],
    ['per-claim anonymous', legacy({ isAnonymous: 'true' }), live],
    ['per-claim role anon', legacy({ role: 'anon' }), live],
    ['the login is gone', good(), world({ userId: ME, notAfterMs: null }, false)],
  ];
  for (const [label, claims, facts] of refused) assert.equal(sessionVerdict(claims, facts, NOW), 'AUTH_REQUIRED', label);
  for (const ok of [good(), good({ is_anonymous: false }), good({ is_anonymous: null }), legacy(), legacy({ isAnonymous: 'false' })]) assert.equal(sessionVerdict(ok, live, NOW), 'active');
  assert.equal(sessionVerdict(good(), world({ userId: ME, notAfterMs: NOW + 1 }), NOW), 'active', 'not_after still ahead');
  assert.equal(sessionVerdict(good(), world({ userId: ME, notAfterMs: NOW }), NOW), 'SESSION_EXPIRED', 'not_after = now is expired (R1: not_after > now)');
});

test('fail closed: unreadable facts are SESSION_UNKNOWN (503), never active', () => {
  for (const facts of [undefined, null, {}, { userExists: 'yes' }, { userExists: true, session: { userId: ME, notAfterMs: Number.NaN } },
    { userExists: true, session: { userId: ME } }, { userExists: true, session: { notAfterMs: null } }, { userExists: true, session: 'row' }]) {
    const v = sessionVerdict(good(), facts as unknown as SessionFacts, NOW);
    assert.equal(v, 'SESSION_UNKNOWN', JSON.stringify(facts));
    assert.deepEqual(reservationPersonGate('receipt', v, ME, () => { throw new Error('read after an unknown session'); }), { refused: 'AUTH_UNAVAILABLE' });
  }
  assert.equal(GATE_HTTP.AUTH_UNAVAILABLE, 503);
  assert.deepEqual([...SESSION_VERDICTS].sort(), ['AUTH_REQUIRED', 'SESSION_EXPIRED', 'SESSION_REVOKED', 'SESSION_UNKNOWN', 'active']);
});

test('the session verdict IS R1\'s subject + session stages: over a matrix it is active exactly when R1 (all else allowed) allows, else R1\'s own code', async () => {
  const allowedRest = (sessionLive: boolean | null, userExists: boolean): AuthFacts => ({
    userExists, sessionLive,
    account: { status: 'active', lifecycleVersion: 3, deletionOpen: false },
    entitlements: { x_autopost: { status: 'active', deletionOpen: false } },
    brand: { kind: 'social_mobile_user_v1', callerRole: 'owner', ownerUserId: ME, ownerCount: 1, ownerEpoch: 2 },
  });
  const claimsSet = [good(), legacy(), good({ is_anonymous: true }), good({ role: 'anon' }), json({ sub: ME, role: 'authenticated' }), good({ session_id: OTHER_SESSION }),
    json({ sub: ME, role: 'authenticated', session_id: MY_SESSION }, OTHER), legacy({ isAnonymous: 'true' })];
  const sessions: SessionFacts['session'][] = [null, { userId: ME, notAfterMs: null }, { userId: ME, notAfterMs: NOW - 1 }, { userId: ME, notAfterMs: NOW + 5 }, { userId: OTHER, notAfterMs: null }];
  let n = 0;
  for (const claims of claimsSet) {
    for (const session of sessions) {
      for (const userExists of [true, false]) {
        const facts: SessionFacts = { userExists, session };
        const v = sessionVerdict(claims, facts, NOW);
        const p = principalFromClaims(claims);
        // R1's SQL reads the session row by id AND user_id: another person's row is no row; then not_after > now or expired
        const sessionLive = session === null || session.userId !== ME ? false : session.notAfterMs === null || session.notAfterMs > NOW ? true : null;
        const r1 = await decide({ app: 'postona', feature: 'read_workspace', brandId: 'u_aaaaaaaaaaaaaaaaaaaaaaaa' }, 'refused' in p ? null : p, allowedRest(sessionLive, userExists), NOW);
        if (v === 'active') assert.equal(r1.decision, 'allow', JSON.stringify({ claims, facts }));
        else assert.equal(r1.reason, v, JSON.stringify({ claims, facts }));
        n += 1;
      }
    }
  }
  assert.equal(n, 80);
});

test('the entitlement is not an input: after the service ended (or while suspended / deleting / never started) a live session still reads its receipts and stops its own reservations -- where R1 read_workspace (option A) would refuse', async () => {
  for (const op of ['receipt', 'cancel'] as const) {
    const s = store({ r1: { ownerUserId: ME, status: 'planned' } });
    assert.ok('proceed' in s.act(op, good(), live, 'r1'), op);
  }
  // option A's cost, from R1's reference: the same live person is refused by read_workspace in every one of these states
  const base: AuthFacts = { userExists: true, sessionLive: true, account: { status: 'active', lifecycleVersion: 3, deletionOpen: false },
    entitlements: { x_autopost: { status: 'active', deletionOpen: false } },
    brand: { kind: 'social_mobile_user_v1', callerRole: 'owner', ownerUserId: ME, ownerCount: 1, ownerEpoch: 2 } };
  const p = principalFromClaims(good());
  if ('refused' in p) throw new Error('the live person must be a principal');
  const scope = { app: 'postona', feature: 'read_workspace', brandId: 'u_aaaaaaaaaaaaaaaaaaaaaaaa' };
  const states: [string, AuthFacts, string][] = [
    ['service ended', { ...base, entitlements: { x_autopost: { status: 'ended', deletionOpen: false } } }, 'SERVICE_NOT_ACTIVE'],
    ['suspended', { ...base, entitlements: { x_autopost: { status: 'suspended', deletionOpen: false } } }, 'SERVICE_SUSPENDED'],
    ['service deletion', { ...base, entitlements: { x_autopost: { status: 'deleting', deletionOpen: true } } }, 'SERVICE_DELETION_IN_PROGRESS'],
    ['never registered', { ...base, entitlements: {} }, 'SERVICE_NOT_REGISTERED'],
    ['the workspace changed owner (G3 Q1)', { ...base, brand: { ...base.brand!, callerRole: null, ownerUserId: OTHER } }, 'BRAND_ACCESS_DENIED'],
  ];
  for (const [label, facts, code] of states) {
    const r1 = await decide(scope, p, facts, NOW);
    assert.equal(`${r1.decision}:${r1.reason}`, `deny:${code}`, `option A refuses: ${label}`);
  }
});

test('no existence oracle, cancel only from a cancellable state, and retries: another person\'s row = an unknown id; a retry after sign-out is 401 and changes nothing', () => {
  const s = store({ mine: { ownerUserId: ME, status: 'planned' }, theirs: { ownerUserId: OTHER, status: 'planned' }, sent: { ownerUserId: ME, status: 'sent' } });
  for (const op of ['receipt', 'cancel'] as const) {
    assert.deepEqual(s.act(op, good(), live, 'theirs'), { refused: 'NOT_FOUND' });
    assert.deepEqual(s.act(op, good(), live, 'nope'), { refused: 'NOT_FOUND' });
  }
  assert.equal(s.rows.theirs.status, 'planned', 'another person\'s row is untouched');
  assert.deepEqual(s.act('cancel', good(), live, 'sent'), { refused: 'NOT_CANCELLABLE' });
  assert.deepEqual(s.act('receipt', good(), live, 'sent'), { proceed: true, userId: ME }, 'a sent row\'s receipt is readable');
  assert.deepEqual([...CANCELLABLE], ['planned']);
  // cancel, then the retry of the same request: the row is no longer cancellable (G3's 007 decides its own idempotent answer)
  assert.ok('proceed' in s.act('cancel', good(), live, 'mine'));
  assert.deepEqual(s.act('cancel', good(), live, 'mine'), { refused: 'NOT_CANCELLABLE' });
  // a retry that arrives after the person signed out: 401 before any read, nothing changes
  const t = store({ r: { ownerUserId: ME, status: 'planned' } });
  assert.deepEqual(t.act('cancel', good(), world(null), 'r'), { refused: 'AUTH_REQUIRED' });
  assert.deepEqual([t.counts.reads, t.counts.writes, t.rows.r.status], [0, 0, 'planned']);
  // a sign-out that lands AFTER the gate of a call already in flight cannot be seen by that call (the documented residual window, section 6)
  const u = store({ r: { ownerUserId: ME, status: 'planned' } });
  const gate = reservationPersonGate('cancel', sessionVerdict(good(), live, NOW), ME, () => u.rows.r);
  assert.ok('proceed' in gate);
});

// ---- the Edge -------------------------------------------------------------------------------------------------------------------------------
const b64url = (o: unknown) => btoa(JSON.stringify(o)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const token = (payload: Record<string, unknown>) => `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url(payload)}.c2lnbmF0dXJl`;
const userBody = { id: ME, role: 'authenticated', aud: 'authenticated', is_anonymous: false };

test('the Edge hands the database the verified token\'s sub AND session_id; a token GoTrue /user would still accept but the database must not is refused', () => {
  const t = token({ sub: ME, role: 'authenticated', session_id: MY_SESSION, is_anonymous: false, exp: 1 });
  const claims = edgeClaimsForDb(t, userBody);
  assert.equal(claims, JSON.stringify({ sub: ME, role: 'authenticated', session_id: MY_SESSION, is_anonymous: false }));
  assert.equal(sessionVerdict({ legacy: null, claimsJson: claims, authUid: ME }, live, NOW), 'active', 'the database can now check the session itself');
  const refused: [string, string, unknown][] = [
    ['no session_id (GoTrue /user loads a session only when the claim is present)', token({ sub: ME, role: 'authenticated' }), userBody],
    ['an anonymous token (GoTrue /user allows it)', token({ sub: ME, role: 'authenticated', session_id: MY_SESSION, is_anonymous: true }), userBody],
    ['an anonymous user body', token({ sub: ME, role: 'authenticated', session_id: MY_SESSION }), { ...userBody, is_anonymous: true }],
    ['sub is not the user Auth returned', token({ sub: OTHER, role: 'authenticated', session_id: MY_SESSION }), userBody],
    ['role anon', token({ sub: ME, role: 'anon', session_id: MY_SESSION }), userBody],
    ['a malformed session_id', token({ sub: ME, role: 'authenticated', session_id: 'x' }), userBody],
    ['is_anonymous not a boolean', token({ sub: ME, role: 'authenticated', session_id: MY_SESSION, is_anonymous: 'false' }), userBody],
    ['two segments', 'aGVhZGVy.cGF5bG9hZA', userBody],
    ['a payload that is not JSON', 'aGVhZGVy.bm90IGpzb24.c2ln', userBody],
    ['a padded / non-url-safe segment', `${b64url({ alg: 'ES256' })}.${btoa(JSON.stringify({ sub: ME }))}.sig`, userBody],
    ['no user body', token({ sub: ME, role: 'authenticated', session_id: MY_SESSION }), null],
    ['a user body array', token({ sub: ME, role: 'authenticated', session_id: MY_SESSION }), [userBody]],
  ];
  for (const [label, tok, body] of refused) assert.equal(edgeClaimsForDb(tok, body), null, label);
});

test('today\'s X reservation adapter hands the database {sub, role} only (F3 postgres_db.ts): every session check, and R1 itself, then refuses everyone', async () => {
  const today: ClaimSources = { legacy: { sub: ME, role: 'authenticated', sessionId: null }, claimsJson: JSON.stringify({ sub: ME, role: 'authenticated' }), authUid: ME };
  assert.equal(sessionVerdict(today, live, NOW), 'AUTH_REQUIRED');
  const p = principalFromClaims(today);
  assert.deepEqual(p, { refused: 'AUTH_REQUIRED' });
  const r1 = await decide({ app: 'postona', feature: 'x_publish', brandId: 'u_aaaaaaaaaaaaaaaaaaaaaaaa' }, null, undefined, NOW);
  assert.equal(`${r1.decision}:${r1.reason}`, 'deny:AUTH_REQUIRED');
});

test('no network: the model made no request', () => {
  assert.throws(() => globalThis.fetch('https://example.invalid/'), /no network request/u);
});
