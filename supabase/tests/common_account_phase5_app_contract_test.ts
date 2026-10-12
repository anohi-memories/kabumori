// F5 (Phase 5): the REAL app-side enrollment modules against the REAL common-account SQL, over HTTP.
//
//   Kabumori   src/lib/service-enrollment.ts                          (used by src/lib/auth.ts, src/providers/auth-provider.tsx)
//   POSTONA    apps/social-mobile/src/domain/service-enrollment.ts    (used by features/service-enrollment/service-enrollment-gate.tsx)
//
// Both modules are imported unmodified and talk, through their own fetch transport, to a small PostgREST
// STAND-IN on 127.0.0.1 that (like PostgREST) verifies an HS256 token, takes the role and claims from it,
// calls ONLY the named public RPC in its own transaction as that database role and maps the SQLSTATE to an
// HTTP status. The SQL is the repository's own (Phase 1/2/3a, the Phase 3b guard, the Phase 4 fence) on a
// disposable local PostgreSQL. What this proves: the exact answers/errors of the SQL are the ones the apps
// parse (a drift fails here, not on a phone), and every scenario of the F5 TASK ends where it should.
// What it does NOT prove: managed Supabase, real GoTrue tokens/sessions, the real PostgREST (error mapping),
// the React gates (pinned by the apps' own tests). Run by common_account_core_fence_run.sh (section app).
import assert from 'node:assert/strict';
import test from 'node:test';

import * as kabumori from '../../src/lib/service-enrollment.ts';
import * as postona from '../../apps/social-mobile/src/domain/service-enrollment.ts';

const enabled = Deno.env.get('CAL_E2E') === '1';
const decoder = new TextDecoder();
const encoder = new TextEncoder();

// ---- database access (psql, as the disposable database's owner) -------------------------------------------
async function psql(statement: string, verbose = false): Promise<{ ok: boolean; out: string; err: string }> {
  const out = await new Deno.Command('psql', {
    args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', ...(verbose ? ['-v', 'VERBOSITY=verbose'] : []), '-c', statement],
    env: {
      PGHOST: Deno.env.get('PGHOST') ?? '', PGPORT: Deno.env.get('PGPORT') ?? '', PGUSER: Deno.env.get('PGUSER') ?? '',
      PGDATABASE: Deno.env.get('PGDATABASE') ?? '', LC_ALL: 'C',
    },
    stdout: 'piped', stderr: 'piped',
  }).output();
  return { ok: out.success, out: decoder.decode(out.stdout).trim(), err: decoder.decode(out.stderr).trim() };
}
async function sql(statement: string): Promise<string> {
  const result = await psql(statement);
  if (!result.ok) throw new Error(result.err);
  return result.out;
}
const lit = (value: unknown): string => {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
};

