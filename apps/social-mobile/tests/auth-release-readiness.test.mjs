import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { providerReadiness } from '../src/domain/auth-flows.ts';
import {
  authReleaseReadiness,
  checkAppAuthConfig,
  formatAuthDiagnostics,
  RELEASE_PROVIDERS,
  REQUIRED_SCHEME,
  USER_PROVIDER_STATUS_LABELS,
  userProviderStatus,
} from '../src/domain/auth-release-readiness.ts';
import { postingXStatus, POSTING_X_STATUS_LABELS } from '../src/domain/account-security.ts';

const root = resolve(import.meta.dirname, '..');
const allOn = { external: { email: true, x: true, apple: true, google: true }, signupDisabled: false };
const allOff = { external: { email: false, x: false, apple: false, google: false }, signupDisabled: true };
const emailOnly = { external: { email: true, x: false, apple: false, google: false }, signupDisabled: false };
const goodApp = {
  supabase: 'ok', scheme: 'kabumori-social', iosBundleIdentifier: 'com.example.fixture', usesAppleSignIn: true,
  plugins: ['expo-router', 'expo-web-browser', ['expo-apple-authentication', {}]], declaredProviders: undefined,
};
const build = (configured, overrides = {}) => ({ configured: new Set(configured), platform: 'ios', nativeAppleAvailable: true, iosBundleIdentifier: 'com.example.fixture', ...overrides });
const run = (settings, b, app = goodApp) => authReleaseReadiness({ settings, build: b, app });

test('default build is e-mail only; other providers are setup-pending with a build blocker; nothing claims E2E', () => {
  const report = run(emailOnly, build(['email']));
  assert.equal(report.providers.email.usableNow, true);
  assert.deepEqual(report.email, { signIn: true, signUp: true, reset: true });
  for (const provider of ['x', 'apple', 'google']) {
    const item = report.providers[provider];
    assert.equal(item.usableNow, false);
    assert.equal(item.enabledInSupabase, 'no');
    assert.equal(item.buildConfigPresent, false);
    assert.ok(item.blockers.includes('not_declared_for_build'));
  }
  for (const provider of RELEASE_PROVIDERS) {
    assert.equal(report.providers[provider].e2eVerified, false);
    assert.equal(report.providers[provider].sourceImplemented, true);
  }
  assert.deepEqual(report.findings, []);
});

test('everything enabled, declared and configured: usable now, yet still not E2E-verified', () => {
  const report = run(allOn, build(['email', 'x', 'google', 'apple']));
  for (const provider of RELEASE_PROVIDERS) {
    assert.deepEqual({ ...report.providers[provider], blockers: [...report.providers[provider].blockers] }, {
      provider, enabledInSupabase: 'yes', buildConfigPresent: true, sourceImplemented: true, e2eVerified: false, usableNow: true, blockers: [],
    });
  }
});

test('unknown Supabase settings: social providers fail closed; e-mail sign-in only', () => {
  const report = run(null, build(['email', 'x', 'google', 'apple']));
  for (const provider of ['x', 'apple', 'google']) {
    assert.equal(report.providers[provider].enabledInSupabase, 'unknown');
    assert.equal(report.providers[provider].usableNow, false);
    assert.ok(report.providers[provider].blockers.includes('supabase_unknown'));
  }
  assert.deepEqual(report.email, { signIn: true, signUp: false, reset: false });
  const disabled = run(allOff, build(['email', 'x']));
  assert.equal(disabled.providers.email.usableNow, false);
  assert.equal(disabled.providers.x.usableNow, false);
  assert.ok(disabled.providers.x.blockers.includes('supabase_disabled'));
});

test('missing or invalid Supabase client config blocks every method', () => {
  for (const supabase of ['missing', 'invalid']) {
    const report = run(allOn, build(['email', 'x', 'google', 'apple']), { ...goodApp, supabase });
    assert.equal(report.findings[0].severity, 'error');
    for (const provider of RELEASE_PROVIDERS) {
      assert.equal(report.providers[provider].usableNow, false, `${supabase}/${provider}`);
      assert.ok(report.providers[provider].blockers.includes('backend_config'));
    }
    assert.deepEqual(report.email, { signIn: false, signUp: false, reset: false });
  }
});

