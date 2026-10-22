// G2 QA (Issue #317, task postona-g2-pr426-legacy-x-connect-qa-mock-compat-20261022) -- QA only, no product code.
// G4 PR #426 added `supabase.auth.getSession()` and `@/domain/recovery-binding` to the X connect hook, so the six X
// connect cases of G2 #419 / #425 stop at "unexpected import" there (a harness gap, not a product result). This file
// re-runs the SAME six cases with a compatible harness (synthetic getSession that follows the sign-in events, the real
// recovery-binding module) and with the old unsafe expectations turned into the safe fail-closed ones. The #419 / #425
// files and logs stay as they are. Offline: no network, no real token (unsigned JWT shapes, only `sub` / `session_id` read).
// Real-SDK runs of the same boundaries are G2 #433 (not repeated); G4's own cases are in x-connect-owner-session.test.mjs.
// G2_HOOK_SOURCE=<path> runs these cases against another copy of the hook (used once for main's hook).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { xConnectAuthSessionOptions } from '../src/features/x-connect/auth-session-options.ts';
import * as oauth from '../src/lib/x-oauth-onboarding.ts';
import * as recoveryBinding from '../src/domain/recovery-binding.ts';

const HOOK_SOURCE = await readFile(process.env.G2_HOOK_SOURCE ?? new URL('../src/features/x-connect/use-x-connect.ts', import.meta.url), 'utf8');
const HAS_OWNER_CHECKS = HOOK_SOURCE.includes('isConnectOwner(');
const plain = (value) => JSON.parse(JSON.stringify(value));
const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
/** A synthetic app session: user + session_id claim; `n` makes a refreshed token of the same session. */
const sessionOf = (userId, sessionId, n = 1) => ({ access_token: `${b64url({ alg: 'none' })}.${b64url({ sub: userId, session_id: sessionId })}.rig${n}`, user: { id: userId } });
const A1 = sessionOf('user-a', 'sess-a-1');
const B1 = sessionOf('user-b', 'sess-b-1');
const A2 = sessionOf('user-a', 'sess-a-2'); // the same person, a NEW session (signed in again)
const A1r = sessionOf('user-a', 'sess-a-1', 2); // the same session, refreshed token

/**
 * The real hook. `auth.set(s)` is a sign-in event: the screen (useAuth) and the SDK (getSession) both follow it, as on
 * a device. `mock: 'stale'` keeps getSession on the START session (a wrong harness); `mock: 'none'` has no getSession.
 */
async function harness({ source = HOOK_SOURCE, mock = 'live', callbackAnswer = () => ({ data: { success: true, handle: 'rig_handle_of_a' }, error: null }) } = {}) {
  const slots = [];
  const requests = [];
  let cursor = 0;
  let round = 0;
  let connected = 0;
  let finishBrowser;
  const auth = { ui: A1, sdk: A1, start: A1 };
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (v) => { slots[i] = v; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useCallback: (cb) => cb,
  };
  const authApi = mock === 'none' ? {} : { getSession: async () => ({ data: { session: mock === 'stale' ? auth.start : auth.sdk }, error: null }) };
  const modules = {
    react,
    'react-native': { Platform: { OS: 'android' } },
    'expo-crypto': { getRandomBytesAsync: async (n) => new Uint8Array(n).fill(++round), digestStringAsync: async (_a, v) => createHash('sha256').update(v).digest('base64'), CryptoDigestAlgorithm: { SHA256: 'SHA256' }, CryptoEncoding: { BASE64: 'BASE64' } },
    'expo-linking': { createURL: () => 'kabumori-social://oauth-callback' },
    'expo-web-browser': { maybeCompleteAuthSession() {}, openAuthSessionAsync: (_url, redirect) => new Promise((resolve) => { finishBrowser = (type) => resolve(type === 'success' ? { type, url: `${redirect}?state=${requests.at(-1).options.body.state}&code=rig_code` } : { type }); }) },
    '@/features/x-connect/auth-session-options': { xConnectAuthSessionOptions },
    '@/domain/recovery-binding': recoveryBinding,
    '@/lib/x-oauth-onboarding': oauth,
    '@/providers/auth-provider': { useAuth: () => ({ session: auth.ui }) },
    '@/lib/supabase': { supabase: { auth: authApi, functions: { invoke: async (name, options) => { requests.push({ name, options: plain(options) }); return name.endsWith('/callback') ? callbackAnswer(options) : { data: { authorization_url: 'https://x.com/i/oauth2/authorize' }, error: null }; } } } },
  };
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod, exports: mod.exports, URL, atob, require: (n) => { assert.ok(Object.hasOwn(modules, n), `unexpected import ${n}`); return modules[n]; }, fetch: () => { throw new Error('live network forbidden'); } }, { filename: 'use-x-connect.ts' });
  const render = () => { cursor = 0; return mod.exports.useXConnect(() => { connected += 1; }); };
  const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r)); };
  const h = {
    requests, render,
    set(session) { auth.ui = session; auth.sdk = session; render(); },
    /** Press connect; wait until the browser is open. Returns { running } (a bare promise would be awaited through). */
    async start() { const running = render().connect(); await settle(); return { running, opened: requests.length === 1 }; },
    /** No-op when the browser never opened (the flow stopped before it). */
    finish: (type = 'success') => finishBrowser?.(type),
    exchanges: () => requests.filter((r) => r.name.endsWith('/callback')),
    connected: () => connected,
  };
  return h;
}
const httpError = (status) => ({ data: null, error: { name: 'FunctionsHttpError', context: { status } } });

