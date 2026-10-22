// G2 QA (Issue #317, task postona-g2-threads-disconnect-ui-ack-boundary-offline-20261022) -- QA only, no product code.
// G2-T2 (P3, owner G4): the Threads disconnect card says "解除しました" before an explicit confirmation. This file follows the
// TIME boundary on the latest G4 head (#381; the disconnect card / hook / runner / domain / accounts screen are byte-identical
// on #381, #393, #412, #418 -- no fix candidate): request sent, waiting for the server, answer lost, a person change WHILE
// waiting, the reload that follows. It uses the REAL card + hook + runner + runtime (transpiled) with the server answer HELD
// until the test releases it, over the same data-layer stand-in as G2 #393 (accounts = the snapshot's list only when 'ready',
// otherwise []). #342 / #393 / G4's own tests are not rebuilt. Offline: no Threads, no Supabase.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as domain from '../src/domain/threads-disconnect.ts';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFile(resolve(root, path), 'utf8');
const transpile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function evaluate(source, path, stubs) {
  const module = { exports: {} };
  const require = (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; };
  vm.runInNewContext(transpile(source), { module, exports: module.exports, require, Response }, { filename: path });
  return module.exports;
}
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r)); };
const walk = (node, visit) => { if (Array.isArray(node)) return node.forEach((c) => walk(c, visit)); if (node === null || typeof node !== 'object') return; visit(node); walk(node.props?.children, visit); };
const texts = (tree) => { const out = []; walk(tree, (n) => { if (n.type === 'Text') out.push([n.props.children].flat().filter((c) => typeof c === 'string' || typeof c === 'number').join('')); }); return out; };
const button = (tree, label) => { let found = null; walk(tree, (n) => { if (n.type === 'ActionButton' && n.props.label === label) found = n.props; }); return found; };

