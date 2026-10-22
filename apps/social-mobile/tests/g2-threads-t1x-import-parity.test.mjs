// G2 QA (Issue #317, task postona-g2-threads-t1x-qa-harness-import-parity-20261022) -- QA only, no product code.
// G2-T1-X: on G4 PR #381 the app test `threads-disconnect.test.mjs` ("parity: the database's exact answers through the
// REAL server handler parse in the app as intended") stops with `unexpected import ./social_account_id.ts`. This file
// separates a contract regression from a test-harness import gap ON THE SAME HEAD: it loads the same real server handler
// with the same stubs (before) and with the real `social_account_id.ts` added (after), feeding the database rows read
// from G4's own test file (not copied, so they stay in sync). G4's test and every product file stay unchanged.
// Offline: the handler gets injected getUser / disconnect functions; no Threads, no Supabase.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as domain from '../src/domain/threads-disconnect.ts';
import * as realAccountId from '../../../supabase/functions/_shared/social/social_account_id.ts';

const root = resolve(import.meta.dirname, '..');
const HANDLER = '../../supabase/functions/_shared/social/threads_disconnect.ts';
const G4_TEST = 'tests/threads-disconnect.test.mjs';
const read = (path) => readFile(resolve(root, path), 'utf8');
const transpile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const plain = (value) => JSON.parse(JSON.stringify(value));
const importsOf = (source) => [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gmu)].map((m) => m[1]);
/** The same loader as G4's test (strict: an import missing from the stubs throws). */
function load(source, stubs) {
  const module = { exports: {} };
  const require = (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; };
  vm.runInNewContext(transpile(source), { module, exports: module.exports, require, URL, URLSearchParams, Response, TextDecoder, Headers }, { filename: 'threads_disconnect.ts' });
  return module.exports;
}
const HANDLER_SOURCE = await read(HANDLER);
const flat = (text) => new Map(Object.entries(JSON.parse(text)));
const G4_STUBS = { '../../social-mobile-threads-publish/logic.ts': { parseFlatJsonObject: flat } };

/** The rows of G4's parity test, evaluated from its own source (`const sql = [ ... ];`). */
async function g4ParityRows() {
  const source = await read(G4_TEST);
  const start = source.indexOf('const sql = [');
  const end = source.indexOf('];', start);
  assert.ok(start > 0 && end > start, 'the parity rows are in G4\'s test');
  // Evaluated in another realm: made plain so deepEqual compares values, not prototypes.
  return plain(vm.runInNewContext(`(${source.slice(start + 'const sql = '.length, end + 1)})`));
}
const USER = '00000000-0000-4000-8000-0000000000a1';
const TARGET = { id: 'sa_0123456789abcdef01234567', handle: 'alice' };
async function ask(server, db, accountId = TARGET.id) {
  const response = await server.handleThreadsDisconnect(new Request('https://edge.example', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify({ action: 'disconnect', social_account_id: accountId, expected_handle: TARGET.handle }),
  }), { getUser: async () => ({ id: USER }), disconnect: async () => JSON.parse(db) });
  return { parsed: domain.parseDisconnectResponse(plain(await response.json()), response.ok), status: response.status };
}

// ---- cause ------------------------------------------------------------------------------------------------------------

test('G2-T1X-1 (cause, source): the handler imports logic.ts AND ./social_account_id.ts (added by #381); G4\'s parity stubs list only logic.ts; social_account_id.ts itself imports nothing', async () => {
  const handler = await read(HANDLER);
  assert.deepEqual(importsOf(handler), ['../../social-mobile-threads-publish/logic.ts', './social_account_id.ts']);
  const g4 = await read(G4_TEST);
  const line = g4.split('\n').find((l) => l.includes(`load('${HANDLER}'`));
  assert.ok(line, 'G4\'s parity load line');
  assert.deepEqual([...line.matchAll(/'(\.\.?\/[^']+)':/gu)].map((m) => m[1]), ['../../social-mobile-threads-publish/logic.ts'], 'only logic.ts is stubbed');
  assert.deepEqual(importsOf(await read('../../supabase/functions/_shared/social/social_account_id.ts')), []);
});

test('G2-T1X-2 (before, same head): the handler with G4\'s stubs fails at load time with exactly that import -- before any database row is tried', () => {
  assert.throws(() => load(HANDLER_SOURCE, G4_STUBS), /unexpected import \.\/social_account_id\.ts/u);
});

// ---- after: the same rows with the real module --------------------------------------------------------------------

test('G2-T1X-3 (after, same head): with the REAL social_account_id.ts added, every row of G4\'s parity test parses in the app as G4 expects -- the contract is intact; T1-X is a test-harness import gap', async () => {
  const server = load(HANDLER_SOURCE, { ...G4_STUBS, './social_account_id.ts': realAccountId });
  const rows = await g4ParityRows();
  assert.equal(rows.length, 7, 'the seven rows of G4\'s test');
  for (const [db, expected] of rows) assert.deepEqual((await ask(server, db)).parsed, expected, db);
});

test('G2-T1X-4 (new parity, same head): account ids the server refuses (#381 shape `^[a-z][a-z0-9_]{1,80}$`) are a refusal in the app too -- never "disconnected", and the database is not asked', async () => {
  let asked = 0;
  const server = load(HANDLER_SOURCE, { ...G4_STUBS, './social_account_id.ts': realAccountId });
  for (const bad of ['SA_upper', '_sa', '1sa', 'sa-1', 'sa 1', 'sa_1\n', `s${'a'.repeat(81)}`, '00000000-0000-4000-8000-0000000000a1']) {
    const response = await server.handleThreadsDisconnect(new Request('https://edge.example', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ action: 'disconnect', social_account_id: bad, expected_handle: 'alice' }),
    }), { getUser: async () => ({ id: USER }), disconnect: async () => { asked += 1; return { code: 'LOCAL_REMOVED', status: 'disconnected' }; } });
    const parsed = domain.parseDisconnectResponse(plain(await response.json()), response.ok);
    assert.equal(response.ok, false, JSON.stringify(bad));
    assert.equal(parsed.kind, 'failed', JSON.stringify(bad));
  }
  assert.equal(asked, 0, 'no refused id reaches the database');
  assert.equal(realAccountId.isSocialAccountId(TARGET.id), true, 'the parity rows\' account is a real-shape id');
});

