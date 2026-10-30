// G1 TASK 29: the person's first run of the personal workspace (G5 W0, PR #590 2c8087fc, source-only) wired into the app.
// The REAL domain module (answer reading, the one bounded retry, the session-bound transport) and the REAL provider
// (transpiled, stubbed React) against a scripted stand-in of PostgREST (an injected fetch; nothing leaves the process).
// Proves: one W0 call per login after the service start, then one snapshot re-read; only "ready" that the snapshot then
// shows lets the AI assist be asked; OWN_WORKSPACE_CONFLICT is asked once more and only ready / created false counts;
// 401 and refused sessions ask for a new sign-in and a new token asks again; sign-out / another person / another
// login / unmount drop the request; a double tap of the retry asks once; nothing is guessed, written or retried in a loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as workspace from '../src/domain/personal-workspace.ts';
import * as enrollment from '../src/domain/service-enrollment.ts';

const NETWORK = ['fetch', 'XMLHttpRequest', 'WebSocket'];
const savedGlobals = new Map();
let trapped = 0;
test.before(() => {
  for (const name of NETWORK) {
    savedGlobals.set(name, globalThis[name]);
    globalThis[name] = function forbidden() { trapped += 1; throw new Error(`network entry point ${name} must not be used`); };
  }
});
test.after(() => {
  for (const name of NETWORK) {
    if (savedGlobals.get(name) === undefined) delete globalThis[name];
    else globalThis[name] = savedGlobals.get(name);
  }
  assert.equal(trapped, 0);
});

const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const SESSION = { A1: '11111111-1111-4111-8111-111111111111', A2: '22222222-2222-4222-8222-222222222222', B1: '33333333-3333-4333-8333-333333333333' };
const jwt = (user, session, n = 1) => `${b64({ alg: 'ES256' })}.${b64({ sub: user, session_id: session, n })}.sig${n}`;
const ID_A = 'u_0123456789abcdef01234567';
const ID_B = 'u_fedcba9876543210fedcba98';
const ready = (id, created) => ({ status: 200, body: { status: 'ready', workspace_id: id, created } });
const refused = (status) => ({ status: 200, body: { status } });

// ---------------------------------------------------------------------------------------------------------------
// The answer reading and the bounded retry (real module).