test('callback scheme / browser plugin errors block every flow that returns through the callback', () => {
  const report = run(allOn, build(['email', 'x', 'google', 'apple']), { ...goodApp, scheme: 'other-app' });
  assert.ok(report.findings.some((finding) => finding.code === 'callback_scheme_mismatch' && finding.severity === 'error'));
  assert.equal(report.providers.x.usableNow, false);
  assert.equal(report.providers.google.usableNow, false);
  assert.ok(report.providers.x.blockers.includes('callback_scheme'));
  assert.equal(report.providers.apple.usableNow, true, 'native Apple does not use the callback');
  assert.deepEqual(report.email, { signIn: true, signUp: false, reset: false }, 'e-mail links need the callback');
  assert.equal(run(allOn, build(['email', 'x']), { ...goodApp, scheme: ['x', REQUIRED_SCHEME] }).providers.x.usableNow, true, 'scheme list containing ours');
  const noBrowser = run(allOn, build(['email', 'google']), { ...goodApp, plugins: ['expo-router'] });
  assert.equal(noBrowser.providers.google.usableNow, false);
  assert.ok(noBrowser.providers.google.blockers.includes('browser_plugin'));
});

test('Apple: iOS native needs bundle id, plugin and device support; other platforms need apple_web', () => {
  const noBundle = run(allOn, build(['apple'], { iosBundleIdentifier: null }), { ...goodApp, iosBundleIdentifier: null });
  assert.ok(noBundle.findings.some((finding) => finding.code === 'ios_bundle_identifier_missing' && finding.severity === 'gate'));
  assert.equal(noBundle.providers.apple.usableNow, false);
  assert.ok(noBundle.providers.apple.blockers.includes('ios_bundle_identifier'));
  const noPlugin = run(allOn, build(['apple']), { ...goodApp, usesAppleSignIn: false });
  assert.equal(noPlugin.providers.apple.usableNow, false);
  assert.ok(noPlugin.providers.apple.blockers.includes('apple_native_plugin'));
  const noDevice = run(allOn, build(['apple'], { nativeAppleAvailable: false }));
  assert.equal(noDevice.providers.apple.usableNow, false);
  assert.ok(noDevice.providers.apple.blockers.includes('apple_native_unavailable'));
  assert.equal(noDevice.providers.apple.buildConfigPresent, true, 'device support is not a build config gap');
  assert.equal(run(allOn, build(['apple'], { platform: 'web' })).providers.apple.usableNow, false, 'native declaration does not enable web');
  assert.equal(run(allOn, build(['apple_web'], { platform: 'android' })).providers.apple.usableNow, true);
});

test('unknown declarations are reported and never enable anything', () => {
  const report = run(allOn, build(['email']), { ...goodApp, declaredProviders: 'email, facebook' });
  assert.deepEqual(report.findings, [{ code: 'unknown_provider_declared', severity: 'warning' }]);
  assert.equal(report.providers.x.usableNow, false);
});

test('usable now is never looser than the accepted Phase 2 gate, across all combinations', () => {
  const declarations = ['email', 'x', 'google', 'apple', 'apple_web'];
  for (const settings of [null, allOff, emailOnly, allOn]) {
    for (let mask = 0; mask < 32; mask++) {
      for (const platform of ['ios', 'android', 'web']) {
        for (const bundle of [null, 'com.example.fixture']) {
          for (const native of [false, true]) {
            for (const app of [goodApp, { ...goodApp, scheme: 'other' }, { ...goodApp, supabase: 'missing' }]) {
              const b = { configured: new Set(declarations.filter((_, index) => mask & (1 << index))), platform, nativeAppleAvailable: native, iosBundleIdentifier: bundle };
              const report = authReleaseReadiness({ settings, build: b, app: { ...app, iosBundleIdentifier: bundle } });
              for (const provider of ['x', 'apple', 'google']) {
                const item = report.providers[provider];
                if (item.usableNow) assert.equal(providerReadiness(provider, settings, b).usable, true);
                if (item.usableNow) assert.deepEqual(item.blockers, []);
                if (settings === null) assert.equal(item.usableNow, false);
                assert.equal(item.e2eVerified, false);
              }
            }
          }
        }
      }
    }
  }
});

