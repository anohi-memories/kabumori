// F4 (postona-f4-sandbox-isolation-preflight-20261017): the non-production isolation preflight for the POSTONA
// service-end device smoke refuses every configuration that could reach production, mock data (which skips the
// enrollment gate), a committed end flag, other POSTONA gates, or missing owner sign-off -- and prints no secret.
// Dummy fixtures only: fake project refs, fake keys, a throwaway git repository. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluatePreflight, isPublishableKey, PRODUCTION_REF_SHA256, sha256, SIDE_EFFECTS_ATTESTATION, supabaseTarget } from '../scripts/postona-sandbox-preflight.mjs';

const root = resolve(import.meta.dirname, '..');
const script = join(root, 'scripts/postona-sandbox-preflight.mjs');
// Dummy 20-character refs (not real projects). The "production" one is injected as a hash, as the script stores it.
const SANDBOX = 'sandboxsandboxsandbo';
const PROD = 'productionproduction';
const OTHER = 'otherprojectotherpro';
const urlOf = (ref) => `https://${ref}.supabase.co`;
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const ANON_JWT = `${b64({ alg: 'HS256' })}.${b64({ role: 'anon', ref: SANDBOX })}.sig`;
const SERVICE_JWT = `${b64({ alg: 'HS256' })}.${b64({ role: 'service_role', ref: SANDBOX })}.sig`;
const PUBLISHABLE = 'sb_publishable_dummyfixture';

function good(over = {}) {
  return {
    productionRefHashes: [sha256(PROD)],
    effectiveEnv: { EXPO_PUBLIC_DATA_SOURCE: 'supabase', EXPO_PUBLIC_SUPABASE_URL: urlOf(SANDBOX), EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE },
    envFiles: [{ name: '.env.local', values: { EXPO_PUBLIC_DATA_SOURCE: 'supabase', EXPO_PUBLIC_SUPABASE_URL: urlOf(SANDBOX) } }],
    operator: { sandboxRef: SANDBOX, redirects: 'kabumori-social://auth-callback,kabumori-social://oauth-callback', signoff: 'F5-signoff-dummy', sideEffects: SIDE_EFFECTS_ATTESTATION },
    endFlag: { head: false, working: true },
    otherGates: [{ name: 'THREADS_CONNECT_UI_ENABLED', value: false }],
    scheme: 'kabumori-social',
    ...over,
  };
}
const failing = (result) => result.checks.filter((c) => !c.ok).map((c) => c.code);

test('a complete dummy non-production configuration is READY', () => {
  const result = evaluatePreflight(good());
  assert.equal(result.ready, true, JSON.stringify(result.checks));
  assert.ok(result.checks.length >= 13);
});

test('the default (nothing set) refuses, starting with mock data and the missing sandbox', () => {
  const result = evaluatePreflight({ effectiveEnv: {}, envFiles: [], operator: {}, endFlag: { head: false, working: false }, otherGates: [], scheme: 'kabumori-social' });
  assert.equal(result.ready, false);
  for (const code of ['DATA_SOURCE_SUPABASE', 'SANDBOX_DECLARED', 'URL_IS_DECLARED_SANDBOX', 'KEY_IS_PUBLISHABLE', 'REDIRECTS_DECLARED', 'END_FLAG_LOCAL_ONLY', 'OWNER_SIGNOFF', 'SIDE_EFFECTS_ATTESTED']) {
    assert.ok(failing(result).includes(code), code);
  }
});

test('mock data is refused even when everything else is a correct sandbox (mock skips the enrollment gate)', () => {
  for (const source of [undefined, '', 'mock', 'Supabase']) {
    const result = evaluatePreflight(good({ effectiveEnv: { ...good().effectiveEnv, EXPO_PUBLIC_DATA_SOURCE: source } }));
    assert.deepEqual(failing(result), ['DATA_SOURCE_SUPABASE'], String(source));
  }
  const viaFile = evaluatePreflight(good({ envFiles: [...good().envFiles, { name: '.env.development', values: { EXPO_PUBLIC_DATA_SOURCE: 'mock' } }] }));
  assert.deepEqual(failing(viaFile), ['ENV_FILES_NO_MOCK'], 'a mode file that could switch to mock is refused too');
});

