// The plan of the managed-disposable acceptance run (F5 Phase 11). SOURCE ONLY, never executed against a managed
// project. Stage G = gate and apply (identity, settings, baseline, the ten-file chain, the read-only probe);
// stage M = the twelve acceptance checks of docs/common-account/phase9-shared-login-enrollment.md section 9;
// stage T = teardown. Every step declares whether it may mutate (the runner verifies the project's identity before
// each such call), what it expects and when it STOPs the run.
import { verifyInventory } from './inventory.ts';
import { BASELINE_GATE, type Ctx, type PlanFile, type Step, type Verdict } from './runner.ts';

export const PROBE_PATH = 'supabase/preflight/common_account_release_probe.sql';
/** The read-only, schema-only inventory query (Phase 12). It is run through the same read-only probe channel as the release probe. */
export const INVENTORY_PATH = 'supabase/preflight/managed_disposable/inventory/schema_inventory.sql';

/** The chain, in release order (the same list the Phase 7 preflight runner pins). `marker` = the function that shows the phase is present. */
export const CHAIN: readonly (PlanFile & { marker: string })[] = [
  { id: 'P1', kind: 'chain', path: 'supabase/migrations/20261001150000_common_account_lifecycle_foundation.sql', marker: 'public.start_kabumori_service()' },
  { id: 'P2', kind: 'chain', path: 'supabase/migrations/20261006230000_common_account_service_start_intent.sql', marker: 'public.reactivate_kabumori_service(bigint)' },
  { id: 'P3a', kind: 'chain', path: 'supabase/migrations/20261009120000_common_account_deletion_completion.sql', marker: 'public.claim_common_account_deletion(uuid,uuid,integer)' },
  { id: 'P3b', kind: 'chain', path: 'supabase/migrations/20261010051938_common_account_service_write_guard.sql', marker: 'private.account_lifecycle_assert_active_service_write(uuid,text)' },
  { id: 'P4', kind: 'chain', path: 'supabase/migrations/20261012130000_common_account_core_service_fence.sql', marker: 'private.account_lifecycle_service_state_refusal(uuid,text)' },
  { id: 'P5', kind: 'chain', path: 'supabase/migrations/20261012230000_common_account_service_brand_state.sql', marker: 'public.common_account_brand_service_state(text,text)' },
  { id: 'P6', kind: 'chain', path: 'supabase/migrations/20261013120000_common_account_service_deletion_ownership.sql', marker: 'public.claim_service_deletion(uuid,text,uuid,uuid,uuid,integer)' },
  { id: 'P8', kind: 'chain', path: 'supabase/migrations/20261013140000_common_account_service_reconciliation_facts.sql', marker: 'public.common_account_service_end_result(uuid,text)' },
  { id: 'P9', kind: 'chain', path: 'supabase/migrations/20261015090000_common_account_enrollment_session_fence.sql', marker: 'private.account_lifecycle_enrollment_fence(uuid,boolean)' },
  { id: 'P10', kind: 'chain', path: 'supabase/migrations/20261015120000_common_account_x_unconfirmed_snapshot_record.sql', marker: 'public.record_owned_service_deletion_x_unconfirmed(uuid,text,uuid,uuid,integer,text)' },
];

/** The operator-supplied baseline (a reviewed schema-only export; NOT in the repository). Its digest comes from the environment. */
export const BASELINE: PlanFile = { id: 'BASELINE', kind: 'baseline', path: 'baseline/disposable_baseline.sql' };

// ---- small helpers over the two transports ---------------------------------------------------------------------------

const PASSWORD = 'Correct-horse-battery-staple-1!';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const asRecord = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});
const pass = (detail: string, manual?: string[]): Verdict => ({ status: 'PASS', detail, ...(manual ? { manual } : {}) });
const fail = (detail: string): Verdict => ({ status: 'FAIL', detail });
const stop = (detail: string): Verdict => ({ status: 'STOP', detail });
const lit = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function claimsOf(token: string): Record<string, unknown> {
  const part = token.split('.')[1] ?? '';
  try {
    return asRecord(JSON.parse(atob(part.replaceAll('-', '+').replaceAll('_', '/'))));
  } catch {
    return {};
  }
}

type Login = { userId: string; email: string; accessToken: string; refreshToken: string; sessionId: string };

