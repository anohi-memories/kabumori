// The structural production exclusion of the X saga stand-in, proven on the REAL tree (no finding) and by planting each violation in
// an overlay of the tree (each is found). Pure file reads; no database, no network.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALLOWED_MENTIONS, exclusionFindings, importsOf, reachable, resolveRelative, RUNTIME_FILES, STAND_IN_DIR, views, type Reader,
} from './exclusion.ts';

const root = new URL('../../../../', import.meta.url);
const SKIP = new Set(['node_modules', '.git', '.expo', 'dist', 'build']);
function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(new URL(`${dir}/`, root))];
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) out.push(...walk(path));
    else if (entry.isFile) out.push(path);
  }
  return out;
}
const real: Reader = { walk, read: (path) => Deno.readTextFileSync(new URL(path, root)) };

/** The real tree with some files replaced / added / removed. */
function overlay(changes: Record<string, string | null>): Reader {
  return {
    walk: (dir) => {
      const base = real.walk(dir).filter((file) => changes[file] !== null);
      const added = Object.keys(changes).filter((file) => changes[file] !== null && file.startsWith(`${dir}/`) && !base.includes(file));
      return [...base, ...added];
    },
    read: (path) => {
      if (path in changes) {
        const value = changes[path];
        if (value === null) throw new Error(`no such file ${path}`);
        return value;
      }
      return real.read(path);
    },
  };
}
const runtime = (name: (typeof RUNTIME_FILES)[number]) => `${STAND_IN_DIR}/${name}`;
const codes = (reader: Reader) => [...new Set(exclusionFindings(reader).map((finding) => finding.code))].sort();
const append = (path: string, extra: string) => overlay({ [path]: `${real.read(path)}\n${extra}\n` });

test('the real tree: the stand-in is unreachable from every Edge function, names nothing external, and has no way out', () => {
  assert.deepEqual(exclusionFindings(real), []);
  const entries = real.walk('supabase/functions').filter((file) => /^supabase\/functions\/[^/]+\/index\.ts$/u.test(file));
  assert.ok(entries.length >= 10, `the check sees ${entries.length} Edge function entries (not a vacuous graph)`);
  const graph = reachable(entries, real.read);
  assert.ok(graph.size > 100, 'the production graph is real');
  assert.ok([...graph].every((file) => !file.startsWith(STAND_IN_DIR)));
  // the allowed mentions are exactly the directory, its runner/tests, docs and coordination files
  assert.ok(ALLOWED_MENTIONS.some((pattern) => pattern.test('docs/common-account/phase13-d2-x-saga-standin.md')));
  assert.ok(!ALLOWED_MENTIONS.some((pattern) => pattern.test('supabase/functions/account-delete/http.ts')));
});

test('E1 production reaching the stand-in is found: directly, through a helper, from another function, and by name', () => {
  const harness = '../../preflight/managed_disposable/x_saga_standin/harness.ts';
  assert.deepEqual(codes(append('supabase/functions/account-delete/index.ts', `import { syntheticXCleaner } from '${harness}';`)),
    ['MENTIONED_OUTSIDE_ALLOWED', 'PRODUCTION_MENTIONS_STAND_IN', 'REACHABLE_FROM_PRODUCTION']);
  const helper = overlay({
    'supabase/functions/_shared/helper.ts': `export { x } from '../../preflight/managed_disposable/x_saga_standin/standin.ts';\n`,
    'supabase/functions/x-test-post/index.ts': `${real.read('supabase/functions/x-test-post/index.ts')}\nimport '../_shared/helper.ts';\n`,
  });
  assert.ok(codes(helper).includes('REACHABLE_FROM_PRODUCTION'));
  assert.deepEqual(codes(append('supabase/functions/account-delete/lifecycle_logic.ts', '// see x_saga_standin')), ['MENTIONED_OUTSIDE_ALLOWED', 'PRODUCTION_MENTIONS_STAND_IN']);
  // a type-only import is still an edge: the graph is deliberately strict
  assert.ok(codes(append('supabase/functions/account-delete/http.ts', `import type { XStandInResult } from '../../preflight/managed_disposable/x_saga_standin/standin.ts';`)).includes('REACHABLE_FROM_PRODUCTION'));
});

test('E1 is not vacuous: without any Edge entry the check says so', () => {
  const none: Reader = { walk: (dir) => (dir.startsWith('supabase/functions') ? [] : real.walk(dir)), read: real.read };
  assert.ok(codes(none).includes('NO_PRODUCTION_ENTRY'));
});