test('answers: only the exact canonical shapes; every 401 is a new sign-in; 404 PGRST202 / 42883 is "off"; anything else decides nothing', () => {
  const parse = (httpStatus, body) => workspace.parsePersonalWorkspaceAnswer({ httpStatus, body }).kind;
  assert.deepEqual(workspace.parsePersonalWorkspaceAnswer({ httpStatus: 200, body: { status: 'ready', workspace_id: ID_A, created: true } }), { kind: 'ready', workspaceId: ID_A, created: true });
  assert.deepEqual(workspace.parsePersonalWorkspaceAnswer({ httpStatus: 200, body: { status: 'ready', workspace_id: ID_A, created: false } }), { kind: 'ready', workspaceId: ID_A, created: false });
  for (const status of ['AUTH_REQUIRED', 'SESSION_REVOKED', 'SESSION_EXPIRED', 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED']) assert.equal(parse(200, { status }), 'relogin', status);
  for (const status of ['ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND', 'SERVICE_NOT_REGISTERED', 'SERVICE_NOT_ACTIVE']) assert.equal(parse(200, { status }), 'service_inactive', status);
  for (const status of ['ACCOUNT_LOCKED', 'ACCOUNT_DELETION_IN_PROGRESS', 'SERVICE_DELETION_IN_PROGRESS']) assert.equal(parse(200, { status }), 'not_available', status);
  for (const status of ['WORKSPACE_OWNER_UNKNOWN', 'OTHER_WORKSPACE_MEMBERSHIP']) assert.equal(parse(200, { status }), 'support', status);
  assert.equal(parse(200, { status: 'OWN_WORKSPACE_CONFLICT' }), 'conflict');
  assert.equal(parse(200, { status: 'ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE' }), 'unavailable');
  for (const body of [{ code: 'PGRST301', message: 'JWT expired' }, { code: 'UNAUTHORIZED_INVALID_JWT_FORMAT', message: 'x', msg: 'x' }, null, 'text', {}]) assert.equal(parse(401, body), 'relogin');
  assert.equal(parse(404, { code: 'PGRST202', message: 'Could not find the function' }), 'off');
  assert.equal(parse(404, { code: '42883' }), 'off');
  assert.equal(parse(404, null), 'unavailable');
  assert.equal(parse(404, { code: 'PGRST205' }), 'unavailable');
  assert.equal(parse(403, { code: '42501', message: 'permission denied for function postona_ensure_my_personal_workspace' }), 'unavailable');
  for (const httpStatus of [0, 400, 409, 500, 502, 503]) assert.equal(parse(httpStatus, { status: 'ready', workspace_id: ID_A, created: false }), 'unavailable', String(httpStatus));
  // not exactly the canonical shape: never ready, never a guess
  for (const body of [
    { status: 'ready', workspace_id: ID_A, created: false, extra: 1 },
    { status: 'ready', workspace_id: ID_A },
    { status: 'ready', workspace_id: ID_A, created: 'false' },
    { status: 'ready', workspace_id: 'u_1', created: false },
    { status: 'ready', workspace_id: 'brand-of-someone', created: false },
    { status: 'ready', workspace_id: ID_A.toUpperCase(), created: false },
    { status: 'AUTH_REQUIRED', workspace_id: ID_A },
    { status: 'OWN_WORKSPACE_CONFLICT', retry: true },
    { status: 'SOMETHING_NEW' },
    { status: 7 },
    [], null, 'ready',
  ]) assert.equal(parse(200, body), 'unavailable', JSON.stringify(body));
});

function scripted(answers) {
  const calls = [];
  const call = async (signal) => {
    calls.push(signal);
    const answer = answers.shift();
    assert.ok(answer, 'no unexpected call');
    return { httpStatus: answer.status, body: answer.body };
  };
  return { call, calls };
}

test('bounded retry: OWN_WORKSPACE_CONFLICT is asked exactly once more; only ready / created false counts; nothing else is retried', async () => {
  const signal = new AbortController().signal;
  const cases = [
    [[refused('OWN_WORKSPACE_CONFLICT'), ready(ID_A, false)], { kind: 'ready', workspaceId: ID_A, created: false }, 2],
    [[refused('OWN_WORKSPACE_CONFLICT'), refused('OWN_WORKSPACE_CONFLICT')], { kind: 'support' }, 2],
    [[refused('OWN_WORKSPACE_CONFLICT'), ready(ID_A, true)], { kind: 'support' }, 2],
    [[refused('OWN_WORKSPACE_CONFLICT'), refused('WORKSPACE_OWNER_UNKNOWN')], { kind: 'support' }, 2],
    [[refused('OWN_WORKSPACE_CONFLICT'), refused('OTHER_WORKSPACE_MEMBERSHIP')], { kind: 'support' }, 2],
    [[refused('OWN_WORKSPACE_CONFLICT'), refused('SESSION_REVOKED')], { kind: 'relogin' }, 2],
    [[refused('OWN_WORKSPACE_CONFLICT'), { status: 401, body: null }], { kind: 'relogin' }, 2],
    [[refused('OWN_WORKSPACE_CONFLICT'), { status: 0, body: null }], { kind: 'unavailable' }, 2],
    [[refused('OWN_WORKSPACE_CONFLICT'), refused('SERVICE_NOT_ACTIVE')], { kind: 'service_inactive' }, 2],
    [[ready(ID_A, true)], { kind: 'ready', workspaceId: ID_A, created: true }, 1],
    [[ready(ID_A, false)], { kind: 'ready', workspaceId: ID_A, created: false }, 1],
    [[{ status: 0, body: null }], { kind: 'unavailable' }, 1],
    [[refused('ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE')], { kind: 'unavailable' }, 1],
    [[refused('WORKSPACE_OWNER_UNKNOWN')], { kind: 'support' }, 1],
    [[{ status: 404, body: { code: 'PGRST202' } }], { kind: 'off' }, 1],
  ];
  for (const [answers, expected, count] of cases) {
    const s = scripted([...answers]);
    assert.deepEqual(await workspace.ensurePersonalWorkspace(s.call, signal), expected, JSON.stringify(answers));
    assert.equal(s.calls.length, count, JSON.stringify(answers));
  }
  const aborted = new AbortController(); aborted.abort();
  const none = scripted([]);
  await assert.rejects(workspace.ensurePersonalWorkspace(none.call, aborted.signal), enrollment.EnrollmentCancelledError);
  assert.equal(none.calls.length, 0, 'cancelled before anything was sent');
  const between = new AbortController();
  const once = { calls: 0, call: async () => { once.calls += 1; between.abort(); return { httpStatus: 200, body: { status: 'OWN_WORKSPACE_CONFLICT' } }; } };
  await assert.rejects(workspace.ensurePersonalWorkspace(once.call, between.signal), enrollment.EnrollmentCancelledError);
  assert.equal(once.calls, 1, 'a cancelled login is never asked again');
});

test('transport: POST /rest/v1/rpc/postona_ensure_my_personal_workspace, empty body, the one token it was made with; network / abort / non-JSON', async () => {
  const seen = [];
  const answers = [new Response(JSON.stringify({ status: 'ready', workspace_id: ID_A, created: true }), { status: 200 }), new Response('not json', { status: 502 })];
  const fetch = async (url, init) => { seen.push({ url, ...init }); const answer = answers.shift(); if (!answer) throw new TypeError('offline'); return answer; };
  const call = workspace.createPersonalWorkspaceCall({ url: 'https://local.test/', apiKey: 'pk-test', accessToken: 'token-A', fetch });
  assert.deepEqual(await call(new AbortController().signal), { httpStatus: 200, body: { status: 'ready', workspace_id: ID_A, created: true } });
  assert.deepEqual(await call(new AbortController().signal), { httpStatus: 502, body: null });
  assert.deepEqual(await call(new AbortController().signal), { httpStatus: 0, body: null });
  assert.equal(seen.length, 3);
  for (const request of seen) {
    assert.equal(request.url, 'https://local.test/rest/v1/rpc/postona_ensure_my_personal_workspace');
    assert.equal(request.method, 'POST');
    assert.equal(request.body, '{}', 'nobody can be named: no argument');
    assert.deepEqual(request.headers, { apikey: 'pk-test', Authorization: 'Bearer token-A', 'Content-Type': 'application/json', Accept: 'application/json' });
  }
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(call(aborted.signal), enrollment.EnrollmentCancelledError);
  assert.equal(seen.length, 3, 'an aborted request is never sent');
  const late = new AbortController();
  const lateCall = workspace.createPersonalWorkspaceCall({ url: 'https://local.test', apiKey: 'pk', accessToken: 't', fetch: async () => { late.abort(); return new Response('{}', { status: 200 }); } });
  await assert.rejects(lateCall(late.signal), enrollment.EnrollmentCancelledError, 'an answer that arrives after the cancel reaches nobody');
});

// ---------------------------------------------------------------------------------------------------------------
// The real provider (transpiled) with stubbed React, a fake auth session, a fake DataProvider and a scripted PostgREST.

async function mount({ source = 'supabase', config = true, token = jwt('user-A', SESSION.A1), userId = 'user-A', snapshotId = null, initialRead = 'done' } = {}) {
  const slots = []; let cursor = 0; const effects = []; const pendingEffects = []; const memos = [];
  const slot = (init) => { const i = cursor++; if (!(i in slots)) slots[i] = init(); return i; };
  const depsChanged = (previous, deps) => !previous || !deps || deps.length !== previous.length || deps.some((d, k) => !Object.is(d, previous[k]));
  const react = {
    createContext: (value) => ({ Provider: 'PersonalWorkspaceContextProvider', value }),
    useContext: () => { throw new Error('not used by the provider'); },
    useState: (initial) => { const i = slot(() => (typeof initial === 'function' ? initial() : initial)); return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef: (initial) => slots[slot(() => ({ current: initial }))],
    useMemo: (make, deps) => { const i = cursor++; if (depsChanged(memos[i]?.deps, deps)) memos[i] = { deps, value: make() }; return memos[i].value; },
    useCallback: (fn, deps) => { const i = cursor++; if (depsChanged(memos[i]?.deps, deps)) memos[i] = { deps, value: fn }; return memos[i].value; },
    useEffect: (effect, deps) => { const i = cursor++; if (depsChanged(effects[i]?.deps, deps)) pendingEffects.push({ i, effect, deps }); },
  };
  const world = { source, config, token, userId, reloads: 0, afterAnswer: null };
  // The DataProvider stand-in: a read per generation, finished by readDone() (the snapshot the server would show then).
  const data = { generation: 0, settled: initialRead === 'done' ? 0 : -1, snapshot: initialRead === 'done' ? { personalWorkspaceId: snapshotId } : null, server: snapshotId };
  const readDone = () => { data.settled = data.generation; data.snapshot = { personalWorkspaceId: data.server }; };
  // PostgREST stand-in: answers in order; `hold` keeps one pending until release().
  const requests = []; const queue = []; const held = [];
  const fetch = (url, init) => {
    requests.push({ url, token: init.headers.Authorization, body: init.body, signal: init.signal });
    const answer = queue.shift();
    assert.ok(answer, `unexpected W0 call #${requests.length}`);
    const respond = () => {
      if (init.signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
      if (answer.status === 0) return Promise.reject(new TypeError('offline'));
      return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status }));
    };
    if (!answer.hold) return respond();
    return new Promise((resolve, reject) => held.push(() => respond().then(resolve, reject)));
  };
  const stubs = {
    react,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    '@/data/repository-selection': { selectDataSource: () => ({ kind: world.source }) },
    // the real transport over the scripted fetch; `afterAnswer` runs once right after an answer has been read (a race window)
    '@/domain/personal-workspace': {
      ...workspace,
      createPersonalWorkspaceCall: (options) => {
        const call = workspace.createPersonalWorkspaceCall({ ...options, fetch });
        return async (signal) => { const answer = await call(signal); const hook = world.afterAnswer; world.afterAnswer = null; hook?.(); return answer; };
      },
    },
    '@/domain/service-enrollment': enrollment,
    '@/lib/supabase': { getSupabaseConfig: () => (world.config ? { ok: true, config: { url: 'https://local.test', publishableKey: 'pk-test' } } : { ok: false, reason: 'missing' }) },
    '@/providers/auth-provider': { useAuth: () => ({ session: world.token ? { access_token: world.token, user: { id: world.userId } } : null }) },
    '@/providers/data-provider': { useDataStatus: () => ({ snapshot: data.snapshot, generation: data.generation, settled: data.settled, reload: () => { world.reloads += 1; data.generation += 1; } }) },
  };
  const source_ = await readFile(new URL('../src/features/personal-workspace/personal-workspace-provider.tsx', import.meta.url), 'utf8');
  const js = ts.transpileModule(source_, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const loaded = { exports: {} };
  vm.runInNewContext(js, { module: loaded, exports: loaded.exports, Promise, AbortController, require: (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; } });
  let mounted = true;
  let tree;
  const renderOnce = () => {
    assert.ok(mounted);
    cursor = 0;
    tree = loaded.exports.PersonalWorkspaceProvider({ children: 'app' });
    while (pendingEffects.length) {
      const { i, effect, deps } = pendingEffects.shift();
      effects[i]?.cleanup?.();
      effects[i] = { deps: deps ?? [], cleanup: effect() };
    }
    // the view as plain data (objects made inside the vm have another Object prototype)
    return { view: JSON.parse(JSON.stringify(tree.props.value.view)), retry: tree.props.value.retry };
  };
  /** Renders and lets queued work run until nothing changes any more (as React re-renders after setState). */
  const run = async () => { for (let i = 0; i < 6; i += 1) { renderOnce(); await settle(); } return renderOnce(); };
  const unmount = () => { mounted = false; effects.forEach((e) => e?.cleanup?.()); };
  const release = async () => { held.shift()(); await settle(); };
  return { world, data, readDone, requests, queue, run, renderOnce, unmount, release, tree: () => tree };
}

test('new person: the service already started → one W0 with the person\'s token → created → one snapshot re-read → ready only once it shows the workspace', async () => {
  const h = await mount();
  h.queue.push(ready(ID_A, true));
  let value = h.renderOnce();
  assert.deepEqual(value.view, { kind: 'preparing' });
  assert.equal(h.tree().props.children, 'app', 'the app is never held back');
  value = await h.run();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].token, `Bearer ${jwt('user-A', SESSION.A1)}`);
  assert.equal(h.requests[0].body, '{}');
  assert.equal(h.world.reloads, 1, 'the snapshot is read again after W0 wrote the workspace');
  assert.deepEqual(value.view, { kind: 'preparing' }, 'not ready before the re-read shows it');
  h.data.server = ID_A; h.readDone();
  value = await h.run();
  assert.deepEqual(value.view, { kind: 'ready', workspaceId: ID_A });
  assert.equal(h.requests.length, 1); assert.equal(h.world.reloads, 1, 'no loop');
  // a token refresh of the same login and later re-renders ask nothing more; a reload for another reason does not flicker
  h.world.token = jwt('user-A', SESSION.A1, 2);
  h.data.generation += 1;
  value = await h.run();
  assert.deepEqual(value.view, { kind: 'ready', workspaceId: ID_A });
  assert.equal(h.requests.length, 1);
});

