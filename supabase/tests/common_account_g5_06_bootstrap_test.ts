// G5-06: the brand-less BOOTSTRAP verdict for the first POSTONA X / Threads connection (supabase/candidates/common_account_postona_authz/
// bootstrap.ts), proven with fixed facts and counting mocks: the person checks, the own-workspace rule, that a bootstrap allow opens nothing else,
// and the whole first-connection flow -- bootstrap -> guarded workspace creation -> brand R1 at the callback -> recheck -> one code exchange.
// No database, no network (run without --allow-net; fetch is replaced by a thrower).
//
//   deno test --no-config --no-check supabase/tests/common_account_g5_06_bootstrap_test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { acceptAllow, type AuthFacts, decide, guardIrreversible, type Principal, type Scope, WIRE_KEYS } from '../candidates/common_account_postona_authz/verdict.ts';
import { bindingFromAllow } from '../candidates/common_account_postona_authz/rpc_preflight.ts';
import {
  BOOTSTRAP_FEATURES, type BootstrapFacts, beginCreateWorkspace, type BeginWorld, bootstrapVerdict, CONNECT_FEATURE_OF,
} from '../candidates/common_account_postona_authz/bootstrap.ts';

globalThis.fetch = (() => { throw new Error('the G5-06 tests make no network request'); }) as typeof fetch;

const NOW = 1_792_500_000_000;
const A = '0a0a0a0a-0000-4000-8000-00000000000a';
const B = '0b0b0b0b-0000-4000-8000-00000000000b';
const S1 = '51515151-0000-4000-8000-000000000051';
const S2 = '52525252-0000-4000-8000-000000000052';
const WS_A = 'u_aaaaaaaaaaaaaaaaaaaaaaaa';
const WS_B = 'u_bbbbbbbbbbbbbbbbbbbbbbbb';
const caller = (userId = A, sessionId = S1, role = 'authenticated'): Principal => ({ userId, sessionId, role });
const boot = (feature = 'x_connect_bootstrap', brandId: string | null = null, app = 'postona'): Scope => ({ app, feature, brandId });

function person(over: Partial<{ session: boolean | null; acct: string; deletionOpen: boolean; ent: string | null; entDeletion: boolean; lv: number; own: BootstrapFacts['ownWorkspace'] }> = {}): BootstrapFacts {
  return {
    userExists: true,
    sessionLive: 'session' in over ? over.session as boolean | null : true,
    account: { status: over.acct ?? 'active', lifecycleVersion: over.lv ?? 3, deletionOpen: over.deletionOpen ?? false },
    entitlements: over.ent === null ? {} : { x_autopost: { status: over.ent ?? 'active', deletionOpen: over.entDeletion ?? false } },
    ownWorkspace: 'own' in over ? over.own as BootstrapFacts['ownWorkspace'] : null,
  };
}
const why = async (f: BootstrapFacts | undefined, s: Scope = boot(), p: Principal | null = caller()) => {
  const v = await bootstrapVerdict(s, p, f, NOW);
  return `${v.decision}:${v.reason}`;
};

// =============================================================================================================================================
test('the bootstrap allow: the 8-key wire, its own feature, no brand, no owner epoch; for a person with no workspace yet or with exactly their own', async () => {
  for (const feature of BOOTSTRAP_FEATURES) {
    const v = await bootstrapVerdict(boot(feature), caller(), person(), NOW);
    assert.equal(Object.keys(v).sort().join(','), WIRE_KEYS);
    assert.deepEqual({ ...v, session: null }, {
      v: 1, decision: 'allow', reason: null, scope: { app: 'postona', feature, brand_slug: null }, subject: { kind: 'user', user_id: A }, session: null,
      owner_epoch: null, entitlements: ['postona:x_autopost'], issued_at_ms: NOW, expires_at_ms: NOW + 60_000,
    });
    assert.equal(v.session?.state, 'active');
  }
  const own = { kind: 'social_mobile_user_v1', callerRole: 'owner', ownerUserId: A, ownerCount: 1 };
  assert.equal(await why(person({ own })), 'allow:null', 'the workspace already exists and is exactly the caller\'s');
});