test('user-facing status: linked / available / setup-pending only; no fake ready', () => {
  const report = run(emailOnly, build(['email']));
  assert.equal(userProviderStatus(report.providers.x, true), 'linked');
  assert.equal(userProviderStatus(report.providers.x, false), 'setup_pending');
  assert.equal(userProviderStatus(run(allOn, build(['x'])).providers.x, false), 'available');
  assert.deepEqual(USER_PROVIDER_STATUS_LABELS, { linked: '利用中', available: '追加できます', setup_pending: '準備中' });
});

test('diagnostics are booleans and fixed codes only', () => {
  const lines = formatAuthDiagnostics(run(null, build(['email', 'apple'], { iosBundleIdentifier: null }), { ...goodApp, iosBundleIdentifier: null, scheme: 'other' }));
  for (const line of lines) {
    assert.match(line, /^[a-z-]+: [A-Za-z0-9=,_: -]+$/u, line);
    assert.doesNotMatch(line, /http|sb_|eyJ|com\.example/u);
  }
  assert.ok(lines.some((line) => line.includes('error:callback_scheme_mismatch')));
  assert.ok(lines.some((line) => line.startsWith('apple:') && line.includes('e2e=no')));
});

test('the real app.json: scheme, plugins and Apple entitlement match; bundle id is an operator gate until set', async () => {
  const expo = JSON.parse(await readFile(join(root, 'app.json'), 'utf8')).expo;
  const app = { supabase: 'ok', scheme: expo.scheme, iosBundleIdentifier: expo.ios?.bundleIdentifier, usesAppleSignIn: expo.ios?.usesAppleSignIn === true, plugins: expo.plugins, declaredProviders: 'email,x,google,apple' };
  const codes = checkAppAuthConfig(app, build(['email', 'x', 'google', 'apple'], { iosBundleIdentifier: expo.ios?.bundleIdentifier ?? null })).map((finding) => finding.code);
  assert.equal(expo.scheme, REQUIRED_SCHEME);
  assert.ok(!codes.includes('callback_scheme_mismatch') && !codes.includes('browser_plugin_missing') && !codes.includes('apple_native_plugin_missing'));
  assert.deepEqual(codes, expo.ios?.bundleIdentifier ? [] : ['ios_bundle_identifier_missing']);
});

test('posting-X status comes from real loaded data only; X login never implies it', () => {
  const connected = [{ platform: 'x', connectionStatus: 'connected' }];
  assert.equal(postingXStatus('mock_preview', connected), 'unknown');
  assert.equal(postingXStatus('loading', connected), 'unknown');
  assert.equal(postingXStatus('ready', connected), 'connected');
  assert.equal(postingXStatus('ready', []), 'not_connected');
  assert.equal(postingXStatus('ready', [{ platform: 'x', connectionStatus: 'not_connected' }]), 'not_connected');
  assert.equal(postingXStatus('ready', [{ platform: 'x', connectionStatus: 'needs_attention' }]), 'needs_reconnect');
  assert.equal(POSTING_X_STATUS_LABELS.unknown, '確認できません');
});

test('operator script: fails on missing config and never prints the URL or key', async () => {
  const exec = promisify(execFile);
  const script = join(root, 'scripts/auth-readiness-check.mjs');
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('EXPO_PUBLIC_')));
  const missing = await exec(process.execPath, [script], { cwd: root, env: clean }).then(() => null, (error) => error);
  assert.equal(missing?.code, 1);
  assert.match(missing.stdout, /config: error:supabase_config_missing/u);
  const dir = await mkdtemp(join(tmpdir(), 'auth-readiness-'));
  const settingsFile = join(dir, 'settings.json');
  await writeFile(settingsFile, JSON.stringify({ external: { email: true, x: true, google: false, apple: false }, disable_signup: false }));
  const env = { ...clean, EXPO_PUBLIC_SUPABASE_URL: 'https://fixture-ref.supabase.co', EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_FIXTUREVALUE', EXPO_PUBLIC_AUTH_PROVIDERS: 'email,x' };
  const { stdout } = await exec(process.execPath, [script, '--settings', settingsFile, '--platform', 'android'], { cwd: root, env });
  assert.doesNotMatch(stdout, /fixture-ref|FIXTUREVALUE|supabase\.co/u);
  assert.match(stdout, /^x: supabase=yes build=yes source=yes e2e=no usable=yes$/mu);
  assert.match(stdout, /^google: supabase=no .* usable=no blockers=supabase_disabled,not_declared_for_build$/mu);
});