test('existing person: W0 answers ready / created false and the snapshot already shows it → no re-read; a read under way is waited for, not doubled', async () => {
  const h = await mount({ snapshotId: ID_A });
  h.queue.push(ready(ID_A, false));
  assert.deepEqual((await h.run()).view, { kind: 'ready', workspaceId: ID_A });
  assert.equal(h.world.reloads, 0);
  const w = await mount({ initialRead: 'pending' });
  w.data.server = ID_A;
  w.queue.push(ready(ID_A, false));
  assert.deepEqual((await w.run()).view, { kind: 'preparing' });
  assert.equal(w.world.reloads, 0, 'the first read (started before W0) is still under way');
  w.readDone();
  assert.deepEqual((await w.run()).view, { kind: 'ready', workspaceId: ID_A });
  assert.equal(w.world.reloads, 0);
});

test('W0 ready but the snapshot never shows it (column not readable, another personal workspace) → one re-read, then "unconfirmed"; never a guess, never a loop', async () => {
  for (const shown of [null, ID_B]) {
    const h = await mount({ snapshotId: shown });
    h.queue.push(ready(ID_A, false));
    await h.run();
    assert.equal(h.world.reloads, 1);
    h.readDone();
    const value = await h.run();
    assert.deepEqual(value.view, { kind: 'unconfirmed' });
    await h.run();
    assert.equal(h.world.reloads, 1); assert.equal(h.requests.length, 1);
    value.retry();
    await h.run();
    assert.equal(h.requests.length, 1, 'retry is only for an answer that decided nothing');
  }
});