async function createUser(ctx: Ctx, tag: string): Promise<{ userId: string; email: string }> {
  const email = ctx.email(tag);
  const answer = await ctx.http({ method: 'POST', path: '/auth/v1/admin/users', key: 'service', body: { email, password: PASSWORD, email_confirm: true } });
  const id = asRecord(answer.body).id;
  if (answer.status >= 300 || typeof id !== 'string' || !UUID.test(id)) throw new Error(`could not create the test user ${tag} (HTTP ${answer.status})`);
  ctx.created.push({ userId: id, email });
  return { userId: id, email };
}

async function signIn(ctx: Ctx, email: string): Promise<Login> {
  const answer = await ctx.http({ method: 'POST', path: '/auth/v1/token', key: 'publishable', query: { grant_type: 'password' }, body: { email, password: PASSWORD } });
  const body = asRecord(answer.body);
  const token = body.access_token;
  if (answer.status !== 200 || typeof token !== 'string') throw new Error(`sign-in failed (HTTP ${answer.status})`);
  const claims = claimsOf(token);
  return {
    userId: String(asRecord(body.user).id), email, accessToken: token, refreshToken: String(body.refresh_token), sessionId: String(claims.session_id ?? ''),
  };
}

const rpc = (ctx: Ctx, fn: string, args: Record<string, unknown>, token: string | null, key: 'publishable' | 'service' = 'publishable') =>
  ctx.http({ method: 'POST', path: `/rest/v1/rpc/${fn}`, key, ...(token ? { bearer: token } : {}), body: args });

const entitlements = (ctx: Ctx, userId: string) =>
  ctx.sql(`select coalesce(string_agg(service_key || ':' || status, ',' order by service_key), '') from public.service_entitlements where user_id = ${lit(userId)}::uuid`);

async function newLogin(ctx: Ctx, tag: string): Promise<Login> {
  const user = await createUser(ctx, tag);
  return signIn(ctx, user.email);
}

/** Ends POSTONA through the service-role lifecycle functions only (no Edge function, no X, no provider). */
async function endPostonaByService(ctx: Ctx, userId: string): Promise<void> {
  const call = async (fn: string, args: Record<string, unknown>) => {
    const answer = await rpc(ctx, fn, args, null, 'service');
    if (answer.status !== 200) throw new Error(`${fn} answered HTTP ${answer.status}`);
    return asRecord(answer.body);
  };
  const begun = await call('begin_service_deletion', { p_user_id: userId, p_service_key: 'x_autopost' });
  const claimed = await call('claim_service_deletion', { p_user_id: userId, p_service_key: 'x_autopost', p_operation_id: begun.operation_id });
  await call('record_owned_service_deletion_provider_result', { p_user_id: userId, p_service_key: 'x_autopost', p_operation_id: begun.operation_id, p_lease: claimed.lease, p_provider: 'x', p_result: 'done' });
  const finished = await call('finish_owned_service_deletion', { p_user_id: userId, p_service_key: 'x_autopost', p_operation_id: begun.operation_id, p_lease: claimed.lease });
  if (finished.status !== 'ended') throw new Error(`the service did not end (${String(finished.status)})`);
}

/** What the apps parse (docs/common-account/phase9-shared-login-enrollment.md section 2). */
export const START_ANSWER = { status: 'active', service: 'x_autopost' } as const;

/** Outcome of an identity-linking observation (M3): which Auth users the same verified address ended up with. */
export function classifyLinking(rows: { userId: string; provider: string }[]): 'linked_same_user' | 'separate_users' | 'single_identity' | 'none' {
  if (rows.length === 0) return 'none';
  const users = new Set(rows.map((row) => row.userId));
  const providers = new Set(rows.map((row) => row.provider));
  if (users.size === 1 && providers.size > 1) return 'linked_same_user';
  if (users.size > 1) return 'separate_users';
  return 'single_identity';
}

// ---- the steps -------------------------------------------------------------------------------------------------------

const probeVerdict = (lines: string, label: string): Verdict => {
  const last = lines.trim().split('\n').filter((line) => line.startsWith('RELEASE_PREFLIGHT|')).pop() ?? '';
  const stopLine = lines.split('\n').find((line) => /\|STOP\|/u.test(line));
  if (stopLine) return stop(`${label}: the probe stopped (${stopLine.split('|').slice(0, 2).join('|')})`);
  if (/^RELEASE_PREFLIGHT\|PASS\|fail=0 /u.test(last)) return pass(`${label}: ${last}`);
  return fail(`${label}: ${last || 'no result line'}`);
};

