// G2 QA (Issue #317, task postona-g2-threads-disconnect-stale-success-crosslayer-qa-20261020) -- QA only, no product code.
// G2-T2 (P3, owner G4) across the layers: the REAL disconnect card + hook + runner (transpiled; unchanged since
// 2026-10-13, the base of G2 PR #342) on top of a stand-in of the app's data layer that follows the real sources:
//   - data-provider.tsx: reload() bumps a generation; the read sets status 'loading', then 'ready' with a snapshot or
//     'unavailable' / 'blocked' without one; an older read that finishes late is cancelled;
//   - active-account-provider.tsx: `accounts` is the snapshot's list only when status is 'ready', otherwise [].
// (Both rules are checked against the source text in the last-but-one test.) Offline: no Threads, no Supabase.
//
// PR #342 already pins the base case ("解除しました" while the list reloads); G4's own tests cover the golden path,
// a second tap, a changed person before sending, refusals, PUBLISH_IN_FLIGHT and an unknown answer. This file adds only
// the cross-layer conditions they do not. "FINDING .." passes while the gap exists and FAILS once fixed.
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

/**
 * The accounts screen (src/app/accounts/index.tsx lines 16-17, 76) as far as the disconnect card sees it:
 * threadsAccount = the first Threads account of `accounts`, `accounts` per the provider rule above.
 */
async function mountScreen({ list = [TH_A, X_1], answer = { ok: true, payload: SUCCESS }, hookSource } = {}) {
  const h = hooks();
  const data = { status: 'ready', list, reloads: 0, generation: 0 };
  const auth = { session: { access_token: 'rig-jwt-a1', user: { id: USER_A } } };
  const invokes = [];
  const stubs = {
    react: h.react, 'react/jsx-runtime': h.runtime,
    'react-native': { Text: 'Text', View: 'View' },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', styles: { muted: {} } },
    '@/constants/theme': { colors: { ink: 'i' } },
    '@/domain/threads-disconnect': domain,
    '@/providers/auth-provider': { useAuth: () => ({ session: auth.session }) },
    '@/lib/supabase': { supabase: { functions: { invoke: async (_name, options) => { invokes.push(options.body); return answer.ok ? { data: answer.payload, error: null } : { data: null, error: {} }; } } } },
  };
  stubs['@/features/threads-disconnect/threads-disconnect-runner'] = evaluate(await read('src/features/threads-disconnect/threads-disconnect-runner.ts'), 'runner', stubs);
  stubs['@/features/threads-disconnect/threads-disconnect-runtime'] = evaluate(await read('src/features/threads-disconnect/threads-disconnect-runtime.ts'), 'runtime', stubs);
  stubs['@/features/threads-disconnect/use-threads-disconnect'] = evaluate(hookSource ?? await read('src/features/threads-disconnect/use-threads-disconnect.ts'), 'hook', stubs);
  const card = evaluate(await read('src/features/threads-disconnect/threads-disconnect-card.tsx'), 'card', stubs);
  const accounts = () => (data.status === 'ready' ? data.list : []);
  const reload = () => { data.reloads += 1; data.generation += 1; data.status = 'loading'; };
  const api = {
    data, auth, invokes,
    render: () => {
      const shown = accounts();
      return h.render(() => card.ThreadsDisconnectCard({ threadsAccount: shown.find((a) => a.platform === 'threads') ?? null, accounts: shown, reload, preview: false, releaseEnabled: true }));
    },
    lines: () => texts(api.render()),
    /** The reload finishes: 'ready' with this list, or 'unavailable' / 'blocked'. */
    finish(status, list = data.list) { data.status = status; if (status === 'ready') data.list = list; },
    async disconnect() {
      button(api.render(), 'Threads連携を解除').onPress();
      const go = button(api.render(), '解除する');
      assert.ok(go, 'the confirmation is shown');
      go.onPress();
      go.onPress(); // a double tap
      await settle();
      return api.render();
    },
  };
  return api;
}

// ---- new cross-layer conditions -----------------------------------------------------------------------------------

test('G2-T2-OK (guard for the fix): the person\'s only account was this Threads one -- after a READY reload the list is truly empty and "解除しました" is right', async () => {
  const s = await mountScreen({ list: [TH_A] });
  await s.disconnect();
  assert.equal(s.invokes.length, 1);
  s.finish('ready', []);
  assert.ok(s.lines().includes(REMOVED_LINE));
});

test('FINDING G2-T2-F (P3, owner G4): the reload FAILS (unavailable / blocked) -- the list is empty because nothing was read, yet the card says "解除しました" and keeps saying it', async () => {
  for (const failed of ['unavailable', 'blocked']) {
    const s = await mountScreen();
    await s.disconnect();
    assert.equal(s.data.reloads, 1);
    s.finish(failed);
    assert.ok(s.lines().includes(REMOVED_LINE), `${failed}: success claimed without any read-back`);
    assert.equal(s.data.reloads, 1, `${failed}: and nothing reads again`);
  }
});

