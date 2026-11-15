// F4 (postona-f4-mobile-auth-entitlement-x-threads-integration-readiness-20261016): the real DataProvider, transpiled
// and driven through a hook runtime with dependency-tracked effects and cleanups.
// - A token refresh (the same person, a new session object -- Supabase answers every TOKEN_REFRESHED with a new
//   one) must not re-read or blank the screens: with status 'loading' the accounts list is empty, so an open
//   account screen showed "アカウントが見つかりません" and dropped the confirmations it held.
// - Another person or a sign-out: nothing of the previous person is exposed, not even for one render, and a late
//   answer read for the previous person never arrives.
// The person-keyed cases FAIL on the provider before this change. Synthetic sessions and repository only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const flush = () => new Promise((r) => setImmediate(r));
const sessionOf = (user, refresh = 0) => ({ access_token: `synthetic-${user}-${refresh}`, user: { id: `user-${user}` } });
const snapshotOf = (user) => ({ workspace: { id: `brand-${user}` }, accounts: [{ id: `account-${user}` }], plannedPosts: [], history: [] });
const source = await readFile(new URL('../src/providers/data-provider.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;

/** The real provider with a synthetic auth session and repository. Every read is held until `answer(i)`. */
function mount({ mode = 'supabase', session = sessionOf('a') } = {}) {
  const world = { session, reads: [] };
  const slots = []; let cursor = 0; const queued = [];
  const changed = (prev, deps) => !prev || deps.length !== prev.length || deps.some((value, i) => !Object.is(value, prev[i]));
  const react = {
    createContext: () => ({ Provider: 'DataContext.Provider' }),
    useContext: () => { throw new Error('not used by the provider'); },
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], (next) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }];
    },
    useCallback(callback, deps) { const i = cursor++; if (changed(slots[i]?.deps, deps)) slots[i] = { deps, value: callback }; return slots[i].value; },
    useMemo(factory, deps) { const i = cursor++; if (changed(slots[i]?.deps, deps)) slots[i] = { deps, value: factory() }; return slots[i].value; },
    useEffect(effect, deps) {
      const i = cursor++; const prev = slots[i];
      if (changed(prev?.deps, deps)) {
        slots[i] = { deps, cleanup: prev?.cleanup };
        queued.push(() => { slots[i].cleanup?.(); slots[i].cleanup = effect() ?? undefined; });
      }
    },
  };
  const repository = { readSnapshot: () => new Promise((resolve) => { world.reads.push({ user: world.session?.user.id ?? null, resolve }); }) };
  const modules = {
    react,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    '@/data/repository-selection': {
      initialDataStatus: () => (mode === 'mock' ? 'mock_preview' : 'loading'),
      selectDataSource: () => (mode === 'mock' ? { kind: 'mock', repository: null } : { kind: 'supabase', repository }),
    },
    '@/providers/auth-provider': { useAuth: () => ({ session: world.session }) },
  };
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, Promise, require: (name) => { assert.ok(Object.hasOwn(modules, name), name); return modules[name]; } });
  /** One render: returns the context value exactly as the screens would see it in that render. */
  const render = () => {
    cursor = 0;
    const tree = module.exports.DataProvider({ children: null });
    queued.splice(0).forEach((run) => run());
    return tree.props.value;
  };
  const settle = async () => { await flush(); await flush(); return render(); };
  const answer = async (i, user) => { world.reads[i].resolve({ state: 'ready', data: snapshotOf(user) }); return settle(); };
  return { world, render, settle, answer };
}

async function readyFor(user = 'a') {
  const h = mount({ session: sessionOf(user) });
  h.render(); await h.settle();
  const value = await h.answer(0, user);
  assert.equal(value.status, 'ready'); assert.equal(value.snapshot.workspace.id, `brand-${user}`);
  return h;
}

