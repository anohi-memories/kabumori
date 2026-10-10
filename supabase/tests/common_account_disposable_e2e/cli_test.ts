// Offline CLI (Phase 3c readiness): default deny, no override flags, no execute command, nothing sensitive printed.
// Files are in memory; the CLI is never given network or environment access.
import assert from 'node:assert/strict';
import test from 'node:test';

import { EXPERIMENT_IDS } from './catalog.ts';
import { run, type CliDeps } from './cli.ts';
import { destructiveConsent } from './guard.ts';

const here = new URL('./', import.meta.url);
const REQUEST = JSON.parse(await Deno.readTextFile(new URL('fixtures/run_request.sample.json', here)));
const MARKER = JSON.parse(await Deno.readTextFile(new URL('fixtures/project_marker.sample.json', here)));
const LEDGER = JSON.parse(await Deno.readTextFile(new URL('fixtures/used_projects.sample.json', here)));

function deps(files: Record<string, unknown>, links: Record<string, string> = {}): CliDeps & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    readText: (path) => {
      reads.push(path);
      if (!(path in files)) return Promise.reject(new Error('ENOENT'));
      const value = files[path];
      return Promise.resolve(typeof value === 'string' ? value : JSON.stringify(value));
    },
    realPath: (path) => (path in files || path in links) ? Promise.resolve(links[path] ?? path) : Promise.reject(new Error('ENOENT')),
    repoRoot: '/Users/fixture/kabumori',
    now: new Date('2026-10-11T10:00:00+09:00'),
  };
}
const FILES = { '/in/request.json': REQUEST, [REQUEST.project_marker_path]: MARKER, '/in/ledger.json': LEDGER };
const VALIDATE = ['validate', '--request', '/in/request.json', '--ledger', '/in/ledger.json'];

test('plan with no request: every experiment listed, default deny, nothing executed', async () => {
  const r = await run(['plan'], deps({}));
  assert.equal(r.code, 0);
  for (const id of EXPERIMENT_IDS) assert.match(r.out, new RegExp(`^${id} \\[`, 'mu'));
  assert.match(r.out, /guard: NO_REQUEST \(default deny\)/u);
  assert.match(r.out, /execution: NOT_AVAILABLE_IN_THIS_STAGE/u);
  assert.match(r.out, /neither candidate is chosen here; the managed_auth_delete release gate stays blocked\./u);
  assert.ok(!/https?:\/\//u.test(r.out), 'no URL is printed');
});

test('validate: the valid sample is a dry run only (exit 0); the marker is read from the named path', async () => {
  const d = deps(FILES);
  const r = await run(VALIDATE, d);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /guard: REQUEST_VALID_DRY_RUN_ONLY/u);
  assert.match(r.out, /^E2 \[destructive\] \[selected\]/mu);
  assert.match(r.out, /^E3 \[destructive\] \[not selected\]/mu);
  assert.deepEqual(d.reads, ['/in/request.json', '/in/ledger.json', REQUEST.project_marker_path]);
  for (const sensitive of [REQUEST.project_ref, REQUEST.project_marker_path, REQUEST.user_approval.approval_reference, REQUEST.typed_confirmation]) {
    assert.ok(!r.out.includes(sensitive), `printed: ${sensitive}`);
  }
});

test('validate: denials exit 3 with reasons; a missing marker, a symlinked marker or a production ref are refused', async () => {
  const noMarker = await run(VALIDATE, deps({ '/in/request.json': REQUEST, '/in/ledger.json': LEDGER }));
  assert.equal(noMarker.code, 3);
  assert.match(noMarker.out, /deny: MARKER_MISSING/u);
  const linked = await run(VALIDATE, deps(FILES, { [REQUEST.project_marker_path]: '/Users/fixture/kabumori/marker.json' }));
  assert.equal(linked.code, 3);
  assert.match(linked.out, /deny: MARKER_PATH_MISMATCH/u);
  assert.match(linked.out, /deny: MARKER_PATH_INSIDE_REPOSITORY/u);
  const production = structuredClone(REQUEST);
  production.project_ref = 'wsmznyzcvmuitkglfeuj';
  production.destructive_consents.E2 = destructiveConsent('E2', production.project_ref, production.run_id);
  const prod = await run(VALIDATE, deps({ ...FILES, '/in/request.json': production }));
  assert.equal(prod.code, 3);
  assert.match(prod.out, /deny: PROJECT_REF_PRODUCTION/u);
  assert.ok(!prod.out.includes('wsmznyzcvmuitkglfeuj'), 'the ref is not echoed');
  const garbage = await run(VALIDATE, deps({ ...FILES, '/in/request.json': '{not json' }));
  assert.equal(garbage.code, 3);
  assert.match(garbage.out, /deny: REQUEST_MISSING/u);
});

test('override flags are refused outright, whatever their position or form', async () => {
  for (const flag of ['--force', '-f', '--yes', '-y', '--skip-guard', '--no-guard', '--override', '--unsafe', '--allow-production', '--execute', '--apply', '--run', '--force=true', '--FORCE']) {
    for (const args of [[...VALIDATE, flag], [flag, ...VALIDATE], ['plan', flag]]) {
      const r = await run(args, deps(FILES));
      assert.equal(r.code, 2, `${args.join(' ')}`);
      assert.match(r.out, /^OVERRIDE_NOT_SUPPORTED/u);
    }
  }
});

test('there is no execute command, and arguments are strict', async () => {
  for (const args of [[], ['execute'], ['run', 'E2'], ['apply'], ['plan', 'extra'], ['validate'], ['validate', '--request', '/in/request.json'],
    ['validate', '--request', '/in/request.json', '--ledger', '/in/ledger.json', '--request', '/in/other.json'], ['validate', '--project', 'x', '--ledger', '/in/ledger.json']]) {
    const r = await run(args, deps(FILES));
    assert.equal(r.code, 2, args.join(' '));
  }
});