test('the person checks are R1\'s: anonymous, no / revoked / expired session, no common account, Kabumori only, every entitlement and account state', async () => {
  for (const p of [null, caller(A, S1, 'anon'), caller('not-a-uuid'), caller(A, 'nope')]) assert.equal(await why(person(), boot(), p), 'deny:AUTH_REQUIRED');
  assert.equal(await why(person({ session: false })), 'deny:SESSION_REVOKED');
  assert.equal(await why(person({ session: null })), 'deny:SESSION_EXPIRED');
  assert.equal(await why({ ...person(), account: null }), 'deny:ACCOUNT_NOT_FOUND');
  assert.equal(await why(person({ ent: null })), 'deny:SERVICE_NOT_REGISTERED');
  assert.equal(await why({ ...person(), entitlements: { kabumori: { status: 'active', deletionOpen: false } } }), 'deny:SERVICE_NOT_REGISTERED', 'Kabumori only');
  assert.equal(await why(person({ ent: 'ended' })), 'deny:SERVICE_NOT_ACTIVE');
  assert.equal(await why(person({ ent: 'suspended' })), 'deny:SERVICE_SUSPENDED');
  assert.equal(await why(person({ ent: 'provisioning' })), 'pending:SERVICE_PROVISIONING');
  assert.equal(await why(person({ entDeletion: true })), 'deny:SERVICE_DELETION_IN_PROGRESS', 'service-end freeze');
  assert.equal(await why(person({ acct: 'deleting' })), 'deny:ACCOUNT_DELETION_IN_PROGRESS');
  assert.equal(await why(person({ deletionOpen: true })), 'deny:ACCOUNT_DELETION_IN_PROGRESS', '退会 open');
  assert.equal(await why(person({ acct: 'locked' })), 'deny:ACCOUNT_LOCKED');
  assert.equal(await why(undefined), 'unknown:FACTS_UNAVAILABLE');
  const revoked = await bootstrapVerdict(boot(), caller(), person({ session: false }), NOW);
  assert.equal(revoked.session?.state, 'revoked', 'a session refusal carries the session state, as R1 does');
});

test('the own workspace: a workspace under the derived id that is not exactly the caller\'s is never joined -- another owner, the caller as admin, two owners, another kind', async () => {
  const ws = (over: Partial<{ kind: string; callerRole: string | null; ownerUserId: string | null; ownerCount: number }>) =>
    person({ own: { kind: 'social_mobile_user_v1', callerRole: 'owner', ownerUserId: A, ownerCount: 1, ...over } });
  assert.equal(await why(ws({ callerRole: null, ownerUserId: B })), 'deny:OWN_WORKSPACE_CONFLICT', 'pre-claimed by another person');
  assert.equal(await why(ws({ callerRole: 'admin', ownerUserId: B })), 'deny:OWN_WORKSPACE_CONFLICT', 'the caller is only an admin there');
  assert.equal(await why(ws({ callerRole: 'owner', ownerUserId: null, ownerCount: 2 })), 'unknown:WORKSPACE_OWNER_UNKNOWN', 'two owners');
  assert.equal(await why(ws({ kind: 'organization_v1' })), 'deny:OWN_WORKSPACE_CONFLICT');
  assert.equal(await why(ws({ callerRole: 'admin', ownerUserId: A })), 'deny:OWN_WORKSPACE_CONFLICT', 'a reader that contradicts itself is not trusted');
  assert.equal(await why(ws({ callerRole: 'owner', ownerUserId: B })), 'deny:OWN_WORKSPACE_CONFLICT', 'the caller is "owner" but the single owner is someone else');
  assert.equal(await why(person({ own: undefined as unknown as null })), 'unknown:OWN_WORKSPACE_UNREADABLE');
  const conflict = await bootstrapVerdict(boot(), caller(), ws({ callerRole: null, ownerUserId: B }), NOW);
  assert.ok(!JSON.stringify(conflict).includes(B), 'the other owner\'s id never appears');
});

test('the request names no brand and no person: a brand id is refused, a body user id does not exist, only the bootstrap features are answered', async () => {
  assert.equal(await why(person(), boot('x_connect_bootstrap', WS_B)), 'deny:BRAND_NOT_EXPECTED');
  for (const s of [boot('x_connect'), boot('x_publish'), boot('consult'), boot('read_workspace'), boot('x_connect_bootstrap', null, 'kabumori'), boot('__proto__'), boot('toString')]) {
    assert.equal(await why(person(), s), 'deny:FEATURE_NOT_ENABLED', JSON.stringify(s));
  }
  const v = await bootstrapVerdict({ ...boot(), user_id: B } as unknown as Scope, caller(A), person(), NOW);
  assert.deepEqual(v.subject, { kind: 'user', user_id: A });
});