test('conflict: an honest concurrent X begin → asked once more → ready / created false; a repeated conflict or another owner\'s brand stops as support', async () => {
  const h = await mount({ snapshotId: ID_A });
  h.queue.push(refused('OWN_WORKSPACE_CONFLICT'), ready(ID_A, false));
  assert.deepEqual((await h.run()).view, { kind: 'ready', workspaceId: ID_A });
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests.every((r) => r.token === h.requests[0].token && r.body === '{}'));
  for (const second of [refused('OWN_WORKSPACE_CONFLICT'), ready(ID_A, true), refused('WORKSPACE_OWNER_UNKNOWN')]) {
    const s = await mount({ snapshotId: ID_A });
    s.queue.push(refused('OWN_WORKSPACE_CONFLICT'), second);
    const value = await s.run();
    assert.deepEqual(value.view, { kind: 'support' }, JSON.stringify(second));
    value.retry();
    await s.run();
    assert.equal(s.requests.length, 2, 'bounded: no third call, no retry for support');
    assert.equal(s.world.reloads, 0);
  }
});

test('refusals map to their own state and are not retried: other membership, owner unknown, service ended / not started, locked, deleting, W0 not installed', async () => {
  const cases = [
    [refused('OTHER_WORKSPACE_MEMBERSHIP'), 'support'],
    [refused('WORKSPACE_OWNER_UNKNOWN'), 'support'],
    [refused('SERVICE_NOT_ACTIVE'), 'service_inactive'],
    [refused('SERVICE_NOT_REGISTERED'), 'service_inactive'],
    [refused('ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND'), 'service_inactive'],
    [refused('ACCOUNT_LOCKED'), 'not_available'],
    [refused('ACCOUNT_DELETION_IN_PROGRESS'), 'not_available'],
    [refused('SERVICE_DELETION_IN_PROGRESS'), 'not_available'],
    [{ status: 404, body: { code: 'PGRST202', message: 'Could not find the function public.postona_ensure_my_personal_workspace' } }, 'off'],
  ];
  for (const [answer, kind] of cases) {
    const h = await mount({ snapshotId: ID_A });
    h.queue.push(answer);
    const value = await h.run();
    assert.deepEqual(value.view, { kind }, JSON.stringify(answer));
    value.retry();
    h.world.token = jwt('user-A', SESSION.A1, 2); // a token refresh of the same login
    await h.run();
    assert.equal(h.requests.length, 1, `${kind}: asked once`);
    assert.equal(h.world.reloads, 0);
  }
});

