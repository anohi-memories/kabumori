// G1 -- combined-stack contract (docs/postona/audit/g1-combined-stack-regression). Meant for the tree in which the
// manual X post UI stack (PR #274 ... #400) AND the safe not-found screen (PR #369) are both present. In any other tree
// (main today, or one of the two alone) these tests SKIP with a reason: they must not pretend to check what is absent.
// Offline: no network, no storage, no secret; the real source files are read / transpiled and expo-router's own route
// builder is run over the real src/app directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const ROOT = new URL('..', import.meta.url).pathname;
const has = (path) => existsSync(join(ROOT, path));
const BOTH = has('src/app/manual-publish.tsx') && has('src/app/+not-found.tsx') && has('src/features/manual-publish/manual-publish-port.ts');
const SKIP = BOTH ? false : 'the combined tree is needed: manual-publish stack (PR #274..#400) + safe not-found (PR #369)';

const NETWORK = ['fetch', 'XMLHttpRequest', 'WebSocket'];
const saved = new Map();
let trapped = 0;
test.before(() => {
  for (const name of NETWORK) {
    saved.set(name, globalThis[name]);
    globalThis[name] = function forbidden() { trapped += 1; throw new Error(`network entry point ${name} must not be used`); };
  }
});
test.after(() => {
  for (const name of NETWORK) {
    if (saved.get(name) === undefined) delete globalThis[name];
    else globalThis[name] = saved.get(name);
  }
});

const codeOf = (path) => ts.transpileModule(readFileSync(join(ROOT, path), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, removeComments: true } }).outputText;
const namedImportsFrom = (path, module) => {
  const sf = ts.createSourceFile(path, readFileSync(join(ROOT, path), 'utf8'), ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const names = [];
  sf.forEachChild((node) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === module && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const element of node.importClause.namedBindings.elements) names.push(element.name.text);
    }
  });
  return names.sort();
};
const importsOf = (path) => {
  const sf = ts.createSourceFile(path, readFileSync(join(ROOT, path), 'utf8'), ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out = [];
  sf.forEachChild((node) => { if (ts.isImportDeclaration(node)) out.push(node.moduleSpecifier.text); });
  return out;
};
const featureFiles = () => (has('src/features/manual-publish') ? readdirSync(join(ROOT, 'src/features/manual-publish')).filter((n) => /\.tsx?$/u.test(n)).map((n) => `src/features/manual-publish/${n}`) : []);

function appKeys() {
  const base = join(ROOT, 'src/app');
  const keys = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (/\.tsx?$/u.test(entry.name)) keys.push(`./${relative(base, full)}`);
    }
  };
  visit(base);
  return keys;
}
const routesOf = (options = {}) => {
  const keys = appKeys();
  const ctx = Object.assign(() => ({ default: () => null }), { keys: () => keys, resolve: (k) => k, id: 'app' });
  return require('expo-router/build/getRoutes').getRoutes(ctx, options).children;
};

test('combined routes: expo-router resolves BOTH the manual-post screen and OUR not-found screen, and the existing routes are intact', { skip: SKIP }, () => {
  const routes = routesOf();
  const byName = new Map(routes.map((r) => [r.route, r]));
  assert.equal(byName.get('manual-publish')?.contextKey, './manual-publish.tsx');
  const notFound = byName.get('+not-found');
  assert.equal(notFound?.contextKey, './+not-found.tsx', 'not the generated English Unmatched screen');
  assert.ok(!notFound.generated && !notFound.internal);
  for (const existing of ['oauth-callback', 'auth-callback', 'login-methods', 'account-deletion']) assert.ok(byName.has(existing), existing);
  assert.ok(routes.some((r) => r.route.startsWith('(tabs)')), 'the tab group');
  assert.ok([...byName.keys()].filter((name) => name === '+not-found').length === 1, 'exactly one not-found route');
});