test('a bootstrap allow opens NOTHING else: not R1\'s features (consumer check), not a worker binding (no epoch), not R1 itself; R1 refuses the bootstrap features', async () => {
  const allow = await bootstrapVerdict(boot(), caller(), person(), NOW);
  assert.equal(allow.decision, 'allow');
  for (const s of [{ app: 'postona', feature: 'x_connect', brandId: WS_A }, { app: 'postona', feature: 'x_publish', brandId: WS_A }, { app: 'postona', feature: 'consult', brandId: WS_A },
    { app: 'postona', feature: 'x_connect', brandId: null }, { app: 'postona', feature: 'threads_connect_bootstrap', brandId: null }]) {
    assert.deepEqual(acceptAllow(allow, s, NOW + 1), { refused: 'SCOPE_MISMATCH' }, JSON.stringify(s));
  }
  assert.ok('generation' in acceptAllow(allow, boot(), NOW + 1), 'it is a valid allow only for its own bootstrap scope');
  assert.equal(bindingFromAllow(allow), null, 'no owner epoch -> no reservation can be bound to it');
  for (const feature of BOOTSTRAP_FEATURES) {
    const r1 = await decide({ app: 'postona', feature, brandId: null }, caller(), { ...person(), brand: null } as AuthFacts, NOW);
    assert.equal(`${r1.decision}:${r1.reason}`, 'deny:FEATURE_NOT_ENABLED', 'R1 (unchanged) does not answer the bootstrap features');
  }
  // a G6-style plan rule: the AI features are opened by an entitlement and a FEATURE; a bootstrap feature is in no plan
  const plan = new Map([['postona:consult', ['postona:x_autopost']], ['postona:post_generation', ['postona:x_autopost']]]);
  for (const feature of BOOTSTRAP_FEATURES) assert.equal(plan.has(`postona:${feature}`), false);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The first-connection flow with counting mocks: bootstrap (Edge) -> begin (one guarded transaction) -> brand R1 at the callback -> recheck right
// before the code exchange -> exchange once.
const md5ish = (u: string) => `u_${u.replaceAll('-', '').slice(0, 24)}`;
type Person = { state: 'active' | 'deleting'; ent: 'active' | 'ended'; lv: number; sessions: Set<string> };
function newWorld() {
  const people = new Map<string, Person>([[A, { state: 'active', ent: 'active', lv: 3, sessions: new Set([S1, S2]) }], [B, { state: 'active', ent: 'active', lv: 5, sessions: new Set([S1]) }]]);
  const epochs = new Map<string, number>();
  const world: BeginWorld = {
    guard: (u) => {
      const p = people.get(u);
      if (!p) return 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND';
      if (p.state === 'deleting') return 'ACCOUNT_DELETION_IN_PROGRESS';
      if (p.ent !== 'active') return 'SERVICE_NOT_ACTIVE';
      return null;
    },
    workspaces: new Map(),
    derive: md5ish,
  };
  const bump = (ws: string) => epochs.set(ws, (epochs.get(ws) ?? 0) + 1);
  const bootFacts = (u: string, session: string): BootstrapFacts => {
    const p = people.get(u)!;
    const ws = world.workspaces.get(world.derive(u));
    const owners = ws ? [...ws.members].filter(([, r]) => r === 'owner').map(([x]) => x) : [];
    return {
      userExists: true, sessionLive: p.sessions.has(session),
      account: { status: p.state, lifecycleVersion: p.lv, deletionOpen: false },
      entitlements: { x_autopost: { status: p.ent, deletionOpen: false } },
      ownWorkspace: ws ? { kind: ws.kind, callerRole: ws.members.get(u) ?? null, ownerUserId: owners.length === 1 ? owners[0] : null, ownerCount: owners.length } : null,
    };
  };
  const brandFacts = (u: string, session: string, brand: string): AuthFacts => {
    const b = bootFacts(u, session);
    const ws = world.workspaces.get(brand);
    const owners = ws ? [...ws.members].filter(([, r]) => r === 'owner').map(([x]) => x) : [];
    return { ...b, brand: ws ? { kind: ws.kind, callerRole: ws.members.get(u) ?? null, ownerUserId: owners.length === 1 ? owners[0] : null, ownerCount: owners.length, ownerEpoch: epochs.get(brand) ?? null } : null };
  };
  return { people, world, epochs, bump, bootFacts, brandFacts };
}

/** begin (Edge + one SQL transaction) and callback (consume -> brand R1 -> prepare -> recheck -> exchange), the mutation between them injected. */
async function connect(w: ReturnType<typeof newWorld>, opts: {
  user?: string; session?: string; callbackUser?: string; callbackSession?: string;
  betweenBeginAndCallback?: () => void; betweenVerdictAndExchange?: () => void; callbackAt?: number; g5DownAtRecheck?: boolean;
} = {}) {
  const user = opts.user ?? A;
  const session = opts.session ?? S1;
  let exchanges = 0;
  const b = await bootstrapVerdict(boot(), caller(user, session), w.bootFacts(user, session), NOW);
  if (b.decision !== 'allow') return { stage: 'bootstrap', code: b.reason, exchanges };
  const created = beginCreateWorkspace(w.world, user);
  if ('refused' in created) return { stage: 'begin', code: created.refused, exchanges };
  if (!w.epochs.has(created.workspace)) w.bump(created.workspace);
  const state = { workspace: created.workspace, initiator: user, used: false, expiresAt: NOW + 600_000 };
  opts.betweenBeginAndCallback?.();
  const cbUser = opts.callbackUser ?? user;
  const cbSession = opts.callbackSession ?? session;
  const at = opts.callbackAt ?? NOW + 30_000;
  // consume: single-use, the initiator, not expired (G4 / F3 SQL)
  if (state.used || state.initiator !== cbUser || at > state.expiresAt) return { stage: 'consume', code: 'OAUTH_STATE_NOT_CONSUMABLE', exchanges };
  state.used = true;
  const scope: Scope = { app: 'postona', feature: CONNECT_FEATURE_OF.x_connect_bootstrap, brandId: state.workspace };
  const first = await decide(scope, caller(cbUser, cbSession), w.brandFacts(cbUser, cbSession, state.workspace), at);
  const out = await guardIrreversible({
    scope, first, prepare: () => { opts.betweenVerdictAndExchange?.(); return Promise.resolve(); },
    recheck: () => opts.g5DownAtRecheck ? Promise.reject(new Error('down')) : decide(scope, caller(cbUser, cbSession), w.brandFacts(cbUser, cbSession, state.workspace), at + 500),
    act: () => { exchanges += 1; return Promise.resolve('tokens (SIMULATED)'); }, nowMs: () => at + 600,
  });
  return out.sent ? { stage: 'exchanged', code: null, exchanges } : { stage: 'callback', code: out.refused, exchanges };
}

test('flow: a first connection creates exactly the caller\'s workspace and exchanges once; a reconnect reuses it; two devices racing get one workspace with one owner', async () => {
  const w = newWorld();
  assert.deepEqual(await connect(w), { stage: 'exchanged', code: null, exchanges: 1 });
  const ws = w.world.workspaces.get(md5ish(A))!;
  assert.deepEqual([...ws.members], [[A, 'owner']]);
  assert.deepEqual(await connect(w), { stage: 'exchanged', code: null, exchanges: 1 }, 'a reconnect: the workspace exists and is exactly the caller\'s');
  const race = newWorld();
  const [x, y] = await Promise.all([connect(race, { session: S1 }), connect(race, { session: S2 })]);
  assert.deepEqual([x.exchanges, y.exchanges], [1, 1]);
  assert.equal(race.world.workspaces.size, 1);
  assert.deepEqual([...race.world.workspaces.get(md5ish(A))!.members], [[A, 'owner']], 'idempotent: one workspace, one owner');
});

test('flow: refused before anything is created or exchanged -- 退会, service ended, signed out, a workspace pre-claimed by someone else (rolled back, nothing joined)', async () => {
  for (const [label, mutate, stage, code] of [
    ['退会 in progress', (w: ReturnType<typeof newWorld>) => { w.people.get(A)!.state = 'deleting'; }, 'bootstrap', 'ACCOUNT_DELETION_IN_PROGRESS'],
    ['POSTONA ended', (w: ReturnType<typeof newWorld>) => { w.people.get(A)!.ent = 'ended'; }, 'bootstrap', 'SERVICE_NOT_ACTIVE'],
    ['signed out', (w: ReturnType<typeof newWorld>) => { w.people.get(A)!.sessions.clear(); }, 'bootstrap', 'SESSION_REVOKED'],
  ] as const) {
    const w = newWorld();
    mutate(w);
    assert.deepEqual(await connect(w), { stage, code, exchanges: 0 }, label);
    assert.equal(w.world.workspaces.size, 0, `${label}: nothing created`);
  }
  // B owns the id the server derives for A (an operator mistake, a leftover): the bootstrap refuses, and so would begin on its own
  const w = newWorld();
  w.world.workspaces.set(md5ish(A), { kind: 'social_mobile_user_v1', members: new Map([[B, 'owner']]) });
  assert.deepEqual(await connect(w), { stage: 'bootstrap', code: 'OWN_WORKSPACE_CONFLICT', exchanges: 0 });
  assert.deepEqual(beginCreateWorkspace(w.world, A), { refused: 'OWN_WORKSPACE_CONFLICT' }, 'begin\'s own check, even without the bootstrap');
  assert.deepEqual([...w.world.workspaces.get(md5ish(A))!.members], [[B, 'owner']], 'rolled back: A never became a second owner');
  // A is only an admin there: begin must not proceed either
  const w2 = newWorld();
  w2.world.workspaces.set(md5ish(A), { kind: 'social_mobile_user_v1', members: new Map([[B, 'owner'], [A, 'admin']]) });
  assert.deepEqual(beginCreateWorkspace(w2.world, A), { refused: 'OWN_WORKSPACE_CONFLICT' });
  // the bootstrap passed, then 退会 started before the begin transaction: the in-transaction guard stops it
  const w3 = newWorld();
  const allow = await bootstrapVerdict(boot(), caller(), w3.bootFacts(A, S1), NOW);
  assert.equal(allow.decision, 'allow');
  w3.people.get(A)!.state = 'deleting';
  assert.deepEqual(beginCreateWorkspace(w3.world, A), { refused: 'ACCOUNT_DELETION_IN_PROGRESS' });
  assert.equal(w3.world.workspaces.size, 0);
});

test('flow: after begin, the code exchange is refused (0) by the callback\'s brand R1 or the recheck -- 退会, service ended, signed out, another person\'s callback, A -> B -> A, G5 down, an expired state', async () => {
  const cases: [string, Parameters<typeof connect>[1], string][] = [
    ['the callback by another person (B with A\'s state)', { callbackUser: B }, 'OAUTH_STATE_NOT_CONSUMABLE'],
    ['the state expired (11 minutes)', { callbackAt: NOW + 660_000 }, 'OAUTH_STATE_NOT_CONSUMABLE'],
    ['G5 unreachable at the recheck', { g5DownAtRecheck: true }, 'AUTH_UNAVAILABLE_BEFORE_SEND'],
  ];
  for (const [label, opts, code] of cases) {
    const r = await connect(newWorld(), opts);
    assert.deepEqual([r.code, r.exchanges], [code, 0], label);
  }
  const mid: [string, (w: ReturnType<typeof newWorld>) => void, string][] = [
    ['退会 starts during the round trip', (w) => { w.people.get(A)!.state = 'deleting'; }, 'RECHECK_ACCOUNT_DELETION_IN_PROGRESS'],
    ['POSTONA ended during the round trip', (w) => { w.people.get(A)!.ent = 'ended'; }, 'RECHECK_SERVICE_NOT_ACTIVE'],
    ['signed out during the round trip', (w) => { w.people.get(A)!.sessions.delete(S1); }, 'RECHECK_SESSION_REVOKED'],
    ['owner A -> B -> A between the verdict and the exchange', (w) => { w.bump(md5ish(A)); w.bump(md5ish(A)); }, 'AUTH_CHANGED_BEFORE_SEND'],
    ['entitlement ended and re-started (lifecycle moves)', (w) => { w.people.get(A)!.lv += 2; }, 'AUTH_CHANGED_BEFORE_SEND'],
  ];
  for (const [label, mutate, code] of mid) {
    const w = newWorld();
    const r = await connect(w, { betweenVerdictAndExchange: () => mutate(w) });
    assert.deepEqual([r.code, r.exchanges], [code, 0], label);
  }
  // the same changes BEFORE the callback's first verdict are refused by that verdict itself
  const w = newWorld();
  const r = await connect(w, { betweenBeginAndCallback: () => { w.people.get(A)!.state = 'deleting'; } });
  assert.deepEqual([r.stage, r.code, r.exchanges], ['callback', 'ACCOUNT_DELETION_IN_PROGRESS', 0]);
  const w4 = newWorld();
  const r4 = await connect(w4, { betweenBeginAndCallback: () => { w4.world.workspaces.get(md5ish(A))!.members.set(B, 'owner'); } });
  assert.deepEqual([r4.code, r4.exchanges], ['WORKSPACE_OWNER_UNKNOWN', 0], 'a second owner appeared before the callback');
});

test('no network: the model made no request', () => {
  assert.throws(() => globalThis.fetch('https://example.invalid/'), /no network request/u);
});
