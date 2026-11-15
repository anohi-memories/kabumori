// G2 QA (Issue #317, task postona-g2-expo-generated-identifiers-reproducibility-qa-20261020) -- QA only, no product code.
// Static / source-contract checks of the app identifiers that `expo prebuild` generates when the tracked config does
// not fix them, and of the URL / callback separation between this app (POSTONA, apps/social-mobile) and the Kabumori
// app at the repository root. The generated values were recorded in disposable worktrees
// (docs/postona/qa/g2-expo-identifiers/); nothing here runs prebuild, a build, a device or a network call.
//
// "FINDING .." passes while the gap exists and FAILS once the owner fixes it; "G2-ID.." holds today.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkAppAuthConfig, REQUIRED_SCHEME } from '../src/domain/auth-release-readiness.ts';
import { parseConfiguredProviders, AUTH_CALLBACK_URL } from '../src/domain/auth-flows.ts';

const app = resolve(import.meta.dirname, '..');
const repo = resolve(app, '../..');
const social = JSON.parse(readFileSync(resolve(app, 'app.json'), 'utf8')).expo;
const kabumori = JSON.parse(readFileSync(resolve(repo, 'app.json'), 'utf8')).expo;
const lock = JSON.parse(readFileSync(resolve(app, 'package-lock.json'), 'utf8'));
const CLI_LOCK_KEY = 'node_modules/expo/node_modules/@expo/cli';
const CLI_SOURCE = resolve(app, CLI_LOCK_KEY, 'build/src/utils/getOrPromptApplicationId.js');

/** Recorded in disposable worktrees on 2026-10-20/21 (R1-R3 in the docs), Expo CLI 57.0.25, EXPO_OFFLINE=1. */
const GENERATED_IOS = Object.freeze({
  iosFirst: 'com.anohi-memories.kabumori-social-mobile', // `prebuild --platform ios` with this Mac's Expo login
  bothPlatforms: 'com.anohimemories.kabumorisocialmobile', // `prebuild` (Android first) with the same login
  noLogin: 'com.anonymous.kabumorisocialmobile', // `prebuild` with no Expo login on the machine
});

/** Every `scheme://` literal (except http/https) in the TS/TSX sources under `dir`. */
function schemesIn(dir) {
  const out = execFileSync('git', ['grep', '-h', '-o', '-E', "['\"`][a-z][a-z0-9+.-]*://", '--', `${dir}/*.ts`, `${dir}/*.tsx`], { cwd: repo, encoding: 'utf8' });
  return [...new Set(out.split('\n').filter(Boolean).map((s) => s.slice(1, -3)))].filter((s) => s !== 'http' && s !== 'https').sort();
}

// ---- reproducibility ---------------------------------------------------------------------------------------------------

test('FINDING G2-ID1 (owner of the native config, undecided): the tracked config fixes neither id, and the locked Expo CLI derives them from the OTHER platform, the machine\'s Expo login, or "anonymous" -- three different iOS ids were generated', () => {
  assert.equal(social.ios?.bundleIdentifier, undefined, 'no ios.bundleIdentifier in apps/social-mobile/app.json');
  assert.equal(social.android?.package, undefined, 'no android.package');
  assert.equal(social.owner, undefined, 'no owner');
  assert.equal(social.extra?.eas?.projectId, undefined, 'no EAS project id');
  assert.equal(lock.packages[CLI_LOCK_KEY]?.version, '57.0.25');
  const cli = readFileSync(CLI_SOURCE, 'utf8');
  assert.match(cli, /const possibleIdFromAndroid = [\s\S]{0,200}exp\.android\.package/u, 'iOS: the Android package first');
  assert.match(cli, /const possibleIdFromApple = [\s\S]{0,200}exp\.ios\.bundleIdentifier/u, 'Android: the iOS id first');
  assert.match(cli, /getSettings\)\(\)\.read\(\)\.auth\)[\s\S]{0,80}\.username/u, "then the cached Expo login's username");
  assert.match(cli, /const ANONYMOUS_USERNAME = 'anonymous';/u, 'else "anonymous"');
  assert.equal(new Set(Object.values(GENERATED_IOS)).size, 3, 'three different iOS bundle ids from the same commit');
});