test('combined send contract: the send port of this build is the unconnected one, so no send can ever be offered', { skip: SKIP }, async () => {
  const port = await import('../src/features/manual-publish/manual-publish-port.ts');
  const model = await import('../src/features/manual-publish/manual-publish-model.ts');
  const flow = await import('../src/features/manual-publish/manual-publish-flow.ts');
  assert.equal(port.getManualPublishPort(), port.UNCONNECTED_MANUAL_PUBLISH_PORT);
  assert.ok(Object.isFrozen(port.UNCONNECTED_MANUAL_PUBLISH_PORT));
  const target = { targetId: '00000000-0000-4000-8000-000000000001', provider: 'x', connectedAccountId: 'X_A', renderedText: 'hi', media: [], consent: { confirmed: true, contentSha256: 'a'.repeat(64) } };
  assert.deepEqual(await port.getManualPublishPort().send(target), { kind: 'refused', targetId: target.targetId, code: 'PORT_NOT_CONNECTED', retryable: false });
  // The readiness the screen would obtain from this build's port is "not connected", and the gate then stays shut -- for real data.
  const record = await flow.runReadinessCheck({ port: port.getManualPublishPort(), now: () => 10_000, newRequestId: () => 'x', memory: flow.createAttemptMemory(), store: {} }, 'X_A');
  assert.equal(record.result.kind, 'not_connected');
  let state = model.createInitialState();
  const step = (action) => { state = model.manualPublishReducer(state, action); };
  step({ type: 'account_selected', accountId: 'X_A' });
  step({ type: 'draft_changed', text: 'hi' });
  step({ type: 'confirm_opened' });
  step({ type: 'readiness_received', record });
  step({ type: 'consent_changed', checked: true });
  const account = { id: 'X_A', brandId: 'A', platform: 'x', profile: { displayName: 'x', handle: '@x', avatarColor: '#000' }, connectionStatus: 'connected', postingState: 'active' };
  for (const dataStatus of ['ready', 'mock_preview', 'loading', 'blocked', 'unavailable']) {
    const gate = model.sendGate({ now: 10_500, signedIn: true, dataStatus, account, state });
    assert.equal(gate.allowed, false, dataStatus);
  }
  assert.equal(model.sendGate({ now: 10_500, signedIn: true, dataStatus: 'ready', account, state }).reason, 'port_not_connected');
  assert.equal(model.sendGate({ now: 10_500, signedIn: true, dataStatus: 'mock_preview', account, state }).reason, 'demo_data');
});

test('the two features do not know each other: the not-found screen shares nothing with the post screen, the post screen reads no link', { skip: SKIP }, () => {
  const notFoundImports = importsOf('src/app/+not-found.tsx');
  assert.ok(!notFoundImports.some((spec) => /manual-publish|AsyncStorage|async-storage|auth|provider|supabase/iu.test(spec)), notFoundImports.join(','));
  for (const file of ['src/app/manual-publish.tsx', ...featureFiles()]) {
    assert.ok(!importsOf(file).some((spec) => /not-found/u.test(spec)), file);
  }
  // A link (deep link, forged URL) cannot pre-fill or steer the post screen: it reads no route parameters at all.
  assert.deepEqual(namedImportsFrom('src/app/manual-publish.tsx', 'expo-router'), ['Link', 'Stack'], 'only navigation components, no link-reading hook');
  assert.deepEqual(namedImportsFrom('src/app/+not-found.tsx', 'expo-router'), ['Link']);
  const screen = codeOf('src/app/manual-publish.tsx');
  assert.ok(!/useLocalSearchParams|useGlobalSearchParams|usePathname|useSegments|useRootNavigationState|createURL|Linking/u.test(screen));
  // ...and the not-found screen touches neither the draft nor the unresolved-attempt keys.
  const notFound = codeOf('src/app/+not-found.tsx');
  assert.ok(!/postona\.manual-publish|draftKeyOf|storeKeyOf|attemptStore|draftStore/u.test(notFound));
});

test('no source of either feature can reach the network, a Supabase client, an Edge Function or a credential', { skip: SKIP }, () => {
  const forbidden = [/\bfetch\b/u, /XMLHttpRequest/u, /\bWebSocket\b/u, /\bsupabase\b/iu, /\.functions\b/u, /\binvoke\b/u, /api\.x\.com|twitter\.com/u, /\bAuthorization\b|\bBearer\b/u, /refresh_?token|provider_token/iu, /\bcreateClient\b/u, /\bsetTimeout\b|\bsetInterval\b/u, /\bconsole\b/u];
  for (const file of ['src/app/manual-publish.tsx', 'src/app/+not-found.tsx', ...featureFiles()]) {
    const code = codeOf(file);
    for (const pattern of forbidden) {
      // The adapter alone hands the person's OWN session token to an injected transport (its tests prove it never reaches an outcome).
      if (file.endsWith('single-post-port.ts') && /access_?token/iu.test(pattern.source)) continue;
      assert.ok(!pattern.test(code), `${file} matches ${pattern}`);
    }
    if (!file.endsWith('single-post-port.ts')) assert.ok(!/access_?token/iu.test(code), `${file} names an access token`);
  }
  assert.equal(trapped, 0);
});

test('the device storage is reached from ONE file, and only the two short-lived records of the post screen use it', { skip: SKIP }, () => {
  const users = [...featureFiles(), 'src/app/manual-publish.tsx', 'src/app/+not-found.tsx'].filter((file) => /async-storage/u.test(readFileSync(join(ROOT, file), 'utf8')));
  assert.deepEqual(users, ['src/features/manual-publish/manual-publish-storage.ts']);
  const store = readFileSync(join(ROOT, 'src/features/manual-publish/manual-publish-store.ts'), 'utf8');
  const draft = readFileSync(join(ROOT, 'src/features/manual-publish/manual-publish-draft-store.ts'), 'utf8');
  assert.ok(/postona\.manual-publish\.unresolved\.v/u.test(store));
  assert.ok(/postona\.manual-publish\.draft\.v/u.test(draft));
});
