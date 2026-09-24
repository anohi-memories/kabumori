// Release preflight: fails loudly, before a build is even started, if the production
// EXPO_PUBLIC_* values are missing or malformed.
//
// Without EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY, src/lib/supabase.ts
// crashes on launch with "supabaseUrl is required" (confirmed while export-smoke-testing this repo
// with dummy values) -- so a build shipped without them is not silently broken, it does not open at
// all. EXPO_PUBLIC_KABUMORI_WEB_URL fails softer by design (the legal/support links show 準備中
// instead), which is the right behaviour for a dev/preview build, but a *production* build should
// not ship with it unset -- App Store review needs working Privacy/Support links.
//
// This never runs during `expo start` or a normal build; EAS does not invoke it automatically. Run
// it by hand, or from CI, before `eas build --profile production`:
//
//   EXPO_PUBLIC_SUPABASE_URL=... EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... \
//   EXPO_PUBLIC_KABUMORI_WEB_URL=... node scripts/verify-production-env.mjs
//
// It intentionally does not read EAS's remote environment itself and mutates nothing; it only
// checks whatever EXPO_PUBLIC_* values are present in the process it runs in.
import { normalizeWebOrigin } from '../src/lib/legal-links.ts';

function checkSupabaseUrl(value) {
  if (!value) return 'is not set';
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(value.trim())) {
    return 'does not look like a Supabase project URL (expected https://<ref>.supabase.co)';
  }
  return null;
}

function checkPublishableKey(value) {
  if (!value) return 'is not set';
  const key = value.trim();
  if (key.length < 20) return 'looks too short to be a real key';
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return null;
  if (isLegacyAnonKey(key)) return null;
  return 'does not look like a Supabase publishable or legacy anon key; secret/service_role keys must not be used';
}

function isLegacyAnonKey(key) {
  const parts = key.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return false;

  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
    return payload?.role === 'anon';
  } catch {
    return false;
  }
}

function checkWebUrl(value) {
  if (!normalizeWebOrigin(value)) {
    return 'is not set, or is not a bare https origin (e.g. https://kabumori.example.com, no path)';
  }
  return null;
}

export const CHECKS = [
  { key: 'EXPO_PUBLIC_SUPABASE_URL', check: checkSupabaseUrl },
  { key: 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY', check: checkPublishableKey },
  { key: 'EXPO_PUBLIC_KABUMORI_WEB_URL', check: checkWebUrl },
];

/** Pure so it is testable without touching real process.env. */
export function verifyProductionEnv(env) {
  const problems = [];
  for (const { key, check } of CHECKS) {
    const problem = check(env[key]);
    if (problem) problems.push(`${key} ${problem}`);
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = verifyProductionEnv(process.env);
  if (problems.length === 0) {
    console.log('OK: all production EXPO_PUBLIC_* values look set and well-formed.');
  } else {
    console.error('Production build preflight failed:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
}
