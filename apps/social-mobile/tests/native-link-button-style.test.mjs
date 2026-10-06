// Root cause of the invisible native buttons (login-methods, iOS Release):
// <Link asChild> renders expo-router's Slot, which merges `style` as
// `{ ...slotStyle, ...childStyle }`. A Pressable's function-valued style
// (`({ pressed }) => [...]`) spreads to `{}`, so the button lost its background,
// padding and border while its white label stayed -> blank button, tap area intact.
// A second, related class: <Link asChild> only injects its press handler into
// its direct child. `Card` and `View` do not accept/forward `onPress`, so a
// Link around them is a dead tap on native. These checks keep both compositions
// out of the screens and keep the account entry points discoverable.
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

/**
 * Components that really receive the `onPress` <Link asChild> injects:
 * RN touchables/Text and our own ActionButton (forwards onPress to a Pressable).
 * Anything else (Card, View, ...) swallows it -> dead tap on native.
 */
const PRESS_FORWARDING = new Set(['Pressable', 'ActionButton', 'Text', 'TouchableOpacity', 'TouchableHighlight', 'TouchableWithoutFeedback']);

/** `<Link asChild>` whose direct child cannot receive the injected press handler. */
function linkAsChildNonInteractiveChild(sf) {
  const found = [];
  visit(sf, (node) => {
    if (tagName(node) !== 'Link' || !attr(node, 'asChild')) return;
    for (const child of children(node)) {
      if (!PRESS_FORWARDING.has(tagName(child))) {
        found.push(`${sf.fileName}:${sf.getLineAndCharacterOfPosition(child.getStart()).line + 1} <${tagName(child)}>`);
      }
    }
  });
  return found;
}

const brokenLink = (sf) => [...linkAsChildFunctionStyle(sf), ...linkAsChildNonInteractiveChild(sf)];

function sample(source) {
  return ts.createSourceFile('sample.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** Pressables that navigate to `route` with router.push, with the ancestors they sit in. */
function pressablesNavigatingTo(sf, route) {
  const out = [];
  visit(sf, (node, ancestors) => {
    if (tagName(node) !== 'Pressable') return;
    const onPress = attr(node, 'onPress')?.getText() ?? '';
    if (onPress.includes('router.push') && onPress.includes(route)) out.push({ node, ancestors });
  });
  return out;
}

function assertStandaloneNavigation(sf, route, why) {
  const found = pressablesNavigatingTo(sf, route);
  assert.ok(found.length >= 1, `${why}: a Pressable pushes ${route}`);
  for (const { node, ancestors } of found) {
    assert.ok(!ancestors.some((a) => tagName(a) === 'Link'), `${why}: not wrapped in Link`);
    assert.ok(attr(node, 'accessibilityRole'), `${why}: has an accessibility role`);
  }
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

test('login-methods and settings contain neither broken Link-asChild composition', async () => {
  for (const file of ['src/app/login-methods.tsx', 'src/app/(tabs)/settings.tsx']) {
    assert.deepEqual(brokenLink(await parse(file)), [], file);
  }
});

test('no screen or component anywhere in src/app and src/components has a broken Link-asChild child', async () => {
  const offenders = [];
  for (const file of await appFiles()) offenders.push(...brokenLink(await parse(file)));
  assert.deepEqual(offenders, []);
});

test('the detectors flag the broken compositions (guards against a silent no-op test)', () => {
  const fnStyle = sample(`export const x = <Link href="/a" asChild><Pressable style={({ pressed }) => [s.button, pressed && s.p]}><Text>a</Text></Pressable></Link>;`);
  assert.equal(linkAsChildFunctionStyle(fnStyle).length, 1);
  assert.equal(brokenLink(fnStyle).length, 1);
  const card = sample(`export const x = <Link href="/a" asChild><Card><Text>a</Text></Card></Link>;`);
  assert.equal(linkAsChildNonInteractiveChild(card).length, 1);
  const view = sample(`export const x = <Link href="/a" asChild><View><Text>a</Text></View></Link>;`);
  assert.equal(linkAsChildNonInteractiveChild(view).length, 1);
});

test('the detectors accept the compositions that do work on native', () => {
  const good = sample(`
    export const a = <Link href="/a" asChild><ActionButton label="x" onPress={() => {}} /></Link>;
    export const b = <Link href="/a" asChild><Pressable style={styles.card}><Text>x</Text></Pressable></Link>;
    export const c = <Link href="/a" asChild><Text>x</Text></Link>;
    export const d = <Link href="/a"><Card><Text>x</Text></Card></Link>;
  `);
  assert.deepEqual(brokenLink(good), []);
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

test('Accounts「ログイン方法」 card is an interactive element that navigates to /login-methods', async () => {
  const sf = await parse('src/app/accounts/index.tsx');
  const found = assertStandaloneNavigation(sf, "'/login-methods'", 'accounts → login-methods');
  const text = found.map((f) => f.node.getText()).join('\n');
  assert.ok(text.includes('ログイン方法'), 'readable label kept');
  assert.ok(text.includes('styles.card'), 'card styling kept');
});

test('Accounts rows open the account detail through an interactive element', async () => {
  const sf = await parse('src/app/accounts/index.tsx');
  assertStandaloneNavigation(sf, "'/accounts/[id]'", 'accounts row');
});

test('Settings「会話で相談する」 is interactive and navigates to /(tabs)/consult', async () => {
  const sf = await parse('src/app/(tabs)/settings.tsx');
  const found = assertStandaloneNavigation(sf, "'/(tabs)/consult'", 'settings → consult');
  const text = found.map((f) => f.node.getText()).join('\n');
  assert.ok(text.includes('会話で相談する') && text.includes('自然な言葉で希望を伝え'), 'existing copy kept');
});

test('Schedule and History rows open the post detail through an interactive element', async () => {
  for (const file of ['src/app/(tabs)/schedule.tsx', 'src/app/(tabs)/history.tsx']) {
    assertStandaloneNavigation(await parse(file), "'/posts/[id]'", file);
  }
});