test('service ended and started again: the gate re-mounts the app, so the provider asks W0 afresh for the restarted service', async () => {
  const before = await mount({ snapshotId: ID_A });
  before.queue.push(refused('SERVICE_NOT_ACTIVE'));
  assert.deepEqual((await before.run()).view, { kind: 'service_inactive' });
  before.unmount();
  const after = await mount({ snapshotId: ID_A });
  after.queue.push(ready(ID_A, false));
  assert.deepEqual((await after.run()).view, { kind: 'ready', workspaceId: ID_A });
  assert.equal(after.requests.length, 1);
});

test('401 / refused session: "sign in again" for that token; a new token of the same login asks once more; a late 401 for an old token never blocks the new one', async () => {
  for (const answer of [{ status: 401, body: { code: 'PGRST301', message: 'JWT expired' } }, refused('SESSION_EXPIRED'), refused('AUTH_REQUIRED')]) {
    const h = await mount({ snapshotId: ID_A });
    h.queue.push(answer);
    let value = await h.run();
    assert.deepEqual(value.view, { kind: 'relogin' });
    await h.run();
    assert.equal(h.requests.length, 1, 'the same token is not asked again');
    h.world.token = jwt('user-A', SESSION.A1, 2);
    h.queue.push({ ...ready(ID_A, false), hold: true });
    value = await h.run();
    assert.deepEqual(value.view, { kind: 'preparing' }, 'the new token is being checked: no "sign in again" for it');
    await h.release();
    value = await h.run();
    assert.deepEqual(value.view, { kind: 'ready', workspaceId: ID_A });
    assert.deepEqual(h.requests.map((r) => r.token), [`Bearer ${jwt('user-A', SESSION.A1)}`, `Bearer ${jwt('user-A', SESSION.A1, 2)}`]);
  }
  const late = await mount({ snapshotId: ID_A });
  late.queue.push({ status: 401, body: null, hold: true });
  await late.run();
  late.world.token = jwt('user-A', SESSION.A1, 2); // refreshed while the old token's request is out
  let value = await late.run();
  assert.equal(late.requests.length, 1, 'a refresh of the same login does not cancel or double the request');
  late.queue.push(ready(ID_A, false));
  await late.release();
  value = await late.run();
  assert.deepEqual(value.view, { kind: 'ready', workspaceId: ID_A }, 'the old token\'s 401 led to one call with the new token, not to a block');
  assert.equal(late.requests[1].token, `Bearer ${jwt('user-A', SESSION.A1, 2)}`);
});

