#!/usr/bin/env node
// Operator/developer check of app-login readiness for this build.
//   node scripts/auth-readiness-check.mjs [--platform ios|android|web] [--settings file.json] [--fetch-settings]
// Reads app.json and EXPO_PUBLIC_* values (process env, then .env / .env.local).
// Prints booleans and fixed codes only — never the URL, keys or any token.
// --fetch-settings performs one read-only GET of the public /auth/v1/settings.
// Exit code 1 when a config error blocks auth flows.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseAuthSettings, parseConfiguredProviders } from '../src/domain/auth-flows.ts';
import { authReleaseReadiness, formatAuthDiagnostics } from '../src/domain/auth-release-readiness.ts';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const platform = option('--platform') ?? 'ios';

async function dotenv(name) {
  try {
    const out = {};
    for (const line of (await readFile(join(root, name), 'utf8')).split('\n')) {
      const match = /^\s*(EXPO_PUBLIC_[A-Z0-9_]+)\s*=\s*(.*)\s*$/u.exec(line);
      if (match) out[match[1]] = match[2].replace(/^["']|["']$/gu, '');
    }
    return out;
  } catch {
    return {};
  }
}

const env = { ...(await dotenv('.env')), ...(await dotenv('.env.local')), ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('EXPO_PUBLIC_'))) };
const expo = JSON.parse(await readFile(join(root, 'app.json'), 'utf8')).expo ?? {};
const url = env.EXPO_PUBLIC_SUPABASE_URL?.trim();
const key = env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
const supabase = !url || !key ? 'missing' : !/^https:\/\//u.test(url) || /service_role|secret/iu.test(key) ? 'invalid' : 'ok';

let settings = null;
if (option('--settings')) settings = parseAuthSettings(JSON.parse(await readFile(resolve(option('--settings')), 'utf8')));
else if (args.includes('--fetch-settings') && supabase === 'ok') {
  try {
    const response = await fetch(`${url.replace(/\/$/u, '')}/auth/v1/settings`, { headers: { apikey: key } });
    settings = response.ok ? parseAuthSettings(await response.json()) : null;
  } catch {
    settings = null;
  }
}

const build = {
  configured: parseConfiguredProviders(env.EXPO_PUBLIC_AUTH_PROVIDERS),
  platform,
  // Device capability; assumed present on iOS so the report shows the config gates.
  nativeAppleAvailable: platform === 'ios',
  iosBundleIdentifier: expo.ios?.bundleIdentifier ?? null,
};
const report = authReleaseReadiness({
  settings,
  build,
  app: {
    supabase, scheme: expo.scheme, iosBundleIdentifier: expo.ios?.bundleIdentifier, usesAppleSignIn: expo.ios?.usesAppleSignIn === true,
    plugins: expo.plugins ?? [], declaredProviders: env.EXPO_PUBLIC_AUTH_PROVIDERS,
  },
});
console.log(`platform: ${platform}  settings: ${settings ? 'read' : 'unknown'}  declared: ${[...build.configured].sort().join(',') || 'none'}`);
for (const line of formatAuthDiagnostics(report)) console.log(line);
process.exitCode = report.findings.some((finding) => finding.severity === 'error') ? 1 : 0;