test('G2-T2-S: the READY reload still lists the account (the server answered, the read shows it) -- no success is claimed; it keeps "checking" (no further read)', async () => {
  const s = await mountScreen();
  await s.disconnect();
  s.finish('ready', [TH_A, X_1]);
  const lines = s.lines();
  assert.ok(lines.includes(CHECKING_LINE));
  assert.ok(!lines.includes(REMOVED_LINE));
  assert.equal(s.data.reloads, 1, 'observation: nothing re-reads later, so it can stay "checking"');
});

test('FINDING G2-T2-M (P3, owner G4): two Threads accounts -- after A is removed the same card shows B\'s button next to a result line that does not say WHICH account was removed', async () => {
  const s = await mountScreen({ list: [TH_A, TH_B, X_1] });
  await s.disconnect();
  assert.equal(JSON.stringify(s.invokes[0]), JSON.stringify({ action: 'disconnect', social_account_id: 'sa_th_a', expected_handle: 'g2_threads_a' }));
  s.finish('ready', [TH_B, X_1]);
  const tree = s.render();
  const lines = texts(tree);
  assert.ok(lines.includes(REMOVED_LINE));
  assert.ok(button(tree, 'Threads連携を解除'), "B's disconnect button is under it");
  assert.ok(!lines.some((line) => line.includes('g2_threads_a')), 'no handle of A in the result');
});

test('FINDING G2-T2-P (P3, owner G4): another person signs in while the card is "checking" -- their list has no such account, and THEY are told "解除しました"', async () => {
  const s = await mountScreen();
  await s.disconnect();
  s.auth.session = { access_token: 'rig-jwt-b2', user: { id: USER_B } }; // SIGNED_IN of B; the provider reloads for B
  s.finish('ready', [account('sa_x_b', 'x', '@g2_x_b')]);
  assert.ok(s.lines().includes(REMOVED_LINE), "A's result is shown to B");
  assert.equal(s.invokes.length, 1);
});

test('G2-T2-L: the data layer drops a read that finishes after a newer reload (no older list can come back), and `accounts` is [] unless the status is ready -- the rules the stand-in follows', async () => {
  const provider = await read('src/providers/data-provider.tsx');
  assert.match(provider, /const reload = useCallback\(\(\) => setGeneration\(\(value\) => value \+ 1\), \[\]\);/u);
  assert.match(provider, /setStatus\('loading'\);[\s\S]{0,120}const result = await selected\.repository\.readSnapshot\(\);\s+if \(cancelled\) return;/u);
  assert.match(provider, /return \(\) => \{ cancelled = true; \};\s+\}, \[session, generation\]\);/u);
  const active = await read('src/providers/active-account-provider.tsx');
  assert.match(active, /status === 'ready' && snapshot \? snapshot\.accounts : \[\]/u);
  const screen = await read('src/app/accounts/index.tsx');
  assert.match(screen, /const threadsAccount = accounts\.find\(\(account\) => account\.platform === 'threads'\) \?\? null;/u);
  assert.match(screen, /<ThreadsDisconnectCard threadsAccount=\{threadsAccount\} accounts=\{accounts\} reload=\{reload\}/u, 'the card is not given the data status');
  const hook = await read('src/features/threads-disconnect/use-threads-disconnect.ts');
  assert.match(hook, /const verified = state\.kind === 'verifying'\s+&& !accounts\.some\(/u, '"verified" looks only at the list');
});

// ---- negative control: a naive fix flips the FINDING but breaks the legitimate case ------------------------------------

test('negative control: "verified only when the list is not empty" (a naive fix) stops the false success after a failed reload, and G2-T2-OK catches that it never confirms a truly empty list', async () => {
  const original = await read('src/features/threads-disconnect/use-threads-disconnect.ts');
  const from = "  const verified = state.kind === 'verifying'\n    && !accounts.some(";
  assert.equal(original.split(from).length - 1, 1, 'the mutation target occurs exactly once');
  const sketch = original.replace(from, "  const verified = state.kind === 'verifying' && accounts.length > 0\n    && !accounts.some(");

  const failed = await mountScreen({ hookSource: sketch });
  await failed.disconnect();
  failed.finish('unavailable');
  assert.ok(!failed.lines().includes(REMOVED_LINE), 'with the sketch: no success after a failed reload (G2-T2-F flips)');

  const only = await mountScreen({ list: [TH_A], hookSource: sketch });
  await only.disconnect();
  only.finish('ready', []);
  assert.ok(!only.lines().includes(REMOVED_LINE), 'but the truly empty list is never confirmed either (G2-T2-OK fails on it)');
  assert.ok(only.lines().includes(CHECKING_LINE));
});
