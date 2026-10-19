// G5-02: the proposed G5 read RPCs (R1 person verdict, W1 / W2 worker verdict) as a MODEL (supabase/candidates/common_account_postona_authz/
// rpc_preflight.ts), proven with fixed facts and counting mocks. It does not repeat G5-01's decision-matrix tests: it covers what the RPC adds --
// the subject from the claims, refusals before any read, anti-enumeration, the one-snapshot requirement, the Edge's stamp and error classes, the
// ACL postcondition over the role graph, the worker answer, and the three consumer flows (OAuth code exchange, a scheduled post, an AI charge).
// No database, no network (run without --allow-net; fetch is replaced by a thrower).
//
//   deno test --no-config --no-check supabase/tests/common_account_g5_02_rpc_preflight_test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { acceptAllow, type AuthFacts, guardIrreversible, type Principal, type Scope } from '../candidates/common_account_postona_authz/verdict.ts';
import {
  aclViolation, type ClaimSources, edgeStamp, POSTONA_POSTING_SERVICE_KEY, principalFromClaims, RPC_KEYS, type RoleEdge, rpcInputRefusal, rpcVerdict,
  workerBrandVerdict, type WorkerFacts,
} from '../candidates/common_account_postona_authz/rpc_preflight.ts';

globalThis.fetch = (() => { throw new Error('the G5-02 tests make no network request'); }) as typeof fetch;

const NOW = 1_792_400_000_000;
const A = '0a0a0a0a-0000-4000-8000-00000000000a';
const B = '0b0b0b0b-0000-4000-8000-00000000000b';
const S1 = '51515151-0000-4000-8000-000000000051';
const BRAND = 'u_g502a';
const json = (o: Record<string, unknown>) => JSON.stringify(o);
const claimsOf = (sub = A, over: Record<string, unknown> = {}, authUid: string | null = sub): ClaimSources =>
  ({ legacy: null, claimsJson: json({ sub, role: 'authenticated', session_id: S1, ...over }), authUid });
const params = (feature = 'x_publish', brand: unknown = BRAND, app: unknown = 'postona') => ({ p_app: app, p_feature: feature, p_brand_id: brand });

function factsFor(user: string, over: Partial<{ role: string | null; owner: string | null; epoch: number | null; lv: number; session: boolean | null; ent: string; acct: string }> = {}): AuthFacts {
  return {
    userExists: true,
    sessionLive: 'session' in over ? over.session as boolean | null : true,
    account: { status: over.acct ?? 'active', lifecycleVersion: over.lv ?? 3, deletionOpen: false },
    entitlements: { x_autopost: { status: over.ent ?? 'active', deletionOpen: false } },
    brand: { kind: 'social_mobile_user_v1', callerRole: 'role' in over ? over.role as string | null : 'owner', ownerUserId: 'owner' in over ? over.owner as string | null : user,
      ownerCount: 1, ownerEpoch: 'epoch' in over ? over.epoch as number | null : 5 },
  };
}
function counter(facts: (p: Principal, brand: string) => AuthFacts) {
  const state = { reads: 0, seen: [] as string[] };
  return { state, read: (p: Principal, brand: string) => { state.reads += 1; state.seen.push(`${p.userId}|${brand}`); return Promise.resolve(facts(p, brand)); } };
}

