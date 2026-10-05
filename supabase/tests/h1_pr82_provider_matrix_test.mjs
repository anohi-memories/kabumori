import assert from 'node:assert/strict';
import test from 'node:test';
import { VaultAccountXAuth } from '../functions/x-test-post/vault_account_auth.ts';
import { XRefreshLease } from '../functions/_shared/x_v2_account_refresh.ts';
import { sendAiLabXPost, AiLabProviderNoPostError } from '../functions/_shared/brand/ai_lab_provider_outcome.ts';

// Real auth and observed sender; all credential/token HTTP/request ports are fake.
async function fixture({ refresh = false, proactive = false, refreshFailure = false } = {}) {
  let refreshed = false;
  const counts = { token: 0, request: 0 };
  const auth = await VaultAccountXAuth.load({ scheduledPostId: 'fixture', socialAccountId: 'fixture', brandId: 'ai_salaryman_lab' }, {
    read: async () => ({ accessToken: refreshed ? 'fixture-new' : 'fixture-old', accessExpiresAt: proactive && !refreshed ? new Date(0).toISOString() : null }),
    begin: async () => new XRefreshLease('fixture-lease', 'fixture-client', 'fixture-refresh'),
    commit: async () => { refreshed = true; return 'committed'; },
    release: async () => 'uncertain',
    recordAccessUnauthorized: async () => 'RECORDED',
    recordRejectedAfterRefresh: async () => 'RECORDED',
  }, { refreshEnabled: refresh, resolveClient: () => ({ clientId: 'fixture-client', clientSecret: 'fixture-only' }),
    fetchImpl: async () => { counts.token++; if (refreshFailure) throw new TypeError('fixture transport failure'); return Response.json({ access_token: 'fixture-new', expires_in: 7200 }); }, now: () => 1_000_000 });
  return { counts, run: responses => sendAiLabXPost({ send: request => auth.send(request), request: async () => {
    const item = responses[counts.request++];
    if (item instanceof Error) throw item;
    return { status: item, body: item === 201 ? { data: { id: '1' } } : {} };
  } }) };
}
for (const status of [400, 401, 422, 429]) test(`actual Vault: ${status} proves no-post`, async () => {
  const f = await fixture();
  await assert.rejects(() => f.run([status]), e => e instanceof AiLabProviderNoPostError && e.evidence === `HTTP_${status}`);
  assert.deepEqual(f.counts, { token: 0, request: 1 });
});
for (const response of [403, 408, 302, 500, 503, new TypeError('fetch failed'), new Error('X_REQUEST_FAILED:401')]) {
  test(`actual Vault: uncertain ${String(response)} never proves no-post`, async () => {
    const f = await fixture();
    await assert.rejects(() => f.run([response]), e => !(e instanceof AiLabProviderNoPostError));
  });
}
test('actual reactive refresh: 401 then success is returned, not released', async () => {
  const f = await fixture({ refresh: true });
  assert.deepEqual(await f.run([401, 201]), { data: { id: '1' } });
  assert.deepEqual(f.counts, { token: 1, request: 2 });
});
test('actual reactive refresh: two genuine 401s preserve transformed code with no-post proof', async () => {
  const f = await fixture({ refresh: true });
  await assert.rejects(() => f.run([401, 401]), e => e instanceof AiLabProviderNoPostError && e.evidence === 'HTTP_401' && e.message === 'X_ACCESS_TOKEN_REJECTED_AFTER_REFRESH');
  assert.deepEqual(f.counts, { token: 1, request: 2 });
});
for (const response of [500, new TypeError('lost response'), new Error('X_REQUEST_FAILED:401')]) test(`actual reactive retry uncertain: ${String(response)}`, async () => {
  const f = await fixture({ refresh: true });
  await assert.rejects(() => f.run([401, response]), e => !(e instanceof AiLabProviderNoPostError));
  assert.deepEqual(f.counts, { token: 1, request: 2 });
});
test('actual proactive refresh transport failure: zero create-post calls is NOT_SENT', async () => {
  const f = await fixture({ refresh: true, proactive: true, refreshFailure: true });
  await assert.rejects(() => f.run([]), e => e instanceof AiLabProviderNoPostError && e.evidence === 'NOT_SENT');
  assert.deepEqual(f.counts, { token: 1, request: 0 });
});
test('observed mixed uncertainty cannot be hidden by a final clear 401', async () => {
  let n = 0;
  await assert.rejects(() => sendAiLabXPost({ send: async request => { await request('fixture'); return request('fixture'); }, request: async () => ({ status: ++n === 1 ? 500 : 401, body: {} }) }), e => !(e instanceof AiLabProviderNoPostError));
});
