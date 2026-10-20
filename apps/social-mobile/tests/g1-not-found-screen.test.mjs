// G1 (F1) -- G2 QA U2: the screen shown for a link the app does not have (src/app/+not-found.tsx).
// expo-router's default "Unmatched Route" screen is English, prints the received URL and links to /_sitemap. This
// screen must show nothing of the link, log nothing, take nothing from the router and offer only the way home.
// Proven offline: the REAL file is transpiled and rendered with stubbed React Native / router modules whose
// link-reading hooks throw; expo-router's own route builder shows that this file replaces the default screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const ROOT = new URL('..', import.meta.url).pathname;
const FILE = 'src/app/+not-found.tsx';

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

const source = () => readFileSync(join(ROOT, FILE), 'utf8');
const codeOnly = (text) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, removeComments: true } }).outputText;

const HOSTILE = [
  '/oauth-callback?access_token=eyJhbGciOi.SECRET-PAYLOAD.sig&refresh_token=REFRESH-SECRET',
  '/?code=AUTH-CODE-123&state=STATE-456#fragment=FRAG-789',
  'kabumori-social://unknown?token=DEEPLINK-TOKEN&user_id=USER-1&email=person@example.com',
  '/%252e%252e/%2525%2570ath?x=%25%32%35',
  '/%E0%A4%A/%zz?q=%',
  `/${'a'.repeat(5000)}?${'k=v&'.repeat(500)}`,
  '/_sitemap',
  '/_sitemap?internal=1',
  'javascript:alert(document.cookie)',
  '//evil.example/phish?next=/accounts',
  '/ユーザー/トークン?コード=ひみつ#かけら',
  '/(tabs)/../../etc/passwd',
  '/\u0000𐏿‮',
];
const MARKERS = ['SECRET', 'REFRESH', 'AUTH-CODE', 'STATE-456', 'FRAG-789', 'DEEPLINK', 'USER-1', 'person@example.com', 'evil.example', 'passwd', 'cookie', 'access_token', 'refresh_token', 'ひみつ', 'ユーザー', 'aaaaaaaaaa'];