// =============================================================================================================================================
test('R1-3 the subject comes only from the JWT claims and auth.uid(): a body user id, an anonymous login, a non-authenticated role, a mismatch, a missing session are refused', async () => {
  assert.deepEqual(principalFromClaims(claimsOf()), { userId: A, role: 'authenticated', sessionId: S1 });
  // the per-claim settings of an older PostgREST win, as in F5 P3b
  assert.deepEqual(principalFromClaims({ legacy: { sub: A, role: 'authenticated', sessionId: S1 }, claimsJson: json({ sub: B, role: 'authenticated', session_id: S1 }), authUid: A }),
    { userId: A, role: 'authenticated', sessionId: S1 });
  const refused = [
    claimsOf(A, { is_anonymous: true }), claimsOf(A, { role: 'anon' }), claimsOf(A, { role: 'service_role' }), claimsOf(A, {}, B), claimsOf(A, {}, null),
    claimsOf(A, { session_id: undefined }), claimsOf(A, { session_id: 'abc' }), claimsOf('not-a-uuid'), { legacy: null, claimsJson: '{not json', authUid: A },
    { legacy: null, claimsJson: '[1]', authUid: A }, { legacy: null, claimsJson: null, authUid: A },
    { legacy: { sub: A, role: 'anon', sessionId: S1 }, claimsJson: null, authUid: A },
    { legacy: { sub: A, role: 'authenticated', sessionId: S1, isAnonymous: 'true' }, claimsJson: null, authUid: A },
  ];
  assert.deepEqual(principalFromClaims({ legacy: { sub: A, role: 'authenticated', sessionId: S1, isAnonymous: 'false' }, claimsJson: null, authUid: A }),
    { userId: A, role: 'authenticated', sessionId: S1 }, 'a per-claim is_anonymous of false is a person');
  for (const c of refused) assert.deepEqual(principalFromClaims(c as ClaimSources), { refused: 'AUTH_REQUIRED' }, JSON.stringify(c));
  // a p_user_id in the call is not a parameter: the answer's subject is the JWT's
  const c = counter((p) => factsFor(p.userId));
  const answer = await rpcVerdict({ ...params(), p_user_id: B } as never, claimsOf(A), c.read);
  assert.deepEqual(answer.subject, { kind: 'user', user_id: A });
  assert.deepEqual(c.state.seen, [`${A}|${BRAND}`]);
});

test('R1-4 refused before any read: another app, an unknown or inherited feature, a malformed / missing / injected brand id, a refused caller', async () => {
  const c = counter((p) => factsFor(p.userId));
  const bad = [params('x_publish', BRAND, 'kabumori'), params('x_publish', BRAND, 'miseiro'), params('delete_account'), params('__proto__'), params('toString'),
    params('x_publish', null), params('x_publish', ''), params('x_publish', 'U_UPPER'), params('x_publish', "u_x' or '1'='1"), params('x_publish', 'u_' + 'a'.repeat(64)),
    params('x_publish', 42)];
  for (const p of bad) {
    const a = await rpcVerdict(p, claimsOf(), c.read);
    assert.equal(a.decision, 'deny', JSON.stringify(p));
    assert.ok(rpcInputRefusal(p.p_app, p.p_feature, p.p_brand_id), JSON.stringify(p));
  }
  for (const claims of [claimsOf(A, { role: 'anon' }), claimsOf(A, { is_anonymous: true })]) assert.equal((await rpcVerdict(params(), claims, c.read)).reason, 'AUTH_REQUIRED');
  assert.equal(c.state.reads, 0, 'nothing was read');
  const ok = await rpcVerdict(params(), claimsOf(), c.read);
  assert.equal(Object.keys(ok).sort().join(','), RPC_KEYS, 'the RPC returns the wire without the times');
  assert.equal(ok.decision, 'allow');
});

test('R1-5 anti-enumeration: an unknown brand and another person\'s brand give byte-identical answers, and no answer carries another person\'s id or role', async () => {
  const unknown = counter(() => ({ ...factsFor(A), brand: null }));
  const foreign = counter(() => factsFor(A, { role: null, owner: B }));
  const x = await rpcVerdict(params('x_publish', 'u_nosuch'), claimsOf(), unknown.read);
  const y = await rpcVerdict(params('x_publish', 'u_nosuch'), claimsOf(), foreign.read);
  assert.equal(JSON.stringify(x), JSON.stringify(y));
  assert.equal(x.reason, 'BRAND_ACCESS_DENIED');
  for (const f of [factsFor(A, { role: 'admin', owner: B }), factsFor(A, { role: null, owner: B }), factsFor(A, { owner: B })]) {
    const a = await rpcVerdict(params(), claimsOf(), () => Promise.resolve(f));
    assert.ok(!JSON.stringify(a).includes(B), 'B\'s id never appears');
    assert.notEqual(a.decision, 'allow');
  }
});

