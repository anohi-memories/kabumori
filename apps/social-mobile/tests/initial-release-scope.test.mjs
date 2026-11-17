// G1-02 gen2 TASK 2: initial release = Threads + X; Instagram is "later" with no action. Local only, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as release from '../src/domain/initial-release.ts';

const root = resolve(import.meta.dirname, '..');
const read = (p) => readFile(resolve(root, p), 'utf8');

test('initial release providers are exactly threads and x; everything else is deferred (fail closed)', () => {
  assert.deepEqual([...release.INITIAL_RELEASE_PROVIDERS].sort(), ['threads', 'x']);
  for (const ok of ['x', 'threads']) assert.equal(release.isDeferredProvider(ok), false, ok);
  for (const later of ['instagram', 'X', ' x', '', null, undefined, 0, 'mastodon']) assert.equal(release.isDeferredProvider(later), true, String(later));
  assert.match(release.DEFERRED_PROVIDER_TEXT, /後日/u);
});

test('account list and detail show Instagram as 後日対応 with no select/publish/connect action', async () => {
  const list = await read('src/app/accounts/index.tsx');
  const detail = await read('src/app/accounts/[id].tsx');
  for (const [name, src] of [['list', list], ['detail', detail]]) {
    assert.match(src, /isDeferredProvider\(account\.platform\)/u, name);
    assert.match(src, /DEFERRED_PROVIDER_LABEL/u, name);
  }
  // The deferred branch returns before the select button / publish setting card are reached.
  assert.ok(list.indexOf('isDeferredProvider(account.platform)') < list.indexOf('このアカウントを選択'));
  assert.ok(detail.indexOf('isDeferredProvider(account.platform)') < detail.indexOf('<PublishSettingCard'));
  const deferredBranch = list.slice(list.indexOf('isDeferredProvider(account.platform)'), list.indexOf('このアカウントを選択'));
  assert.doesNotMatch(deferredBranch.split('return (\n          <Card key')[0], /selectAccount|ActionButton|onPress/u);
});

test('the active account can never be a deferred provider', async () => {
  const src = await read('src/providers/active-account-provider.tsx');
  assert.match(src, /isInitialReleaseProvider/u);
  assert.doesNotMatch(src, /accounts\[0\]/u);
});

test('Instagram connect/publish is not added: no instagram oauth/publish module exists in features', async () => {
  const { readdir } = await import('node:fs/promises');
  const features = await readdir(resolve(root, 'src/features'));
  assert.deepEqual(features.filter((f) => /instagram/iu.test(f)), []);
});