test('E2 a file outside the allowed set that names the directory is found (app, migration, another preflight file); allowed places are not', () => {
  assert.deepEqual(codes(overlay({ 'apps/social-mobile/src/lib/x.ts': `// x_saga_standin\n` })), ['MENTIONED_OUTSIDE_ALLOWED']);
  assert.deepEqual(codes(overlay({ 'supabase/migrations/99990101000000_x.sql': `-- x_saga_standin\n` })), ['MENTIONED_OUTSIDE_ALLOWED']);
  assert.deepEqual(codes(overlay({ 'supabase/preflight/managed_disposable/other.ts': `export const x = 'x_saga_standin';\n` })), ['MENTIONED_OUTSIDE_ALLOWED']);
  assert.deepEqual(codes(overlay({ 'docs/common-account/note.md': 'x_saga_standin', 'supabase/tests/common_account_phase13_d2_standin_run.sh': '# x_saga_standin' })), []);
});

test('E3 the runtime files import only each other and TYPES of production; a value import, an external one or a tooling one is found', () => {
  const standin = runtime('standin.ts');
  const harness = runtime('harness.ts');
  assert.deepEqual(codes(append(harness, `import { handleWithdrawPostona } from '../../../functions/account-delete/lifecycle_logic.ts';`)), ['VALUE_IMPORT_FROM_PRODUCTION']);
  assert.deepEqual(codes(append(harness, `import type { LifecycleDeps } from '../../../functions/account-delete/lifecycle_logic.ts';`)), []);
  assert.deepEqual(codes(append(standin, `import { x } from 'npm:left-pad';`)), ['EXTERNAL_IMPORT']);
  assert.deepEqual(codes(append(standin, `import assert from 'node:assert/strict';`)), ['EXTERNAL_IMPORT']);
  assert.deepEqual(codes(append(standin, `import { armTripwires } from './tripwire.ts';`)), ['IMPORT_OF_TOOLING']);
  assert.deepEqual(codes(append(standin, `import { secretFindings } from '../inventory.ts';`)), ['IMPORT_OUTSIDE_DIRECTORY']);
  assert.deepEqual(codes(append(standin, `const m = await import('./harness.ts');`)).includes('DYNAMIC_IMPORT'), true);
  assert.deepEqual(codes(append(standin, `export { x } from '../../../functions/account-delete/http.ts';`)), ['VALUE_IMPORT_FROM_PRODUCTION']);
});

test('E4 the runtime files have no way out: network, Deno, environment, dynamic code, timers, clock, randomness, Vault / OAuth vocabulary', () => {
  const standin = runtime('standin.ts');
  const cases: [string, string, string][] = [
    ['a fetch', `export const f = () => fetch('/x');`, 'FORBIDDEN_NETWORK'],
    ['a WebSocket', `export const w = () => new WebSocket('/x');`, 'FORBIDDEN_NETWORK'],
    ['the Deno namespace', `export const d = Deno.cwd();`, 'FORBIDDEN_DENO_NAMESPACE'],
    ['an environment read', `export const e = process.env.X;`, 'FORBIDDEN_ENVIRONMENT'],
    ['eval', `export const e = eval('1');`, 'FORBIDDEN_DYNAMIC_CODE'],
    ['the global object', `export const g = globalThis;`, 'FORBIDDEN_DYNAMIC_CODE'],
    ['a timer', `export const t = setTimeout(() => {}, 1);`, 'FORBIDDEN_TIMER'],
    ['the clock', `export const t = Date.now();`, 'FORBIDDEN_RANDOM_OR_CLOCK'],
    ['randomness', `export const r = Math.random();`, 'FORBIDDEN_RANDOM_OR_CLOCK'],
    ['Vault vocabulary', `export const vault = 1;`, 'FORBIDDEN_DATABASE_OR_VAULT_OR_OAUTH'],
    ['OAuth vocabulary', `export const oauth_token = 1;`, 'FORBIDDEN_DATABASE_OR_VAULT_OR_OAUTH'],
    ['a service credential name', `export const service_role = 1;`, 'FORBIDDEN_DATABASE_OR_VAULT_OR_OAUTH'],
    ['psql', `export const p = psql;`, 'FORBIDDEN_DATABASE_OR_VAULT_OR_OAUTH'],
  ];
  for (const [name, code, expected] of cases) {
    assert.ok(codes(append(standin, code)).includes(expected), `${name} -> ${expected}`);
    assert.ok(codes(append(runtime('harness.ts'), code)).includes(expected), `${name} (harness) -> ${expected}`);
  }
  // words inside comments and string literals are not code
  assert.deepEqual(codes(append(standin, `// fetch('x') Deno.env vault oauth eval( setTimeout\nexport const note = "fetch( Deno.env vault oauth api_key";`)), []);
  assert.deepEqual(codes(append(standin, `/* fetch(1)\n Deno.x */ export const k = \`vault \${1}\`;`)), []);
  // a URL, a host or a key in a string is not code but it is secret-shaped (E6)
  const url = ['https', '://api.x.com/2/oauth2/revoke'].join('');
  const host = ['abcdefghij0123456789', '.supabase.co'].join('');
  assert.ok(codes(append(standin, `export const u = '${url}';`)).includes('SECRET_SHAPED'));
  assert.ok(codes(append(standin, `export const h = '${host}';`)).includes('SECRET_SHAPED'));
});