/** Render the real file. Every router hook that could read the link throws; a spy records any console output. */
async function load() {
  const calls = [];
  const consoleCalls = [];
  const trap = (name) => () => { calls.push(name); throw new Error(`${name} must not be called by the not-found screen`); };
  const stubs = {
    'react/jsx-runtime': { jsx: (type, props, key) => ({ type: typeof type === 'function' ? type.name : type, props, key }), jsxs: (type, props, key) => ({ type: typeof type === 'function' ? type.name : type, props, key }), Fragment: 'Fragment' },
    'react-native': { Text: 'Text', View: 'View' },
    'expo-router': {
      Link: 'Link',
      usePathname: trap('usePathname'), useLocalSearchParams: trap('useLocalSearchParams'), useGlobalSearchParams: trap('useGlobalSearchParams'),
      useSegments: trap('useSegments'), useRootNavigationState: trap('useRootNavigationState'), useRouter: trap('useRouter'),
      useNavigation: trap('useNavigation'), useRoute: trap('useRoute'), useUnstableGlobalHref: trap('useUnstableGlobalHref'),
    },
    'expo-status-bar': { StatusBar: 'StatusBar' },
    '@/constants/theme': { colors: new Proxy({}, { get: (_t, name) => String(name) }), spacing: { xs: 6, sm: 10, md: 16, lg: 22, xl: 32 } },
    '@/components/ui': { ActionButton: 'ActionButton', Screen: 'Screen', styles: { muted: { muted: true } } },
  };
  const js = ts.transpileModule(source(), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const mod = { exports: {} };
  const spy = { log: (...a) => consoleCalls.push(['log', a]), warn: (...a) => consoleCalls.push(['warn', a]), error: (...a) => consoleCalls.push(['error', a]), info: (...a) => consoleCalls.push(['info', a]), debug: (...a) => consoleCalls.push(['debug', a]) };
  vm.runInNewContext(js, { module: mod, exports: mod.exports, console: spy, require: (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; } }, { filename: '+not-found.tsx' });
  return { Screen: mod.exports.default, calls, consoleCalls };
}

const walk = (node, visit) => {
  if (Array.isArray(node)) { node.forEach((child) => walk(child, visit)); return; }
  if (node === null || typeof node !== 'object') return;
  visit(node);
  walk(node.props?.children, visit);
};
const textsOf = (tree) => {
  const out = [];
  walk(tree, (node) => {
    if (node.props?.label) out.push(node.props.label);
    for (const kid of [node.props?.children].flat(Infinity)) if (typeof kid === 'string' || typeof kid === 'number') out.push(String(kid));
  });
  return out;
};

// ---- what the person sees ----------------------------------------------------------------------------------------------------

test('the screen says "page not found" in Japanese and offers exactly one way out: the home screen', async () => {
  const { Screen, calls } = await load();
  const tree = Screen();
  assert.deepEqual(textsOf(tree), ['ページが見つかりません', '開こうとしたリンクは、このアプリでは使えないか、すでに無効です。', 'ホームに戻る']);
  const links = [];
  walk(tree, (node) => { if (node.type === 'Link') links.push(node.props); });
  assert.equal(links.length, 1);
  assert.equal(links[0].href, '/', 'the home screen');
  assert.equal(links[0].replace, true, 'the unknown link is not kept in the back stack');
  const headings = [];
  walk(tree, (node) => { if (node.props?.accessibilityRole === 'header') headings.push(node); });
  assert.equal(headings.length, 1);
  const bars = [];
  walk(tree, (node) => { if (node.type === 'StatusBar') bars.push(node.props.style); });
  assert.deepEqual(bars, ['dark'], 'dark status bar text on the fixed light screen');
  assert.deepEqual(calls, [], 'no router hook was called');
});

// ---- nothing of the link is shown, read or logged ---------------------------------------------------------------------------------------

test('whatever the link is -- tokens, queries, fragments, broken or repeated encodings, giant paths, /_sitemap -- the screen is IDENTICAL and shows none of it', async () => {
  const reference = JSON.stringify(textsOf((await load()).Screen()));
  const referenceTree = JSON.stringify((await load()).Screen());
  for (const hostile of HOSTILE) {
    const { Screen, calls, consoleCalls } = await load();
    // The router may hand a route component props; none of them is used.
    const props = { route: { key: hostile, name: hostile, path: hostile, params: { token: hostile, code: hostile, '+not-found': [hostile] } }, navigation: { getState: () => ({ routes: [{ path: hostile }] }) }, pathname: hostile, url: hostile, segments: [hostile], params: { token: hostile } };
    let tree;
    assert.doesNotThrow(() => { tree = Screen(props); }, hostile.slice(0, 40));
    const serialized = JSON.stringify(tree);
    assert.equal(serialized, referenceTree, `independent of the link: ${hostile.slice(0, 40)}`);
    assert.equal(JSON.stringify(textsOf(tree)), reference);
    for (const marker of MARKERS) assert.ok(!serialized.includes(marker), `${marker} leaked`);
    assert.ok(!/sitemap/iu.test(serialized), 'no sitemap link or text');
    assert.ok(!/Unmatched|Not Found|Sitemap/u.test(serialized), 'none of the default screen\'s text');
    assert.deepEqual(calls, [], 'no router hook was called');
    assert.deepEqual(consoleCalls, [], 'nothing is logged');
  }
});

test('the source reads nothing about the link and logs nothing: only `Link` from the router, no hooks, no console, no network, no sign-in', () => {
  const text = source();
  const code = codeOnly(text);
  const sf = ts.createSourceFile(FILE, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = [];
  sf.forEachChild((node) => {
    if (ts.isImportDeclaration(node)) {
      const names = node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) ? node.importClause.namedBindings.elements.map((e) => e.name.text) : [];
      imports.push([node.moduleSpecifier.text, names]);
    }
  });
  assert.deepEqual(imports, [
    ['expo-router', ['Link']],
    ['expo-status-bar', ['StatusBar']],
    ['react-native', ['Text', 'View']],
    ['@/constants/theme', ['colors', 'spacing']],
    ['@/components/ui', ['ActionButton', 'Screen', 'styles']],
  ]);
  for (const forbidden of [
    /\buse[A-Z]\w*\(/u, /\bconsole\b/u, /\bfetch\b/u, /XMLHttpRequest|WebSocket/u, /\bcreateURL\b|\bLinking\b/u, /\bsupabase\b/iu,
    /oauth|auth-callback|token|session|password|credential/iu, /\bpath(name)?\b|searchParams|\bsegments\b|\bquery\b|\bhref\s*=\s*\{/u, /_sitemap|\bsitemap\b/iu,
  ]) assert.ok(!forbidden.test(code), `the executable code must not match ${forbidden}`);
  assert.ok(/export default function NotFoundScreen\(\) \{/u.test(text), 'a screen with no parameters at all');
});

// ---- expo-router really uses this file instead of its default screen ----------------------------------------------------------------------

function appContext(extraKeys = [], withoutFile = false) {
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
  const all = [...keys, ...extraKeys].filter((key) => !(withoutFile && key === './+not-found.tsx'));
  return Object.assign(() => ({ default: () => null }), { keys: () => all, resolve: (key) => key, id: 'app' });
}
const childrenOf = (options, context) => require('expo-router/build/getRoutes').getRoutes(context, options).children;
const notFoundOf = (children) => children.find((child) => child.route === '+not-found');

test('expo-router resolves the real src/app tree so that `+not-found` is THIS file, not the generated Unmatched screen', () => {
  assert.ok(existsSync(join(ROOT, FILE)), 'the file is in the app root, where expo-router looks for it');
  const own = notFoundOf(childrenOf({}, appContext()));
  assert.ok(own, 'a +not-found route exists');
  assert.equal(own.contextKey, './+not-found.tsx');
  assert.ok(!own.generated && !own.internal, 'not the generated default');
  // Control (FAIL before this change): without the file, expo-router generates its English Unmatched screen.
  const generated = notFoundOf(childrenOf({}, appContext([], true)));
  assert.equal(generated.contextKey, 'expo-router/build/views/Unmatched.js');
  assert.ok(generated.generated && generated.internal);
});

test('read-only state of the shared setting: the `/_sitemap` route is still generated unless the router option `sitemap: false` is set (NOT FIXED here; owner: shared app config)', () => {
  const routes = (options) => childrenOf(options, appContext()).map((child) => child.route);
  assert.ok(routes({}).includes('_sitemap'), 'default: the sitemap route exists');
  assert.ok(routes({ sitemap: true }).includes('_sitemap'));
  assert.ok(!routes({ sitemap: false }).includes('_sitemap'), 'what the shared config option would do');
  assert.ok(routes({ sitemap: false }).includes('+not-found'), 'and the not-found screen is unaffected');
  // This change touches no shared config: app.json is not part of it.
  const appJson = JSON.parse(readFileSync(join(ROOT, 'app.json'), 'utf8'));
  assert.ok(Array.isArray(appJson.expo.plugins));
});

test('no network entry point was touched by any step', () => {
  assert.equal(trapped, 0);
});