test('sign-out, another person (A→B→A) or another login while W0 is out: the old request is cancelled and its answer reaches nobody', async () => {
  const h = await mount({ snapshotId: ID_A });
  h.queue.push({ ...ready(ID_A, false), hold: true });
  await h.run();
  h.world.token = null; h.world.userId = null; // sign-out
  assert.deepEqual((await h.run()).view, { kind: 'idle' });
  assert.equal(h.requests[0].signal.aborted, true);
  await h.release();
  assert.deepEqual((await h.run()).view, { kind: 'idle' });
  // B signs in on the same screen: B's own call with B's token; A's held answer is dropped
  h.world.userId = 'user-B'; h.world.token = jwt('user-B', SESSION.B1);
  h.data.server = ID_B; h.data.snapshot = { personalWorkspaceId: ID_B };
  h.queue.push(ready(ID_B, false));
  assert.deepEqual((await h.run()).view, { kind: 'ready', workspaceId: ID_B });
  assert.equal(h.requests[1].token, `Bearer ${jwt('user-B', SESSION.B1)}`);
  // A again: a new login (new session id) never inherits B's answer nor A's first one
  h.world.userId = 'user-A'; h.world.token = jwt('user-A', SESSION.A2);
  h.queue.push({ ...ready(ID_A, false), hold: true });
  let value = await h.run();
  assert.deepEqual(value.view, { kind: 'preparing' }, 'B\'s workspace is never shown for A');
  h.data.server = ID_A; h.data.snapshot = { personalWorkspaceId: ID_A };
  await h.release();
  value = await h.run();
  assert.deepEqual(value.view, { kind: 'ready', workspaceId: ID_A });
  assert.equal(h.requests.length, 3);
  // another login of the same person while a request is out cancels it
  h.queue.push({ ...ready(ID_A, false), hold: true }, ready(ID_A, false));
  h.world.token = jwt('user-A', SESSION.A1, 9);
  await h.run();
  assert.equal(h.requests.length, 4);
  h.world.token = jwt('user-A', '44444444-4444-4444-8444-444444444444', 10); // a third login
  await h.run();
  assert.equal(h.requests[3].signal.aborted, true);
  assert.equal(h.requests.length, 5);
  h.unmount();
});