function hooks() {
  const slots = []; let cursor = 0; let effects = [];
  const react = {
    useLayoutEffect: (effect) => { effects.push(effect); },
    useState: (initial) => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef: (initial) => { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useCallback: (cb) => { cursor++; return cb; },
  };
  const jsx = (type, props) => ({ type: typeof type === 'function' ? type.name : type, props });
  const render = (fn) => { cursor = 0; effects = []; const tree = fn(); const run = effects; effects = []; run.forEach((e) => e()); return tree; };
  return { react, runtime: { jsx, jsxs: jsx, Fragment: 'Fragment' }, render };
}

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b2';
const account = (id, platform, handle) => ({ id, platform, profile: { displayName: id, handle, avatarColor: '#000', voice: { tone: '', language: '', avoid: [] } }, connectionStatus: 'connected', postingState: 'paused' });
const TH_A = account('sa_th_a', 'threads', '@g2_threads_a');
const TH_B = account('sa_th_b', 'threads', '@g2_threads_b');
const X_1 = account('sa_x_1', 'x', '@g2_x');
const SUCCESS = { ok: true, status: 'disconnected', code: 'LOCAL_REMOVED', publish_permission: 'withdrawn', local_credentials: 'removed', remote_access: 'not_revoked_by_app' };
const REMOVED_LINE = 'Threads連携を解除しました。POSTONAに保存していたThreadsの認証情報を削除し、投稿もできなくなりました。';
const CHECKING_LINE = '解除を確認しています…';


/** The accounts screen with the server answer HELD: `answer()` releases it (or throws for a lost answer). */
async function mountScreen({ list = [TH_A, X_1], provider = 'empty-while-loading' } = {}) {
  const h = hooks();
  const data = { status: 'ready', list, lastReady: list, reloads: 0 };
  const auth = { session: { access_token: 'rig-jwt-a1', user: { id: USER_A } } };
  const invokes = [];
  let release = null;
  const stubs = {
    react: h.react, 'react/jsx-runtime': h.runtime,
    'react-native': { Text: 'Text', View: 'View' },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', styles: { muted: {} } },
    '@/constants/theme': { colors: { ink: 'i' } },
    '@/domain/threads-disconnect': domain,
    '@/providers/auth-provider': { useAuth: () => ({ session: auth.session }) },
    '@/lib/supabase': { supabase: { functions: { invoke: (_name, options) => { invokes.push({ body: options.body, auth: options.headers?.Authorization ?? null }); return new Promise((resolve, reject) => { release = { resolve, reject }; }); } } } },
  };
  stubs['@/features/threads-disconnect/threads-disconnect-runner'] = evaluate(await read('src/features/threads-disconnect/threads-disconnect-runner.ts'), 'runner', stubs);
  stubs['@/features/threads-disconnect/threads-disconnect-runtime'] = evaluate(await read('src/features/threads-disconnect/threads-disconnect-runtime.ts'), 'runtime', stubs);
  stubs['@/features/threads-disconnect/use-threads-disconnect'] = evaluate(await read('src/features/threads-disconnect/use-threads-disconnect.ts'), 'hook', stubs);
  const card = evaluate(await read('src/features/threads-disconnect/threads-disconnect-card.tsx'), 'card', stubs);
  // 'empty-while-loading' is the real provider rule; 'keep-last-while-loading' is a control world (see the last test).
  const accounts = () => (data.status === 'ready' ? data.list : provider === 'keep-last-while-loading' ? data.lastReady : []);
  const reload = () => { data.reloads += 1; data.status = 'loading'; };
  const api = {
    data, auth, invokes,
    render: () => { const shown = accounts(); return h.render(() => card.ThreadsDisconnectCard({ threadsAccount: shown.find((a) => a.platform === 'threads') ?? null, accounts: shown, reload, preview: false, releaseEnabled: true })); },
    lines: () => texts(api.render()),
    finish(status, next = data.list) { data.status = status; if (status === 'ready') { data.list = next; data.lastReady = next; } },
    async press() {
      button(api.render(), 'Threads連携を解除').onPress();
      const go = button(api.render(), '解除する');
      assert.ok(go, 'the confirmation is shown');
      go.onPress();
      await settle();
    },
    async answer(payload, { ok = true, lost = false } = {}) {
      assert.ok(release, 'a request is waiting');
      if (lost) release.reject(new TypeError('network')); else release.resolve(ok ? { data: payload, error: null } : { data: null, error: {} });
      await settle();
    },
  };
  return api;
}
const SUCCESS_LINES = (lines) => lines.some((l) => l.startsWith('Threads連携を解除しました') || l.startsWith('すでに'));

// ---- the release gate (red while G2-T2 is open) ---------------------------------------------------------------------
test('RELEASE GATE G2-T2-TIME: "解除しました" appears only after a reload that started AFTER the answer has finished READY without the account -- never at the answer, never while that reload is still loading', { todo: 'RELEASE GATE (G2-T2, P3, owner G4): red until fixed' }, async () => {
  const s = await mountScreen({ list: [TH_A] });
  await s.press();
  await s.answer(SUCCESS);
  assert.equal(s.data.reloads, 1, 'the answer asked for a reload');
  assert.equal(s.data.status, 'loading');
  assert.equal(SUCCESS_LINES(s.lines()), false, 'not while the reload is loading (G2-T2)');
  s.finish('ready', []);
  assert.ok(s.lines().includes(REMOVED_LINE), 'and yes once the READY list lacks it');
});

// ---- the time boundary, stage by stage -----------------------------------------------------------------------------
test('G2-T2T-1: before the answer -- while confirming and while the request waits -- nothing says "disconnected"; the waiting card says only "解除しています…" and a second press sends nothing', async () => {
  const s = await mountScreen();
  button(s.render(), 'Threads連携を解除').onPress();
  assert.equal(SUCCESS_LINES(s.lines()), false, 'confirming');
  const go = button(s.render(), '解除する');
  go.onPress();
  go.onPress();
  await settle();
  const waiting = s.lines();
  assert.ok(waiting.includes('解除しています…'));
  assert.equal(SUCCESS_LINES(waiting), false, 'waiting');
  assert.equal(s.invokes.length, 1, 'one request');
  assert.equal(s.data.reloads, 0, 'no reload before the answer');
});

test('G2-T2T-2: the answer is LOST while waiting, and the server did remove it -- the card says the result is unknown, reloads, and even after the READY list lacks the account it never says "disconnected"', async () => {
  const s = await mountScreen();
  await s.press();
  await s.answer(null, { lost: true });
  assert.equal(s.data.reloads, 1, 'an unknown answer reloads');
  s.finish('ready', [X_1]);
  const lines = s.lines();
  assert.equal(SUCCESS_LINES(lines), false, 'never claimed');
  assert.ok(lines.length > 0, 'something honest is shown');
});

test('KNOWN G2-T2-P, another entrance (P3, owner G4, not a new finding): another person signs in WHILE the request waits (G2 #393 had it during "checking") -- the answer is A\'s, and B is told "解除しました"', async () => {
  const s = await mountScreen();
  await s.press();
  assert.equal(s.invokes[0].auth, 'Bearer rig-jwt-a1', 'sent with A\'s token');
  s.auth.session = { access_token: 'rig-jwt-b2', user: { id: USER_B } };
  await s.answer(SUCCESS);
  s.finish('ready', [account('sa_x_b', 'x', '@g2_x_b')]);
  assert.ok(s.lines().includes(REMOVED_LINE), 'B sees A\'s result as a success');
});

test('G2-T2T-3: refusals and stops answered while waiting (PUBLISH_IN_FLIGHT stop, ACCOUNT_CHANGED, a failed HTTP answer) end without any success line, whatever the list does next', async () => {
  for (const [payload, opts] of [[{ ok: true, status: 'stopped', code: 'PUBLISH_IN_FLIGHT', publish_permission: 'withdrawn', local_credentials: 'kept', remote_access: 'not_revoked_by_app' }, {}], [{ ok: false, error: 'ACCOUNT_CHANGED' }, { ok: false }], [null, { ok: false }]]) {
    const s = await mountScreen();
    await s.press();
    await s.answer(payload, opts);
    if (s.data.status === 'loading') s.finish('ready', [X_1]);
    assert.equal(SUCCESS_LINES(s.lines()), false, JSON.stringify(payload));
  }
});

// ---- controls ----------------------------------------------------------------------------------------------------
test('controls: the gate measures exactly the loading-empty boundary -- in a world whose provider kept the last list while loading the current card passes the gate; the real provider rule is what the source says; and in the real world the success line is there while loading', async () => {
  // (1) keep-last-while-loading: no premature success, and success once the READY list lacks it
  {
    const s = await mountScreen({ list: [TH_A], provider: 'keep-last-while-loading' });
    await s.press();
    await s.answer(SUCCESS);
    assert.equal(SUCCESS_LINES(s.lines()), false, 'no success while loading in that world');
    s.finish('ready', []);
    assert.ok(s.lines().includes(REMOVED_LINE));
  }
  // (2) the real rule: accounts are [] unless ready (as G2 #393 T2-L pinned against the source)
  const provider = await read('src/providers/active-account-provider.tsx');
  assert.match(provider, /status === 'ready'/u);
  // (3) the real world, today: the success line is there while loading (this is why the gate is red)
  {
    const s = await mountScreen({ list: [TH_A] });
    await s.press();
    await s.answer(SUCCESS);
    assert.ok(s.lines().includes(REMOVED_LINE), 'today: success while the reload is still loading');
  }
});