test('R1-6 one snapshot is required: owner and epoch read at two moments across an owner change ALLOW the former owner; one snapshot refuses', async () => {
  // t1: A is the single owner (epoch 5). Between t1 and t2: A leaves, B becomes the owner (epoch 7). A asks.
  const atT1 = factsFor(A, { epoch: 5 });
  const atT2 = factsFor(A, { role: null, owner: B, epoch: 7 });
  const twoSnapshots: AuthFacts = { ...atT2, brand: { ...atT1.brand!, ownerEpoch: atT2.brand!.ownerEpoch } };   // role + owner from t1, epoch from t2
  const hazard = await rpcVerdict(params(), claimsOf(), () => Promise.resolve(twoSnapshots));
  assert.equal(hazard.decision, 'allow', 'the hazard is real: a two-read implementation would let the former owner act under the new owner\'s epoch');
  const one = await rpcVerdict(params(), claimsOf(), () => Promise.resolve(atT2));
  assert.equal(`${one.decision}:${one.reason}`, 'deny:BRAND_ACCESS_DENIED');
  // a reader failure is never allow
  assert.equal((await rpcVerdict(params(), claimsOf(), () => Promise.reject(new Error('42501')))).decision, 'unknown');
});

test('R1-8 the Edge stamps and classifies: 401/403 deny, 404 not deployed, other errors and wrong shapes unknown, only an exact 200 for the asked scope becomes a 60 s allow', async () => {
  const scope: Scope = { app: 'postona', feature: 'x_publish', brandId: BRAND };
  const body = await rpcVerdict(params(), claimsOf(), () => Promise.resolve(factsFor(A)));
  const ok = edgeStamp(scope, { status: 200, body }, NOW);
  assert.deepEqual([ok.decision, ok.expires_at_ms - ok.issued_at_ms], ['allow', 60_000]);
  assert.ok('generation' in acceptAllow(ok, scope, NOW + 1));
  const cases: [number, unknown, string][] = [
    [401, null, 'deny:AUTH_REQUIRED'], [403, { message: 'permission denied' }, 'deny:AUTH_REQUIRED'], [404, null, 'unknown:RPC_NOT_DEPLOYED'],
    [500, null, 'unknown:RPC_FAILED'], [503, null, 'unknown:RPC_FAILED'], [200, { ...body, admin: true }, 'unknown:RPC_SHAPE'], [200, [body], 'unknown:RPC_SHAPE'],
    [200, { ...body, v: 2 }, 'unknown:RPC_SHAPE'], [200, { ...body, scope: { ...body.scope, brand_slug: 'u_other' } }, 'unknown:SCOPE_MISMATCH'],
    [200, { ...body, issued_at_ms: NOW, expires_at_ms: NOW + 1e9 }, 'unknown:RPC_SHAPE'],
  ];
  for (const [status, b, expected] of cases) {
    const w = edgeStamp(scope, { status, body: b }, NOW);
    assert.equal(`${w.decision}:${w.reason}`, expected, `${status} ${JSON.stringify(b)?.slice(0, 40)}`);
    assert.equal(w.expires_at_ms, NOW, 'a refusal is born expired');
  }
  const deny = edgeStamp(scope, { status: 200, body: await rpcVerdict(params(), claimsOf(), () => Promise.resolve(factsFor(A, { ent: 'ended' }))) }, NOW);
  assert.deepEqual([deny.decision, deny.reason, deny.expires_at_ms], ['deny', 'SERVICE_NOT_ACTIVE', NOW]);
});

