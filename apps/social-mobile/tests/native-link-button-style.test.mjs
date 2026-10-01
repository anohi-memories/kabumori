// Root cause of the invisible native buttons (login-methods, iOS Release):
// <Link asChild> renders expo-router's Slot, which merges `style` as
// `{ ...slotStyle, ...childStyle }`. A Pressable's function-valued style
// (`({ pressed }) => [...]`) spreads to `{}`, so the button lost its background,
// padding and border while its white label stayed -> blank button, tap area intact.
// These checks keep that composition out of the screens and keep the account
// entry points discoverable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = new URL('..', import.meta.url).pathname;

async function parse(rel) {
  const text = await readFile(join(ROOT, rel), 'utf8');
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

const isJsx = (node) => ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
const openingOf = (node) => (ts.isJsxElement(node) ? node.openingElement : node);
const tagName = (node) => openingOf(node).tagName.getText();
const attr = (node, name) => openingOf(node).attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText() === name);
const children = (node) => (ts.isJsxElement(node) ? node.children.filter(isJsx) : []);

function visit(node, fn, ancestors = []) {
  if (isJsx(node)) fn(node, ancestors);
  node.forEachChild((child) => visit(child, fn, isJsx(node) ? [...ancestors, node] : ancestors));
}

/** `<Link asChild>` whose direct child sets `style` to a function. */
function linkAsChildFunctionStyle(sf) {
  const found = [];
  visit(sf, (node) => {
    if (tagName(node) !== 'Link' || !attr(node, 'asChild')) return;
    for (const child of children(node)) {
      const style = attr(child, 'style');
      const expression = style?.initializer && ts.isJsxExpression(style.initializer) ? style.initializer.expression : undefined;
      if (expression && (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression))) {
        found.push(`${sf.fileName}:${sf.getLineAndCharacterOfPosition(child.getStart()).line + 1}`);
      }
    }
  });
  return found;
}

/** The Pressable that contains `label` as its text, with the ancestors it sits in. */
function pressableWithLabel(sf, label) {
  let result = null;
  visit(sf, (node, ancestors) => {
    if (tagName(node) === 'Pressable' && node.getText().includes(label)) result = { node, ancestors };
  });
  return result;
}

async function appFiles() {
  const out = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.tsx')) out.push(relative(ROOT, path));
    }
  }
  await walk(join(ROOT, 'src/app'));
  await walk(join(ROOT, 'src/components'));
  return out.sort();
}

// Files owned by another in-flight change (X-connect / account switching). Same
// defect, reported separately; remove from this list when it is fixed there.
const KNOWN_UNFIXED = new Set(['src/app/accounts/index.tsx']);

test('login-methods and settings never put a function-valued style under <Link asChild>', async () => {
  for (const file of ['src/app/login-methods.tsx', 'src/app/(tabs)/settings.tsx']) {
    assert.deepEqual(linkAsChildFunctionStyle(await parse(file)), [], file);
  }
});

test('no other screen or component adds the blank-button composition (known file excepted)', async () => {
  const offenders = [];
  for (const file of await appFiles()) {
    if (KNOWN_UNFIXED.has(file)) continue;
    offenders.push(...linkAsChildFunctionStyle(await parse(file)));
  }
  assert.deepEqual(offenders, []);
});

test('the detector flags the original composition (guards against a silent no-op test)', () => {
  const sf = ts.createSourceFile(
    'sample.tsx',
    `export const x = <Link href="/a" asChild><Pressable style={({ pressed }) => [s.button, pressed && s.p]}><Text>a</Text></Pressable></Link>;`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  assert.equal(linkAsChildFunctionStyle(sf).length, 1);
});

test('the two login-methods buttons are standalone pressables that navigate on press', async () => {
  const sf = await parse('src/app/login-methods.tsx');
  const cases = [
    ['投稿用のX接続を確認する', '/accounts'],
    ['アカウントの削除について', '/account-deletion'],
  ];
  for (const [label, route] of cases) {
    const found = pressableWithLabel(sf, label);
    assert.ok(found, `${label}: pressable exists`);
    assert.ok(!found.ancestors.some((a) => tagName(a) === 'Link'), `${label}: not wrapped in Link`);
    const onPress = attr(found.node, 'onPress')?.getText() ?? '';
    assert.ok(onPress.includes('router.push') && onPress.includes(`'${route}'`), `${label}: navigates to ${route}`);
    const style = attr(found.node, 'style')?.getText() ?? '';
    assert.ok(style.includes('styles.button'), `${label}: keeps the button style`);
    assert.ok(found.node.getText().includes('styles.buttonText'), `${label}: label style kept`);
  }
});

test('Settings has a visible account-management entry that opens login-methods, above the long form', async () => {
  const sf = await parse('src/app/(tabs)/settings.tsx');
  const found = pressableWithLabel(sf, 'アカウントを管理する');
  assert.ok(found, 'entry exists');
  assert.ok(!found.ancestors.some((a) => tagName(a) === 'Link'), 'not wrapped in Link');
  const onPress = attr(found.node, 'onPress')?.getText() ?? '';
  assert.ok(onPress.includes('router.push') && onPress.includes("'/login-methods'"), 'opens /login-methods');
  const text = sf.getFullText();
  for (const word of ['ログイン方法', '投稿用のXアカウントの接続', 'アカウントの削除']) assert.ok(text.includes(word), word);
  assert.ok(text.indexOf('アカウント管理') < text.indexOf('コンテンツ設定'), 'entry sits above the content form');
});