// ---- harness controls ---------------------------------------------------------------------------------------------

test('harness control: the "after" run really goes through the id check -- with the pre-#381 UUID-only rule stubbed in, the real-shape account is refused and the parity rows FAIL; with an accept-all rule they pass but the refusals of G2-T1X-4 are no longer refusals', async () => {
  const uuidOnly = { SOCIAL_ACCOUNT_ID: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u };
  const strict = load(HANDLER_SOURCE, { ...G4_STUBS, './social_account_id.ts': uuidOnly });
  const rows = await g4ParityRows();
  const [db, expected] = rows[0];
  assert.notDeepEqual((await ask(strict, db)).parsed, expected, 'UUID-only rule: the real account is refused');
  const anything = load(HANDLER_SOURCE, { ...G4_STUBS, './social_account_id.ts': { SOCIAL_ACCOUNT_ID: /^.*$/su } });
  assert.deepEqual((await ask(anything, db)).parsed, expected, 'accept-all: the rows alone do not test the id rule');
  assert.equal((await ask(anything, db, 'SA_upper')).parsed.kind, 'disconnected', 'accept-all: a refused id would now look disconnected -- only G2-T1X-4 catches this');
});

test('negative control (AST, product source in memory only): the handler without its id check accepts a refused id -- G2-T1X-4 would fail', async () => {
  const file = ts.createSourceFile('threads_disconnect.ts', HANDLER_SOURCE, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  let n = 0;
  const out = ts.transform(file, [(context) => (rootNode) => ts.visitNode(rootNode, function v(node) {
    if (ts.isPrefixUnaryExpression(node) && node.getText() === '!SOCIAL_ACCOUNT_ID.test(accountId)') { n += 1; return ts.factory.createFalse(); }
    return ts.visitEachChild(node, v, context);
  })]);
  assert.equal(n, 1, 'exactly one id check in the handler');
  const mutant = load(ts.createPrinter().printFile(out.transformed[0]), { ...G4_STUBS, './social_account_id.ts': realAccountId });
  const [db] = (await g4ParityRows())[0];
  assert.equal((await ask(mutant, db, 'SA_upper')).parsed.kind, 'disconnected', 'mutant: a refused id is "disconnected"');
});

// ---- import-parity gate for every strict server load in the app tests ---------------------------------------------

test('G2-T1X-5 (gate): every app test that loads a server source through a strict stub map lists all of that source\'s relative imports -- today only the disconnect parity load misses one (T1-X)', async () => {
  const files = (await readdir(resolve(root, 'tests'))).filter((f) => f.endsWith('.test.mjs') && !f.startsWith('g2-'));
  const gaps = [];
  for (const f of files) {
    const src = await read(`tests/${f}`);
    for (const m of src.matchAll(/load\('(\.\.\/\.\.\/supabase\/functions\/[^']+\.ts)', \{([^}]*(?:\{[^}]*\}[^}]*)*)\}/gu)) {
      const stubbed = [...m[2].matchAll(/'(\.\.?\/[^']+)':/gu)].map((x) => x[1]);
      const needed = importsOf(await read(m[1])).filter((p) => p.startsWith('.'));
      const missing = needed.filter((p) => !stubbed.includes(p));
      if (missing.length) gaps.push(`${f}: ${m[1].split('/').pop()} misses ${missing.join(', ')}`);
    }
  }
  assert.deepEqual(gaps, ['threads-disconnect.test.mjs: threads_disconnect.ts misses ./social_account_id.ts']);
});
