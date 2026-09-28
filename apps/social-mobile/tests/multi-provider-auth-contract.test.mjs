import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFile(join(root, path), 'utf8');
async function sources(dir) {
  const out = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sources(path));
    else if (/\.(ts|tsx)$/u.test(entry.name)) out.push({ path, text: await read(path) });
  }
  return out;
}

test('login X is never a posting credential: no provider tokens anywhere; auth code never calls the posting connector', async () => {
  for (const { path, text } of await sources('src')) {
    assert.doesNotMatch(text, /provider_token|provider_refresh_token|providerToken/u, path);
  }
  const flows = await read('src/lib/auth-client-flows.ts');
  const provider = await read('src/providers/auth-provider.tsx');
  for (const text of [flows, provider]) assert.doesNotMatch(text, /x-oauth-connect-user|useXConnect/u);
  const posting = await read('src/features/x-connect/use-x-connect.ts');
  assert.doesNotMatch(posting, /signInWithOAuth|linkIdentity|signInWithIdToken/u);
});

test('user_metadata is never used (not for authorization, not for anything)', async () => {
  for (const { path, text } of await sources('src')) assert.doesNotMatch(text, /user_metadata|raw_user_meta_data/u, path);
});

test('PKCE and redirect contract: fixed auth callback, only the project host may be opened', async () => {
  assert.match(await read('src/lib/supabase.ts'), /flowType: 'pkce'/u);
  const flows = await read('src/lib/auth-client-flows.ts');
  assert.equal((flows.match(/redirectTo: AUTH_CALLBACK_URL, skipBrowserRedirect: true/gu) ?? []).length, 2);
  assert.match(flows, /target\.protocol !== 'https:' \|\| target\.host !== supabaseHost \|\| !target\.pathname\.startsWith\('\/auth\/v1\/'\)/u);
  assert.match(flows, /openAuthSessionAsync\(authorizeUrl, AUTH_CALLBACK_URL\)/u);
  assert.match(flows, /if \(handledCodes\.has\(callback\.code\)\) return \{ ok: true \};/u, 'a code is exchanged at most once');
});

test('Apple native: nonce hashed to Apple, raw to Supabase', async () => {
  const flows = await read('src/lib/auth-client-flows.ts');
  assert.match(flows, /nonce: hashedNonce/u);
  assert.match(flows, /signInWithIdToken\(\{ provider: 'apple', token: credential\.identityToken, nonce: rawNonce \}\)/u);
});

test('linking is explicit and authenticated: linkIdentity only in linkOAuthProvider, used only by the login-methods screen', async () => {
  const code = (text) => text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, '');
  const hits = (await sources('src')).filter(({ text }) => /linkIdentity\(/u.test(code(text))).map(({ path }) => path);
  assert.deepEqual(hits, ['src/lib/auth-client-flows.ts']);
  const users = (await sources('src')).filter(({ text }) => /linkProvider\(/u.test(code(text))).map(({ path }) => path).sort();
  assert.deepEqual(users, ['src/app/login-methods.tsx'], 'only the explicit login-methods screen links');
  assert.doesNotMatch(await read('src/app/login-methods.tsx'), /unlinkIdentity/u, 'no unlink in this phase');
});

test('existing password login, session restore, logout and recovery ordering are preserved', async () => {
  const provider = await read('src/providers/auth-provider.tsx');
  assert.match(provider, /signInWithPassword\(\{ email, password \}\)/u);
  assert.match(provider, /auth\.getSession\(\)/u);
  assert.match(provider, /onAuthStateChange\(\(event, nextSession\)/u);
  assert.match(provider, /if \(event === 'PASSWORD_RECOVERY'\) setRecoveryMode\(true\);/u);
  assert.match(provider, /setSession\(null\);\s+setRecoveryMode\(false\);/u);
  assert.match(provider, /\/auth\/v1\/settings/u);
  assert.doesNotMatch(provider, /SERVICE_ROLE|service_role/u);
  const layout = await read('src/app/_layout.tsx');
  const auth = layout.indexOf('if (!session) return <AuthScreen />');
  const recovery = layout.indexOf('if (recoveryMode) return <NewPasswordScreen />');
  assert.ok(auth > 0 && recovery > auth && recovery < layout.indexOf('<OnboardingGate>'));
  const reset = provider.slice(provider.indexOf('requestPasswordReset: async'), provider.indexOf('completePasswordRecovery: async'));
  assert.match(reset, /登録済みのメールアドレスであれば/u, 'same answer whether or not the address exists');
});

test('auth deep-link route never parses the link itself; posting and auth callbacks differ', async () => {
  const route = (await read('src/app/auth-callback.tsx')).replace(/\/\*[\s\S]*?\*\//gu, '');
  assert.match(route, /<Redirect href="\/" \/>/u);
  assert.doesNotMatch(route, /useLocalSearchParams|code|token/u);
  const domain = await read('src/domain/auth-flows.ts');
  assert.match(domain, /AUTH_CALLBACK_URL = 'kabumori-social:\/\/auth-callback'/u);
  assert.match(domain, /POSTING_CALLBACK_URL = 'kabumori-social:\/\/oauth-callback'/u);
});
