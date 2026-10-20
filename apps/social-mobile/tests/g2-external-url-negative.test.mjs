// G2 independent QA (2026-10-20, Issue #317 generation 5): external `kabumori-social://` URLs versus the manual X post
// draft and the "unknown link" screen, on top of PR #346. Offline only: pure model / route sources and the installed
// expo-router build are read; nothing reaches a network, an identity provider or a device.
// Tests named "FINDING" pin what the source does today for a P3 handed to G1 / the app-wide owner; a fix is expected
// to change them (they then become the regression baseline the other way round).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as m from '../src/features/manual-publish/manual-publish-model.ts';
import { AUTH_CALLBACK_URL, completeAuthCallback, forgetAuthCallbackOutcomes, parseAuthCallbackUrl } from '../src/domain/auth-flows.ts';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const apply = (state, ...actions) => actions.reduce((s, a) => m.manualPublishReducer(s, a), state);

// ---------------------------------------------------------------- (a) draft and selected account vs. an incoming URL

test('FINDING G2-U1 (P3, owner G1/app): both return routes replace the current screen with Home — nothing keeps the open draft', () => {
  for (const route of ['src/app/oauth-callback.tsx', 'src/app/auth-callback.tsx']) {
    const source = read(route);
    assert.match(source, /<Redirect href="\/" \/>/u, `${route} redirects to Home`);
    assert.doesNotMatch(source, /router\.back|canGoBack|dismiss/u, `${route} does not return to the previous screen`);
  }
});

test('FINDING G2-U1 (P3): the draft lives only in the screen state — a remounted screen starts with an empty draft and no account', () => {
  const typed = apply(m.createInitialState(), { type: 'account_selected', accountId: 'account-x-sub' }, { type: 'draft_changed', text: '途中まで書いた本文' });
  assert.equal(typed.draft, '途中まで書いた本文');
  assert.equal(typed.accountId, 'account-x-sub');
  // What ManualPublishScreen does on a fresh mount when no unresolved attempt is remembered.
  const remounted = m.createInitialState(null);
  assert.equal(remounted.draft, '');
  assert.equal(remounted.accountId, null);
  const screen = read('src/app/manual-publish.tsx');
  assert.doesNotMatch(screen, /draft[^\n]{0,40}(AsyncStorage|attemptStore\.save|persist)/u, 'the draft text is not persisted anywhere');
});

test('no mixing: a URL can never pre-fill the text or choose the account — the screen reads no route params', () => {
  const screen = read('src/app/manual-publish.tsx');
  assert.doesNotMatch(screen, /useLocalSearchParams|useGlobalSearchParams|useSearchParams/u);
});

test('no mixing: after an account / workspace switch the chosen account is dropped unless it is still in the list', () => {
  const s = apply(m.createInitialState(), { type: 'account_selected', accountId: 'account-x-sub' }, { type: 'draft_changed', text: '本文' });
  assert.equal(apply(s, { type: 'accounts_changed', accountIds: ['account-x-main', 'account-x-sub'] }).accountId, 'account-x-sub');
  const switched = apply(s, { type: 'accounts_changed', accountIds: ['account-x-main'] });
  assert.equal(switched.accountId, null, 'never kept for another account list');
  assert.equal(switched.consent, null);
});

// ---------------------------------------------------------------- (b) unknown / malformed links

test('FINDING G2-U2 (P3, owner G1/app): the app has no not-found route, so expo-router\'s default Unmatched screen is used', () => {
  const files = readdirSync(resolve(root, 'src/app'));
  assert.equal(files.some((f) => /^\+not-found\./u.test(f)), false, 'no src/app/+not-found.tsx');
  assert.equal(existsSync(resolve(root, 'src/app/_sitemap.tsx')), false, 'the default sitemap route is not overridden either');
});

