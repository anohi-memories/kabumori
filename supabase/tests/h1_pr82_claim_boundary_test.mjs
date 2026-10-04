// H1 independent review: fake X/model; actual candidate SQL through a local-only psql bridge.
// Safety assertions are intentionally RED where candidate contracts remain unmet.
import assert from 'node:assert/strict';
import test, { before, beforeEach, after } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAiLabTopicPort } from '../functions/_shared/brand/ai_lab_brand_post_store.ts';
import { dispatchAiLabScheduledBrandPost } from '../functions/_shared/brand/ai_lab_scheduled_brand_post.ts';
import { buildAiLabTopicCandidates } from '../functions/_shared/brand/ai_lab_dev_diary_context.ts';
import { resolveBrandContext } from '../functions/_shared/brand/brand_context.ts';
import { VaultAccountXAuth } from '../functions/x-test-post/vault_account_auth.ts';

const run = promisify(execFile);
const host = process.env.AILAB_PGHOST;
const port = process.env.AILAB_PGPORT;
const superuser = process.env.AILAB_PGSUPER;
if (!host?.startsWith('/private/tmp/kabumori-h1-20261004.') || !port || !superuser) throw new Error('H1 OWN LOCAL CLUSTER REQUIRED');
const db = `h1_pr82_boundary_${process.pid}`;
const owner = 'kb_ai_lab_claims_owner';
const migration = process.env.H1_MUTATION_SQL ?? new URL('../migrations/20261004090000_ai_lab_topic_claims.sql', import.meta.url).pathname;
if (process.env.H1_MUTATION_SQL && !migration.startsWith(`${host}/`)) throw new Error('H1 MUTATION MUST BE OWN LOCAL FILE');
const literal = value => value === null ? 'null' : `'${String(value).replaceAll("'", "''")}'`;
const args = (database, role) => ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', host, '-p', port, '-U', role, '-d', database];
async function sql(query, role = owner, database = db) {
  return (await run('psql', [...args(database, role), '-c', query], { maxBuffer: 2_000_000 })).stdout.trim();
}
async function apply(role = owner) { return run('psql', [...args(db, role), '-f', migration]); }
const sid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const key = 'diary:20261001-account-selection-check';
const diary = { kind: 'diary', eventKey: key, unitKey: `${key}#changed`, themeTags: [], topic: '接続画面のアカウント重複を確認した' };
const evergreen = (n, themeTags = []) => ({ kind: 'evergreen', eventKey: `evergreen-${n}`, unitKey: `evergreen-${n}`, themeTags, topic: '設定画面を確認した' });
const payload = candidates => candidates.map(c => ({ kind: c.kind, event_key: c.eventKey, unit_key: c.unitKey, theme_tags: c.themeTags }));
async function claim(n, candidates) {
  return JSON.parse(await sql(`set role service_role; select public.claim_ai_lab_topic(${literal(sid(n))},${literal(JSON.stringify(payload(candidates)))}::jsonb,900)`));
}
const context = resolveBrandContext(
  { id: 'ai_salaryman_lab', display_name: 'fixture', is_active: true, publish_mode: 'live', code_profile_key: 'ai_salaryman_lab_v1' },
  { id: 'ai_salaryman_lab_x', brand_id: 'ai_salaryman_lab', platform: 'x', handle: 'kaishain_ai_lab', publish_enabled: true, oauth_client_ref: 'default' },
  { brand_id: 'ai_salaryman_lab', fixed_hashtags: [], note_url: null, image_policy: {}, enabled_post_types: ['brand_post'] },
);
const text = 'Xの接続画面で、前回のアカウントが残る問題を見つけた。 #個人開発';
const draft = { brandId: 'ai_salaryman_lab', postType: 'brand_post', text, model: 'fixture', inputTokens: 0, outputTokens: 0, apiCostUsd: 0, characterCount: Array.from(text).length };
function topicPort(n, candidates, fault = null) {
  const fetchImpl = async (url, init) => {
    const fn = String(url).split('/rpc/')[1];
    const b = JSON.parse(init.body);
    const parameters = fn === 'claim_ai_lab_topic' ? [b.p_scheduled_post_id, JSON.stringify(b.p_candidates), b.p_lease_seconds]
      : [b.p_claim_id, b.p_scheduled_post_id, b.p_event_key, ...(fn === 'settle_ai_lab_topic_claim_published' ? [b.p_unit_key, b.p_x_post_id] : fn === 'start_ai_lab_topic_provider' ? [] : [b.p_reason])];
    const signature = parameters.map((v, i) => literal(v) + (fn === 'claim_ai_lab_topic' && i === 1 ? '::jsonb' : '')).join(',');
    try {
      const result = await sql(`set role service_role; select to_jsonb(public.${fn}(${signature}))`);
      if (fault === fn) throw new Error('lost response after committed SQL');
      return new Response(result, { status: 200 });
    } catch (error) {
      if (fault === fn) throw error;
      const code = /AI_LAB_TOPIC_CLAIM_[A-Z_]+/.exec(error.stderr ?? '')?.[0] ?? 'LOCAL_SQL_REFUSAL';
      return new Response(JSON.stringify({ message: code }), { status: 400 });
    }
  };
  return createAiLabTopicPort({ supabaseUrl: 'https://fixture.invalid', serviceRoleKey: 'fixture-only', scheduledPostId: sid(n), candidates, fetchImpl });
}
function dispatch(n, candidates = [diary], overrides = {}) {
  return dispatchAiLabScheduledBrandPost({ context, postType: 'brand_post', scheduledPostId: sid(n), openAiApiKey: 'fixture-only',
    topic: topicPort(n, candidates), generate: async () => draft, loadRecentFingerprints: async () => [],
    publishText: async () => ({ data: { id: String(n + 1) } }), completePublishedPost: async () => ({ fingerprintPersisted: true }), ...overrides });
}
before(async () => {
  await sql(`create database ${db} owner ${owner}`, superuser, 'postgres');
  await sql('grant usage on schema public to anon,authenticated,service_role');
  await apply();
});
beforeEach(async () => {
  // A REVOKE against a temporary API owner can also revoke the restored owner's
  // explicit DML ACL; restore fixture DML as superuser, never production.
  await sql(`grant all on public.ai_lab_topic_claims to ${owner}; truncate public.ai_lab_topic_claims`, superuser);
});
after(async () => { await sql(`drop database ${db} with (force)`, superuser, 'postgres'); });

