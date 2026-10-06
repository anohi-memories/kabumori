// D1: the data source must not silently fall back to the mock preview on native.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { dataSourceMode, initialDataStatusFor, INVALID_DATA_SOURCE_REASON } from '../src/data/data-source-mode.ts';
import * as modeModule from '../src/data/data-source-mode.ts';

const root = resolve(import.meta.dirname, '..');

test('mode: exactly supabase is real data; unset/empty/mock is the explicit preview; anything else is invalid', () => {
  assert.equal(dataSourceMode('supabase'), 'supabase');
  assert.equal(dataSourceMode(' supabase '), 'supabase');
  for (const value of [undefined, '', '  ', 'mock']) assert.equal(dataSourceMode(value), 'mock', String(value));
  for (const value of ['Supabase', 'prod', 'real', 'true', 'supabase2']) assert.equal(dataSourceMode(value), 'invalid', value);
  assert.equal(initialDataStatusFor('supabase'), 'loading');
  assert.equal(initialDataStatusFor('mock'), 'mock_preview');
  assert.equal(initialDataStatusFor('invalid'), 'blocked');
});

/**
 * Loads the real repository-selection.ts the way a native (Metro) bundle sees it:
 * every static `process.env.EXPO_PUBLIC_X` is replaced by its literal, and the
 * remaining `process.env` object is EMPTY.
 */
async function loadNativeStyle(publicEnv) {
  let source = await readFile(join(root, 'src/data/repository-selection.ts'), 'utf8');
  source = source.replace(/process\.env\.(EXPO_PUBLIC_[A-Z_]+)/gu, (_, name) => (name in publicEnv ? JSON.stringify(publicEnv[name]) : 'undefined'));
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  class SupabaseSocialRepository { constructor(client) { this.client = client; } }
  const stubs = {
    '@/lib/supabase': {
      supabase: { stub: true },
      getSupabaseConfig: (env) => (env.EXPO_PUBLIC_SUPABASE_URL && env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY
        ? { ok: true, config: {} } : { ok: false, kind: 'missing', reason: 'Supabase接続設定がありません。' }),
    },
    '@/data/mock-repository': { mockRepository: { mock: true } },
    '@/data/supabase-repository': { SupabaseSocialRepository },
    '@/data/data-source-mode': modeModule,
  };
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, process: { env: {} }, require: (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; } }, { filename: 'repository-selection.ts' });
  return module.exports;
}

const REAL = { EXPO_PUBLIC_DATA_SOURCE: 'supabase', EXPO_PUBLIC_SUPABASE_URL: 'https://fixture.supabase.co', EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture' };

test('native production-style env (statically inlined, process.env itself empty) selects the real repository', async () => {
  const selection = await loadNativeStyle(REAL);
  const selected = selection.selectDataSource();
  assert.equal(selected.kind, 'supabase');
  assert.deepEqual({ ...selected.repository.client }, { stub: true });
  assert.equal(selection.initialDataStatus(), 'loading');
});

test('explicit mock and unset stay the preview', async () => {
  for (const value of ['mock', undefined]) {
    const selection = await loadNativeStyle({ ...REAL, EXPO_PUBLIC_DATA_SOURCE: value });
    assert.equal(selection.selectDataSource().kind, 'mock', String(value));
    assert.equal(selection.initialDataStatus(), 'mock_preview', String(value));
  }
});

test('invalid or missing configuration is blocked with a truthful reason, never mock or real', async () => {
  const typo = await loadNativeStyle({ ...REAL, EXPO_PUBLIC_DATA_SOURCE: 'Supabase' });
  assert.deepEqual({ ...typo.selectDataSource() }, { kind: 'blocked', reason: INVALID_DATA_SOURCE_REASON });
  assert.equal(typo.initialDataStatus(), 'blocked');
  const noUrl = await loadNativeStyle({ EXPO_PUBLIC_DATA_SOURCE: 'supabase', EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'k' });
  const selected = noUrl.selectDataSource();
  assert.equal(selected.kind, 'blocked');
  assert.match(selected.reason, /Supabase/u);
  assert.equal(noUrl.initialDataStatus(), 'loading', 'loading resolves to blocked on the first load, never to real data');
});

test('the selection and the provider cannot disagree for any value', async () => {
  for (const value of ['supabase', 'mock', undefined, '', 'Supabase', 'x']) {
    const selection = await loadNativeStyle({ ...REAL, EXPO_PUBLIC_DATA_SOURCE: value });
    const kind = selection.selectDataSource().kind;
    const status = selection.initialDataStatus();
    if (kind === 'mock') assert.equal(status, 'mock_preview', String(value));
    else if (kind === 'blocked') assert.ok(['blocked', 'loading'].includes(status), String(value));
    else assert.equal(status, 'loading', String(value));
  }
});

async function sources(dir) {
  const out = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sources(path));
    else if (/\.(ts|tsx)$/u.test(entry.name)) out.push({ path, text: await readFile(join(root, path), 'utf8') });
  }
  return out;
}

test('every EXPO_PUBLIC env read in src is a static property access; the provider uses the shared status', async () => {
  for (const { path, text } of await sources('src')) {
    const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, '');
    assert.doesNotMatch(code, /=\s*process\.env\s*[,)]|process\.env\s*\[|\(\s*process\.env\s*\)|\.\.\.process\.env/u, `${path}: dynamic process.env access is dropped by native bundles`);
  }
  const provider = await readFile(join(root, 'src/providers/data-provider.tsx'), 'utf8');
  assert.match(provider, /useState<DataStatus>\(initialDataStatus\)/u);
  assert.doesNotMatch(provider, /process\.env/u);
});
