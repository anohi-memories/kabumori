// G2 independent QA (2026-10-20, Issue #317 generation 4): how a `kabumori-social://` return behaves when the OS delivers
// it through the scene life cycle — once as the cold-start initial URL and again (or instead) as a `url` event, late,
// twice, for another flow, or malformed. Pure domain code only (src/domain/auth-flows.ts, src/lib/x-oauth-onboarding.ts);
// the Supabase client is a stub, nothing reaches a network or an identity provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTH_CALLBACK_URL, POSTING_CALLBACK_URL, completeAuthCallback, forgetAuthCallbackOutcomes, parseAuthCallbackUrl,
} from '../src/domain/auth-flows.ts';
import { parseOAuthReturn } from '../src/lib/x-oauth-onboarding.ts';

const FLOW_A = 'flowAAAA11112222';
const FLOW_B = 'flowBBBB33334444';
const USER_A = '00000000-0000-4000-8000-0000000000a1';

/** What AuthProvider does with every delivered URL (getInitialURL and each `url` event). */
function deliver(client, url, expectation) {
  const callback = parseAuthCallbackUrl(url);
  if (callback.kind === 'invalid') return null; // ignored, nothing exchanged
  return completeAuthCallback(client, callback, expectation);
}

function stubClient({ userId = USER_A, fail = null, gate = null } = {}) {
  const calls = [];
  return {
    calls,
    auth: {
      async exchangeCodeForSession(code, options) {
        calls.push({ kind: 'exchange', code, flowId: options?.flowId ?? null });
        if (gate) await gate;
        if (fail) return { data: null, error: { code: fail } };
        return { data: { session: { user: { id: userId } } }, error: null };
      },
      async verifyOtp(params) {
        calls.push({ kind: 'otp', type: params.type });
        return { data: { session: { user: { id: userId } } }, error: null };
      },
    },
  };
}

test.beforeEach(() => forgetAuthCallbackOutcomes());

test('cold start + url event delivering the SAME return: one exchange, both get the same real result', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const client = stubClient({ gate });
  const url = `${AUTH_CALLBACK_URL}?sb_flow_id=${FLOW_A}&code=c-1`;
  const initial = deliver(client, url);
  const event = deliver(client, url);
  release();
  const [a, b] = await Promise.all([initial, event]);
  assert.deepEqual(a, { ok: true, userId: USER_A });
  assert.deepEqual(b, a);
  assert.equal(client.calls.length, 1, 'the verifier is consumed once');
});

test('a late duplicate (after background → resume) shares the first outcome, including a failure — never a fresh "success"', async () => {
  const client = stubClient({ fail: 'flow_state_not_found' });
  const url = `${AUTH_CALLBACK_URL}?sb_flow_id=${FLOW_A}&code=c-2`;
  const first = await deliver(client, url);
  const late = await deliver(client, url);
  assert.equal(first.ok, false);
  assert.deepEqual(late, first);
  assert.equal(client.calls.length, 1);
});

test('the same code replayed under ANOTHER flow id is refused without exchanging or borrowing the first result', async () => {
  const client = stubClient();
  await deliver(client, `${AUTH_CALLBACK_URL}?sb_flow_id=${FLOW_A}&code=c-3`);
  const replay = await deliver(client, `${AUTH_CALLBACK_URL}?sb_flow_id=${FLOW_B}&code=c-3`);
  assert.equal(replay.ok, false);
  assert.equal(client.calls.length, 1);
});

test('a flow this process started only accepts ITS return; a return for another flow is refused before any exchange', async () => {
  const client = stubClient();
  const result = await deliver(client, `${AUTH_CALLBACK_URL}?sb_flow_id=${FLOW_B}&code=c-4`, { flowId: FLOW_A });
  assert.equal(result.ok, false);
  assert.equal(client.calls.length, 0);
});

test('malformed / foreign / posting returns delivered by the OS are ignored (no exchange at all)', async () => {
  const client = stubClient();
  for (const url of [
    `${POSTING_CALLBACK_URL}?code=x&state=s`, // the X posting connect return is never a sign-in return
    'kabumori-social://manual-publish',
    'kabumori-social://accounts/sa_th_connected',
    `kabumori-social://auth-callback/extra?sb_flow_id=${FLOW_A}&code=c`,
    `kabumori-social://auth-callback?code=c`, // PKCE code without its flow id
    `kabumori-social://auth-callback?sb_flow_id=${FLOW_A}&code=c&code=d`,
    `kabumori-social://auth-callback?sb_flow_id=${FLOW_A}&code=c&access_token=t`, // implicit-grant fields are not accepted
    `kabumori-social://auth-callback?sb_flow_id=${FLOW_A}&code=c&user_id=${USER_A}`, // no identity can be injected by URL
    'kabumori-social://auth-callback',
    '%%%',
  ]) assert.equal(deliver(client, url), null, url);
  assert.equal(client.calls.length, 0);
});

test('the signed-in identity comes only from the exchanged session, never from the URL', async () => {
  const client = stubClient({ userId: '00000000-0000-4000-8000-0000000000b2' });
  const result = await deliver(client, `${AUTH_CALLBACK_URL}?sb_flow_id=${FLOW_A}&code=c-5`);
  assert.deepEqual(result, { ok: true, userId: '00000000-0000-4000-8000-0000000000b2' });
});

test('X posting connect return: only the in-flight state is accepted; a stale, foreign or duplicated return fails closed', () => {
  const redirect = POSTING_CALLBACK_URL;
  assert.deepEqual(parseOAuthReturn(`${redirect}?code=abc&state=s-now`, redirect, 's-now'), { kind: 'success', code: 'abc', state: 's-now' });
  // an old return arriving after a new connect started (resume after background)
  assert.throws(() => parseOAuthReturn(`${redirect}?code=abc&state=s-old`, redirect, 's-now'), /OAUTH_STATE_MISMATCH/u);
  // a return meant for another route or app
  assert.throws(() => parseOAuthReturn(`kabumori-social://auth-callback?code=abc&state=s-now`, redirect, 's-now'), /REDIRECT_MISMATCH/u);
  assert.throws(() => parseOAuthReturn(`com.anohi-memories.kabumori-social-mobile://oauth-callback?code=abc&state=s-now`, redirect, 's-now'), /REDIRECT_MISMATCH/u);
  // no state at all
  assert.throws(() => parseOAuthReturn(`${redirect}?code=abc`, redirect, 's-now'), /OAUTH_STATE_MISMATCH/u);
});

test('OBSERVATION (no finding): a repeated `state` parameter is resolved by URLSearchParams.get (the first wins); the server-side state check stays authoritative', () => {
  const redirect = POSTING_CALLBACK_URL;
  assert.deepEqual(parseOAuthReturn(`${redirect}?code=abc&state=s-now&state=evil`, redirect, 's-now'), { kind: 'success', code: 'abc', state: 's-now' });
  assert.throws(() => parseOAuthReturn(`${redirect}?code=abc&state=evil&state=s-now`, redirect, 's-now'), /OAUTH_STATE_MISMATCH/u);
});