test('R1-1 / W2-1 the ACL postcondition over the role graph: R1 = authenticated only, W2 = service_role only, W1 = no API role; every MEMBER path counts', () => {
  const OWNER = 'postgres_owner';
  // the Supabase shape: authenticator is a member of the three API roles; the owner is a member of them too (never the other way round)
  const base: RoleEdge[] = [{ member: 'authenticator', role: 'anon' }, { member: 'authenticator', role: 'authenticated' }, { member: 'authenticator', role: 'service_role' },
    { member: OWNER, role: 'anon' }, { member: OWNER, role: 'authenticated' }, { member: OWNER, role: 'service_role' }];
  const r1 = (grants: string[], edges: RoleEdge[] = base, superusers: string[] = ['supabase_admin']) =>
    aclViolation({ owner: OWNER, grants, edges, superusers, allowed: ['authenticated'] });
  assert.equal(r1(['authenticated']), null);
  assert.equal(r1(['authenticated', 'public']), 'PUBLIC_EXECUTE');
  assert.equal(r1([]), 'AUTHENTICATED_CANNOT_EXECUTE');
  assert.equal(r1(['authenticated', 'service_role']), 'SERVICE_ROLE_CAN_EXECUTE');
  assert.equal(r1(['authenticated', 'anon']), 'ANON_CAN_EXECUTE');
  assert.equal(r1(['authenticated'], [...base, { member: 'anon', role: 'authenticated' }]), 'ANON_CAN_EXECUTE', 'anon a member of authenticated');
  assert.equal(r1(['authenticated', 'kb_mid'], [...base, { member: 'anon', role: 'kb_mid' }]), 'ANON_CAN_EXECUTE', 'through an intermediate (NOINHERIT / SET-only) role');
  assert.equal(r1(['authenticated'], [...base, { member: 'authenticated', role: OWNER }]), 'AUTHENTICATED_REACHES_OWNER');
  assert.equal(r1(['authenticated'], [...base, { member: 'service_role', role: 'kb_x' }, { member: 'kb_x', role: 'supabase_admin' }]), 'SERVICE_ROLE_REACHES_SUPERUSER');
  const w2 = (grants: string[]) => aclViolation({ owner: OWNER, grants, edges: base, superusers: [], allowed: ['service_role'] });
  assert.equal(w2(['service_role']), null);
  assert.equal(w2(['service_role', 'authenticated']), 'AUTHENTICATED_CAN_EXECUTE', 'a person can never call the worker form');
  const w1 = (grants: string[]) => aclViolation({ owner: OWNER, grants, edges: base, superusers: [], allowed: [] });
  assert.equal(w1([]), null);
  assert.equal(w1(['service_role']), 'SERVICE_ROLE_CAN_EXECUTE');
});