test('production is refused wherever it appears: the URL, the declared sandbox, or any .env file', () => {
  const url = evaluatePreflight(good({ effectiveEnv: { ...good().effectiveEnv, EXPO_PUBLIC_SUPABASE_URL: urlOf(PROD) } }));
  assert.ok(failing(url).includes('URL_NOT_PRODUCTION')); assert.ok(failing(url).includes('URL_IS_DECLARED_SANDBOX'));
  const declared = evaluatePreflight(good({ operator: { ...good().operator, sandboxRef: PROD }, effectiveEnv: { ...good().effectiveEnv, EXPO_PUBLIC_SUPABASE_URL: urlOf(PROD) }, envFiles: [] }));
  assert.ok(failing(declared).includes('SANDBOX_NOT_PRODUCTION'), 'declaring production as the sandbox is refused');
  const file = evaluatePreflight(good({ envFiles: [...good().envFiles, { name: '.env.production', values: { EXPO_PUBLIC_SUPABASE_URL: urlOf(PROD) } }] }));
  assert.deepEqual(failing(file), ['ENV_FILES_CONSISTENT']);
  assert.match(file.checks.find((c) => c.code === 'ENV_FILES_CONSISTENT').detail, /\.env\.production/u);
});

test('another project than the declared sandbox, or a URL of any other shape, is refused', () => {
  for (const url of [urlOf(OTHER), `http://${SANDBOX}.supabase.co`, `${urlOf(SANDBOX)}/rest/v1`, `${urlOf(SANDBOX)}?x=1`, 'https://example.com', 'not a url', '']) {
    const result = evaluatePreflight(good({ effectiveEnv: { ...good().effectiveEnv, EXPO_PUBLIC_SUPABASE_URL: url } }));
    assert.ok(failing(result).includes('URL_IS_DECLARED_SANDBOX'), url);
  }
});

