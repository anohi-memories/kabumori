import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { Buffer } from 'node:buffer';
import ts from 'typescript';
import * as account from '../src/domain/account-deletion.ts';
import * as end from '../src/domain/postona-service-end.ts';
import * as notices from '../src/domain/postona-end-notices.ts';
import * as flows from '../src/domain/auth-flows.ts';
import * as recovery from '../src/domain/recovery-binding.ts';

const session = (id = 'u1', sid = 's1') => ({ user: { id, identities: [{ provider: 'email' }] }, access_token: `synthetic.${Buffer.from(JSON.stringify({ session_id: sid })).toString('base64url')}.signature` });
const context = { userId: 'u1', sessionId: 's1' };
const bound = { ok: true, accountStatus: 'active', lifecycleVersion: 7, services: [{ service: 'kabumori', status: 'active' }, { service: 'x_autopost', status: 'active' }], acknowledgementRequired: ['threads'], postonaAvailable: true, deletionInProgress: false, context };
const walk = (n, out = []) => { if (Array.isArray(n)) n.forEach((c) => walk(c, out)); else if (n && typeof n === 'object') { out.push(n); walk(n.props?.children, out); } return out; };
const texts = (tree) => walk(tree).filter((n) => n.type === 'Text' || n.type === 'SectionTitle').map((n) => [n.props.children].flat(Infinity).filter((s) => typeof s === 'string').join(''));
const findButton = (tree, label) => walk(tree).find((n) => n.type === 'Pressable' && texts(n).some((s) => s.includes(label)));
const flush = () => new Promise((r) => setImmediate(r));
async function screenHarness({ enabled = false, execute = async () => end.endFailure('RESULT_UNCONFIRMED') } = {}) {
  const slots = []; let cursor = 0; const effects = []; let calls = 0, previews = 0, reauths = 0;
  const auth = { session: session(), backendAvailable: true, email: { signIn: true }, readiness: () => ({ usableNow: true }),
    reauthenticate: async () => { reauths++; return { ok: true, context }; },
    previewPostonaEnd: async () => { previews++; return bound; },
    endPostonaService: async (input) => { calls++; return execute(input); } };
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useCallback(cb) { return cb; },
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || deps.some((v, j) => v !== slots[i][j])) { slots[i] = deps; effects.push(fn); } },
  };
  const jsx = (type, props) => ({ type, props });
  const modules = { react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': Object.fromEntries(['ActivityIndicator', 'Linking', 'Pressable', 'ScrollView', 'Text', 'TextInput'].map((n) => [n, n])),
    '@/constants/theme': { colors: {} }, '@/components/ui': { Card: 'Card', Pill: 'Pill', Screen: 'Screen', SectionTitle: 'SectionTitle', styles: {} },
    '@/domain/account-deletion': account, '@/domain/postona-service-end': { ...end, POSTONA_END_SOURCE_ENABLED: enabled }, '@/domain/postona-end-notices': notices,
    '@/domain/auth-flows': flows, '@/domain/recovery-binding': recovery, '@/domain/legal-links': { LEGAL_LINK_LABELS: {} },
    '@/lib/legal-config': { LEGAL_LINKS: { support: {} } }, '@/providers/auth-provider': { useAuth: () => auth } };
  const source = await readFile(new URL('../src/app/account-deletion.tsx', import.meta.url), 'utf8');
  const module = { exports: {} };
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, require: (n) => { assert.ok(Object.hasOwn(modules, n), n); return modules[n]; } });
  const render = () => { cursor = 0; const tree = module.exports.default(); effects.splice(0).forEach((fn) => fn()); return tree; };
  render(); await flush();
  return { render, auth, counts: () => ({ calls, previews, reauths }) };
}

test('actual OFF screen offers two distinct explanations, always-blocked whole ID action, and zero backend calls', async () => {
  const h = await screenHarness(), t = h.render();
  assert.ok(texts(t).includes('POSTONAの利用終了')); assert.ok(texts(t).includes('共通IDを完全削除'));
  assert.ok(texts(t).some((s) => s.includes('共通IDとかぶモリの利用状況・データは残ります')));
  findButton(t, '共通IDの完全削除について').props.onPress();
  const open = h.render(); const button = findButton(open, '共通IDを完全削除（準備中）');
  assert.equal(button.props.disabled, true); assert.equal(button.props.onPress, undefined);
  assert.ok(texts(open).some((s) => s.includes('共通IDとかぶモリ・POSTONAのデータが削除されることを理解')));
  assert.deepEqual(h.counts(), { calls: 0, previews: 0, reauths: 0 });
});

test('actual service screen binds reauth, typed service-only phrase, and separate Threads local/remote consent', async () => {
  let resolve; const pending = new Promise((r) => { resolve = r; });
  const h = await screenHarness({ enabled: true, execute: () => pending });
  let t = h.render(); const local = notices.REMOTE_UNVERIFIED.threads.local, remote = notices.REMOTE_UNVERIFIED.threads.remote;
  assert.ok(texts(t).includes(local)); assert.ok(texts(t).includes(remote));
  const password = walk(t).find((n) => n.type === 'TextInput' && n.props.secureTextEntry);
  password.props.onChangeText('synthetic-password');
  await findButton(h.render(), 'で本人確認').props.onPress(); await flush(); t = h.render();
  const phrase = walk(t).find((n) => n.type === 'TextInput' && !n.props.secureTextEntry);
  phrase.props.onChangeText(end.POSTONA_END_CONFIRM_PHRASE);
  assert.equal(findButton(h.render(), 'POSTONAの利用を終了').props.disabled, true, 'requires unverified consent');
  walk(h.render()).find((n) => n.type === 'Pressable' && n.props.accessibilityRole === 'checkbox').props.onPress();
  const submit = findButton(h.render(), 'POSTONAの利用を終了'); assert.equal(submit.props.disabled, false);
  submit.props.onPress(); submit.props.onPress(); await flush(); assert.equal(h.counts().calls, 1);
  resolve(end.endFailure('RECONCILIATION_REQUIRED')); await flush(); t = h.render();
  assert.ok(texts(t).includes(notices.ERROR_NOTICES.RECONCILIATION_REQUIRED.ja));
  assert.ok(!texts(t).some((s) => s.includes('利用を終了しました')));
});

test('old user result and confirmation disappear after authentication switch', async () => {
  const h = await screenHarness({ enabled: true });
  let t = h.render(); walk(t).find((n) => n.type === 'TextInput' && n.props.secureTextEntry).props.onChangeText('synthetic');
  await findButton(h.render(), 'で本人確認').props.onPress(); await flush();
  h.auth.session = session('u2', 's2'); h.render(); t = h.render();
  assert.equal(findButton(t, 'POSTONAの利用を終了'), undefined, 'old preview not usable');
});
