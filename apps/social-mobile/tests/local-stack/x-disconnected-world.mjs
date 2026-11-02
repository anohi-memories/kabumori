// G1 TASK 36: the world of the disconnected-X check on one throw-away local runtime (run-x-disconnected.sh): real GoTrue, Kong, Edge
// twin, Postgres; a person's real JWT. Only 127.0.0.1 is reachable. SYNTHETIC (labelled where used): the X connection is made and removed
// by G4's SQL with fake tokens, and a service end is a row, as in G3's local_test.ts.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

export const API = process.env.G3LS_API;
export const PUBLISHABLE = process.env.G3LS_PUBLISHABLE;
const DB_PORT = process.env.G3LS_DB_PORT;
const REAL_FETCH = globalThis.fetch;
export const X_FUNCTION = `${API}/functions/v1/postona-x-reservations-localtest`;

export const psql = (script, vars = {}) => new Promise((resolve) => {
  const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', DB_PORT, '-U', 'postgres', '-d', 'postgres'];
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  const child = execFile('psql', args, { env: { ...process.env, PGPASSWORD: 'postgres' } }, (error, stdout, stderr) => {
    resolve(error ? `ERR:${stderr.trim().split('\n')[0]}` : stdout.trim());
  });
  child.stdin.end(script);
});
const CLAIMS = "select set_config('request.jwt.claims', json_build_object('sub', :'u', 'role', 'authenticated', 'session_id', :'s', 'is_anonymous', false)::text, true) \\gset x_\n";
const claimsOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
const authCall = (path, body, token) => REAL_FETCH(`${API}/auth/v1/${path}`, {
  method: 'POST',
  headers: { apikey: PUBLISHABLE, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});
export const rpc = async (fn, token, body = {}) => {
  const r = await REAL_FETCH(`${API}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: PUBLISHABLE, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
export async function signUp(label) {
  const email = `g1t36-${label}-${randomUUID().slice(0, 8)}@example.test`;
  const password = randomUUID();
  const r = await authCall('signup', { email, password });
  const j = await r.json();
  assert.equal(r.status, 200, `sign-up ${label}`);
  const c = claimsOf(j.access_token);
  return { token: j.access_token, userId: String(c.sub), sessionId: String(c.session_id), email, password };
}
/** A second, separate session of the same person. */
export async function signIn(p) {
  const r = await authCall('token?grant_type=password', { email: p.email, password: p.password });
  const j = await r.json();
  assert.equal(r.status, 200, 'sign-in');
  return { ...p, token: j.access_token, sessionId: String(claimsOf(j.access_token).session_id) };
}
export async function signOut(p) {
  const r = await authCall('logout?scope=local', {}, p.token);
  await r.body?.cancel();
  assert.equal(r.status, 204, 'sign-out');
}
export async function firstRun(p) {
  assert.equal((await rpc('start_x_autopost_service', p.token)).status, 200);
  const w0 = await rpc('postona_ensure_my_personal_workspace', p.token);
  assert.equal(w0.body.status, 'ready', JSON.stringify(w0.body));
  return String(w0.body.workspace_id);
}
export async function xConnect(p, label, puid) {
  const out = await psql(`begin;\n${CLAIMS}
select 1 as began from public.begin_social_mobile_x_oauth_connection(md5(:'l') || md5(:'l' || '#'), 'kabumori-social://oauth-callback', now() + interval '10 minutes') \\gset z_
select public.complete_social_mobile_x_oauth_connection((select id from public.social_account_oauth_states where state_hash = md5(:'l') || md5(:'l' || '#')),
  :'puid', '@h_' || :'puid', 'fakeXat_' || :'l', 'fakeXrt_' || :'l')::text as completed \\gset w_
commit;
select sa.id from public.social_accounts sa where sa.platform = 'x' and sa.brand_id = public.social_mobile_account_deletion_workspace(:'u'::uuid);`,
  { u: p.userId, s: p.sessionId, l: `g1t36-${label}-${p.userId}`, puid });
  assert.match(out, /^sa_[0-9a-f]{24}$/u, `X connect ${label}: ${out}`);
  return out;
}
export const xDisconnect = (p) => psql(`begin;\n${CLAIMS}select postona_g4_x_oauth.disconnect_x_connection()::text as d \\gset d_\ncommit;\nselect 'done';`, { u: p.userId, s: p.sessionId });
/** SYNTHETIC: the entitlement as G5's end leaves it. */
export const endService = (p) => psql("update public.service_entitlements set status = 'ended', ended_at = now() where user_id = :'u' and service_key = 'x_autopost'", { u: p.userId });
export const lifecycleOf = (p) => psql("select lifecycle_version from public.common_accounts where user_id = :'u'", { u: p.userId });
export const rowState = (id) => psql("select status || '/' || revision || '/' || consent_state from postona_x_resv.reservations where id = :'i'", { i: id });
export const rowCount = (account) => psql("select count(*) from postona_x_resv.reservations where social_account_id = :'a'", { a: account });

/** What the person can read through RLS with their own JWT: the column the app's repositories read. */
export async function connectionStatus(p, account) {
  const r = await REAL_FETCH(`${API}/rest/v1/social_accounts?select=connection_status&id=eq.${account}`, { headers: { apikey: PUBLISHABLE, authorization: `Bearer ${p.token}` } });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  return j[0]?.connection_status ?? null;
}

/** One raw call to the real Edge twin: what the server answers, without any screen in between. */
export async function http(action, payload, token) {
  const r = await REAL_FETCH(X_FUNCTION, { method: 'POST', headers: { apikey: PUBLISHABLE, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action, payload }) });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body, code: `${r.status} ${body.code ?? (body.ok === true ? 'ok' : '?')}`, rows: body.reservations ?? [] };
}
export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
let cursor = 0;
/** A saved row, created through the real API while the person is allowed to. Each is 2 days apart: the 60-minute slot rule stays out of the way. */
export async function saveRow(p, account, body) {
  cursor += 1;
  const scheduled_at = new Date(Date.now() + (20 + cursor * 2) * 86400e3).toISOString();
  const answer = await http('create', { socialAccountId: account, clientBatchId: randomUUID(), revision: 1, mode: 'manual_exact', band: null, items: [{ draft_id: `g1t36_${randomUUID().slice(0, 8)}`, scheduled_at, body, consent: { confirmed: true, content_sha256: sha256(body) } }] }, p.token);
  assert.equal(answer.code, '200 ok', `save ${body}`);
  return answer.rows[0];
}
/** A person with the service on, a workspace and a real (fake-token) X connection. */
let puid = Date.now() % 1e12;
export async function person(label) {
  const p = await signUp(label);
  const workspace = await firstRun(p);
  puid += 1;
  const account = await xConnect(p, `${label}1`, String(puid));
  return { ...p, workspace, account, puid: String(puid) };
}
/** The app's supabase-repository.ts rule, applied to the real column. */
export const asAppStatus = (status) => (status === 'connected' || status === 'identity_verified' ? 'connected' : 'needs_attention');