test('a token refresh (same person, new session object) neither re-reads nor blanks the screens', async () => {
  const h = await readyFor('a');
  for (const refresh of [1, 2, 3]) {
    h.world.session = sessionOf('a', refresh);   // what onAuthStateChange(TOKEN_REFRESHED) sets
    const now = h.render();
    assert.equal(now.status, 'ready', `refresh ${refresh}: the render right after the refresh`);
    assert.equal(now.snapshot.accounts[0].id, 'account-a');
    const later = await h.settle();
    assert.equal(later.status, 'ready'); assert.equal(later.snapshot.accounts[0].id, 'account-a');
  }
  assert.equal(h.world.reads.length, 1, 'only the first read');
});

test('another person signs in: not one render shows the previous person\'s snapshot', async () => {
  const h = await readyFor('a');
  h.world.session = sessionOf('b');
  const now = h.render();
  assert.equal(now.snapshot, null, 'nothing of A in the first render for B'); assert.notEqual(now.status, 'ready');
  const loading = await h.settle();
  assert.equal(loading.status, 'loading'); assert.equal(loading.snapshot, null);
  assert.equal(h.world.reads.length, 2); assert.equal(h.world.reads[1].user, 'user-b');
  const ready = await h.answer(1, 'b');
  assert.equal(ready.status, 'ready'); assert.equal(ready.snapshot.workspace.id, 'brand-b');
});

test('sign-out: the previous person\'s snapshot is gone at once and stays gone', async () => {
  const h = await readyFor('a');
  h.world.session = null;
  const now = h.render();
  assert.equal(now.snapshot, null); assert.notEqual(now.status, 'ready');
  const after = await h.settle();
  assert.equal(after.status, 'blocked'); assert.equal(after.snapshot, null);
  assert.equal(h.world.reads.length, 1, 'nothing is read without a person');
});

test('a read for the previous person that answers late never shows', async () => {
  const h = mount({ session: sessionOf('a') });
  h.render(); await h.settle();
  h.world.session = sessionOf('b');
  h.render(); await h.settle();
  const late = await h.answer(0, 'a');   // A's read was cancelled by the switch
  assert.equal(late.snapshot, null); assert.equal(late.status, 'loading');
  const b = await h.answer(1, 'b');
  assert.equal(b.snapshot.workspace.id, 'brand-b');
});

test('a late answer for the previous person never replaces what the current person already has', async () => {
  const h = mount({ session: sessionOf('a') });
  h.render(); await h.settle();
  h.world.session = sessionOf('b');
  h.render(); await h.settle();
  assert.equal((await h.answer(1, 'b')).snapshot.workspace.id, 'brand-b');
  const after = await h.answer(0, 'a');   // A's read, cancelled by the switch, answers last
  assert.equal(after.status, 'ready'); assert.equal(after.snapshot.workspace.id, 'brand-b');
});

test('reload() still re-reads for the same person and keeps that person\'s snapshot while loading', async () => {
  const h = await readyFor('a');
  h.render().reload();
  h.render();   // the render that sees the new generation runs the effect
  const loading = await h.settle();
  assert.equal(loading.status, 'loading'); assert.equal(loading.snapshot.workspace.id, 'brand-a');
  assert.equal(h.world.reads.length, 2);
  const again = await h.answer(1, 'a');
  assert.equal(again.status, 'ready');
});

test('the same person on a new login keeps the data; the enrollment gate (not this provider) remounts the tree on a login change', async () => {
  const h = await readyFor('a');
  h.world.session = { ...sessionOf('a', 9), access_token: 'synthetic-a-another-login' };
  assert.equal(h.render().status, 'ready');
  const later = await h.settle();
  assert.equal(later.status, 'ready'); assert.equal(h.world.reads.length, 1);
  const layout = await readFile(new URL('../src/app/_layout.tsx', import.meta.url), 'utf8');
  assert.match(layout, /<ServiceEnrollmentGate><DataProvider>/u, 'the gate still wraps the provider');
});

test('the local mock preview is unaffected by refreshes and person changes', async () => {
  const h = mount({ mode: 'mock' });
  assert.equal(h.render().status, 'mock_preview');
  assert.equal((await h.settle()).status, 'mock_preview');
  h.world.session = sessionOf('a', 1);
  assert.equal((await h.settle()).status, 'mock_preview');
  assert.equal(h.world.reads.length, 0);
});
