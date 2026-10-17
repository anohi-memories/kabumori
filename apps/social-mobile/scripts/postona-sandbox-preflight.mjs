#!/usr/bin/env node
// POSTONA service-end (G1/G2) device smoke: NON-PRODUCTION isolation preflight (F4).
//   node scripts/postona-sandbox-preflight.mjs [--app-dir <dir>] [--json]
// Refuses (exit 1) unless THIS checkout would talk only to the declared non-production Supabase project, with the
// end flow enabled only locally and every other risky gate off. Local files and `git show HEAD:` only -- no network
// request, nothing written. Prints check codes and booleans only, never a URL, project ref, key or token.
//
// Operator inputs (environment, never committed; see docs/postona-sandbox-preflight.md):
//   POSTONA_SMOKE_SANDBOX_REF      the non-production project ref the build must use, or `local` (supabase start)
//   POSTONA_SMOKE_AUTH_REDIRECTS   comma list of redirect URLs allowed on that project's Auth (as configured by F5/G5)
//   POSTONA_SMOKE_F5_SIGNOFF       reference of the F5/G5 sign-off for that project (migrations, Edge, Auth settings)
//   POSTONA_SMOKE_SIDE_EFFECTS     must be exactly `no-x-no-ai-no-real-email` (that project has no X client secret, no
//                                  AI provider key, and Auth mail goes to a test inbox or is disabled)
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** SHA-256 of the production project ref(s) (the ref used by the committed cron migrations); the ref itself is not stored. */
export const PRODUCTION_REF_SHA256 = Object.freeze(['02be5936f6b6d012d4fe3c99d756664232953392eb200c82e206035f89e807ff']);
export const SIDE_EFFECTS_ATTESTATION = 'no-x-no-ai-no-real-email';
/** Other POSTONA gates that must stay OFF during the service-end smoke (no X/Threads operation, no reservations). */
export const OTHER_GATES = Object.freeze(['THREADS_CONNECT_UI_ENABLED', 'THREADS_MANUAL_PUBLISH_UI_ENABLED', 'THREADS_DISCONNECT_UI_ENABLED', 'POSTONA_RESERVATION_PERSISTENCE_ENABLED']);
const END_FLAG_FILE = 'src/domain/postona-service-end.ts';

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** `{ kind: 'hosted', ref }`, `{ kind: 'local' }` or `{ kind: 'invalid' }` -- the only URL shapes the smoke accepts. */
export function supabaseTarget(url) {
  const value = url?.trim();
  if (!value) return { kind: 'missing' };
  let parsed;
  try { parsed = new URL(value); } catch { return { kind: 'invalid' }; }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) return { kind: 'invalid' };
  const hosted = /^([a-z0-9]{20})\.supabase\.co$/u.exec(parsed.hostname);
  if (parsed.protocol === 'https:' && hosted && !parsed.port) return { kind: 'hosted', ref: hosted[1] };
  if ((parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) return { kind: 'local' };
  return { kind: 'invalid' };
}

/** A publishable/anon key only: never a secret or service-role key. */
export function isPublishableKey(key) {
  const value = key?.trim();
  if (!value) return false;
  if (/service_role|secret/iu.test(value) || value.startsWith('sb_secret_')) return false;
  const parts = value.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (payload?.role !== 'anon') return false;
    } catch { return false; }
  }
  return true;
}

/**
 * Pure decision. Every check must pass; anything unknown fails closed.
 * input = { effectiveEnv, envFiles: [{ name, values }], operator: { sandboxRef, redirects, signoff, sideEffects },
 *           endFlag: { head, working } (booleans or null), otherGates: [{ name, value }], scheme, productionRefHashes? }
 */