test('H1 CONTROL: two actual SQL-backed dispatchers, same diary, only one fake X', async () => {
  let x = 0;
  const results = await Promise.allSettled([1, 2].map(n => dispatch(n, [diary], { publishText: async () => { x++; return { data: { id: String(n) } }; } })));
  assert.equal(x, 1);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(await sql(`select count(*) from public.ai_lab_topic_claims where event_key=${literal(key)} and state='published'`), '1');
});
test('H1 CONTROL: durable start committed, lost RPC response never reaches X or reopens diary', async () => {
  let x = 0;
  await assert.rejects(() => dispatch(1, [diary], { topic: topicPort(1, [diary], 'start_ai_lab_topic_provider'), publishText: async () => { x++; return { data: { id: '1' } }; } }));
  assert.equal(x, 0);
  assert.equal(await sql('select state from public.ai_lab_topic_claims'), 'provider_started');
  assert.equal((await claim(2, [diary])).claim, null);
});
test('H1 CONTROL: confirmed X/settle failure/completion success still blocks diary', async () => {
  let x = 0;
  const port = topicPort(1, [diary]);
  const result = await dispatch(1, [diary], { topic: { ...port, settlePublished: async () => { throw new Error('database unavailable'); } }, publishText: async () => { x++; return { data: { id: '1' } }; } });
  assert.equal(result.topicSettlement, 'SETTLE_FAILED');
  assert.equal((await claim(2, [diary])).claim, null);
  assert.equal(x, 1);
});
test('H1 CONTROL: expired worker cannot start, release newer claim, or settle', async () => {
  const a = (await claim(1, [diary])).claim;
  await sql("update public.ai_lab_topic_claims set claimed_at=now()-interval '20 minutes',lease_until=now()-interval '5 minutes'");
  const b = (await claim(2, [diary])).claim;
  assert.notEqual(a.claim_id, b.claim_id);
  const fence = [a.claim_id, sid(1), key].map(literal).join(',');
  assert.equal(await sql(`set role service_role; select public.start_ai_lab_topic_provider(${fence})`), 'f');
  assert.equal(await sql(`set role service_role; select public.release_ai_lab_topic_claim(${fence},'PRE_X_FAILED')`), 'EXPIRED');
  await assert.rejects(() => sql(`set role service_role; select public.settle_ai_lab_topic_claim_published(${fence},${literal(diary.unitKey)},'1')`), /STATE_CONFLICT/);
  assert.equal(await sql(`select state from public.ai_lab_topic_claims where claim_id=${literal(b.claim_id)}`), 'claimed');
});
test('H1 CONTROL: partial UNIQUE independently rejects a second active diary row', async () => {
  await claim(1, [diary]);
  await assert.rejects(() => sql(`insert into public.ai_lab_topic_claims(scheduled_post_id,topic_kind,event_key,unit_key,state,lease_until) values(${literal(sid(2))},'diary',${literal(key)},${literal(diary.unitKey)},'claimed',now()+interval '15 minutes')`), /duplicate key/);
});
test('H1 CONTROL: clean install denies all direct API table privileges including PG17 MAINTAIN', async () => {
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) {
      assert.equal(await sql(`select has_table_privilege(${literal(role)},'public.ai_lab_topic_claims',${literal(privilege)})`), 'f');
    }
  }
});
test('H1 REQUIRED: unsettled evergreen provider-started survives cooldown age', async () => {
  const c = (await claim(1, [evergreen(2)])).claim;
  await sql(`select public.start_ai_lab_topic_provider(${literal(c.claim_id)},${literal(sid(1))},'evergreen-2')`);
  await sql("update public.ai_lab_topic_claims set claimed_at=now()-interval '73 hours',lease_until=now()-interval '73 hours'+interval '15 minutes',provider_started_at=now()-interval '73 hours'");
  const newer = await claim(2, [evergreen(2)]);
  assert.equal(newer.claim, null, 'unresolved possibly-posted evergreen automatically became reclaimable');
});
test('H1 REQUIRED: interrupted evergreen sender and replacement cannot both reach fake X', async () => {
  let ready;
  let resume;
  const started = new Promise(resolve => { ready = resolve; });
  const barrier = new Promise(resolve => { resume = resolve; });
  let x = 0;
  const a = dispatch(1, [evergreen(2)], { publishText: async () => {
    ready();
    await barrier;
    x++;
    return { data: { id: '1' } };
  } });
  await started;
  try {
    // Simulate elapsed wall time locally; no wait or provider request is used.
    await sql("update public.ai_lab_topic_claims set claimed_at=now()-interval '73 hours',lease_until=now()-interval '73 hours'+interval '15 minutes',provider_started_at=now()-interval '73 hours'");
    await dispatch(2, [evergreen(2)], { publishText: async () => { x++; return { data: { id: '2' } }; } }).catch(error => {
      if (!String(error).includes('NO_ELIGIBLE_TOPIC')) throw error;
    });
  } finally { resume(); await a; }
  assert.equal(x, 1, 'old provider-started claim is still send/settle capable while a new claim also sends');
});
test('H1 REQUIRED: 72h cooldown is measured since confirmed publish, not earlier claim', async () => {
  const c = (await claim(1, [evergreen(2)])).claim;
  await sql(`select public.start_ai_lab_topic_provider(${literal(c.claim_id)},${literal(sid(1))},'evergreen-2'); select public.settle_ai_lab_topic_claim_published(${literal(c.claim_id)},${literal(sid(1))},'evergreen-2','evergreen-2','1')`);
  await sql("update public.ai_lab_topic_claims set claimed_at=now()-interval '72 hours 1 minute',lease_until=now()-interval '71 hours 46 minutes',provider_started_at=now()-interval '71 hours 59 minutes',settled_at=now()-interval '71 hours 59 minutes'");
  assert.equal((await claim(2, [evergreen(2)])).claim, null, 'published less than 72h ago but claim aged past 72h');
});
test('H1 REQUIRED: DB rejects unexpected JSON candidate keys', async () => {
  const bad = { ...payload([diary])[0], body: 'unexpected input is not stored but should be rejected' };
  await assert.rejects(() => sql(`set role service_role; select public.claim_ai_lab_topic(${literal(sid(1))},${literal(JSON.stringify([bad]))}::jsonb,900)`));
});
test('H1 REQUIRED: caller cannot omit canonical seed theme to bypass 48h', async () => {
  const c = (await claim(1, [evergreen(0, ['unglamorous_work'])])).claim;
  await sql(`select public.start_ai_lab_topic_provider(${literal(c.claim_id)},${literal(sid(1))},'evergreen-0'); select public.settle_ai_lab_topic_claim_published(${literal(c.claim_id)},${literal(sid(1))},'evergreen-0','evergreen-0','1')`);
  assert.equal((await claim(2, [evergreen(5, [])])).claim, null, 'seed 5 overlaps seed 0 but empty tags bypass DB cooldown');
});
test('H1 REQUIRED: table API-owner drift refuses migration reapply', async () => {
  await sql('alter table public.ai_lab_topic_claims owner to service_role', superuser);
  try { await assert.rejects(() => apply(superuser), /DRIFT|ACL/); }
  finally { await sql(`alter table public.ai_lab_topic_claims owner to ${owner}`, superuser); await apply(); }
});
test('H1 REQUIRED: function API-owner drift refuses migration reapply', async () => {
  await sql('alter function public.claim_ai_lab_topic(uuid,jsonb,integer) owner to anon', superuser);
  try { await assert.rejects(() => apply(superuser), /DRIFT|ACL/); }
  finally { await sql(`alter function public.claim_ai_lab_topic(uuid,jsonb,integer) owner to ${owner}`, superuser); await apply(); }
});
test('H1 REQUIRED: inherited table owner privileges cannot pass effective ACL proof', async () => {
  // The stock runner grants service_role to the migration owner. Temporarily
  // reverse that edge instead of creating a circular role-membership fixture.
  await sql(`revoke service_role from ${owner}; grant ${owner} to service_role`, superuser);
  try {
    assert.equal(await sql("select has_table_privilege('service_role','public.ai_lab_topic_claims','TRUNCATE')"), 't');
    await apply(superuser);
    assert.equal(await sql("select has_table_privilege('service_role','public.ai_lab_topic_claims','TRUNCATE')"), 'f', 'reapply accepts effective inherited TRUNCATE');
  } finally { await sql(`revoke ${owner} from service_role; grant service_role to ${owner}`, superuser); await apply(); }
});
test('H1 REQUIRED: duplicate event_id label cannot silently rename same event', () => {
  const markdown = '## 2026-10-01\nevent_id: 20261001-account-selection-check\nevent_id: 20261001-account-selection-recheck\nchanged: 接続先のアカウントが重複していた\n';
  const result = buildAiLabTopicCandidates({ markdown, now: new Date('2026-10-01T03:00:00Z'), rotationIndex: 0 });
  assert.equal(result.candidates.filter(c => c.kind === 'diary').length, 0, 'last event_id wins and creates a fresh publishable key');
});
test('H1 REQUIRED: actual Vault wrapper known 401 is not permanently ambiguous', async () => {
  const auth = await VaultAccountXAuth.load({ scheduledPostId: sid(1), socialAccountId: 'fixture', brandId: 'ai_salaryman_lab' }, {
    read: async () => ({ accessToken: 'fixture-only', accessExpiresAt: null }),
    recordAccessUnauthorized: async () => 'RECORDED',
  }, { resolveClient: async () => { throw new Error('should not refresh'); }, refreshEnabled: false });
  await assert.rejects(() => dispatch(1, [diary], { publishText: async () => {
    const sent = await auth.send(async () => ({ status: 401, body: {} }));
    if (sent.status < 200 || sent.status >= 300) throw new Error(`X_REQUEST_FAILED:${sent.status}`);
    return sent.body;
  } }), /X_ACCESS_TOKEN_UNAUTHORIZED/);
  assert.equal(await sql('select state from public.ai_lab_topic_claims'), 'released', 'real Vault path loses definitive 401 classification');
});
