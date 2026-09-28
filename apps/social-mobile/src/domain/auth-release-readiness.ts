/**
 * Release readiness for app login, per provider. Deterministic and pure (only
 * a relative import of the equally pure auth-flows), so it runs under node:test
 * and in the operator script `scripts/auth-readiness-check.mjs`.
 *
 * Four facts are kept separate and never merged into one "ready" flag:
 * enabled in Supabase (yes/no/unknown), required build config present,
 * source path implemented, real-device E2E verified (always false here).
 * "Usable now" is the fail-closed conjunction the UI gates on.
 * Diagnostics contain only booleans and fixed codes — never URLs, keys or tokens.
 */
import {
  AUTH_CALLBACK_URL,
  applePath,
  emailCapabilities,
  providerReadiness,
  type AuthProviderId,
  type BuildAuthConfig,
  type ProviderSettings,
} from './auth-flows.ts';

export const RELEASE_PROVIDERS: readonly AuthProviderId[] = ['email', 'x', 'apple', 'google'];
const DECLARABLE = ['email', 'x', 'google', 'apple', 'apple_web'];

/** The URL scheme the auth callback (and e-mail links) return to. */
export const REQUIRED_SCHEME = AUTH_CALLBACK_URL.slice(0, AUTH_CALLBACK_URL.indexOf(':'));

/** Only what the app bundle itself declares; values are never echoed back. */
export type AppAuthConfig = {
  supabase: 'ok' | 'missing' | 'invalid';
  scheme: string | readonly string[] | null | undefined;
  iosBundleIdentifier: string | null | undefined;
  usesAppleSignIn: boolean;
  plugins: readonly unknown[];
  /** Raw EXPO_PUBLIC_AUTH_PROVIDERS, only to detect unknown entries. */
  declaredProviders: string | undefined;
};

export type ConfigFindingCode =
  | 'supabase_config_missing'
  | 'supabase_config_invalid'
  | 'callback_scheme_mismatch'
  | 'browser_plugin_missing'
  | 'apple_native_plugin_missing'
  | 'ios_bundle_identifier_missing'
  | 'unknown_provider_declared';

export type ConfigFinding = {
  code: ConfigFindingCode;
  /** error: blocks the affected flows now. gate: an operator step still needed before that provider can work. */
  severity: 'error' | 'gate' | 'warning';
};

export type ReadinessBlocker =
  | 'backend_config'
  | 'supabase_disabled'
  | 'supabase_unknown'
  | 'not_declared_for_build'
  | 'callback_scheme'
  | 'browser_plugin'
  | 'apple_native_plugin'
  | 'ios_bundle_identifier'
  | 'apple_native_unavailable';

export type TriState = 'yes' | 'no' | 'unknown';

export type ProviderReleaseReadiness = {
  provider: AuthProviderId;
  enabledInSupabase: TriState;
  buildConfigPresent: boolean;
  sourceImplemented: boolean;
  /** Only real-device testing can set this; source never claims it. */
  e2eVerified: false;
  usableNow: boolean;
  blockers: readonly ReadinessBlocker[];
};

export type AuthReleaseReport = {
  findings: readonly ConfigFinding[];
  providers: Record<AuthProviderId, ProviderReleaseReadiness>;
  email: { signIn: boolean; signUp: boolean; reset: boolean };
};

/** Every provider has an implemented source path (e-mail/PKCE, browser OAuth, native Apple on iOS). */
const SOURCE_IMPLEMENTED: Record<AuthProviderId, boolean> = { email: true, x: true, apple: true, google: true };

function pluginNames(plugins: readonly unknown[]): Set<string> {
  const names = new Set<string>();
  for (const plugin of plugins) {
    if (typeof plugin === 'string') names.add(plugin);
    else if (Array.isArray(plugin) && typeof plugin[0] === 'string') names.add(plugin[0]);
  }
  return names;
}

function schemeMatches(scheme: AppAuthConfig['scheme']): boolean {
  if (typeof scheme === 'string') return scheme === REQUIRED_SCHEME;
  return Array.isArray(scheme) && scheme.includes(REQUIRED_SCHEME);
}

