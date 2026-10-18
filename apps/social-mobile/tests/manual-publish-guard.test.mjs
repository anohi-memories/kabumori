// F1 manual X single post: static guards. The feature has no way to reach the network, Supabase, Edge
// Functions or any credential in this build, imports only what it is allowed to, and the home entry is the
// same working Link/ActionButton composition the other home buttons use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';

const ROOT = new URL('..', import.meta.url).pathname;
const FEATURE_DIR = 'src/features/manual-publish';
const ROUTE = 'src/app/manual-publish.tsx';

async function sources() {
  const names = (await readdir(join(ROOT, FEATURE_DIR))).filter((n) => /\.(ts|tsx)$/u.test(n)).map((n) => `${FEATURE_DIR}/${n}`);
  return [...names, ROUTE];
}

const ALLOWED_IMPORTS = new Set([
  'react',
  'react-native',
  'expo-router',
  'expo-crypto',
  '@/constants/theme',
  '@/components/ui',
  '@/domain/types',
  '@/features/manual-publish/manual-post-preview',
  '@/features/manual-publish/manual-publish-flow',
  '@/features/manual-publish/manual-publish-model',
  '@/features/manual-publish/manual-publish-port',
  '@/features/manual-publish/manual-publish-storage',
  '@/providers/active-account-provider',
  '@/providers/auth-provider',
  '@/providers/data-provider',
  '../../domain/schedule-planner.ts',
  '../../domain/types.ts',
  './manual-publish-flow.ts',
  './manual-publish-hash.ts',
  './manual-publish-model.ts',
  './manual-publish-port.ts',
  './manual-publish-store.ts',
  './single-post-contract.ts',
]);

// The device storage is touched by ONE file, which holds no logic; every other file reaches it only through the
// injected store (manual-publish-store.ts), so its failures can be simulated and proven offline.
const STORAGE_FILE = `${FEATURE_DIR}/manual-publish-storage.ts`;
const STORAGE_ONLY_IMPORTS = new Set(['@react-native-async-storage/async-storage']);

test('the feature has exactly the expected files', async () => {
  assert.deepEqual(
    (await sources()).sort(),
    [
      'src/app/manual-publish.tsx',
      'src/features/manual-publish/manual-post-preview.tsx',
      'src/features/manual-publish/manual-publish-flow.ts',
      'src/features/manual-publish/manual-publish-hash.ts',
      'src/features/manual-publish/manual-publish-model.ts',
      'src/features/manual-publish/manual-publish-port.ts',
      'src/features/manual-publish/manual-publish-storage.ts',
      'src/features/manual-publish/manual-publish-store.ts',
      'src/features/manual-publish/single-post-contract.ts',
      'src/features/manual-publish/single-post-port.ts',
    ],
  );
});

test('every import is on the allow-list: no Supabase, data layer, OAuth, storage or network client', async () => {
  for (const rel of await sources()) {
    const sf = ts.createSourceFile(rel, await readFile(join(ROOT, rel), 'utf8'), ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const imports = [];
    sf.forEachChild((node) => { if (ts.isImportDeclaration(node)) imports.push(node.moduleSpecifier.text); });
    for (const spec of imports) {
      const storageOnly = rel === STORAGE_FILE && STORAGE_ONLY_IMPORTS.has(spec);
      assert.ok(ALLOWED_IMPORTS.has(spec) || storageOnly, `${rel} imports "${spec}", which is not allowed`);
    }
  }
});

test('the compiled code (comments removed) names no network, credential or storage API', async () => {
  const forbidden = [
    /\bfetch\b/u, /XMLHttpRequest/u, /\bWebSocket\b/u, /\bsupabase\b/iu, /\.functions\b/u, /\binvoke\b/u,
    /api\.x\.com/u, /twitter\.com/u, /\bAuthorization\b/iu, /\bBearer\b/u, /access_?token/iu, /refresh_?token/iu,
    /\bAsyncStorage\b/u, /SecureStore/u, /\bcreateClient\b/u, /\bsetTimeout\b/u, /\bsetInterval\b/u,
  ];
  for (const rel of await sources()) {
    const text = await readFile(join(ROOT, rel), 'utf8');
    const js = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, removeComments: true } }).outputText;
    for (const pattern of forbidden) {
      // The adapter alone handles the signed-in person's OWN session token, and only to hand it to the injected
      // transport (its tests prove it never reaches an outcome). No other file may name an access token at all.
      if (pattern.source.startsWith('access_') && rel.endsWith('single-post-port.ts')) continue;
      // ...and the one-line device storage file is the only place that names AsyncStorage.
      if (pattern.source === '\\bAsyncStorage\\b' && rel === STORAGE_FILE) continue;
      assert.ok(!pattern.test(js), `${rel} contains ${pattern}`);
    }
  }
});

test('the guarded app copy of the provider model is still imported by no app source (an existing guard)', async () => {
  for (const rel of await sources()) {
    assert.ok(!/provider-domain/u.test(await readFile(join(ROOT, rel), 'utf8')), rel);
  }
});