test('E5 the outcome `done` exists in exactly one place: the conversion in harness.ts', () => {
  assert.deepEqual(codes(append(runtime('standin.ts'), `export const r = { outcome: 'done' };`)), ['DONE_OUTCOME']);
  assert.deepEqual(codes(append(runtime('harness.ts'), `export const r = { outcome: 'done' };`)), ['DONE_OUTCOME']);
  const without = real.read(runtime('harness.ts')).replace("outcome: 'done',", "outcome: 'finished',");
  assert.notEqual(without, real.read(runtime('harness.ts')));
  assert.deepEqual(codes(overlay({ [runtime('harness.ts')]: without })), ['DONE_OUTCOME']);
  assert.deepEqual(codes(append(runtime('standin.ts'), `import type { XCleanupResult } from '../../../functions/account-delete/lifecycle_logic.ts';`)), ['LIFECYCLE_TYPE_OUTSIDE_HARNESS']);
});

test('E6 a secret-shaped value anywhere in the directory (tests included) is found', () => {
  const key = ['sb_secret_', 'abcdef1234567890'].join('');
  assert.ok(codes(overlay({ [`${STAND_IN_DIR}/note_test.ts`]: `export const k = '${key}';\n` })).includes('SECRET_SHAPED'));
  assert.ok(codes(overlay({ [`${STAND_IN_DIR}/note_test.ts`]: `export const k = ${JSON.stringify(['postgres', '://u:p@h/db'].join(''))};\n` })).includes('SECRET_SHAPED'));
});

test('the runtime file list is the real one, and a missing runtime file is a finding', () => {
  for (const name of RUNTIME_FILES) assert.ok(real.walk(STAND_IN_DIR).includes(runtime(name)), name);
  assert.ok(codes(overlay({ [runtime('harness.ts')]: null })).includes('RUNTIME_FILE_MISSING'));
});

test('the helpers: comments and strings are blanked in the code view, imports and relative resolution read correctly', () => {
  const sample = `import a from './a.ts';\nimport type { B } from "../b.ts"; // import c from './c.ts'\nexport { d } from './d.ts';\nexport type { E } from './e.ts';\nimport './side.ts';\nconst x = import('./dyn.ts');\nconst s = 'fetch(1)'; /* Deno */ const t = \`vault\`;\n`;
  assert.deepEqual(importsOf(sample).map((r) => [r.specifier, r.typeOnly, r.dynamic]), [
    ['./a.ts', false, false], ['../b.ts', true, false], ['./c.ts', false, false], ['./d.ts', false, false], ['./e.ts', true, false], ['./side.ts', false, false], ['./dyn.ts', false, true],
  ]);
  const { code, noComments } = views(sample);
  assert.equal(code.length, sample.length);
  assert.ok(!/fetch|Deno|vault/u.test(code));
  assert.ok(noComments.includes("'fetch(1)'") && !noComments.includes('Deno'));
  assert.equal(resolveRelative('a/b/c.ts', '../d.ts'), 'a/d.ts');
  assert.equal(resolveRelative('a/b/c.ts', './d.ts'), 'a/b/d.ts');
  assert.equal(resolveRelative('a/b/c.ts', 'npm:x'), null);
  assert.equal(resolveRelative('a/b/c.ts', 'node:test'), null);
});