// ---- the six legacy cases with the safe expectation (each returns true when the safe expectation held) -------------
const CASES = {
  /** #419 CB5: B signs in while A's X browser is open. Old expectation: exchange with A's token, B told "connected @A". */
  async 'L1 #419 CB5'(opts) {
    const h = await harness(opts);
    const { running, opened } = await h.start();
    h.set(B1);
    h.finish();
    await running;
    const now = h.render();
    return opened && h.exchanges().length === 0 && now.state !== 'connected' && now.verifiedHandle === null && h.connected() === 0;
  },
  /** #419 CB6: sign-out while the browser is open. Old expectation: the exchange still went out with A's token. */
  async 'L2 #419 CB6'(opts) {
    const h = await harness(opts);
    const { running, opened } = await h.start();
    h.set(null);
    h.finish();
    await running;
    return opened && h.exchanges().length === 0 && h.connected() === 0;
  },
  /** #425 CX1: sign-out, then cancel. Expectation unchanged: no exchange, "cancelled". */
  async 'L3 #425 CX1'(opts) {
    const h = await harness(opts);
    const { running, opened } = await h.start();
    h.set(null);
    h.finish('cancel');
    await running;
    return opened && h.exchanges().length === 0 && h.render().state === 'cancelled';
  },
  /** #425 CX2: sign-out, the same person signs in again (new session). Old: exchange with the OLD token (UNKNOWN server). */
  async 'L4 #425 CX2'(opts) {
    for (const answer of [() => httpError(401), () => ({ data: { success: true, handle: 'rig_handle_of_a' }, error: null })]) {
      const h = await harness({ ...opts, callbackAnswer: answer });
      const { running, opened } = await h.start();
      h.set(null);
      h.set(A2);
      h.finish();
      await running;
      const now = h.render();
      if (!(opened && h.exchanges().length === 0 && now.state !== 'connected' && h.connected() === 0)) return false;
    }
    return true;
  },
  /** #425 CX3: after a sign-out, whatever the server would answer, never "connected" -- now: no exchange at all. */
  async 'L5 #425 CX3'(opts) {
    for (const answer of [httpError(401), httpError(403), httpError(400), httpError(503), { data: { success: false }, error: null }, { data: { success: true, handle: '' }, error: null }]) {
      const h = await harness({ ...opts, callbackAnswer: () => answer });
      const { running, opened } = await h.start();
      h.set(null);
      h.finish();
      await running;
      const now = h.render();
      if (!(opened && h.exchanges().length === 0 && now.state !== 'connected' && now.verifiedHandle === null && h.connected() === 0)) return false;
    }
    return true;
  },
};
/** Positive controls: what must still work (so a harness that blocks everything cannot look "safe"). */
const POSITIVE = {
  /** The same session throughout: exchange once with that token, connected. */
  async 'P1 same session'(opts) {
    const h = await harness(opts);
    const { running, opened } = await h.start();
    h.finish();
    await running;
    const [call] = h.exchanges();
    return opened && !!call && call.options.headers.Authorization === `Bearer ${A1.access_token}` && h.render().state === 'connected' && h.connected() === 1;
  },
  /** The same session refreshed its token while the browser was open: still the owner; the exchange uses the CURRENT token. */
  async 'P2 same session, refreshed token'(opts) {
    const h = await harness(opts);
    const { running, opened } = await h.start();
    h.set(A1r);
    h.finish();
    await running;
    const [call] = h.exchanges();
    return opened && !!call && call.options.headers.Authorization === `Bearer ${A1r.access_token}` && h.render().state === 'connected';
  },
  /** The same session, the server refuses the exchange (expired state / failure): an error, never "connected". */
  async 'P3 same session, exchange fails'(opts) {
    for (const answer of [httpError(400), httpError(401), httpError(503), { data: { success: false }, error: null }]) {
      const h = await harness({ ...opts, callbackAnswer: () => answer });
      const { running, opened } = await h.start();
      h.finish();
      await running;
      const now = h.render();
      if (!(opened && h.exchanges().length === 1 && ['terminal_error', 'retryable_error'].includes(now.state) && h.connected() === 0)) return false;
    }
    return true;
  },
};
const runAll = async (table, opts = {}) => Object.fromEntries(await Promise.all(Object.entries(table).map(async ([name, fn]) => [name, await fn(opts)])));