/**
 * What the chain must NOT change: how many cron jobs the project holds and how many user triggers run a function that
 * mentions cron / net / http. Read through the read-only session; `cron.job` is read only when the project has it.
 */
async function silenceFootprint(ctx: Ctx): Promise<string> {
  const hasCron = (await ctx.sql(`select to_regclass('cron.job') is not null`)).trim() === 't';
  const jobs = hasCron ? (await ctx.sql('select count(*) from cron.job')).trim() : '0';
  const triggers = (await ctx.sql(
    `select count(*) from pg_trigger t join pg_proc p on p.oid = t.tgfoid where not t.tgisinternal and lower(p.prosrc) ~ '(\\mnet\\.|pg_net|http_post|http_get|\\mcron\\.|pg_cron)'`,
  )).trim();
  return `cron_jobs=${jobs} network_triggers=${triggers}`;
}

const PLAN_STEPS: readonly Step[] = [
  {
    id: 'G1', title: 'the project says which project it is (marker row)', access: 'read', mode: 'automated', modelled: true,
    expected: 'public.kabumori_disposable_marker holds exactly one row, and it is the allowlisted ref',
    stop: 'no marker, another ref, or more than one row',
    run: async (ctx) => {
      const rows = (await ctx.sql('select coalesce(string_agg(project_ref, \',\' order by project_ref), \'\') from public.kabumori_disposable_marker')).trim();
      return rows === ctx.target.projectRef ? pass('the marker names the target project') : stop('the marker does not name the target project');
    },
  },
  {
    id: 'G2', title: 'Auth settings read-back (public endpoint, publishable key)', access: 'read', mode: 'automated', modelled: true,
    expected: 'e-mail provider enabled, sign-ups open; the autoconfirm mode is recorded (it decides whether M2 may run)',
    stop: 'e-mail provider disabled (nothing can be tested)',
    run: async (ctx) => {
      const answer = await ctx.http({ method: 'GET', path: '/auth/v1/settings', key: 'publishable' });
      const body = asRecord(answer.body);
      const external = asRecord(body.external);
      if (answer.status !== 200 || typeof body.disable_signup !== 'boolean') return stop(`settings unreadable (HTTP ${answer.status})`);
      ctx.memo.autoconfirm = body.mailer_autoconfirm === true;
      if (external.email !== true) return stop('the e-mail provider is disabled');
      if (body.disable_signup === true) return { status: 'WARN', detail: 'sign-ups are disabled: M2 and M4 cannot create users through sign-up' };
      return pass(`e-mail on, sign-ups open, autoconfirm=${String(ctx.memo.autoconfirm)}, apple=${String(external.apple === true)}, google=${String(external.google === true)}`);
    },
  },
  {
    id: 'G3a', title: 'baseline schema (operator-supplied, digest-pinned)', access: 'mutate', mode: 'automated', modelled: false,
    expected: 'the file whose SHA-256 the operator gave applies; the 17 relations the chain preflight needs exist afterwards',
    stop: 'digest mismatch, a foreign project host / cron / HTTP-from-database in the file, or any SQL error',
    run: async (ctx) => {
      await ctx.applyFile(BASELINE);
      return pass('baseline applied');
    },
  },
  {
    id: BASELINE_GATE, title: 'baseline read-back: the project\'s own schema inventory against the approved contract digest', access: 'read', mode: 'automated', modelled: true,
    expected: 'the contract subset of the project\'s inventory provides every object the chain requires (baseline contract v2: the Phase 1 lists, public.ensure_my_profile() with its shape, public.social_accounts.platform, auth.uid(), auth.sessions), and its SHA-256 equals KABUMORI_DISPOSABLE_INVENTORY_SHA256',
    stop: 'no approved digest, a required object missing or of another type or shape, a lock of another contract version, any difference from the approved contract, secret-shaped text in the output, or an unreadable inventory',
    run: async (ctx) => {
      const requirements = ctx.baseline.requirements;
      if (!requirements) return stop('the plan lock carries no baseline requirements: regenerate it with cli.ts --write-lock');
      const verdict = await verifyInventory(await ctx.probe(INVENTORY_PATH), requirements, ctx.baseline.approvedInventory);
      if (verdict.status !== 'PASS' || verdict.digest === undefined) return stop(verdict.detail);
      ctx.memo.silenceBefore = await silenceFootprint(ctx);
      // the evidence the runner binds to this run: the contract digest that was approved, and the pinned query that produced it
      return { ...pass(`${verdict.detail}; ${String(ctx.memo.silenceBefore)}`), evidence: { kind: 'baseline_contract' as const, digest: verdict.digest, probePath: INVENTORY_PATH } };
    },
  },
  ...CHAIN.map((file): Step => ({
    id: `G3-${file.id}`, title: `chain file ${file.id}`, access: 'mutate', mode: 'automated', modelled: true,
    expected: `${file.path.split('/').pop()} applies as written and its marker function exists`,
    stop: 'the file refuses with its own COMMON_ACCOUNT_* code, a digest mismatch, or the marker is absent afterwards',
    run: async (ctx) => {
      await ctx.applyFile(file);
      const present = (await ctx.sql(`select to_regprocedure(${lit(file.marker)}) is not null`)).trim();
      return present === 't' ? pass(`${file.id} applied; ${file.marker} present`) : stop(`${file.id} applied but its marker function is absent`);
    },
  })),
  {
    id: 'G3c', title: 'the chain left the project silent: no cron job and no network trigger was added', access: 'read', mode: 'automated', modelled: true,
    expected: 'the number of cron jobs and of user triggers that reach cron / net / http is exactly what G3b recorded before the first chain file',
    stop: 'the count of either went up (or down): a migration armed, or removed, something that calls out',
    run: async (ctx) => {
      const before = ctx.memo.silenceBefore;
      if (typeof before !== 'string') return stop('G3b did not record the footprint before the chain: nothing to compare with');
      const after = await silenceFootprint(ctx);
      return after === before ? pass(`unchanged (${after})`) : stop(`the footprint changed: before ${before}, after ${after}`);
    },
  },
  {
    id: 'G4', title: 'release probe on the full chain (read-only)', access: 'read', mode: 'automated', modelled: true,
    expected: 'RELEASE_PREFLIGHT|PASS|fail=0 (warnings for the ledger are listed, never ignored)',
    stop: 'any FAIL or STOP line',
    run: async (ctx) => probeVerdict(await ctx.probe(PROBE_PATH), 'G4'),
  },
  {
    id: 'M1', title: 'M1 auth.sessions is readable by the owner of the lifecycle objects', access: 'read', mode: 'automated', modelled: true,
    expected: 'columns id, user_id, not_after exist and the owner of public.common_accounts has SELECT',
    stop: 'unreadable: the writer guard and the enrollment fence cannot work',
    run: async (ctx) => {
      const columns = (await ctx.sql(`select count(*) from pg_attribute a where a.attrelid = 'auth.sessions'::regclass and not a.attisdropped and a.attname in ('id','user_id','not_after')`)).trim();
      const readable = (await ctx.sql(`select has_table_privilege((select pg_get_userbyid(c.relowner) from pg_class c where c.oid = 'public.common_accounts'::regclass), 'auth.sessions', 'SELECT')`)).trim();
      return columns === '3' && readable === 't' ? pass('auth.sessions has the three columns and the owner can read it') : stop(`auth.sessions columns=${columns} owner_select=${readable}`);
    },
  },
  {
    id: 'M4', title: 'M4 sign-in -> start -> refresh -> new sign-in', access: 'mutate', mode: 'automated', modelled: true,
    expected: 'start answers active/started once, then idempotently; a refresh keeps session_id; a new sign-in changes it; one entitlement, no Kabumori row',
    stop: 'session_id missing from the access token, a refresh changes it, or a second start answers started=true',
    run: async (ctx) => {
      const first = await newLogin(ctx, 'm4');
      if (!UUID.test(first.sessionId) || claimsOf(first.accessToken).role !== 'authenticated') return stop('the access token carries no session_id / role=authenticated');
      const started = asRecord((await rpc(ctx, 'start_x_autopost_service', {}, first.accessToken)).body);
      if (started.status !== 'active' || started.service !== 'x_autopost' || started.started !== true) return fail(`first start answered ${JSON.stringify(started)}`);
      const again = asRecord((await rpc(ctx, 'start_x_autopost_service', {}, first.accessToken)).body);
      if (again.started !== false) return fail('a second start answered started=true');
      const refreshed = await ctx.http({ method: 'POST', path: '/auth/v1/token', key: 'publishable', query: { grant_type: 'refresh_token' }, body: { refresh_token: first.refreshToken } });
      const refreshedToken = String(asRecord(refreshed.body).access_token ?? '');
      if (refreshed.status !== 200 || claimsOf(refreshedToken).session_id !== first.sessionId) return stop('a refresh changed (or lost) the session_id');
      const relogin = await signIn(ctx, first.email);
      if (relogin.sessionId === first.sessionId) return fail('a new sign-in kept the session_id');
      const third = asRecord((await rpc(ctx, 'start_x_autopost_service', {}, relogin.accessToken)).body);
      if (third.started !== false) return fail('a new sign-in started the service again');
      const rows = await entitlements(ctx, first.userId);
      const profiles = (await ctx.sql(`select count(*) from public.profiles where id = ${lit(first.userId)}::uuid`)).trim();
      return rows === 'x_autopost:active' && profiles === '0' ? pass('one active x_autopost entitlement; no Kabumori row or profile') : fail(`entitlements=${rows} profiles=${profiles}`);
    },
  },
  {
    id: 'M2', title: 'M2 simultaneous sign-up of one address', access: 'mutate', mode: 'automated', modelled: true,
    expected: 'one auth.users row and one identity for the address; no 5xx',
    stop: 'two users for one address, or a 5xx',
    run: async (ctx) => {
      if (ctx.memo.autoconfirm !== true) {
        return { status: 'MANUAL', detail: 'the project sends confirmation e-mail: the harness never triggers mail', manual: ['M2: with autoconfirm OFF run six parallel sign-ups of one synthetic address from the operator\'s tooling, then compare auth.users and auth.identities counts for it (expected 1 and 1)'] };
      }
      const email = ctx.email('m2');
      const attempts = await Promise.all(Array.from({ length: 6 }, () => ctx.http({ method: 'POST', path: '/auth/v1/signup', key: 'publishable', body: { email, password: PASSWORD } })));
      const users = (await ctx.sql(`select count(*) from auth.users where lower(email) = ${lit(email)}`)).trim();
      const id = (await ctx.sql(`select coalesce((select id::text from auth.users where lower(email) = ${lit(email)} limit 1), '')`)).trim();
      if (UUID.test(id)) ctx.created.push({ userId: id, email });
      const identities = id ? (await ctx.sql(`select count(*) from auth.identities where user_id = ${lit(id)}::uuid`)).trim() : '0';
      if (attempts.some((a) => a.status >= 500)) return stop(`a sign-up answered ${attempts.find((a) => a.status >= 500)?.status}`);
      return users === '1' && identities === '1' ? pass(`six parallel sign-ups -> 1 user, 1 identity (statuses ${attempts.map((a) => a.status).join(',')})`) : stop(`users=${users} identities=${identities}`);
    },
  },
  {
    id: 'M6', title: 'M6 anonymous sign-ins', access: 'mutate', mode: 'automated', modelled: true,
    expected: 'an anonymous sign-in is refused by the project; if it is not, a guest token is refused by the start RPC',
    stop: 'a guest session is enrolled',
    run: async (ctx) => {
      const answer = await ctx.http({ method: 'POST', path: '/auth/v1/signup', key: 'publishable', body: {} });
      const token = asRecord(answer.body).access_token;
      if (typeof token !== 'string') return pass(`anonymous sign-in refused (HTTP ${answer.status})`);
      const claims = claimsOf(token);
      if (typeof claims.sub === 'string' && UUID.test(claims.sub)) ctx.created.push({ userId: claims.sub, email: '' });
      const start = await rpc(ctx, 'start_x_autopost_service', {}, token);
      const rows = await entitlements(ctx, String(claims.sub));
      if (start.status >= 400 && rows === '') return { status: 'WARN', detail: 'anonymous sign-ins are ENABLED on the project; the guest token was refused by the start RPC (turn the setting off)' };
      return stop(`a guest session reached the start RPC: HTTP ${start.status}, entitlements=${rows}`);
    },
  },
  {
    id: 'M7', title: 'M7 anon key, forged token and a deleted login\'s token reach nothing', access: 'mutate', mode: 'automated', modelled: true,
    expected: 'no bearer / publishable key as bearer / forged token -> 401; a deleted login\'s token -> a refusal and no row created',
    stop: 'any of them is accepted or creates a row',
    run: async (ctx) => {
      const noBearer = await rpc(ctx, 'start_x_autopost_service', {}, null);
      if (noBearer.status !== 401 && noBearer.status !== 403) return stop(`no bearer: HTTP ${noBearer.status}`);
      const forged = `${btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/=+$/u, '')}.${btoa(JSON.stringify({ sub: crypto.randomUUID(), role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 600 })).replace(/=+$/u, '')}.${'A'.repeat(43)}`;
      const forgedAnswer = await rpc(ctx, 'start_x_autopost_service', {}, forged);
      if (forgedAnswer.status !== 401) return stop(`forged token: HTTP ${forgedAnswer.status}`);
      const login = await newLogin(ctx, 'm7');
      const gone = await ctx.http({ method: 'DELETE', path: `/auth/v1/admin/users/${login.userId}`, key: 'service' });
      if (gone.status >= 300) return fail(`could not remove the test login (HTTP ${gone.status})`);
      const stale = await rpc(ctx, 'start_x_autopost_service', {}, login.accessToken);
      const rows = await ctx.sql(`select (select count(*) from public.common_accounts where user_id = ${lit(login.userId)}::uuid) + (select count(*) from public.service_entitlements where user_id = ${lit(login.userId)}::uuid)`);
      if (stale.status < 400 || rows.trim() !== '0') return stop(`a deleted login's token: HTTP ${stale.status}, rows=${rows.trim()}`);
      return pass('anon, forged and deleted-login credentials are refused and create nothing', ['M7 expired token: set the project JWT expiry to its minimum, wait it out, then call the start RPC (expected 401, nothing created)']);
    },
  },
  {
    id: 'M5', title: 'M5 a signed-out device\'s valid token cannot restart an ended service', access: 'mutate', mode: 'automated', modelled: true,
    expected: 'after a global sign-out the old token\'s explicit restart is refused (403, ACCOUNT_LIFECYCLE_AUTH_REQUIRED / ACCOUNT_NOT_FOUND) and the service stays ended',
    stop: 'the stale token restarts the service',
    run: async (ctx) => {
      const login = await newLogin(ctx, 'm5');
      await rpc(ctx, 'start_x_autopost_service', {}, login.accessToken);
      await endPostonaByService(ctx, login.userId);
      const ended = asRecord((await rpc(ctx, 'start_x_autopost_service', {}, login.accessToken)).body);
      if (ended.status !== 'reenroll_required' || typeof ended.lifecycle_version !== 'number') return fail(`an ended service answered ${JSON.stringify(ended)}`);
      const out = await ctx.http({ method: 'POST', path: '/auth/v1/logout', key: 'publishable', bearer: login.accessToken, query: { scope: 'global' } });
      if (out.status !== 204 && out.status !== 200) return fail(`global sign-out answered HTTP ${out.status}`);
      const restart = await rpc(ctx, 'reactivate_x_autopost_service', { p_expected_lifecycle_version: ended.lifecycle_version }, login.accessToken);
      const rows = await entitlements(ctx, login.userId);
      if (restart.status < 400 && asRecord(restart.body).status === 'active') return stop('the signed-out token restarted the ended service');
      return rows === 'x_autopost:ended' ? pass(`restart refused (HTTP ${restart.status}); the service stays ended`) : fail(`entitlements=${rows}`);
    },
  },
  {
    id: 'M8', title: 'M8 RLS: a token reads its own rows and only the granted columns', access: 'mutate', mode: 'automated', modelled: true,
    expected: 'each person sees only their own service_entitlements / common_accounts rows; source / legacy_evidence are not selectable',
    stop: 'another person\'s row, or a non-granted column, is readable',
    run: async (ctx) => {
      const a = await newLogin(ctx, 'm8a');
      const b = await newLogin(ctx, 'm8b');
      await rpc(ctx, 'start_x_autopost_service', {}, a.accessToken);
      await rpc(ctx, 'start_x_autopost_service', {}, b.accessToken);
      const read = (login: Login, table: string, select: string) =>
        ctx.http({ method: 'GET', path: `/rest/v1/${table}`, key: 'publishable', bearer: login.accessToken, query: { select } });
      const own = await read(a, 'service_entitlements', 'user_id,service_key,status');
      const rowsA = Array.isArray(own.body) ? own.body as Record<string, unknown>[] : [];
      if (own.status !== 200 || rowsA.length !== 1 || rowsA[0].user_id !== a.userId) return stop(`entitlements as A: HTTP ${own.status}, ${rowsA.length} row(s)`);
      const account = await read(a, 'common_accounts', 'user_id,status');
      const accountRows = Array.isArray(account.body) ? account.body as Record<string, unknown>[] : [];
      if (account.status !== 200 || accountRows.length !== 1 || accountRows[0].user_id !== a.userId) return stop(`common_accounts as A: HTTP ${account.status}`);
      const hidden = await read(a, 'service_entitlements', 'source,legacy_evidence');
      if (hidden.status < 400) return stop('source / legacy_evidence are selectable');
      return pass('own rows only; the non-granted columns are refused');
    },
  },
  {
    id: 'M10', title: 'M10 SQLSTATE -> HTTP status as the clients read it', access: 'mutate', mode: 'automated', modelled: true,
    expected: 'a service-only function: 401/403 permission denied; a private function: 404; a person\'s unknown signature: 404 -- never a 2xx and never a 5xx for these terminal answers',
    stop: 'a terminal refusal answers 2xx or 5xx (the clients would retry or accept it)',
    run: async (ctx) => {
      const login = await newLogin(ctx, 'm10');
      const serviceOnly = await rpc(ctx, 'begin_service_deletion', { p_user_id: login.userId, p_service_key: 'x_autopost' }, login.accessToken);
      const privateFn = await rpc(ctx, 'account_lifecycle_lock', { p_user_id: login.userId }, login.accessToken);
      const spoof = await rpc(ctx, 'start_x_autopost_service', { p_user_id: login.userId }, login.accessToken);
      const seen = { serviceOnly: serviceOnly.status, privateFn: privateFn.status, spoof: spoof.status };
      const terminal = [serviceOnly.status, privateFn.status, spoof.status];
      if (terminal.some((status) => status < 400 || status >= 500)) return stop(`statuses ${JSON.stringify(seen)}`);
      return pass(`statuses ${JSON.stringify(seen)} (recorded: they are the client mapping's input)`);
    },
  },
  {
    id: 'M11', title: 'M11 a lock timeout under concurrent starts', access: 'mutate', mode: 'automated', modelled: true,
    expected: 'the start waits at most its lock timeout and answers a retryable status (recorded; 503 is documented); no partial rows',
    stop: 'a 2xx while the lock is held, or a body that leaks SQL text',
    run: async (ctx) => {
      const login = await newLogin(ctx, 'm11');
      await rpc(ctx, 'start_x_autopost_service', {}, login.accessToken);
      const hold = await ctx.hold(`select 1 from public.common_accounts where user_id = ${lit(login.userId)}::uuid for update`, 12);
      let answer;
      try {
        answer = await rpc(ctx, 'start_x_autopost_service', {}, login.accessToken);
      } finally {
        await hold.release();
      }
      const text = JSON.stringify(answer.body);
      const rows = await entitlements(ctx, login.userId);
      if (answer.status === 200 && asRecord(answer.body).status === 'active' && asRecord(answer.body).started === false) {
        return { status: 'INFO', detail: `the idempotent start answered without waiting (HTTP 200); entitlements=${rows}` };
      }
      if (answer.status < 400 || /SELECT|FROM|public\./u.test(text)) return stop(`HTTP ${answer.status}: ${text.slice(0, 120)}`);
      return rows === 'x_autopost:active' ? pass(`held lock -> HTTP ${answer.status}; the entitlement is unchanged`) : fail(`entitlements=${rows}`);
    },
  },
  {
    id: 'M12', title: 'M12 ending POSTONA alone keeps the login, the profile and Kabumori', access: 'mutate', mode: 'automated', modelled: false,
    expected: 'account-delete withdraw_postona answers ended; the Auth user, the Kabumori entitlement and profile are unchanged; no X call (no X account exists)',
    stop: 'the login or another service changes, or the function answers anything but ended / a typed refusal',
    run: async (ctx) => {
      const login = await newLogin(ctx, 'm12');
      await rpc(ctx, 'start_x_autopost_service', {}, login.accessToken);
      await rpc(ctx, 'ensure_my_profile', {}, login.accessToken);
      const before = await ctx.sql(`select md5(coalesce((select to_jsonb(e)::text from public.service_entitlements e where e.user_id = ${lit(login.userId)}::uuid and e.service_key = 'kabumori'), '-') || coalesce((select to_jsonb(p)::text from public.profiles p where p.id = ${lit(login.userId)}::uuid), '-'))`);
      const probe = await ctx.http({ method: 'POST', path: '/functions/v1/account-delete', key: 'publishable', bearer: login.accessToken, body: { action: 'preview' } });
      if (probe.status === 404) return { status: 'MANUAL', detail: 'account-delete is not deployed to this project', manual: ['M12: deploy account-delete and social-mobile-account-delete from the reviewed stack, with no X secret set, then re-run M12'] };
      const answer = await ctx.http({ method: 'POST', path: '/functions/v1/account-delete', key: 'publishable', bearer: login.accessToken, body: { action: 'withdraw_postona', confirmation: 'END_POSTONA_SERVICE' } });
      const body = asRecord(answer.body);
      const after = await ctx.sql(`select md5(coalesce((select to_jsonb(e)::text from public.service_entitlements e where e.user_id = ${lit(login.userId)}::uuid and e.service_key = 'kabumori'), '-') || coalesce((select to_jsonb(p)::text from public.profiles p where p.id = ${lit(login.userId)}::uuid), '-'))`);
      const users = (await ctx.sql(`select count(*) from auth.users where id = ${lit(login.userId)}::uuid`)).trim();
      const rows = await entitlements(ctx, login.userId);
      if (users !== '1' || after !== before) return stop('the login or the Kabumori rows changed');
      if (answer.status === 200 && body.outcome === 'ended' && rows === 'kabumori:active,x_autopost:ended') return pass('POSTONA ended; the login, the profile and the Kabumori entitlement are unchanged');
      return fail(`HTTP ${answer.status} ${JSON.stringify(body).slice(0, 160)} entitlements=${rows}`);
    },
  },
  {
    id: 'M9', title: 'M9 the probe again after the exercise (ACL / ownership / policy inventory)', access: 'read', mode: 'automated', modelled: true,
    expected: 'RELEASE_PREFLIGHT|PASS|fail=0 again: nothing drifted while the checks ran',
    stop: 'any FAIL or STOP line',
    run: async (ctx) => probeVerdict(await ctx.probe(PROBE_PATH), 'M9'),
  },
  {
    id: 'M3', title: 'M3 Apple / Google linking and private-relay (observation)', access: 'read', mode: 'manual', modelled: false,
    expected: 'the outcome is recorded as one of linked_same_user / separate_users; a private-relay address is a different person',
    stop: 'the outcome contradicts the documented identity rule (one Auth user = one common account; no merge by this code)',
    run: (ctx) => {
      const rows = ctx.memo.m3Rows as { userId: string; provider: string }[] | undefined;
      if (!rows) {
        return Promise.resolve<Verdict>({
          status: 'MANUAL', detail: 'needs a real provider sign-in with a test account the operator controls',
          manual: [
            'M3: sign in with e-mail, then with Apple/Google using a test account whose VERIFIED address equals it; then run the read-back below and record linked_same_user or separate_users',
            "read-back: select u.id, i.provider from auth.users u join auth.identities i on i.user_id = u.id where lower(u.email) = '<address>'",
          ],
        });
      }
      return Promise.resolve<Verdict>({ status: 'INFO', detail: `linking outcome: ${classifyLinking(rows)}` });
    },
  },
  {
    id: 'T1', title: 'T1 teardown: remove the test logins this run created (then delete the project)', access: 'mutate', mode: 'automated', modelled: true, always: true,
    expected: 'every login recorded by this run is removed through the Auth admin API; the project itself is then deleted by its owner',
    stop: 'a recorded login cannot be removed (report it; do not retry blindly)',
    run: async (ctx) => {
      const problems: string[] = [];
      for (const user of ctx.created) {
        const answer = await ctx.http({ method: 'DELETE', path: `/auth/v1/admin/users/${user.userId}`, key: 'service' });
        if (answer.status >= 300 && answer.status !== 404) problems.push(`${user.userId.slice(0, 8)}: HTTP ${answer.status}`);
      }
      return problems.length === 0
        ? pass(`${ctx.created.length} test login(s) removed; delete the disposable project itself to finish`)
        : { status: 'WARN', detail: `could not remove: ${problems.join('; ')} -- delete the project instead` };
    },
  },
];

/** The ordered ids a model run exercises. */
/**
 * Every step that mutates the project -- the chain files and the acceptance checks that create logins -- requires the
 * baseline read-back to have passed in the same run. Exceptions: G3a (it applies the baseline the read-back then checks)
 * and teardown (`always`), which must stay runnable alone. The runner enforces this at the selection, at the step and
 * again at the mutation itself (applyFile / non-GET http / held lock).
 */
export const STEPS: readonly Step[] = PLAN_STEPS.map((step) => (
  step.access === 'mutate' && step.always !== true && step.id !== 'G3a' ? { ...step, requires: [BASELINE_GATE] } : step
));

export const MODELLED = STEPS.filter((step) => step.modelled).map((step) => step.id);
