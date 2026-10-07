// POSTONA provider domain (Phase 2a1): the app's copy of the pure provider model. Parity with the server
// copy is enforced by supabase/functions/_shared/social/provider_domain_parity_test.ts; this file checks
// the app module on its own and that nothing in the app uses it yet (no behavior change).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as domain from '../src/domain/provider-domain.ts';

const root = resolve(import.meta.dirname, '..');

test('provider ids are exactly x, threads, instagram, matching SocialPlatform', async () => {
  assert.deepEqual([...domain.PROVIDER_IDS], ['x', 'threads', 'instagram']);
  const types = await readFile(resolve(root, 'src/domain/types.ts'), 'utf8');
  const union = /export type SocialPlatform = ([^;]+);/u.exec(types)[1];
  assert.deepEqual([...union.matchAll(/'([a-z]+)'/gu)].map((m) => m[1]).sort(), [...domain.PROVIDER_IDS].sort());
});

test('an unknown provider is refused (fail closed)', () => {
  for (const value of ['X', ' x', 'twitter', 'facebook', '', null, undefined, 0, {}, '__proto__', 'toString']) {
    assert.equal(domain.parseProviderId(value), null, String(value));
    assert.equal(domain.providerCapabilities(value), null, String(value));
  }
  assert.equal(domain.parseProviderId('instagram'), 'instagram');
});

test('structural capabilities: X single call with rotating refresh; Threads and Instagram container flow with long-lived access; Instagram needs media', () => {
  const { x, threads, instagram } = domain.PROVIDER_CAPABILITIES;
  assert.deepEqual([x.publishFlow, x.credentialProfile, x.textOnly, x.mediaRequired], ['single_call', 'oauth2_rotating_refresh', true, false]);
  assert.deepEqual([threads.publishFlow, threads.credentialProfile, threads.textOnly, threads.mediaRequired], ['container_then_publish', 'long_lived_access', true, false]);
  assert.deepEqual([instagram.publishFlow, instagram.credentialProfile, instagram.textOnly, instagram.mediaRequired], ['container_then_publish', 'long_lived_access', false, true]);
  assert.ok(Object.isFrozen(domain.PROVIDER_CAPABILITIES) && Object.isFrozen(instagram));
});

test('target shape and target-level retry rules', () => {
  const image = [{ assetId: 'asset_1', kind: 'image' }];
  assert.equal(domain.checkTargetShape({ provider: 'threads', renderedText: '本文', media: [] }), null);
  assert.equal(domain.checkTargetShape({ provider: 'instagram', renderedText: '本文', media: [] }), 'TEXT_ONLY_NOT_SUPPORTED');
  assert.equal(domain.checkTargetShape({ provider: 'instagram', renderedText: '本文', media: image }), null);
  assert.equal(domain.checkTargetShape({ provider: 'mastodon', renderedText: '本文', media: [] }), 'PROVIDER_UNSUPPORTED');
  assert.deepEqual(domain.publishStepsFor('container_then_publish'), ['prepare', 'await_ready', 'publish']);
  assert.equal(domain.mayRetryTarget({ kind: 'uncertain', targetId: 't', code: 'C' }), false);
  assert.equal(domain.mayRetryTarget({ kind: 'rejected', targetId: 't', code: 'C' }), true);
});

test('no behavior change: no app source file imports the provider domain yet, and it imports nothing', async () => {
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(ts|tsx)$/u.test(entry.name) && !/\.test\.ts$/u.test(entry.name)) files.push(path);
    }
  };
  await walk(resolve(root, 'src'));
  const importers = [];
  for (const file of files) {
    if (file.endsWith('provider-domain.ts')) continue;
    if (/provider-domain/u.test(await readFile(file, 'utf8'))) importers.push(file);
  }
  assert.deepEqual(importers, []);
  const source = await readFile(resolve(root, 'src/domain/provider-domain.ts'), 'utf8');
  assert.equal(/^\s*import\b/mu.test(source), false);
});
