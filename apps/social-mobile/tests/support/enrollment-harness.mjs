// Shared support for the ServiceEnrollmentGate tests (F5): synthetic tokens, a fake PostgREST endpoint and the REAL gate
// transpiled and driven through a hook runtime with dependency-tracked effects and cleanups. No network, no renderer.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

import * as enrollmentModule from '../../src/domain/service-enrollment.ts';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFile(join(root, path), 'utf8');

// Synthetic unsigned access tokens with only the claims the client reads (sub, session_id): a person's
// login N, and the same login's token after a refresh. Built at run time; not credentials.
export const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
export const loginUuid = (user, login) => `00000000-0000-4000-8000-${String(user.charCodeAt(0)).padStart(6, '0')}${String(login).padStart(6, '0')}`;
export const tokenOf = (user, login = 1, refresh = 0) => `${b64url({ alg: 'none' })}.${b64url({ sub: `user-${user}`, session_id: loginUuid(user, login), iat: refresh })}.unsigned`;
export const sessionOf = (user, login = 1, refresh = 0) => ({ access_token: tokenOf(user, login, refresh), user: { id: `user-${user}` } });
export const contextOf = (user, login = 1, refresh = 0) => ({ userId: `user-${user}`, accessToken: tokenOf(user, login, refresh) });
export const flush = () => new Promise((r) => setImmediate(r));


// ---------------------------------------------------------------------------------------------
// A fake PostgREST endpoint: records every RPC with the token it carried; answers can be held.
export function fakeServer(answer) {
  const requests = [];
  const held = [];
  const fetchImpl = (url, init) => {
    const fn = String(url).split('/rpc/')[1];
    const token = init.headers.Authorization.replace(/^Bearer /u, '');
    const entry = { fn, token, body: JSON.parse(init.body), signal: init.signal };
    requests.push(entry);
    const reply = answer(entry);
    const respond = (value) => ({ ok: value.ok ?? true, status: value.status ?? 200, json: async () => value.body });
    if (reply === 'offline') return Promise.reject(new TypeError('Network request failed'));
    if (reply === 'hold') {
      return new Promise((resolve, reject) => {
        held.push({ entry, release: (value) => resolve(respond(value)) });
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    return Promise.resolve(respond(reply));
  };
  return { requests, held, fetchImpl };
}


// ---------------------------------------------------------------------------------------------
// The real gate, transpiled, with a hook runtime that tracks effect dependencies and cleanups.
function depsEqual(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}

export async function gateHarness(server, options = {}) {
  const slots = [];
  let cursor = 0;
  let pending = [];
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
      const slot = slots[i];
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; }];
    },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useMemo(factory, deps) {
      const i = cursor++;
      if (slots[i] && depsEqual(slots[i].deps, deps)) return slots[i].value;
      slots[i] = { deps, value: factory() };
      return slots[i].value;
    },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
    useEffect(effect, deps) {
      const i = cursor++;
      if (!slots[i] || !depsEqual(slots[i].deps, deps)) {
        const previous = slots[i];
        slots[i] = { deps, cleanup: previous?.cleanup };
        pending.push({ i, effect });
      }
    },
  };
  let session = null;
  const modules = {
    react,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' },
    'react-native': { ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View' },
    '@/constants/theme': { colors: {}, typography: {} },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', Pill: 'Pill', Screen: 'Screen', SectionTitle: 'SectionTitle', styles: {} },
    '@/components/sign-out-button': { SignOutButton: 'SignOutButton' },
    '@/data/repository-selection': { selectDataSource: () => ({ kind: options.dataSource ?? 'supabase' }) },
    '@/domain/service-enrollment': enrollmentModule,
    '@/lib/supabase': { getSupabaseConfig: () => ({ ok: true, config: { url: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture' } }) },
    '@/providers/auth-provider': { useAuth: () => ({ session }) },
    '@/app/account-deletion': { __esModule: true, default: 'AccountDeletionScreen' },
    // The gate's one view of F4's service-lifecycle signal. Without a lifecycle mock every person is at epoch 0.
    '@/features/service-enrollment/lifecycle-epoch': options.lifecycleModule ?? { useLifecycleEpoch: (userId) => (options.lifecycle && userId ? options.lifecycle.epochOf(userId) : 0) },
  };
  const source = await read('src/features/service-enrollment/service-enrollment-gate.tsx');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, require: (name) => { assert.ok(Object.hasOwn(modules, name), `unexpected import ${name}`); return modules[name]; } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = server.fetchImpl;
  const CHILDREN = { type: 'APP' };
  let tree = null;
  function render() {
    cursor = 0;
    pending = [];
    tree = module.exports.ServiceEnrollmentGate({ children: CHILDREN });
    for (const { i, effect } of pending) {
      slots[i].cleanup?.();
      const cleanup = effect();
      slots[i].cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    }
    return tree;
  }
  async function settle() {
    for (let round = 0; round < 5; round += 1) {
      await new Promise((r) => setImmediate(r));
      render();
    }
    return tree;
  }
  function textOf(node) {
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(textOf).join('');
    return node && typeof node === 'object' ? textOf(node.props?.children) : '';
  }
  function find(node, predicate) {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) { for (const child of node) { const hit = find(child, predicate); if (hit) return hit; } return null; }
    if (predicate(node)) return node;
    return find(node.props?.children, predicate);
  }
  return {
    CHILDREN,
    setSession(next) { session = next; },
    render, settle,
    isApp: () => tree === CHILDREN || find(tree, (n) => n === CHILDREN) !== null || tree?.props?.children === CHILDREN,
    button: (label) => find(tree, (n) => n.type === 'ActionButton' && n.props.label === label),
    /** a Pressable whose text contains `label` (the link that opens the embedded end screen) */
    link: (label) => find(tree, (n) => n.type === 'Pressable' && textOf(n).includes(label)),
    /** whether any element of this type is in the tree */
    has: (type) => find(tree, (n) => n.type === type) !== null,
    hasSignOut: () => find(tree, (n) => n.type === 'SignOutButton') !== null,
    unmount() { for (const slot of slots) if (slot && typeof slot.cleanup === 'function') slot.cleanup(); },
    /** After unmount(): the next render mounts a fresh gate (the module's shared gate survives, as in the app). */
    clear() { slots.length = 0; tree = null; },
    restore() { globalThis.fetch = originalFetch; },
  };
}