test('FINDING G2-ID5 (owner of the native config / auth): the app\'s own release gate for the iOS bundle id reads app.json -- an uncommitted local prebuild silently clears it with a machine-dependent id', () => {
  const declared = parseConfiguredProviders('email,x,google,apple');
  const findingsFor = (bundleId) => checkAppAuthConfig(
    { supabase: 'ok', scheme: social.scheme, iosBundleIdentifier: bundleId, usesAppleSignIn: social.ios?.usesAppleSignIn === true, plugins: social.plugins, declaredProviders: 'email,x,google,apple' },
    { configured: declared, platform: 'ios', nativeAppleAvailable: true, iosBundleIdentifier: bundleId ?? null },
  ).map((f) => `${f.code}:${f.severity}`);
  assert.deepEqual(findingsFor(social.ios?.bundleIdentifier), ['ios_bundle_identifier_missing:gate'], 'the tracked app.json: a gate');
  for (const generated of Object.values(GENERATED_IOS)) assert.deepEqual(findingsFor(generated), [], `${generated}: no gate any more`);
});

// ---- separation from the Kabumori app ----------------------------------------------------------------------------------

test('G2-ID2: none of the generated ids can collide with the Kabumori app\'s bundle id, and both apps keep different display names', () => {
  assert.equal(kabumori.ios?.bundleIdentifier, 'com.anohimemories.kabumori');
  for (const id of Object.values(GENERATED_IOS)) {
    assert.notEqual(id, kabumori.ios.bundleIdentifier);
    assert.notEqual(id.replace(/[^a-z0-9.]/gu, ''), kabumori.ios.bundleIdentifier.replace(/[^a-z0-9.]/gu, ''));
  }
  assert.notEqual(social.name, kabumori.name);
  assert.notEqual(social.slug, kabumori.slug);
});

test('G2-ID3: the two apps register different URL schemes, each app\'s sources use only its own, and neither claims https links (no associated domains / verified App Links)', () => {
  assert.equal(social.scheme, 'kabumori-social');
  assert.equal(kabumori.scheme, 'kabumori');
  assert.notEqual(social.scheme, kabumori.scheme);
  assert.deepEqual(schemesIn('apps/social-mobile/src'), ['kabumori-social']);
  assert.deepEqual(schemesIn('src'), ['kabumori']);
  for (const cfg of [social, kabumori]) {
    assert.equal(cfg.ios?.associatedDomains, undefined);
    assert.equal(cfg.android?.intentFilters, undefined);
  }
});

test('G2-ID4: the sign-in and X-connect returns are built from the fixed scheme, not from the bundle id -- a drifting id does not move them (native Apple sign-in is the part that depends on the id)', () => {
  assert.equal(AUTH_CALLBACK_URL, 'kabumori-social://auth-callback');
  assert.equal(REQUIRED_SCHEME, social.scheme);
  const xConnect = readFileSync(resolve(app, 'src/features/x-connect/use-x-connect.ts'), 'utf8');
  assert.match(xConnect, /Linking\.createURL\('oauth-callback', \{ scheme: 'kabumori-social' \}\)/u);
  const flows = readFileSync(resolve(app, 'src/domain/auth-flows.ts'), 'utf8');
  assert.match(flows, /build\.configured\.has\('apple'\) && build\.nativeAppleAvailable && Boolean\(build\.iosBundleIdentifier\)/u, 'native Apple sign-in needs the bundle id');
});

// ---- negative controls -----------------------------------------------------------------------------------------------

test('negative controls: each condition above turns false for the fixed / broken variant it guards against', () => {
  const idGap = (cfg) => cfg.ios?.bundleIdentifier === undefined && cfg.android?.package === undefined;
  assert.equal(idGap(social), true);
  assert.equal(idGap({ ...social, ios: { ...social.ios, bundleIdentifier: 'com.example.fixed' }, android: { package: 'com.example.fixed' } }), false, 'fixed ids');
  const schemeClash = (a, b) => a.scheme === b.scheme;
  assert.equal(schemeClash(social, kabumori), false);
  assert.equal(schemeClash({ ...social, scheme: 'kabumori' }, kabumori), true, 'a shared scheme is caught');
  const foreign = (schemes, own) => schemes.some((s) => s !== own);
  assert.equal(foreign(schemesIn('apps/social-mobile/src'), 'kabumori-social'), false);
  assert.equal(foreign(['kabumori-social', 'kabumori'], 'kabumori-social'), true, 'a Kabumori-scheme URL in POSTONA sources is caught');
  assert.ok(existsSync(CLI_SOURCE), 'the CLI source the FINDING reads is there');
});
