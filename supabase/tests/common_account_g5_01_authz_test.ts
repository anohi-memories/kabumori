// G5-01: the POSTONA authorization verdict reference (supabase/candidates/common_account_postona_authz/verdict.ts), proven with fixed
// facts and a counting mock transport. No database, no network (run without --allow-net; fetch is replaced by a thrower as well).
//
//   deno test --no-config --no-check supabase/tests/common_account_g5_01_authz_test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acceptAllow, ALLOW_TTL_MS, type AuthFacts, authorize, decide, guardIrreversible, ownerEpochToken, POSTONA_FEATURES, type Principal, type Scope,
  sessionRef, type VerdictWire, WIRE_KEYS,
} from '../candidates/common_account_postona_authz/verdict.ts';

globalThis.fetch = (() => { throw new Error('the G5-01 tests make no network request'); }) as typeof fetch;

const NOW = 1_792_400_000_000;
const A = '0a0a0a0a-0000-4000-8000-00000000000a';
const B = '0b0b0b0b-0000-4000-8000-00000000000b';
const S1 = '51515151-0000-4000-8000-000000000051';
const S2 = '52525252-0000-4000-8000-000000000052';
const BRAND = 'u_g501a';
const OTHER = 'u_g501b';
const scope = (feature = 'x_publish', brandId: string | null = BRAND, app = 'postona'): Scope => ({ app, feature, brandId });
const caller = (userId = A, sessionId = S1, role = 'authenticated'): Principal => ({ userId, sessionId, role });

/** A's own workspace, everything active: the one state that allows. */
function facts(over: Partial<{
  userExists: boolean; sessionLive: boolean | null | undefined; account: AuthFacts['account'] | undefined;
  entitlements: AuthFacts['entitlements']; brand: AuthFacts['brand'] | undefined;
}> = {}): AuthFacts {
  return {
    userExists: over.userExists ?? true,
    sessionLive: 'sessionLive' in over ? over.sessionLive as boolean | null : true,
    account: 'account' in over ? over.account as AuthFacts['account'] : { status: 'active', lifecycleVersion: 3, deletionOpen: false },
    entitlements: over.entitlements ?? { x_autopost: { status: 'active', deletionOpen: false }, kabumori: { status: 'active', deletionOpen: false } },
    brand: 'brand' in over ? over.brand as AuthFacts['brand']
      : { kind: 'social_mobile_user_v1', callerRole: 'owner', ownerUserId: A, ownerCount: 1, ownerEpoch: 5 },
  };
}
const brand = (over: Partial<NonNullable<AuthFacts['brand']>>): AuthFacts['brand'] =>
  ({ kind: 'social_mobile_user_v1', callerRole: 'owner', ownerUserId: A, ownerCount: 1, ownerEpoch: 5, ...over });
const verdict = (f: AuthFacts | undefined, s: Scope = scope(), p: Principal | null = caller()) => decide(s, p, f, NOW);
const why = async (f: AuthFacts | undefined, s: Scope = scope(), p: Principal | null = caller()) => {
  const v = await verdict(f, s, p);
  return `${v.decision}:${v.reason}`;
};

// ---------------------------------------------------------------------------------------------------------------------------------
test('the one allowed state: the wire object is exactly v1 (G6 PR #336 keys), the token binds the owner epoch and the lifecycle, the session id never travels', async () => {
  const v = await verdict(facts());
  assert.equal(Object.keys(v).sort().join(','), WIRE_KEYS);
  assert.deepEqual({ ...v, session: null }, {
    v: 1, decision: 'allow', reason: null, scope: { app: 'postona', feature: 'x_publish', brand_slug: BRAND }, subject: { kind: 'user', user_id: A },
    session: null, owner_epoch: 'g5oe:5:3', entitlements: ['postona:x_autopost'], issued_at_ms: NOW, expires_at_ms: NOW + ALLOW_TTL_MS,
  });
  assert.equal(v.session?.state, 'active');
  assert.equal(v.session?.ref, await sessionRef(S1));
  assert.ok(!JSON.stringify(v).includes(S1), 'the raw session id is not on the wire');
  assert.notEqual(await sessionRef(S1), await sessionRef(S2));
  assert.ok(!v.entitlements.includes('kabumori:kabumori'), 'only the scope app\'s entitlements are listed');
  const accepted = acceptAllow(v, scope(), NOW + 1);
  assert.ok('generation' in accepted && accepted.userId === A);
  for (const feature of Object.keys(POSTONA_FEATURES)) assert.equal((await verdict(facts(), scope(feature))).decision, 'allow', feature);
});