test('W-3 the worker answer: P5 state, owner epoch equal to the bound one, no re-activation since the bind; the Threads posting service key is x_autopost', () => {
  const facts = (over: Partial<WorkerFacts> = {}): WorkerFacts => ({ serviceState: 'active', ownerEpoch: 5, entitlementActivatedAtMs: NOW - 10_000, ...over });
  const bound = (over: Partial<{ serviceKey: string; expectedOwnerEpoch: number | null; boundAtMs: number | null }> = {}) =>
    ({ serviceKey: POSTONA_POSTING_SERVICE_KEY, expectedOwnerEpoch: 5, boundAtMs: NOW - 5_000, ...over });
  assert.equal(POSTONA_POSTING_SERVICE_KEY, 'x_autopost');
  assert.equal(workerBrandVerdict(facts(), bound()), 'active');
  for (const code of ['WORKSPACE_OWNER_UNKNOWN', 'ACCOUNT_DELETION_IN_PROGRESS', 'SERVICE_DELETION_IN_PROGRESS', 'SERVICE_NOT_ACTIVE', 'ACCOUNT_LOCKED', 'SERVICE_NOT_REGISTERED']) {
    assert.equal(workerBrandVerdict(facts({ serviceState: code }), bound()), code);
  }
  assert.equal(workerBrandVerdict(facts({ serviceState: 'ACTIVE' }), bound()), 'SERVICE_STATE_UNKNOWN');
  assert.equal(workerBrandVerdict(facts({ ownerEpoch: null }), bound()), 'OWNER_EPOCH_UNAVAILABLE');
  assert.equal(workerBrandVerdict(facts({ ownerEpoch: 7 }), bound()), 'OWNER_EPOCH_CHANGED', 'A -> B -> A after the bind');
  assert.equal(workerBrandVerdict(facts({ entitlementActivatedAtMs: NOW - 1_000 }), bound()), 'SERVICE_REACTIVATED_SINCE_BIND', 'ended and re-activated after the bind');
  assert.equal(workerBrandVerdict(facts({ entitlementActivatedAtMs: null }), bound()), 'SERVICE_STATE_UNKNOWN');
  assert.equal(workerBrandVerdict(facts(), bound({ expectedOwnerEpoch: 0 })), 'EXPECTED_OWNER_EPOCH_REQUIRED', 'the PR #282 stand-in 0 is not an epoch');
  assert.equal(workerBrandVerdict(facts(), bound({ expectedOwnerEpoch: null })), 'EXPECTED_OWNER_EPOCH_REQUIRED');
  assert.equal(workerBrandVerdict(facts(), bound({ boundAtMs: null })), 'BOUND_AT_REQUIRED');
  for (const key of ['threads', 'kabumori', 'postona:x_autopost', '']) assert.equal(workerBrandVerdict(facts(), bound({ serviceKey: key })), 'ACCOUNT_LIFECYCLE_SERVICE_INVALID', key);
  assert.equal(workerBrandVerdict(undefined, bound()), 'FACTS_UNAVAILABLE');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The consumer flows, each with a counting mock of the irreversible step.
type World = { facts: AuthFacts; down?: boolean };
/** The person's path: Edge -> R1 (the model) -> edgeStamp; `down` is a transport failure. */
function personPort(world: World, claims: () => ClaimSources) {
  return async (scope: Scope, nowMs: number) => {
    if (world.down) throw new Error('G5 unreachable');
    const body = await rpcVerdict({ p_app: scope.app, p_feature: scope.feature, p_brand_id: scope.brandId }, claims(), () => Promise.resolve(world.facts));
    return edgeStamp(scope, { status: 200, body }, nowMs);
  };
}

test('flow 1 (G4): the OAuth code is exchanged only after a fresh verdict at the callback; revocation, 退会, entitlement end, owner change, another person, G5 down, a stale verdict all exchange 0', async () => {
  const scope: Scope = { app: 'postona', feature: 'x_connect', brandId: BRAND };
  const run = async (between: (w: World, who: { claims: ClaimSources }) => void, callbackAtMs = NOW + 30_000) => {
    const world: World = { facts: factsFor(A) };
    const who = { claims: claimsOf(A) };
    const port = personPort(world, () => who.claims);
    const atBegin = await port(scope, NOW);              // POST begin: state stored, the user goes to the provider
    between(world, who);                                 // ... the provider round trip ...
    let exchanges = 0;
    const out = await guardIrreversible({ scope, first: atBegin, prepare: () => Promise.resolve(), recheck: () => port(scope, callbackAtMs),
      act: () => { exchanges += 1; return Promise.resolve('tokens (SIMULATED)'); }, nowMs: () => callbackAtMs });
    return { out, exchanges };
  };
  assert.deepEqual(await run(() => {}), { out: { sent: true, result: 'tokens (SIMULATED)' }, exchanges: 1 });
  const cases: [string, (w: World, who: { claims: ClaimSources }) => void, string, number?][] = [
    ['signed out during the round trip', (w) => { w.facts = factsFor(A, { session: false }); }, 'RECHECK_SESSION_REVOKED'],
    ['退会 began', (w) => { w.facts = factsFor(A, { acct: 'deleting' }); }, 'RECHECK_ACCOUNT_DELETION_IN_PROGRESS'],
    ['POSTONA ended', (w) => { w.facts = factsFor(A, { ent: 'ended' }); }, 'RECHECK_SERVICE_NOT_ACTIVE'],
    ['owner A -> B -> A', (w) => { w.facts = factsFor(A, { epoch: 7 }); }, 'AUTH_CHANGED_BEFORE_SEND'],
    ['entitlement ended and re-started', (w) => { w.facts = factsFor(A, { lv: 5 }); }, 'AUTH_CHANGED_BEFORE_SEND'],
    ['B completes A\'s callback', (w, who) => { who.claims = claimsOf(B); w.facts = factsFor(B, { role: null, owner: A }); }, 'RECHECK_BRAND_ACCESS_DENIED'],
    ['G5 down at the callback', (w) => { w.down = true; }, 'AUTH_UNAVAILABLE_BEFORE_SEND'],
    ['a second owner appeared', (w) => { w.facts = { ...factsFor(A), brand: { ...factsFor(A).brand!, ownerCount: 2, ownerUserId: null, ownerEpoch: null } }; }, 'RECHECK_WORKSPACE_OWNER_UNKNOWN'],
    ['the callback came 61 s later (stale begin verdict)', () => {}, 'EXPIRED', NOW + 61_000],
  ];
  for (const [label, between, code, at] of cases) assert.deepEqual(await run(between, at), { out: { sent: false, refused: code }, exchanges: 0 }, label);
});

test('flow 2 (G3): a scheduled post binds the owner epoch and time at reservation; the worker answer right before the provider sends 0 on any change', () => {
  const reservation = { serviceKey: POSTONA_POSTING_SERVICE_KEY, expectedOwnerEpoch: 5, boundAtMs: NOW };
  const dispatch = (now: WorkerFacts | undefined) => {
    let sends = 0;
    const verdict = workerBrandVerdict(now, reservation);
    if (verdict === 'active') sends += 1;
    return { verdict, sends };
  };
  assert.deepEqual(dispatch({ serviceState: 'active', ownerEpoch: 5, entitlementActivatedAtMs: NOW - 86_400_000 }), { verdict: 'active', sends: 1 });
  const changed: [string, WorkerFacts | undefined, string][] = [
    ['owner A -> B -> A after the reservation', { serviceState: 'active', ownerEpoch: 9, entitlementActivatedAtMs: NOW - 86_400_000 }, 'OWNER_EPOCH_CHANGED'],
    ['POSTONA ended and re-started after the reservation', { serviceState: 'active', ownerEpoch: 5, entitlementActivatedAtMs: NOW + 60_000 }, 'SERVICE_REACTIVATED_SINCE_BIND'],
    ['service-end freeze', { serviceState: 'SERVICE_DELETION_IN_PROGRESS', ownerEpoch: 5, entitlementActivatedAtMs: NOW - 1 }, 'SERVICE_DELETION_IN_PROGRESS'],
    ['退会', { serviceState: 'ACCOUNT_DELETION_IN_PROGRESS', ownerEpoch: 5, entitlementActivatedAtMs: NOW - 1 }, 'ACCOUNT_DELETION_IN_PROGRESS'],
    ['two owners', { serviceState: 'WORKSPACE_OWNER_UNKNOWN', ownerEpoch: null, entitlementActivatedAtMs: NOW - 1 }, 'WORKSPACE_OWNER_UNKNOWN'],
    ['epoch coverage broken', { serviceState: 'active', ownerEpoch: null, entitlementActivatedAtMs: NOW - 1 }, 'OWNER_EPOCH_UNAVAILABLE'],
    ['G5 down', undefined, 'FACTS_UNAVAILABLE'],
  ];
  for (const [label, now, code] of changed) assert.deepEqual(dispatch(now), { verdict: code, sends: 0 }, label);
});

test('flow 3 (G6): an AI charge needs an allow for exactly this feature and brand; a consult allow is not a post_generation allow, an old allow is not reused, a refused recheck charges 0', async () => {
  const world: World = { facts: factsFor(A) };
  const port = personPort(world, () => claimsOf(A));
  const consult: Scope = { app: 'postona', feature: 'consult', brandId: BRAND };
  const generation: Scope = { app: 'postona', feature: 'post_generation', brandId: BRAND };
  const consultAllow = await port(consult, NOW);
  let charges = 0;
  const charge = (scope: Scope, first: unknown, at = NOW + 1_000) => guardIrreversible({ scope, first, prepare: () => Promise.resolve(), recheck: () => port(scope, at),
    act: () => { charges += 1; return Promise.resolve('reply (SIMULATED)'); }, nowMs: () => at });
  assert.deepEqual(await charge(generation, consultAllow), { sent: false, refused: 'SCOPE_MISMATCH' });
  assert.deepEqual(await charge({ ...consult, brandId: 'u_other' }, consultAllow), { sent: false, refused: 'SCOPE_MISMATCH' });
  assert.deepEqual(await charge(consult, consultAllow, NOW + 120_000), { sent: false, refused: 'EXPIRED' });
  world.facts = factsFor(A, { ent: 'suspended' });
  assert.deepEqual(await charge(consult, consultAllow), { sent: false, refused: 'RECHECK_SERVICE_SUSPENDED' });
  assert.equal(charges, 0);
  world.facts = factsFor(A);
  assert.deepEqual(await charge(consult, consultAllow), { sent: true, result: 'reply (SIMULATED)' });
  assert.equal(charges, 1);
});

test('no network: the model made no request', () => {
  assert.throws(() => globalThis.fetch('https://example.invalid/'), /no network request/u);
});