test('a local stack (supabase start) is accepted only when declared as `local`', () => {
  const local = { effectiveEnv: { ...good().effectiveEnv, EXPO_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321' }, envFiles: [], operator: { ...good().operator, sandboxRef: 'local' } };
  assert.equal(evaluatePreflight(good(local)).ready, true);
  const undeclared = evaluatePreflight(good({ ...local, operator: good().operator }));
  assert.ok(failing(undeclared).includes('URL_IS_DECLARED_SANDBOX'));
});

test('only a publishable/anon key is accepted', () => {
  assert.equal(isPublishableKey(PUBLISHABLE), true);
  assert.equal(isPublishableKey(ANON_JWT), true);
  for (const key of ['sb_secret_dummy', SERVICE_JWT, 'xx.notjson.yy', 'service_role', '', undefined]) assert.equal(isPublishableKey(key), false, String(key));
  const result = evaluatePreflight(good({ effectiveEnv: { ...good().effectiveEnv, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: SERVICE_JWT } }));
  assert.deepEqual(failing(result), ['KEY_IS_PUBLISHABLE']);
});

test('both app redirect URIs must be allowlisted on the sandbox, and no wildcard', () => {
  for (const redirects of ['kabumori-social://auth-callback', 'kabumori-social://oauth-callback', 'kabumori-social://*', `${'kabumori-social://auth-callback'},kabumori-social://oauth-callback,https://*.example.com`]) {
    const result = evaluatePreflight(good({ operator: { ...good().operator, redirects } }));
    assert.deepEqual(failing(result), ['REDIRECTS_DECLARED'], redirects);
  }
});

test('the end flag must be true only in this checkout and false in Git; other POSTONA gates must stay off', () => {
  assert.deepEqual(failing(evaluatePreflight(good({ endFlag: { head: true, working: true } }))), ['END_FLAG_LOCAL_ONLY']);
  assert.deepEqual(failing(evaluatePreflight(good({ endFlag: { head: false, working: false } }))), ['END_FLAG_LOCAL_ONLY']);
  assert.deepEqual(failing(evaluatePreflight(good({ endFlag: { head: null, working: true } }))), ['END_FLAG_LOCAL_ONLY']);
  assert.deepEqual(failing(evaluatePreflight(good({ otherGates: [{ name: 'POSTONA_RESERVATION_PERSISTENCE_ENABLED', value: true }] }))), ['OTHER_GATES_OFF']);
  assert.deepEqual(failing(evaluatePreflight(good({ otherGates: [{ name: 'THREADS_CONNECT_UI_ENABLED', value: null }] }))), ['OTHER_GATES_OFF'], 'unknown counts as on');
});

test('owner sign-off and the side-effect attestation are required', () => {
  assert.deepEqual(failing(evaluatePreflight(good({ operator: { ...good().operator, signoff: ' ' } }))), ['OWNER_SIGNOFF']);
  assert.deepEqual(failing(evaluatePreflight(good({ operator: { ...good().operator, sideEffects: 'yes' } }))), ['SIDE_EFFECTS_ATTESTED']);
});

test('URL parsing accepts only https://<20-char ref>.supabase.co or a local host', () => {
  assert.deepEqual(supabaseTarget(urlOf(SANDBOX)), { kind: 'hosted', ref: SANDBOX });
  assert.deepEqual(supabaseTarget(`${urlOf(SANDBOX)}/`), { kind: 'hosted', ref: SANDBOX });
  assert.equal(supabaseTarget('http://localhost:54321').kind, 'local');
  assert.equal(supabaseTarget(`https://user:pw@${SANDBOX}.supabase.co`).kind, 'invalid');
  assert.equal(supabaseTarget(undefined).kind, 'missing');
});

test('the script holds no production ref (only its hash) and makes no network call', async () => {
  const source = await readFile(script, 'utf8');
  assert.doesNotMatch(source, /[a-z0-9]{20}\.supabase\.co/u, 'no project URL in the script');
  assert.doesNotMatch(source, /\bfetch\(|https?\.request|node:https?|WebSocket/u, 'no network API');
  assert.deepEqual(PRODUCTION_REF_SHA256, ['02be5936f6b6d012d4fe3c99d756664232953392eb200c82e206035f89e807ff']);
});

// ---------------------------------------------------------------------------------------------- CLI dry run

async function fixtureApp({ envLocal, headFlag = 'false', workingFlag = 'true', gate = null }) {
  const dir = await mkdtemp(join(tmpdir(), 'postona-preflight-'));
  await mkdir(join(dir, 'src/domain'), { recursive: true });
  await writeFile(join(dir, 'app.json'), JSON.stringify({ expo: { scheme: 'kabumori-social' } }));
  const flag = (value) => `export const POSTONA_END_SOURCE_ENABLED = ${value};\n${gate ? `export const ${gate.name} = ${gate.value};\n` : ''}`;
  await writeFile(join(dir, 'src/domain/postona-service-end.ts'), flag(headFlag));
  const git = (...a) => assert.equal(spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).status, 0, a.join(' '));
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', 'commit', '-q', '-m', 'fixture');
  await writeFile(join(dir, 'src/domain/postona-service-end.ts'), flag(workingFlag));
  if (envLocal) await writeFile(join(dir, '.env.local'), envLocal);
  return dir;
}
const operatorEnv = { POSTONA_SMOKE_SANDBOX_REF: SANDBOX, POSTONA_SMOKE_AUTH_REDIRECTS: 'kabumori-social://auth-callback,kabumori-social://oauth-callback', POSTONA_SMOKE_F5_SIGNOFF: 'F5-signoff-dummy', POSTONA_SMOKE_SIDE_EFFECTS: SIDE_EFFECTS_ATTESTATION };
const run = (dir, env) => spawnSync(process.execPath, [script, '--app-dir', dir], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

test('CLI dry run: dummy sandbox fixture -> READY (exit 0); nothing secret is printed', async () => {
  const dir = await fixtureApp({ envLocal: `EXPO_PUBLIC_DATA_SOURCE=supabase\nEXPO_PUBLIC_SUPABASE_URL=${urlOf(SANDBOX)}\nEXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${PUBLISHABLE}\n` });
  try {
    const out = run(dir, operatorEnv);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /PREFLIGHT: READY/u);
    assert.doesNotMatch(out.stdout + out.stderr, new RegExp(`${SANDBOX}|${PUBLISHABLE}|supabase\\.co`, 'u'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI dry run: the same fixture without operator inputs, with mock data, or with the flag committed -> REFUSED (exit 1)', async () => {
  const sandboxEnv = `EXPO_PUBLIC_DATA_SOURCE=supabase\nEXPO_PUBLIC_SUPABASE_URL=${urlOf(SANDBOX)}\nEXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${PUBLISHABLE}\n`;
  const cases = [
    [{ envLocal: sandboxEnv }, {}, 'SANDBOX_DECLARED'],
    [{ envLocal: sandboxEnv.replace('supabase\n', 'mock\n') }, operatorEnv, 'DATA_SOURCE_SUPABASE'],
    [{ envLocal: sandboxEnv, headFlag: 'true' }, operatorEnv, 'END_FLAG_LOCAL_ONLY'],
    [{ envLocal: sandboxEnv, gate: { name: 'THREADS_CONNECT_UI_ENABLED', value: 'true' } }, operatorEnv, 'OTHER_GATES_OFF'],
    [{ envLocal: null }, operatorEnv, 'URL_IS_DECLARED_SANDBOX'],
  ];
  for (const [fixture, env, code] of cases) {
    const dir = await fixtureApp(fixture);
    try {
      const out = run(dir, env);
      assert.equal(out.status, 1, code);
      assert.match(out.stdout, new RegExp(`FAIL ${code}`, 'u'));
      assert.match(out.stdout, /PREFLIGHT: REFUSED/u);
      assert.doesNotMatch(out.stdout + out.stderr, new RegExp(`${SANDBOX}|${PUBLISHABLE}`, 'u'));
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('this repository as committed is REFUSED (no sandbox declared, mock/unset data, end flag false)', () => {
  const out = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(out.status, 1);
  assert.match(out.stdout, /FAIL DATA_SOURCE_SUPABASE/u);
  assert.match(out.stdout, /FAIL END_FLAG_LOCAL_ONLY/u);
  assert.match(out.stdout, /PREFLIGHT: REFUSED/u);
});