/** Static checks of the bundle's own auth configuration. */
export function checkAppAuthConfig(app: AppAuthConfig, build: BuildAuthConfig): ConfigFinding[] {
  const findings: ConfigFinding[] = [];
  if (app.supabase === 'missing') findings.push({ code: 'supabase_config_missing', severity: 'error' });
  if (app.supabase === 'invalid') findings.push({ code: 'supabase_config_invalid', severity: 'error' });
  if (!schemeMatches(app.scheme)) findings.push({ code: 'callback_scheme_mismatch', severity: 'error' });
  const plugins = pluginNames(app.plugins);
  if (!plugins.has('expo-web-browser')) findings.push({ code: 'browser_plugin_missing', severity: 'error' });
  if (build.configured.has('apple')) {
    if (!plugins.has('expo-apple-authentication') || !app.usesAppleSignIn) findings.push({ code: 'apple_native_plugin_missing', severity: 'error' });
    if (!app.iosBundleIdentifier?.trim()) findings.push({ code: 'ios_bundle_identifier_missing', severity: 'gate' });
  }
  const declared = (app.declaredProviders ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  if (declared.some((item) => !DECLARABLE.includes(item))) findings.push({ code: 'unknown_provider_declared', severity: 'warning' });
  return findings;
}

/** Whether a flow needs a browser/deep-link return (all but native Apple and password sign-in). */
function usesCallback(provider: AuthProviderId, build: BuildAuthConfig): boolean {
  return provider !== 'email' && !(provider === 'apple' && applePath(build) === 'native');
}

function blockersFor(provider: AuthProviderId, settings: ProviderSettings, build: BuildAuthConfig, codes: ReadonlySet<ConfigFindingCode>): ReadinessBlocker[] {
  const blockers: ReadinessBlocker[] = [];
  if (codes.has('supabase_config_missing') || codes.has('supabase_config_invalid')) blockers.push('backend_config');
  // E-mail sign-in keeps working while settings are unknown (existing users); social providers do not.
  if (settings === null) { if (provider !== 'email') blockers.push('supabase_unknown'); }
  else if (!settings.external[provider]) blockers.push('supabase_disabled');
  const native = provider === 'apple' && applePath(build) === 'native';
  const declaredKey = provider === 'apple' && !native ? 'apple_web' : provider;
  if (!build.configured.has(declaredKey)) blockers.push('not_declared_for_build');
  if (usesCallback(provider, build)) {
    if (codes.has('callback_scheme_mismatch')) blockers.push('callback_scheme');
    if (codes.has('browser_plugin_missing')) blockers.push('browser_plugin');
  }
  if (native) {
    if (codes.has('apple_native_plugin_missing')) blockers.push('apple_native_plugin');
    if (!build.iosBundleIdentifier?.trim()) blockers.push('ios_bundle_identifier');
    if (!build.nativeAppleAvailable) blockers.push('apple_native_unavailable');
  }
  return blockers;
}

const BUILD_BLOCKERS: ReadonlySet<ReadinessBlocker> = new Set([
  'backend_config', 'not_declared_for_build', 'callback_scheme', 'browser_plugin', 'apple_native_plugin', 'ios_bundle_identifier',
]);

export function authReleaseReadiness(input: { settings: ProviderSettings; build: BuildAuthConfig; app: AppAuthConfig }): AuthReleaseReport {
  const { settings, build, app } = input;
  const findings = checkAppAuthConfig(app, build);
  const codes = new Set(findings.map((finding) => finding.code));
  const backendOk = !codes.has('supabase_config_missing') && !codes.has('supabase_config_invalid');
  const callbackOk = !codes.has('callback_scheme_mismatch');
  const caps = emailCapabilities(settings, build);
  // E-mail links (confirmation, recovery) come back through the auth callback.
  const email = { signIn: backendOk && caps.signIn, signUp: backendOk && callbackOk && caps.signUp, reset: backendOk && callbackOk && caps.reset };
  const providers = {} as Record<AuthProviderId, ProviderReleaseReadiness>;
  for (const provider of RELEASE_PROVIDERS) {
    const blockers = blockersFor(provider, settings, build, codes);
    // Social providers: the Phase 2 gate AND no blocker at all (fail closed).
    const usableNow = provider === 'email'
      ? email.signIn
      : providerReadiness(provider, settings, build).usable && SOURCE_IMPLEMENTED[provider] && blockers.length === 0;
    providers[provider] = {
      provider,
      enabledInSupabase: settings === null ? 'unknown' : settings.external[provider] ? 'yes' : 'no',
      buildConfigPresent: !blockers.some((blocker) => BUILD_BLOCKERS.has(blocker)),
      sourceImplemented: SOURCE_IMPLEMENTED[provider],
      e2eVerified: false,
      usableNow,
      blockers,
    };
  }
  return { findings, providers, email };
}

export type UserProviderStatus = 'linked' | 'available' | 'setup_pending';

/** What an ordinary user sees: never operator detail, never a fake "ready". */
export function userProviderStatus(readiness: ProviderReleaseReadiness, linked: boolean): UserProviderStatus {
  if (linked) return 'linked';
  return readiness.usableNow ? 'available' : 'setup_pending';
}

export const USER_PROVIDER_STATUS_LABELS: Record<UserProviderStatus, string> = {
  linked: '利用中',
  available: '追加できます',
  setup_pending: '準備中',
};

/** Developer/operator-only lines: booleans and fixed codes, no values from config or the server. */
export function formatAuthDiagnostics(report: AuthReleaseReport): string[] {
  const yesNo = (value: boolean) => (value ? 'yes' : 'no');
  const lines = RELEASE_PROVIDERS.map((provider) => {
    const item = report.providers[provider];
    return `${provider}: supabase=${item.enabledInSupabase} build=${yesNo(item.buildConfigPresent)} source=${yesNo(item.sourceImplemented)} e2e=${yesNo(item.e2eVerified)} usable=${yesNo(item.usableNow)}${item.blockers.length ? ` blockers=${item.blockers.join(',')}` : ''}`;
  });
  lines.push(`email-capabilities: signIn=${yesNo(report.email.signIn)} signUp=${yesNo(report.email.signUp)} reset=${yesNo(report.email.reset)}`);
  lines.push(`config: ${report.findings.length ? report.findings.map((finding) => `${finding.severity}:${finding.code}`).join(',') : 'ok'}`);
  return lines;
}