// ---- the cases on this head ------------------------------------------------------------------------------------------
for (const [name, fn] of Object.entries(CASES)) {
  test(`${name}: safe fail-closed expectation`, async () => { assert.equal(await fn({}), true); });
}
for (const [name, fn] of Object.entries(POSITIVE)) {
  test(`${name}: still works`, async () => { assert.equal(await fn({}), true); });
}

// ---- harness controls --------------------------------------------------------------------------------------------------
test('harness control H1: a STALE getSession mock (stuck on the start session) must not make the hook look safe -- on a head with owner checks, L1 / L2 / L4 / L5 then fail', { skip: HAS_OWNER_CHECKS ? false : 'no owner checks on this head' }, async () => {
  const stale = await runAll(CASES, { mock: 'stale' });
  assert.deepEqual(stale, { 'L1 #419 CB5': false, 'L2 #419 CB6': false, 'L3 #425 CX1': true, 'L4 #425 CX2': false, 'L5 #425 CX3': false });
});

test('harness control H2: a harness WITHOUT getSession (the #419 / #425 harness gap) blocks everything at the start -- the "opened" check and the positive controls catch it, so it can never pass as safe', { skip: HAS_OWNER_CHECKS ? false : 'no owner checks on this head' }, async () => {
  const blocked = await runAll({ ...CASES, ...POSITIVE }, { mock: 'none' });
  assert.ok(Object.values(blocked).every((ok) => ok === false), JSON.stringify(blocked));
});

// ---- negative controls (AST on this hook) ----------------------------------------------------------------------------
function mutateHook(predicate, replace) {
  const file = ts.createSourceFile('use-x-connect.ts', HOOK_SOURCE, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  let n = 0;
  const out = ts.transform(file, [(context) => (root) => ts.visitNode(root, function v(node) { if (predicate(node)) { n += 1; return replace(node); } return ts.visitEachChild(node, v, context); })]);
  return { text: ts.createPrinter().printFile(out.transformed[0]), n };
}

test('negative controls: (1) both owner re-checks removed -> L1 / L4 fail (another signed-in person); a sign-out is then still stopped only by the null token read, so (1b) also exchanging with the screen\'s captured token (the old code) -> L2 / L5 fail too; (2) the #425 control: the cancel branch removed -> L3 fails', { skip: HAS_OWNER_CHECKS ? false : 'no owner checks on this head' }, async () => {
  const f = ts.factory;
  const first = mutateHook((n) => ts.isIfStatement(n) && n.expression.getText() === '!isConnectOwner(owner, exchangeSession)', () => f.createEmptyStatement());
  assert.equal(first.n, 1);
  const file = ts.createSourceFile('m.ts', first.text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  let n2 = 0;
  const both = ts.createPrinter().printFile(ts.transform(file, [(context) => (root) => ts.visitNode(root, function v(node) { if (ts.isIfStatement(node) && node.expression.getText() === '!isConnectOwner(owner, await currentSession())') { n2 += 1; return f.createEmptyStatement(); } return ts.visitEachChild(node, v, context); })]).transformed[0]);
  assert.equal(n2, 1);
  assert.deepEqual(await runAll(CASES, { source: both }), { 'L1 #419 CB5': false, 'L2 #419 CB6': true, 'L3 #425 CX1': true, 'L4 #425 CX2': false, 'L5 #425 CX3': true }, 'mutant 1');
  const captured = both.split('exchangeSession.access_token').join('session.access_token');
  assert.notEqual(captured, both, 'the exchange token read exists');
  assert.deepEqual(await runAll(CASES, { source: captured }), { 'L1 #419 CB5': false, 'L2 #419 CB6': false, 'L3 #425 CX1': true, 'L4 #425 CX2': false, 'L5 #425 CX3': false }, 'mutant 1b');
  const noCancel = mutateHook((n) => ts.isIfStatement(n) && n.expression.getText() === "browserResult.type === 'cancel' || browserResult.type === 'dismiss'", () => f.createEmptyStatement());
  assert.equal(noCancel.n, 1);
  assert.equal(await CASES['L3 #425 CX1']({ source: noCancel.text }), false, 'mutant 2');
});