export function evaluatePreflight(input) {
  const production = new Set(input.productionRefHashes ?? PRODUCTION_REF_SHA256);
  const isProduction = (target) => target.kind === 'hosted' && production.has(sha256(target.ref));
  const checks = [];
  const check = (code, ok, detail) => checks.push(detail === undefined ? { code, ok } : { code, ok, detail });
  const env = input.effectiveEnv ?? {};
  const operator = input.operator ?? {};

  // Mock data never reaches the enrollment gate, so G1/G2 cannot be observed: refused like production.
  const source = env.EXPO_PUBLIC_DATA_SOURCE?.trim();
  check('DATA_SOURCE_SUPABASE', source === 'supabase', source === undefined || source === '' ? 'unset (mock)' : source === 'mock' ? 'mock' : source === 'supabase' ? undefined : 'invalid');

  const declared = operator.sandboxRef?.trim() ?? '';
  const declaredKind = declared === 'local' ? 'local' : /^[a-z0-9]{20}$/u.test(declared) ? 'hosted' : 'missing';
  check('SANDBOX_DECLARED', declaredKind !== 'missing');
  check('SANDBOX_NOT_PRODUCTION', declaredKind !== 'missing' && !(declaredKind === 'hosted' && production.has(sha256(declared))));

  const target = supabaseTarget(env.EXPO_PUBLIC_SUPABASE_URL);
  const matchesDeclared = (t) => (declaredKind === 'local' ? t.kind === 'local' : declaredKind === 'hosted' && t.kind === 'hosted' && t.ref === declared);
  check('URL_NOT_PRODUCTION', target.kind !== 'missing' && target.kind !== 'invalid' && !isProduction(target), target.kind === 'hosted' || target.kind === 'local' ? undefined : target.kind);
  check('URL_IS_DECLARED_SANDBOX', matchesDeclared(target));

  // Expo merges .env files by mode; any file that could win must agree (none may point anywhere else).
  const disagreeing = (input.envFiles ?? []).filter((file) => {
    const url = file.values?.EXPO_PUBLIC_SUPABASE_URL;
    if (url === undefined) return false;
    const t = supabaseTarget(url);
    return isProduction(t) || !matchesDeclared(t);
  }).map((file) => file.name);
  check('ENV_FILES_CONSISTENT', disagreeing.length === 0, disagreeing.length ? `disagreeing: ${disagreeing.join(',')}` : undefined);
  const mockFiles = (input.envFiles ?? []).filter((file) => file.values?.EXPO_PUBLIC_DATA_SOURCE !== undefined && file.values.EXPO_PUBLIC_DATA_SOURCE.trim() !== 'supabase').map((file) => file.name);
  check('ENV_FILES_NO_MOCK', mockFiles.length === 0, mockFiles.length ? `not supabase in: ${mockFiles.join(',')}` : undefined);

  check('KEY_IS_PUBLISHABLE', isPublishableKey(env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY));

  const redirects = (operator.redirects ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  const scheme = input.scheme ?? '';
  const required = scheme ? [`${scheme}://auth-callback`, `${scheme}://oauth-callback`] : [];
  const missing = required.filter((uri) => !redirects.includes(uri));
  const wildcard = redirects.some((entry) => entry.includes('*'));
  check('REDIRECTS_DECLARED', Boolean(scheme) && missing.length === 0 && !wildcard, !scheme ? 'no app scheme' : wildcard ? 'wildcard entry' : missing.length ? `missing: ${missing.join(',')}` : undefined);

  const end = input.endFlag ?? {};
  check('END_FLAG_LOCAL_ONLY', end.head === false && end.working === true,
    end.head === true ? 'committed true (must stay false in Git)' : end.head !== false ? 'HEAD value unknown' : end.working !== true ? 'end flow disabled in this checkout (nothing to test)' : undefined);

  const on = (input.otherGates ?? []).filter((gate) => gate.value !== false).map((gate) => gate.name);
  check('OTHER_GATES_OFF', on.length === 0, on.length ? `on or unknown: ${on.join(',')}` : undefined);

  check('OWNER_SIGNOFF', Boolean(operator.signoff?.trim()));
  check('SIDE_EFFECTS_ATTESTED', operator.sideEffects?.trim() === SIDE_EFFECTS_ATTESTATION);

  return { ready: checks.every((c) => c.ok), checks };
}

// ------------------------------------------------------------------------------------------------ CLI (local only)

function parseDotenv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?(EXPO_PUBLIC_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/u.exec(line);
    if (match) out[match[1]] = match[2].replace(/^["']|["']$/gu, '');
  }
  return out;
}
const booleanConst = (source, name) => {
  const match = new RegExp(`export const ${name}\\s*=\\s*(true|false)\\b`, 'u').exec(source ?? '');
  return match ? match[1] === 'true' : null;
};

async function sourceFiles(dir) {
  const out = [];
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(path));
    else if (/\.(ts|tsx)$/u.test(entry.name)) out.push(await readFile(path, 'utf8'));
  }
  return out;
}

export async function collect(appDir, environment = process.env) {
  const names = (await readdir(appDir)).filter((name) => /^\.env(\..+)?$/u.test(name) && name !== '.env.example').sort();
  const envFiles = [];
  for (const name of names) envFiles.push({ name, values: parseDotenv(await readFile(join(appDir, name), 'utf8')) });
  // Expo's precedence for `expo start` (development): .env < .env.development < .env.local < .env.development.local < process env.
  const order = ['.env', '.env.development', '.env.local', '.env.development.local'];
  const effectiveEnv = {};
  for (const name of order) Object.assign(effectiveEnv, envFiles.find((file) => file.name === name)?.values ?? {});
  for (const [key, value] of Object.entries(environment)) if (key.startsWith('EXPO_PUBLIC_')) effectiveEnv[key] = value;
  const appJson = JSON.parse(await readFile(join(appDir, 'app.json'), 'utf8')).expo ?? {};
  let working = null; let head = null;
  try { working = booleanConst(await readFile(join(appDir, END_FLAG_FILE), 'utf8'), 'POSTONA_END_SOURCE_ENABLED'); } catch { working = null; }
  const shown = spawnSync('git', ['-C', appDir, 'show', `HEAD:./${END_FLAG_FILE}`], { encoding: 'utf8' });
  if (shown.status === 0) head = booleanConst(shown.stdout, 'POSTONA_END_SOURCE_ENABLED');
  // Every declaration of another POSTONA gate in src (read from disk, so an unreadable tree fails closed below).
  const gateSource = (await sourceFiles(join(appDir, 'src'))).join('\n');
  const otherGates = OTHER_GATES.filter((name) => new RegExp(`export const ${name}\\b`, 'u').test(gateSource)).map((name) => ({ name, value: booleanConst(gateSource, name) }));
  return {
    effectiveEnv, envFiles, scheme: appJson.scheme ?? '', endFlag: { head, working }, otherGates,
    operator: {
      sandboxRef: environment.POSTONA_SMOKE_SANDBOX_REF, redirects: environment.POSTONA_SMOKE_AUTH_REDIRECTS,
      signoff: environment.POSTONA_SMOKE_F5_SIGNOFF, sideEffects: environment.POSTONA_SMOKE_SIDE_EFFECTS,
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const index = args.indexOf('--app-dir');
  const appDir = resolve(index >= 0 ? args[index + 1] : join(import.meta.dirname, '..'));
  const result = evaluatePreflight(await collect(appDir));
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    for (const c of result.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.code}${c.detail ? ` (${c.detail})` : ''}`);
    console.log(result.ready ? 'PREFLIGHT: READY (non-production isolation only; not a release or production approval)' : `PREFLIGHT: REFUSED (${result.checks.filter((c) => !c.ok).length} failing)`);
  }
  process.exitCode = result.ready ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