test('FINDING G2-U2 (P3): the default Unmatched screen is English, prints the received link and links to the route sitemap', () => {
  const unmatched = readFileSync(resolve(root, 'node_modules/expo-router/build/views/Unmatched.js'), 'utf8');
  assert.match(unmatched, /"Unmatched Route"/u);
  assert.match(unmatched, /"Page could not be found\."/u);
  assert.match(unmatched, /createURL\)\(pathname\)/u, 'the link text is rebuilt from the received path');
  assert.match(unmatched, /href: "\/_sitemap"/u);
  assert.match(unmatched, /"Sitemap"/u);
});

// ---------------------------------------------------------------- (c) returns go only to the flow / person they belong to

const FLOW_A = 'flowAAAA11112222';
const FLOW_B = 'flowBBBB33334444';
function client(userId = '00000000-0000-4000-8000-0000000000a1') {
  const calls = [];
  return { calls, auth: {
    async exchangeCodeForSession(code, options) { calls.push({ code, flowId: options?.flowId ?? null }); return { data: { session: { user: { id: userId } } }, error: null }; },
    async verifyOtp() { calls.push({ otp: true }); return { data: { session: { user: { id: userId } } }, error: null }; },
  } };
}
const deliver = (c, url, expectation) => { const cb = parseAuthCallbackUrl(url); return cb.kind === 'invalid' ? null : completeAuthCallback(c, cb, expectation); };

test.beforeEach(() => forgetAuthCallbackOutcomes());

test('token-like or identity-like query parameters on a return are refused outright (0 exchanges)', () => {
  const c = client();
  for (const extra of ['access_token=QA', 'refresh_token=QA', 'provider_token=QA', 'provider_refresh_token=QA', 'id_token=QA', 'user_id=QA', 'email=qa%40example.com', 'redirect_to=evil://x']) {
    assert.equal(deliver(c, `${AUTH_CALLBACK_URL}?sb_flow_id=${FLOW_A}&code=c1&${extra}`), null, extra);
  }
  assert.equal(c.calls.length, 0);
});

test('percent-encoding tricks do not create a second credential or another flow (0 exchanges)', () => {
  const c = client();
  for (const url of [
    `${AUTH_CALLBACK_URL}?sb_flow_id=${FLOW_A}&code=c1%26code%3Dc2`, // an encoded "&code=" stays inside one value -> unsafe value
    `${AUTH_CALLBACK_URL}?sb_flow_id=${FLOW_A}%26sb_flow_id%3D${FLOW_B}&code=c1`,
    `${AUTH_CALLBACK_URL}?sb_flow_id=${FLOW_A}&code=%E0%A4%A`, // broken escape
  ]) assert.equal(deliver(c, url), null, url);
  assert.equal(c.calls.length, 0);
  // An encoded key name is ordinary URL decoding ("co%64e" IS "code"): one normal credential, not a bypass.
  assert.deepEqual(parseAuthCallbackUrl(`${AUTH_CALLBACK_URL}?sb_flow_id=${FLOW_A}&co%64e=c1`), { kind: 'code', code: 'c1', flowId: FLOW_A });
  assert.deepEqual(parseAuthCallbackUrl(`${AUTH_CALLBACK_URL}?sb_flow_id=${FLOW_A}&code=c1&co%64e=c2`), { kind: 'invalid' }, 'and it still counts as a duplicate');
});

test('valid return for the flow this device started: exactly one exchange; duplicate shares it; wrong flow refused before exchange', async () => {
  const c = client();
  const url = `${AUTH_CALLBACK_URL}?sb_flow_id=${FLOW_A}&code=c-ok`;
  const [one, two] = await Promise.all([deliver(c, url, { flowId: FLOW_A }), deliver(c, url)]);
  assert.deepEqual(one, { ok: true, userId: '00000000-0000-4000-8000-0000000000a1' });
  assert.deepEqual(two, one);
  assert.equal(c.calls.length, 1);
  const wrong = await deliver(c, `${AUTH_CALLBACK_URL}?sb_flow_id=${FLOW_B}&code=c-other`, { flowId: FLOW_A });
  assert.equal(wrong.ok, false);
  assert.equal(c.calls.length, 1, 'wrong flow: 0 further exchanges');
});