// ---- HS256 tokens ----------------------------------------------------------------------------------------
const b64url = (input: Uint8Array | string) => {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};
const unb64url = (text: string) => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
const hmacKey = (secret: Uint8Array) => crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
const SECRET = crypto.getRandomValues(new Uint8Array(32));
const OTHER_SECRET = crypto.getRandomValues(new Uint8Array(32));
const APIKEY = 'stand-in-publishable-key';
async function mint(claims: Record<string, unknown>, secret = SECRET): Promise<string> {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(signature)}`;
}
async function verify(token: string): Promise<{ claims: Record<string, unknown> } | 'bad' | 'expired'> {
  const parts = token.split('.');
  if (parts.length !== 3) return 'bad';
  try {
    const good = await crypto.subtle.verify('HMAC', await hmacKey(SECRET), unb64url(parts[2]) as BufferSource, encoder.encode(`${parts[0]}.${parts[1]}`));
    if (!good) return 'bad';
    const claims = JSON.parse(decoder.decode(unb64url(parts[1]))) as Record<string, unknown>;
    if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) return 'expired';
    return { claims };
  } catch {
    return 'bad';
  }
}

// ---- the PostgREST stand-in --------------------------------------------------------------------------------
const EXPOSED = new Set([
  'start_kabumori_service', 'start_x_autopost_service', 'reactivate_kabumori_service', 'reactivate_x_autopost_service', 'ensure_my_profile',
]);
type Hit = { fn: string; sub: unknown; role: unknown; status: number };
const hits: Hit[] = [];
const json = (body: unknown, status: number) => Response.json(body, { status });

async function handler(req: Request): Promise<Response> {
  const path = /^\/rest\/v1\/rpc\/([a-z_]+)$/u.exec(new URL(req.url).pathname);
  if (req.method !== 'POST' || !path) return json({ code: 'PGRST125', message: 'Invalid path specified in request URL' }, 404);
  const fn = path[1];
  const reply = (status: number, body: unknown, who?: { sub?: unknown; role?: unknown }) => {
    hits.push({ fn, sub: who?.sub, role: who?.role, status });
    return json(body, status);
  };
  if (req.headers.get('apikey') !== APIKEY) return reply(401, { code: 'PGRST301', message: 'No API key found in request' });
  const bearer = /^Bearer (\S+)$/u.exec(req.headers.get('authorization') ?? '');
  if (!bearer) return reply(401, { code: 'PGRST302', message: 'Anonymous access is disabled' });
  const checked = await verify(bearer[1]);
  if (checked === 'expired') return reply(401, { code: 'PGRST303', message: 'JWT expired' });
  if (checked === 'bad') return reply(401, { code: 'PGRST301', message: 'JWSError JWSInvalidSignature' });
  const { claims } = checked;
  const who = { sub: claims.sub, role: claims.role };
  if (claims.role !== 'authenticated' && claims.role !== 'anon') return reply(401, { code: '42704', message: 'role does not exist' }, who);
  if (!EXPOSED.has(fn)) return reply(404, { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` }, who);
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const named: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (!/^p_[a-z_]+$/u.test(key) || !['string', 'number', 'boolean'].includes(typeof value)) {
      return reply(400, { code: 'PGRST102', message: 'Invalid request body' }, who);
    }
    named.push(`${key} => ${lit(value)}`);
  }
  // As PostgREST does: the claims travel in request.jwt.claims, the role is the database role, one transaction.
  const result = await psql(
    `begin; set local "request.jwt.claims" = ${lit(JSON.stringify(claims))}; set local role ${claims.role}; `
    + `select to_jsonb(public.${fn}(${named.join(', ')})); commit;`,
    true,
  );
  if (result.ok) return reply(200, JSON.parse(result.out), who);
  const error = /ERROR:\s+([0-9A-Z]{5}): ([^\n]*)/u.exec(result.err);
  const state = error?.[1] ?? 'XX000';
  const message = error?.[2] ?? 'internal error';
  if (state === '42883') return reply(404, { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache`, details: null, hint: null }, who);
  const status = state === '42501' ? (claims.role === 'anon' ? 401 : 403) : state === '55P03' ? 503 : 400;
  return reply(status, { code: state, message, details: null, hint: null }, who);
}

let server: Deno.HttpServer | undefined;
let baseUrl = '';
function start() {
  if (server) return;
  server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, handler);
  baseUrl = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
}

// ---- people, tokens, apps ----------------------------------------------------------------------------------
let counter = 0;
const uuidOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const newUser = () => uuidOf(970_000 + ++counter);
async function person(): Promise<string> {
  const user = newUser();
  await sql(`select public.fixture_login('${user}'::uuid)`);
  return user;
}
const nowS = () => Math.floor(Date.now() / 1000);
const tokenFor = (user: string, extra: Record<string, unknown> = {}) =>
  mint({ sub: user, role: 'authenticated', session_id: crypto.randomUUID(), aud: 'authenticated', exp: nowS() + 3600, ...extra });
const APPS = {
  kabumori: { label: 'Kabumori', mod: kabumori, service: 'kabumori' as const },
  postona: { label: 'POSTONA', mod: postona, service: 'x_autopost' as const },
};
type App = typeof APPS[keyof typeof APPS];
const transport = (app: App, token: string) =>
  app.mod.createSessionBoundTransport({ url: baseUrl, apiKey: APIKEY, accessToken: token });
const startOf = (app: App, token: string) =>
  app.mod.startServiceAutomatically(transport(app, token), app.service, new AbortController().signal);
const restartOf = (app: App, token: string, version: number) =>
  app.mod.reactivateServiceExplicitly(transport(app, token), app.service, version, new AbortController().signal);
const raw = async (fn: string, token: string, args: Record<string, unknown> = {}, apikey = APIKEY) => {
  const response = await fetch(`${baseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> | string };
};
const entitlements = (user: string) => sql(
  `select coalesce(string_agg(service_key || ':' || status, ',' order by service_key), '-') from public.service_entitlements where user_id = '${user}'`);
const count = (table: string, column: string, user: string) => sql(`select count(*) from ${table} where ${column} = '${user}'`);
const version = async (user: string) => Number(await sql(`select lifecycle_version from public.common_accounts where user_id = '${user}'`));
const svc = async (statement: string) => JSON.parse(await sql(`begin; set local role service_role; select to_jsonb(${statement}); commit;`));
async function endPostona(user: string) {
  const begun = await svc(`public.begin_service_deletion('${user}'::uuid, 'x_autopost')`);
  assert.equal(begun.status, 'started');
  const finished = await svc(`public.finish_service_deletion('${user}'::uuid, 'x_autopost', '${begun.operation_id}'::uuid)`);
  assert.equal(finished.status, 'ended');
}
const hitsFor = (user: string) => hits.filter((h) => h.sub === user);

const t = (name: string, run: () => Promise<void>) => test(name, { skip: !enabled }, async () => {
  start();
  await run();
});
test('teardown', { skip: !enabled }, async () => { await server?.shutdown(); });

// ---- scenarios ---------------------------------------------------------------------------------------------
t('new person, first app: account + that service only; the login and identities are untouched (both apps)', async () => {
  for (const key of ['kabumori', 'postona'] as const) {
    const app = APPS[key];
    const user = await person();
    const outcome = await startOf(app, await tokenFor(user));
    assert.deepEqual(outcome, { kind: 'ready', started: true, sharedAccountNotice: false }, app.label);
    assert.equal(await entitlements(user), `${app.service}:active`, `${app.label}: only its own service`);
    assert.equal(await count('public.common_accounts', 'user_id', user), '1');
    assert.equal(await count('auth.users', 'id', user), '1');
    assert.equal(await count('auth.identities', 'user_id', user), '1');
    assert.equal(await count('public.brand_memberships', 'user_id', user), '0', 'a start creates no workspace');
    assert.equal(await count('public.profiles', 'id', user), key === 'kabumori' ? '1' : '0', 'the Kabumori root exists only for Kabumori');
  }
});

t('existing common ID opens the other app: only that entitlement is added; the shared-account notice is shown once', async () => {
  const user = await person();
  const token = await tokenFor(user);
  assert.equal((await startOf(APPS.kabumori, token)).kind, 'ready');
  const before = { accounts: await count('public.common_accounts', 'user_id', user), users: await count('auth.users', 'id', user) };
  const second = await startOf(APPS.postona, token);
  assert.deepEqual(second, { kind: 'ready', started: true, sharedAccountNotice: true });
  assert.equal(await entitlements(user), 'kabumori:active,x_autopost:active');
  assert.deepEqual({ accounts: await count('public.common_accounts', 'user_id', user), users: await count('auth.users', 'id', user) }, before,
    'no second account, no second login');
  assert.equal(await count('public.profiles', 'id', user), '1', 'the Kabumori profile is not duplicated');
});

t('the same request twice (each app): ready, started=false, no new row, no lifecycle-version change', async () => {
  const user = await person();
  const token = await tokenFor(user);
  for (const app of [APPS.kabumori, APPS.postona]) {
    await startOf(app, token);
    const v = await version(user);
    const again = await startOf(app, token);
    assert.deepEqual(again, { kind: 'ready', started: false, sharedAccountNotice: false }, app.label);
    assert.equal(await version(user), v, `${app.label}: the version did not move`);
  }
  assert.equal(await entitlements(user), 'kabumori:active,x_autopost:active');
});

t('service separation: a POSTONA-only person has no Kabumori entitlement or data; B never touches A', async () => {
  const a = await person();
  const b = await person();
  await startOf(APPS.postona, await tokenFor(a));
  await startOf(APPS.kabumori, await tokenFor(b));
  assert.equal(await entitlements(a), 'x_autopost:active');
  assert.equal(await entitlements(b), 'kabumori:active');
  assert.equal(await count('public.profiles', 'id', a), '0');
  // B names A in the body: no such signature exists (the person is the token's subject, never an argument).
  const attempt = await raw('start_kabumori_service', await tokenFor(b), { p_user_id: a });
  assert.equal(attempt.status, 404);
  assert.equal(await entitlements(a), 'x_autopost:active', 'A is untouched');
});

t('ended service: the automatic start never restarts it; an explicit restart needs the shown version, once', async () => {
  const user = await person();
  const token = await tokenFor(user);
  await startOf(APPS.kabumori, token);
  await startOf(APPS.postona, token);
  await endPostona(user);
  const ended = await startOf(APPS.postona, token);
  assert.equal(ended.kind, 'reenroll_required');
  const shown = (ended as { lifecycleVersion: number }).lifecycleVersion;
  assert.equal(await entitlements(user), 'kabumori:active,x_autopost:ended', 'nothing restarted silently');
  assert.equal((await startOf(APPS.kabumori, token)).kind, 'ready', 'the other app is not affected');
  const stale = await restartOf(APPS.postona, token, shown - 1);
  assert.equal(stale.kind, 'reenroll_required', 'a stale version restarts nothing');
  assert.equal(await entitlements(user), 'kabumori:active,x_autopost:ended');
  const restarted = await restartOf(APPS.postona, token, (stale as { lifecycleVersion: number }).lifecycleVersion);
  assert.deepEqual(restarted, { kind: 'ready', started: true, sharedAccountNotice: true });
  assert.equal(await entitlements(user), 'kabumori:active,x_autopost:active');
  // A version is used once (the restart itself moves it): replaying the old one answers the NEW version and
  // changes nothing; the service stays active and the next automatic start simply reports it ready.
  const replay = await restartOf(APPS.postona, token, shown);
  assert.equal(replay.kind, 'reenroll_required');
  assert.ok((replay as { lifecycleVersion: number }).lifecycleVersion > shown, 'the answer carries the moved version');
  assert.equal(await entitlements(user), 'kabumori:active,x_autopost:active', 'a replayed restart changes nothing');
  assert.deepEqual(await startOf(APPS.postona, token), { kind: 'ready', started: false, sharedAccountNotice: false });
  const sameVersion = await restartOf(APPS.postona, token, (replay as { lifecycleVersion: number }).lifecycleVersion);
  assert.deepEqual(sameVersion, { kind: 'ready', started: false, sharedAccountNotice: false }, 'at the current version an active service just answers active');
});

t('whole-account deletion begun: the SAME still-valid token is blocked in both apps, and nothing is created', async () => {
  const user = await person();
  const token = await tokenFor(user);
  await startOf(APPS.kabumori, token);
  await svc(`public.begin_common_account_deletion('${user}'::uuid, ${await version(user)})`);
  for (const app of [APPS.kabumori, APPS.postona]) {
    assert.deepEqual(await startOf(app, token), { kind: 'blocked', reason: 'ACCOUNT_DELETION_IN_PROGRESS' }, app.label);
  }
  assert.equal(await entitlements(user), 'kabumori:active', 'the freeze changed no entitlement and added none');
  assert.equal(await sql(`select count(*) from public.service_entitlements where user_id = '${user}' and service_key = 'x_autopost'`), '0',
    'POSTONA was not started during the freeze');
  const legacy = await raw('ensure_my_profile', token);
  assert.equal(legacy.status, 403);
  assert.equal((legacy.body as { message: string }).message, 'ACCOUNT_DELETION_IN_PROGRESS', 'the old-build path is refused too');
});

t('locked, service deleting and suspended: the exact fixed reasons the apps map to copy', async () => {
  const locked = await person();
  await startOf(APPS.kabumori, await tokenFor(locked));
  await sql(`update public.common_accounts set status = 'locked' where user_id = '${locked}'`);
  assert.deepEqual(await startOf(APPS.postona, await tokenFor(locked)), { kind: 'blocked', reason: 'ACCOUNT_LOCKED' });

  const leaving = await person();
  const token = await tokenFor(leaving);
  await startOf(APPS.postona, token);
  await svc(`public.begin_service_deletion('${leaving}'::uuid, 'x_autopost')`);
  assert.deepEqual(await startOf(APPS.postona, token), { kind: 'blocked', reason: 'SERVICE_DELETION_IN_PROGRESS' });

  const suspended = await person();
  const suspendedToken = await tokenFor(suspended);
  await startOf(APPS.postona, suspendedToken);
  await sql(`update public.service_entitlements set status = 'suspended' where user_id = '${suspended}'`);
  assert.deepEqual(await startOf(APPS.postona, suspendedToken), { kind: 'blocked', reason: 'SERVICE_SUSPENDED' });
});

t('a removed login with a still-valid token: ACCOUNT_NOT_FOUND, and nothing is created', async () => {
  const user = await person();
  const token = await tokenFor(user);
  await startOf(APPS.kabumori, token);
  await sql(`delete from auth.users where id = '${user}'`);
  for (const app of [APPS.kabumori, APPS.postona]) {
    assert.deepEqual(await startOf(app, token), { kind: 'blocked', reason: 'ACCOUNT_NOT_FOUND' }, app.label);
  }
  assert.equal(await count('public.common_accounts', 'user_id', user), '0');
  assert.equal(await count('public.service_entitlements', 'user_id', user), '0');
});

t('credentials: expired, wrongly signed, anon and key-less requests are never ready and change nothing', async () => {
  const user = await person();
  const cases: [string, string][] = [
    ['expired', await tokenFor(user, { exp: nowS() - 60 })],
    ['wrong signature', await mint({ sub: user, role: 'authenticated', session_id: crypto.randomUUID(), exp: nowS() + 3600 }, OTHER_SECRET)],
    ['anon role', await tokenFor(user, { role: 'anon' })],
  ];
  for (const [label, token] of cases) {
    await assert.rejects(startOf(APPS.postona, token), (failure: Error) => failure.name === 'EnrollmentUnavailableError', label);
  }
  const noKey = await raw('start_x_autopost_service', await tokenFor(user), {}, 'wrong-key');
  assert.equal(noKey.status, 401);
  assert.equal(await count('public.common_accounts', 'user_id', user), '0');
  assert.equal(await entitlements(user), '-');
});

t('a token that names no login (no session id) is never sent by the apps\' gate', async () => {
  const user = await person();
  const noSession = await mint({ sub: user, role: 'authenticated', aud: 'authenticated', exp: nowS() + 3600 });
  const before = hits.length;
  for (const app of [APPS.kabumori, APPS.postona]) {
    const gate = app.mod.createEnrollmentGate((context, signal) =>
      app.mod.startServiceAutomatically(transport(app, context.accessToken), app.service, signal));
    assert.deepEqual(await gate.ensure({ userId: user, accessToken: noSession }), { kind: 'blocked', reason: 'ACCOUNT_NOT_FOUND' }, app.label);
  }
  assert.equal(hits.length, before, 'no request left the app');
  assert.equal(await entitlements(user), '-');
});

t('the gate shares one request per login (concurrent callers and a refreshed token), and the database sees one start', async () => {
  const user = await person();
  const sessionId = crypto.randomUUID();
  const first = await tokenFor(user, { session_id: sessionId });
  const refreshed = await tokenFor(user, { session_id: sessionId });
  const before = hitsFor(user).length;
  const gate = kabumori.createEnrollmentGate((context, signal) =>
    kabumori.startServiceAutomatically(transport(APPS.kabumori, context.accessToken), 'kabumori', signal));
  const [one, two] = await Promise.all([gate.ensure({ userId: user, accessToken: first }), gate.ensure({ userId: user, accessToken: refreshed })]);
  assert.deepEqual(one, { kind: 'ready', started: true, sharedAccountNotice: false });
  assert.deepEqual(two, one);
  assert.equal(hitsFor(user).length - before, 1, 'one request for one login');
  assert.equal(await entitlements(user), 'kabumori:active');
});

t('old builds (ensure_my_profile): enrolled like the new start; an ended service is not silently re-created', async () => {
  const user = await person();
  const token = await tokenFor(user);
  const created = await raw('ensure_my_profile', token);
  assert.equal(created.status, 200);
  assert.equal(created.body, user);
  assert.equal(await entitlements(user), 'kabumori:active');
  assert.equal(await count('public.profiles', 'id', user), '1');
  await svc(`public.withdraw_kabumori_service('${user}'::uuid)`);
  const ended = await raw('ensure_my_profile', token);
  assert.equal(ended.status, 403);
  assert.equal((ended.body as { message: string }).message, 'SERVICE_REENROLL_REQUIRED');
  assert.equal(await count('public.profiles', 'id', user), '0', 'no profile came back');
  assert.equal(await entitlements(user), 'kabumori:ended');
  // The new build then offers the explicit restart at the shown version.
  const outcome = await startOf(APPS.kabumori, token);
  assert.equal(outcome.kind, 'reenroll_required');
});

t('a legacy profile without an entitlement (an old build before Phase 2) is enrolled, not duplicated', async () => {
  const user = await person();
  await sql(`alter table public.profiles disable trigger account_lifecycle_profile_root_fence;
             insert into public.profiles (id) values ('${user}');
             alter table public.profiles enable trigger account_lifecycle_profile_root_fence`);
  assert.deepEqual(await startOf(APPS.kabumori, await tokenFor(user)), { kind: 'ready', started: true, sharedAccountNotice: false });
  assert.equal(await count('public.profiles', 'id', user), '1');
  assert.equal(await entitlements(user), 'kabumori:active');
});
