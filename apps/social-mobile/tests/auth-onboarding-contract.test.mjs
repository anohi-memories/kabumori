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

test('no service role / secret material anywhere in the mobile client', async () => {
  for (const { path, text } of await sources('src')) {
    assert.doesNotMatch(text, /SERVICE_ROLE|service_role_key|X_CLIENT_SECRET|vault_(access|refresh)_token_secret_id|decrypted_secret/u, path);
  }
});

test('X connect keeps state/verifier in memory only and sends no ownership ids', async () => {
  const hook = await read('src/features/x-connect/use-x-connect.ts');
  assert.doesNotMatch(hook, /AsyncStorage|localStorage|SecureStore/u);
  assert.match(hook, /rawState = null;\s+codeVerifier = null;/u);
  assert.match(hook, /body: \{ state: rawState, code_challenge: codeChallenge, redirect_uri: redirectUri \}/u);
  assert.doesNotMatch(hook, /brand_id|social_account_id|user_id/u);
  assert.match(hook, /authorization\.hostname !== 'x\.com'/u);
  const accounts = await read('src/app/accounts/index.tsx');
  assert.match(accounts, /useXConnect\(reload\)/u);
  assert.doesNotMatch(accounts, /functions\.invoke|Crypto\./u, 'single connect implementation');
});

test('onboarding reads only RLS-scoped, non-secret data derived from the self-membership', async () => {
  const repo = await read('src/data/onboarding-repository.ts');
  assert.match(repo, /from\('brand_memberships'\)\.select\('brand_id'\)\.eq\('user_id', userId\)/u);
  assert.match(repo, /select\('id,brand_id,handle,connection_status,last_connection_error_code'\)/u);
  assert.match(repo, /\.eq\('brand_id', brandIds\[0\]\)\.eq\('platform', 'x'\)/u);
  assert.match(repo, /if \(brandIds\.length !== 1\)/u);
  assert.doesNotMatch(repo, /service|vault|token/iu);
});

test('real-data mode never falls back to mock accounts; routing puts the gate after auth and before the app', async () => {
  const active = await read('src/providers/active-account-provider.tsx');
  assert.match(active, /status === 'mock_preview' \? mockRepository\.getAccounts\(\) : status === 'ready' && snapshot \? snapshot\.accounts : \[\]/u);
  const layout = await read('src/app/_layout.tsx');
  const gate = layout.indexOf('<OnboardingGate>');
  assert.ok(layout.indexOf('if (!session) return <AuthScreen />') < gate && gate < layout.indexOf('<ActiveAccountProvider>'));
  const callback = await read('src/app/oauth-callback.tsx');
  assert.match(callback, /<Redirect href="\/" \/>/u);
  assert.doesNotMatch(callback.replace(/\/\*[\s\S]*?\*\//gu, ''), /useLocalSearchParams|code|state/u, 'deep link is never parsed or stored here');
});