test('no source of the feature can produce a "sent" result except from a published outcome', async () => {
  const text = await readFile(join(ROOT, `${FEATURE_DIR}/manual-publish-model.ts`), 'utf8');
  const producers = [...text.matchAll(/kind: 'sent'/gu)];
  assert.equal(producers.length, 2, "one type member and one construction (in resultOf's published branch)");
  const resultOf = /export function resultOf[\s\S]*?\n\}\n/u.exec(text)[0];
  assert.ok(/case 'published':[\s\S]*?kind: 'sent'/u.test(resultOf));
  for (const rel of await sources()) {
    // single-post-contract.ts names the F3 answer kind `sent`; it is mapped to `published` there and nowhere else.
    if (rel.endsWith('manual-publish-model.ts') || rel.endsWith('single-post-contract.ts')) continue;
    assert.ok(!/kind: 'sent'/u.test(await readFile(join(ROOT, rel), 'utf8')), `${rel} must not construct a sent result`);
  }
});

test('a "published" outcome is constructed in exactly one place: the mapping of F3 `sent` (stored and read back)', async () => {
  const builders = [];
  for (const rel of await sources()) {
    const code = await readFile(join(ROOT, rel), 'utf8');
    if (/\{ kind: 'published',/u.test(code)) builders.push(rel);
  }
  assert.deepEqual(builders, [`${FEATURE_DIR}/single-post-contract.ts`]);
  const contract = await readFile(join(ROOT, `${FEATURE_DIR}/single-post-contract.ts`), 'utf8');
  assert.ok(/case 'sent':\s*return \{ kind: 'published'/u.test(contract));
});

// ---- the home entry ----------------------------------------------------------------------------------------------------------

test('home: the entry is <Link href="/manual-publish" asChild> with an ActionButton as its direct child', async () => {
  const rel = 'src/app/(tabs)/index.tsx';
  const sf = ts.createSourceFile(rel, await readFile(join(ROOT, rel), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  const visit = (node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText() === 'Link') {
      const attrs = node.openingElement.attributes.properties;
      const href = attrs.find((a) => ts.isJsxAttribute(a) && a.name.getText() === 'href');
      const asChild = attrs.some((a) => ts.isJsxAttribute(a) && a.name.getText() === 'asChild');
      if (href?.initializer?.text === '/manual-publish') {
        const kids = node.children.filter((c) => ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c));
        found.push({ asChild, kids: kids.map((k) => (ts.isJsxElement(k) ? k.openingElement.tagName.getText() : k.tagName.getText())) });
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  assert.deepEqual(found, [{ asChild: true, kids: ['ActionButton'] }]);
});

test('home: the entry text promises nothing the build does not do', async () => {
  const text = await readFile(join(ROOT, 'src/app/(tabs)/index.tsx'), 'utf8');
  const card = /手入力でXに投稿[\s\S]*?<\/Card>/u.exec(text)[0];
  assert.ok(card.includes('送信は、接続・利用権・投稿許可をサーバーで確認できたときだけ有効になります。'));
  for (const claim of ['投稿されました', '送信しました', '今すぐ投稿', 'すぐに投稿']) assert.ok(!card.includes(claim), claim);
});

test('existing screens that other owners edit are not part of this feature', async () => {
  // The feature neither imports nor renames them; the diff of this change is checked against them in review.
  for (const rel of await sources()) {
    const text = await readFile(join(ROOT, rel), 'utf8');
    for (const protectedPath of ['(tabs)/schedule', 'login-methods', 'account-deletion', 'service-lifecycle', 'service-enrollment', 'x-connect', 'x-oauth']) {
      assert.ok(!text.includes(protectedPath), `${rel} mentions ${protectedPath}`);
    }
  }
});

// ---- restart safety: what the device may keep ---------------------------------------------------------------------------------

test('the durable record is hash-only: no post text, no token, no consent flag can be written to the device', async () => {
  const text = await readFile(join(ROOT, `${FEATURE_DIR}/manual-publish-store.ts`), 'utf8');
  const serialize = /function serialize[\s\S]*?\n\}\n/u.exec(text)[0];
  const fields = [...serialize.matchAll(/(\w+): (?:STORE_VERSION|attempt\.\w+)/gu)].map((match) => match[1]).sort();
  assert.deepEqual(fields, ['accountId', 'contentSha256', 'kind', 'requestId', 'savedAt', 'v']);
  for (const forbiddenField of [/\btext\b/u, /renderedText/u, /\bdraft\b/u, /token/iu, /consent/iu, /session/iu, /providerPostId/u]) {
    assert.ok(!forbiddenField.test(serialize), `serialize() must not mention ${forbiddenField}`);
  }
  const type = /export type PersistedAttempt = [\s\S]*?\}>;/u.exec(text)[0];
  assert.ok(!/\btext\b/u.test(type), 'the persisted type has no text field');
});

test('only the storage file imports the device storage, and the screen reaches it through that file alone', async () => {
  for (const rel of await sources()) {
    const code = await readFile(join(ROOT, rel), 'utf8');
    const importsAsyncStorage = /from '@react-native-async-storage\/async-storage'/u.test(code);
    assert.equal(importsAsyncStorage, rel === STORAGE_FILE, rel);
  }
  const route = await readFile(join(ROOT, ROUTE), 'utf8');
  assert.ok(route.includes("from '@/features/manual-publish/manual-publish-storage'"));
});