test('a common ID without POSTONA: no common account, no x_autopost entitlement, a Kabumori-only person -- every one refused', async () => {
  assert.equal(await why(facts({ account: null })), 'deny:ACCOUNT_NOT_FOUND');
  assert.equal(await why(facts({ entitlements: {} })), 'deny:SERVICE_NOT_REGISTERED');
  assert.equal(await why(facts({ entitlements: { kabumori: { status: 'active', deletionOpen: false } } })), 'deny:SERVICE_NOT_REGISTERED', 'Kabumori only');
  assert.equal(await why(facts({ userExists: false })), 'deny:AUTH_REQUIRED', 'a login that no longer exists');
});

test('every entitlement and account state: provisioning is pending, suspended / ended / deleting / an open deletion are refused, an unknown value is unknown', async () => {
  const ent = (status: string, deletionOpen = false) => facts({ entitlements: { x_autopost: { status, deletionOpen } } });
  assert.equal(await why(ent('provisioning')), 'pending:SERVICE_PROVISIONING');
  assert.equal(await why(ent('suspended')), 'deny:SERVICE_SUSPENDED');
  assert.equal(await why(ent('ended')), 'deny:SERVICE_NOT_ACTIVE');
  assert.equal(await why(ent('deleting')), 'deny:SERVICE_DELETION_IN_PROGRESS');
  assert.equal(await why(ent('active', true)), 'deny:SERVICE_DELETION_IN_PROGRESS', 'an open service deletion with the row still active');
  assert.equal(await why(ent('Active')), 'unknown:SERVICE_STATE_UNKNOWN');
  const acct = (status: string, deletionOpen = false, lifecycleVersion = 3) => facts({ account: { status, lifecycleVersion, deletionOpen } });
  assert.equal(await why(acct('deleting')), 'deny:ACCOUNT_DELETION_IN_PROGRESS');
  assert.equal(await why(acct('active', true)), 'deny:ACCOUNT_DELETION_IN_PROGRESS', 'an open account deletion (退会) with the row still active');
  assert.equal(await why(acct('locked')), 'deny:ACCOUNT_LOCKED');
  assert.equal(await why(acct('frozen')), 'unknown:ACCOUNT_STATE_UNKNOWN');
  assert.equal(await why(acct('active', false, 0)), 'unknown:ACCOUNT_UNREADABLE');
});

test('another person and another brand: not a member and an unknown brand give the SAME answer (no existence oracle); a non-owner role, another owner, another workspace kind are refused', async () => {
  assert.equal(await why(facts({ brand: null })), 'deny:BRAND_ACCESS_DENIED', 'unknown brand');
  assert.equal(await why(facts({ brand: brand({ callerRole: null, ownerUserId: B }) })), 'deny:BRAND_ACCESS_DENIED', 'B\'s brand, A is not a member');
  for (const role of ['admin', 'member', 'viewer']) assert.equal(await why(facts({ brand: brand({ callerRole: role, ownerUserId: B }) })), 'deny:ROLE_NOT_ALLOWED', role);
  assert.equal(await why(facts({ brand: brand({ kind: 'organization_v1' }) })), 'deny:WORKSPACE_KIND_UNSUPPORTED');
  // a reader bug that returns B as the owner while A has an owner row: never allow
  assert.equal(await why(facts({ brand: brand({ ownerUserId: B }) })), 'deny:BRAND_ACCESS_DENIED');
  // a verdict made for one brand / feature / app is not accepted for another
  const v = await verdict(facts());
  for (const s of [scope('x_publish', OTHER), scope('consult'), scope('x_publish', BRAND, 'kabumori')]) assert.deepEqual(acceptAllow(v, s, NOW), { refused: 'SCOPE_MISMATCH' });
});