test('unmount cancels the request; a token that names no login, a missing config or the mock preview sends nothing', async () => {
  const h = await mount();
  h.queue.push({ ...ready(ID_A, true), hold: true });
  await h.run();
  h.unmount();
  assert.equal(h.requests[0].signal.aborted, true);
  const mock = await mount({ source: 'mock' });
  assert.deepEqual((await mock.run()).view, { kind: 'idle' });
  const blocked = await mount({ source: 'blocked' });
  assert.deepEqual((await blocked.run()).view, { kind: 'idle' });
  const anonymousLike = await mount({ token: `${b64({ alg: 'ES256' })}.${b64({ sub: 'user-A' })}.sig` });
  assert.deepEqual((await anonymousLike.run()).view, { kind: 'idle' }, 'no session id: never sent');
  const otherSub = await mount({ token: jwt('user-Z', SESSION.A1) });
  assert.deepEqual((await otherSub.run()).view, { kind: 'idle' }, 'a token of another person: never sent');
  const noConfig = await mount({ config: false });
  assert.deepEqual((await noConfig.run()).view, { kind: 'unavailable' });
  for (const quiet of [mock, blocked, anonymousLike, otherSub, noConfig]) assert.equal(quiet.requests.length, 0);
});

test('an answer that decided nothing (network, stopped grant, fence unavailable) offers one retry; a double tap asks once', async () => {
  for (const first of [{ status: 0 }, { status: 403, body: { code: '42501' } }, refused('ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE'), { status: 500, body: {} }]) {
    const h = await mount({ snapshotId: ID_A });
    h.queue.push(first);
    let value = await h.run();
    assert.deepEqual(value.view, { kind: 'unavailable' });
    h.queue.push({ ...ready(ID_A, false), hold: true });
    value.retry(); value.retry(); // double tap before any re-render
    value = await h.run();
    h.renderOnce().retry(); // and once more while the retry is out
    await h.run();
    assert.equal(h.requests.length, 2, JSON.stringify(first));
    await h.release();
    assert.deepEqual((await h.run()).view, { kind: 'ready', workspaceId: ID_A });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Wiring and boundary (source).

const read = (path) => readFile(new URL(`../src/${path}`, import.meta.url), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, '');

test('wiring: auth → service enrollment (start) → data → W0 provider → onboarding → app; the provider never blocks the app', async () => {
  const layout = await read('app/_layout.tsx');
  const at = (tag) => layout.indexOf(tag);
  assert.ok(at('<ServiceEnrollmentGate>') < at('<DataProvider>') && at('<DataProvider>') < at('<PersonalWorkspaceProvider>') && at('<PersonalWorkspaceProvider>') < at('<OnboardingGate>'));
  assert.match(layout, /<\/OnboardingGate><\/PersonalWorkspaceProvider><\/DataProvider><\/ServiceEnrollmentGate>/u);
  const provider = code(await read('features/personal-workspace/personal-workspace-provider.tsx'));
  assert.match(provider, /return <PersonalWorkspaceContext\.Provider value=\{value\}>\{children\}<\/PersonalWorkspaceContext\.Provider>;/u);
  assert.equal((provider.match(/return /gu) ?? []).length > 0, true);
  assert.doesNotMatch(provider, /ActivityIndicator|Screen|<View/u, 'no screen of its own: the app is never held back');
});

test('boundary: W0 is the only call; no argument, no table, no member, no X, no post, no storage, the token never logged', async () => {
  const provider = code(await read('features/personal-workspace/personal-workspace-provider.tsx'));
  const domain = code(await read('domain/personal-workspace.ts'));
  for (const [name, text] of [['provider', provider], ['domain', domain]]) {
    assert.doesNotMatch(text, /\.from\(|\.rpc\(|\.insert\(|\.upsert\(|\.update\(|\.delete\(|functions\.invoke/u, `${name}: no direct table / other API`);
    assert.doesNotMatch(text, /brand_memberships|from\('brands'\)|social_accounts|x-oauth|oauth_state|publish_|publish-setting|manual-publish|scheduled_posts|start_x_autopost_service|reactivate_/iu, `${name}: no other write, no X, no post, no service start`);
    assert.doesNotMatch(text, /console\.|AsyncStorage|SecureStore|localStorage/u, `${name}: nothing logged or stored`);
    assert.doesNotMatch(text, /p_user|user_id|workspace_id:/u, `${name}: nobody can be named`);
  }
  assert.equal((domain.match(/rest\/v1\/rpc\//gu) ?? []).length, 1);
  assert.match(domain, /export const PERSONAL_WORKSPACE_RPC = 'postona_ensure_my_personal_workspace';/u);
  assert.match(domain, /body: '\{\}',/u);
  assert.equal((domain.match(/await call\(signal\)/gu) ?? []).length, 2, 'at most two calls: the first and the one bounded retry');
});

test('another person never sees the previous person\'s answer, and an answer read just before a switch never overwrites the new person\'s request', async () => {
  const h = await mount({ snapshotId: ID_A });
  h.queue.push(refused('OTHER_WORKSPACE_MEMBERSHIP'));
  assert.deepEqual((await h.run()).view, { kind: 'support' });
  h.world.userId = 'user-B'; h.world.token = jwt('user-B', SESSION.B1);
  h.queue.push({ ...ready(ID_B, false), hold: true });
  assert.deepEqual((await h.run()).view, { kind: 'preparing' }, 'A\'s support is not B\'s');
  h.data.server = ID_B; h.data.snapshot = { personalWorkspaceId: ID_B };
  await h.release();
  assert.deepEqual((await h.run()).view, { kind: 'ready', workspaceId: ID_B });
  // race: A's answer has been read; before it is applied, B signs in (B's request starts at once)
  const r = await mount({ snapshotId: ID_A });
  r.queue.push(ready(ID_A, false));
  r.world.afterAnswer = () => {
    r.world.userId = 'user-B'; r.world.token = jwt('user-B', SESSION.B1);
    r.queue.push({ ...ready(ID_B, false), hold: true });
    r.renderOnce();
  };
  await r.run();
  assert.equal(r.requests.length, 2);
  assert.equal(r.requests[0].signal.aborted, true);
  r.data.server = ID_B; r.data.snapshot = { personalWorkspaceId: ID_B };
  await r.release();
  assert.deepEqual((await r.run()).view, { kind: 'ready', workspaceId: ID_B });
  assert.equal(r.requests.length, 2, 'A\'s late answer neither replaced B\'s request nor caused another one');
});
