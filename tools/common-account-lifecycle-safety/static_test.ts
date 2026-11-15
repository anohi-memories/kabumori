// Static safety rules of the Phase 3i tooling: pure logic and a synthetic world, nothing that can reach anything.
import assert from 'node:assert/strict';
import test from 'node:test';

const here = new URL('./', import.meta.url);
const SOURCES = ['protocol.ts', 'world.ts'];
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:'"`])\/\/.*$/gmu, '$1');

test('the logic and the world have no network, process, environment, file or dynamic-import access', async () => {
  const forbidden = /\bfetch\s*\(|\bDeno\.[A-Za-z]+|\bWebSocket\b|XMLHttpRequest|\bimport\s*\(|node:(http|https|net|tls|dgram|dns|child_process|fs|os|worker_threads)|npm:|jsr:|https?:\/\/|process\.env|Math\.random|Date\.now|new Date\(/u;
  for (const file of SOURCES) {
    const code = strip(await Deno.readTextFile(new URL(file, here)));
    assert.ok(!forbidden.test(code), `${file}: ${code.match(forbidden)?.[0]}`);
    for (const m of code.matchAll(/\bfrom\s+'([^']+)'/gu)) assert.ok(m[1].startsWith('./') && !m[1].includes('..'), `${file} imports ${m[1]}`);
  }
});

test('determinism: no clock and no randomness anywhere in the logic or the model', async () => {
  for (const file of SOURCES) {
    const code = strip(await Deno.readTextFile(new URL(file, here)));
    assert.ok(!/crypto\.|Math\.random|performance\.now|setTimeout|setInterval/u.test(code), file);
  }
});

test('no secret-shaped or identifying literal in the tooling', async () => {
  for (const file of ['protocol.ts', 'world.ts', 'protocol_test.ts', 'invariants_test.ts', 'README.md']) {
    const text = await Deno.readTextFile(new URL(file, here));
    assert.ok(!/eyJ[A-Za-z0-9_-]{10,}|sb_(secret|publishable)_|BEGIN [A-Z ]*PRIVATE KEY|@[a-z0-9-]+\.(com|jp|net|io)\b|\.supabase\.(co|in|com)/u.test(text), file);
  }
});