test('owner unknown: two owners, no single owner, and a NULL owner epoch (coverage broken, not installed) are unknown, never allow', async () => {
  assert.equal(await why(facts({ brand: brand({ ownerCount: 2, ownerUserId: null }) })), 'unknown:WORKSPACE_OWNER_UNKNOWN');
  assert.equal(await why(facts({ brand: brand({ ownerCount: 1, ownerUserId: null }) })), 'unknown:WORKSPACE_OWNER_UNKNOWN');
  assert.equal(await why(facts({ brand: brand({ ownerCount: 0, ownerUserId: null }) })), 'unknown:WORKSPACE_OWNER_UNKNOWN');
  assert.equal(await why(facts({ brand: brand({ ownerEpoch: null }) })), 'unknown:OWNER_EPOCH_UNAVAILABLE');
  assert.equal(await why(facts({ brand: brand({ ownerEpoch: 0 }) })), 'unknown:OWNER_EPOCH_UNAVAILABLE');
});

test('the caller comes only from the verified JWT: no / anon / malformed callers are refused WITHOUT reading anything; the reader is asked for the JWT subject only', async () => {
  let reads = 0;
  const seen: string[] = [];
  const read = (p: Principal, s: Scope) => { reads += 1; seen.push(`${p.userId}|${s.brandId}`); return Promise.resolve(facts()); };
  for (const p of [null, caller(A, S1, 'anon'), caller(A, S1, 'service_role'), caller('not-a-uuid'), caller(A, 'not-a-session')]) {
    assert.equal((await authorize(scope(), p, read, NOW)).reason, 'AUTH_REQUIRED');
  }
  for (const s of [scope('x_publish', BRAND, 'miseiro'), scope('market_report', null, 'kabumori'), scope('delete_everything'), scope('x_publish', null), scope('x_publish', 'U_UPPER'),
    scope('x_publish', "u_x' or 1=1"), scope('__proto__'), scope('constructor')]) {
    const v = await authorize(s, caller(), read, NOW);
    assert.equal(v.decision, 'deny', JSON.stringify(s));
  }
  assert.equal(reads, 0, 'nothing was read for a refused caller or scope');
  // decide() is exported: it refuses the same callers on its own, even with facts that would allow
  for (const p of [null, caller(A, S1, 'anon'), caller(A, S1, 'service_role'), caller('not-a-uuid'), caller(A, 'not-a-session')]) {
    assert.equal(await why(facts(), scope(), p), 'deny:AUTH_REQUIRED', JSON.stringify(p));
  }
  assert.equal((await authorize(scope(), caller(), read, NOW)).decision, 'allow');
  assert.deepEqual(seen, [`${A}|${BRAND}`]);
  assert.equal((await authorize(scope(), caller(), () => Promise.reject(new Error('db down')), NOW)).reason, 'FACTS_UNAVAILABLE');
});

test('session revocation and expiry: a revoked (signed-out) or expired session is refused; an unreadable one is unknown', async () => {
  const revoked = await verdict(facts({ sessionLive: false }));
  assert.equal(`${revoked.decision}:${revoked.reason}:${revoked.session?.state}`, 'deny:SESSION_REVOKED:revoked');
  assert.equal(await why(facts({ sessionLive: null })), 'deny:SESSION_EXPIRED');
  assert.equal(await why(facts({ sessionLive: undefined })), 'unknown:SESSION_UNKNOWN');
});

