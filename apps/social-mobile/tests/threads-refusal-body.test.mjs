// G1 TASK 49 (found on the iOS Simulator with the native rig): Expo's fetch hands supabase-js a Response that is not
// `instanceof Response`, so the connect / disconnect runtimes read every refusal as the generic failure. They now read any context
// that reads as JSON; a context that does not stays the generic failure. Real source, transpiled; React Native modules stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as connectDomain from '../src/domain/threads-connect.ts';
import * as disconnectDomain from '../src/domain/threads-disconnect.ts';

const read = (rel) => readFile(new URL(`../${rel}`, import.meta.url), 'utf8');
const transpile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
async function load(rel, stubs) {
  const module = { exports: {} };
  const require = (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; };
  vm.runInNewContext(transpile(await read(rel)), { module, exports: module.exports, require, Response, setTimeout, clearTimeout, Promise });
  return module.exports;
}
/** What Expo's fetch gives supabase-js: a response-like object, NOT `instanceof Response`. */
const expoLike = (body) => ({ status: 409, clone() { return { json: async () => body }; }, json: async () => body });
// Objects built in the vm context have its prototypes: compare by value.
const same = (actual, expected) => assert.equal(JSON.stringify(actual), JSON.stringify(expected));
const supabaseAnswering = (context) => ({ functions: { invoke: async () => ({ data: null, error: { name: 'FunctionsHttpError', context } }) } });

async function connectDeps(context) {
  const runtime = await load('src/features/threads-connect/threads-connect-runtime.ts', {
    'expo-constants': { default: { expoConfig: { extra: {}, ios: {} } } },
    'expo-linking': { addEventListener: () => ({ remove() {} }) },
    'expo-web-browser': { openAuthSessionAsync: async () => ({ type: 'cancel' }), dismissAuthSession() {} },
    'react-native': { Platform: { OS: 'ios', Version: '18.0' } },
    '@/domain/threads-connect': connectDomain,
    '@/lib/supabase': { supabase: supabaseAnswering(context) },
  });
  return runtime.productionThreadsConnectDeps(() => ({ userId: 'u', token: 't' }));
}
async function disconnectDeps(context) {
  const runtime = await load('src/features/threads-disconnect/threads-disconnect-runtime.ts', {
    '@/domain/threads-disconnect': disconnectDomain,
    '@/lib/supabase': { supabase: supabaseAnswering(context) },
  });
  return runtime.productionThreadsDisconnectDeps(() => ({ userId: 'u', token: 't' }));
}

test('T49 connect runtime: an Expo-style (not instanceof Response) refusal is read; a real Response too; a non-JSON context stays generic', async () => {
  const body = { ok: false, error: 'COMPLETE_OUTCOME_UNKNOWN', reconciliation_required: true };
  const invoke = async (context) => (await connectDeps(context)).invoke({ action: 'start' }, 't');
  same(await invoke(expoLike(body)), { ok: false, payload: body });
  same(await invoke(new Response(JSON.stringify(body), { status: 409, headers: { 'content-type': 'application/json' } })), { ok: false, payload: body });
  const notJson = { clone() { return { json: async () => { throw new SyntaxError('html'); } }; }, json: async () => { throw new SyntaxError('html'); } };
  same(await invoke(notJson), { ok: false, payload: null });
  same(await invoke('boom'), { ok: false, payload: null });
  same(await invoke(null), { ok: false, payload: null });
});

test('T49 disconnect runtime: an Expo-style refusal (PUBLISH_IN_FLIGHT) is read, so the screen keeps the account and says why', async () => {
  const body = { ok: false, status: 'stopped', code: 'PUBLISH_IN_FLIGHT', local_credentials: 'kept' };
  const invoke = async (context) => (await disconnectDeps(context)).invoke({}, 't');
  same(await invoke(expoLike(body)), { ok: false, payload: body });
  same(await invoke({}), { ok: false, payload: null });
});