test('anything unreadable is never allow: removing any one fact gives unknown or deny', async () => {
  const keys = ['userExists', 'sessionLive', 'account', 'entitlements', 'brand'] as const;
  for (const key of keys) {
    const f = { ...facts() } as Record<string, unknown>;
    delete f[key];
    const v = await verdict(f as unknown as AuthFacts);
    assert.notEqual(v.decision, 'allow', key);
  }
  for (const key of ['kind', 'callerRole', 'ownerUserId', 'ownerCount', 'ownerEpoch'] as const) {
    const b = { ...brand({}) } as Record<string, unknown>;
    delete b[key];
    assert.notEqual((await verdict(facts({ brand: b as AuthFacts['brand'] }))).decision, 'allow', `brand.${key}`);
  }
  assert.equal(await why(undefined), 'unknown:FACTS_UNAVAILABLE');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The irreversible action (an X / Threads post, a token exchange, a paid AI call): a fresh verdict right before it, same generation.
function transport() {
  const state = { sends: 0, rechecks: 0 };
  return { state, act: () => { state.sends += 1; return Promise.resolve('accepted (SIMULATED)'); } };
}
async function attempt(first: AuthFacts, atRecheck: AuthFacts | Error | (() => Promise<unknown>), s: Scope = scope(), p: Principal = caller(), recheckPrincipal: Principal = p) {
  const t = transport();
  const firstWire = await decide(s, p, first, NOW);
  const out = await guardIrreversible({
    scope: s,
    first: firstWire,
    prepare: () => Promise.resolve(),
    recheck: () => {
      t.state.rechecks += 1;
      if (atRecheck instanceof Error) return Promise.reject(atRecheck);
      if (typeof atRecheck === 'function') return atRecheck();
      return decide(s, recheckPrincipal, atRecheck, NOW + 500);
    },
    act: t.act,
    nowMs: () => NOW + 1_000,
  });
  return { out, ...t.state };
}

test('TOCTOU: nothing changed -> sent exactly once; owner A -> B -> A, an entitlement ended and re-activated, a deletion started and cancelled -> sent 0', async () => {
  const same = await attempt(facts(), facts());
  assert.deepEqual([same.out.sent, same.sends, same.rechecks], [true, 1, 1]);
  // A -> B -> A between the verdict and the send: the owner is A again, the F5 epoch moved by two
  const aba = await attempt(facts(), facts({ brand: brand({ ownerEpoch: 7 }) }));
  assert.deepEqual([aba.out, aba.sends], [{ sent: false, refused: 'AUTH_CHANGED_BEFORE_SEND' }, 0]);
  // x_autopost active -> ended -> active again: status is "active" again, lifecycle_version moved (I7)
  const entAba = await attempt(facts(), facts({ account: { status: 'active', lifecycleVersion: 5, deletionOpen: false } }));
  assert.deepEqual([entAba.out, entAba.sends], [{ sent: false, refused: 'AUTH_CHANGED_BEFORE_SEND' }, 0]);
  assert.notEqual(ownerEpochToken(5, 3), ownerEpochToken(5, 5));
  assert.notEqual(ownerEpochToken(5, 3), ownerEpochToken(7, 3));
});

test('TOCTOU: revocation, deletion, entitlement end, owner change and an unreachable G5 at the recheck all send 0', async () => {
  const cases: [string, AuthFacts | Error | (() => Promise<unknown>), string][] = [
    ['signed out', facts({ sessionLive: false }), 'RECHECK_SESSION_REVOKED'],
    ['session expired', facts({ sessionLive: null }), 'RECHECK_SESSION_EXPIRED'],
    ['account deletion began (退会)', facts({ account: { status: 'deleting', lifecycleVersion: 4, deletionOpen: true } }), 'RECHECK_ACCOUNT_DELETION_IN_PROGRESS'],
    ['service ended', facts({ entitlements: { x_autopost: { status: 'ended', deletionOpen: false } } }), 'RECHECK_SERVICE_NOT_ACTIVE'],
    ['service deletion began', facts({ entitlements: { x_autopost: { status: 'active', deletionOpen: true } } }), 'RECHECK_SERVICE_DELETION_IN_PROGRESS'],
    ['owner became B', facts({ brand: brand({ ownerUserId: B, callerRole: 'admin', ownerEpoch: 6 }) }), 'RECHECK_ROLE_NOT_ALLOWED'],
    ['a second owner', facts({ brand: brand({ ownerUserId: null, ownerCount: 2, ownerEpoch: null }) }), 'RECHECK_WORKSPACE_OWNER_UNKNOWN'],
    ['coverage broken', facts({ brand: brand({ ownerEpoch: null }) }), 'RECHECK_OWNER_EPOCH_UNAVAILABLE'],
    ['G5 unreachable', new Error('timeout'), 'AUTH_UNAVAILABLE_BEFORE_SEND'],
    ['a tampered recheck', () => Promise.resolve({ v: 1, decision: 'allow' }), 'RECHECK_WIRE_SHAPE'],
    ['a recheck for another brand', () => decide(scope('x_publish', OTHER), caller(), facts(), NOW), 'RECHECK_SCOPE_MISMATCH'],
  ];
  for (const [label, recheck, code] of cases) {
    const r = await attempt(facts(), recheck);
    assert.deepEqual([r.out, r.sends], [{ sent: false, refused: code }, 0], label);
  }
  // a new login of the same person (another session) is a different generation as well
  const relogin = await attempt(facts(), facts(), scope(), caller(A, S1), caller(A, S2));
  assert.deepEqual([relogin.out, relogin.sends], [{ sent: false, refused: 'AUTH_CHANGED_BEFORE_SEND' }, 0]);
  // a refused or expired first verdict never reaches prepare or the recheck
  const refused = await attempt(facts({ entitlements: {} }), facts());
  assert.deepEqual([refused.out, refused.sends, refused.rechecks], [{ sent: false, refused: 'SERVICE_NOT_REGISTERED' }, 0, 0]);
  const t = transport();
  const late = await guardIrreversible({ scope: scope(), first: await verdict(facts()), prepare: () => Promise.resolve(), recheck: () => verdict(facts()), act: t.act,
    nowMs: () => NOW + ALLOW_TTL_MS + 1 });
  assert.deepEqual([late, t.state.sends], [{ sent: false, refused: 'EXPIRED' }, 0]);
});

test('tampered wire objects are refused by the consumer check: shape, version, reason, scope, subject, session, owner epoch, entitlements, time', async () => {
  const good = await verdict(facts());
  const mutate = (fn: (w: Record<string, unknown>) => void) => { const w = structuredClone(good) as unknown as Record<string, unknown>; fn(w); return w; };
  const cases: [string, Record<string, unknown> | unknown, string][] = [
    ['not an object', 'allow', 'WIRE_SHAPE'],
    ['an extra key', mutate((w) => { w.admin = true; }), 'WIRE_SHAPE'],
    ['a missing key', mutate((w) => { delete w.session; }), 'WIRE_SHAPE'],
    ['version 2', mutate((w) => { w.v = 2; }), 'WIRE_SHAPE'],
    ['allow with a reason', mutate((w) => { w.reason = 'X'; }), 'WIRE_REASON'],
    ['deny', mutate((w) => { w.decision = 'deny'; w.reason = 'SERVICE_NOT_ACTIVE'; }), 'SERVICE_NOT_ACTIVE'],
    ['deny with free text', mutate((w) => { w.decision = 'deny'; w.reason = 'no <script>'; }), 'NOT_ALLOWED'],
    ['scope with an extra key', mutate((w) => { (w.scope as Record<string, unknown>).user_id = B; }), 'SCOPE_MISMATCH'],
    ['subject system', mutate((w) => { w.subject = { kind: 'system' }; }), 'SUBJECT_SHAPE'],
    ['subject not a uuid', mutate((w) => { w.subject = { kind: 'user', user_id: 'u_g501a' }; }), 'SUBJECT_SHAPE'],
    ['session revoked but allow', mutate((w) => { (w.session as Record<string, unknown>).state = 'revoked'; }), 'SESSION_SHAPE'],
    ['session null', mutate((w) => { w.session = null; }), 'SESSION_SHAPE'],
    ['owner epoch missing', mutate((w) => { w.owner_epoch = null; }), 'OWNER_EPOCH_SHAPE'],
    ['owner epoch the stand-in 0', mutate((w) => { w.owner_epoch = 'g5oe:0:3'; }), 'OWNER_EPOCH_SHAPE'],
    ['owner epoch free form', mutate((w) => { w.owner_epoch = '5'; }), 'OWNER_EPOCH_SHAPE'],
    ['entitlement duplicated', mutate((w) => { w.entitlements = ['postona:x_autopost', 'postona:x_autopost']; }), 'WIRE_ENTITLEMENTS'],
    ['entitlement shape', mutate((w) => { w.entitlements = ['POSTONA'] }), 'WIRE_ENTITLEMENTS'],
    ['too many entitlements', mutate((w) => { w.entitlements = Array.from({ length: 33 }, (_, i) => `postona:s${i}`); }), 'WIRE_ENTITLEMENTS'],
    ['time not an integer', mutate((w) => { w.expires_at_ms = '9'; }), 'WIRE_TIME'],
    ['issued in the future', mutate((w) => { w.issued_at_ms = NOW + 31_000; w.expires_at_ms = NOW + 40_000; }), 'ISSUED_IN_FUTURE'],
    ['expired', mutate((w) => { w.expires_at_ms = NOW; }), 'EXPIRED'],
    ['lifetime too long', mutate((w) => { w.expires_at_ms = NOW + ALLOW_TTL_MS + 1; }), 'TTL_TOO_LONG'],
  ];
  for (const [label, wire, code] of cases) assert.deepEqual(acceptAllow(wire, scope(), NOW), { refused: code }, label);
  // the generation binds the person, the session, the owner token and the entitlements
  const gen = (w: unknown) => { const r = acceptAllow(w, scope(), NOW); return 'generation' in r ? r.generation : r.refused; };
  const base = gen(good);
  for (const [label, w] of [
    ['other session', mutate((x) => { (x.session as Record<string, unknown>).ref = 's:other'; })],
    ['other owner token', mutate((x) => { x.owner_epoch = 'g5oe:6:3'; })],
    ['fewer entitlements', mutate((x) => { x.entitlements = []; })],
    ['other person', mutate((x) => { x.subject = { kind: 'user', user_id: B }; })],
  ] as const) assert.notEqual(gen(w), base, label);
});

test('G6 compatibility (PR #336 proposal): every verdict this reference emits keeps G6\'s exact keys, token / entitlement shapes and the 5-minute ceiling', async () => {
  const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;
  const states: AuthFacts[] = [facts(), facts({ entitlements: {} }), facts({ sessionLive: false }), facts({ brand: brand({ ownerEpoch: null }) }),
    facts({ account: null }), facts({ entitlements: { x_autopost: { status: 'provisioning', deletionOpen: false } } })];
  for (const f of states) {
    const v: VerdictWire = await verdict(f);
    assert.equal(Object.keys(v).sort().join(','), WIRE_KEYS);
    assert.ok(v.reason === null || TOKEN.test(v.reason), String(v.reason));
    assert.ok(['allow', 'deny', 'unknown', 'pending'].includes(v.decision));
    if (v.owner_epoch !== null) assert.ok(TOKEN.test(v.owner_epoch));
    if (v.session) assert.ok(TOKEN.test(v.session.ref));
    assert.ok(v.expires_at_ms - v.issued_at_ms <= 300_000);
    assert.equal(v.decision === 'allow', v.reason === null);
  }
});

test('no network: the model made no request', () => {
  assert.throws(() => globalThis.fetch('https://example.invalid/'), /no network request/u);
});
