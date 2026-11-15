// G2-02 TASK 15: G2-owned composite driver. G1 #689's real client + paging walk (unchanged files, imported from the throwaway tree) over the
// real GoTrue -> Kong -> Edge (G3 #690) -> PG17 of G1's throw-away runtime (g1xs, 127.0.0.1 only). SYNTHETIC notification rows (as G3's L42/L43).
// Prints one line per check: PASS/FAIL <id> <detail>. No test credentials are printed.
import { createApprovalClient } from '/Users/yuya/Developer/kabumori-g2-int15/apps/social-mobile/src/features/approvals/approval-client.ts';
import { startWalk, acceptPage, FIRST_PAGE_SIZE, MORE_PAGE_SIZE, MAX_PAGES } from '/Users/yuya/Developer/kabumori-g2-int15/apps/social-mobile/src/features/approvals/notification-pages.ts';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const S = '/private/tmp/claude-501/-Users-yuya-Developer-kabumori/e98c2921-c101-4ee6-b59b-243231954603/scratchpad';
const env = Object.fromEntries(readFileSync(`${S}/g2-15.env`, 'utf8').trim().split('\n').map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
const { API, PUBLISHABLE, DB_PORT } = env;
const FN = 'postona-x-approvals-localtest';
let fails = 0;
const check = (id: string, ok: boolean, detail: string) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${detail}`); };

const psql = (script: string, vars: Record<string, string> = {}): Promise<string> => new Promise((resolve) => {
  const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', DB_PORT, '-U', 'postgres', '-d', 'postgres'];
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  const child = execFile('psql', args, { env: { ...process.env, PGPASSWORD: 'postgres' } }, (error, stdout, stderr) => resolve(error ? `ERR:${stderr.trim().split('\n')[0]}` : stdout.trim()));
  child.stdin!.end(script);
});
const rpc = async (fn: string, token: string) => (await fetch(`${API}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: PUBLISHABLE, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' })).status;
type Person = { userId: string; email: string; password: string; token: string };
async function person(label: string): Promise<Person> {
  const email = `g2y${label}${randomBytes(3).toString('hex')}@example.test`;
  const password = `G2y${randomBytes(6).toString('hex')}`;
  const r = await fetch(`${API}/auth/v1/signup`, { method: 'POST', headers: { apikey: PUBLISHABLE, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const j = await r.json() as { access_token: string };
  const userId = JSON.parse(Buffer.from(j.access_token.split('.')[1], 'base64url').toString()).sub as string;
  await rpc('start_x_autopost_service', j.access_token);
  await rpc('postona_ensure_my_personal_workspace', j.access_token);
  return { userId, email, password, token: j.access_token };
}
const login = async (p: Person) => { const r = await fetch(`${API}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: PUBLISHABLE, 'content-type': 'application/json' }, body: JSON.stringify({ email: p.email, password: p.password }) }); return ((await r.json()) as { access_token: string }).access_token; };
const seed = (p: Person, n: number) => n === 0 ? Promise.resolve('') : psql("insert into postona_x_resv.notifications (user_id, brand_id, event_key, kind, subject_revision, state) select :'u', (select brand_id from public.brand_memberships where user_id = :'u' and role = 'owner'), 'approval_requested:' || gen_random_uuid() || ':r1', 'approval_requested', 1, 'pending_approval' from generate_series(1, :'n'::int)", { u: p.userId, n: String(n) });   // SYNTHETIC
const dbIds = async (p: Person) => (await psql("select id from postona_x_resv.notifications where user_id = :'u' order by id", { u: p.userId })).split('\n').filter(Boolean);
const raw = async (token: string | null, payload: Record<string, unknown>, action = 'notifications') => {
  const headers: Record<string, string> = { apikey: PUBLISHABLE, 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`${API}/functions/v1/${FN}`, { method: 'POST', headers, body: JSON.stringify({ action, payload }) });
  let body: any = null; try { body = await r.json(); } catch { /* none */ }
  return { status: r.status, body };
};

// The screen adapter: G1's client + walk exactly as the hook drives them (first page 50, then 100 each, only `before` = the walk's next).
function clientFor(token: () => string) {
  let sent = 0;
  const counted: typeof fetch = (u, i) => { sent++; return fetch(u, i); };
  const client = createApprovalClient({ supabaseUrl: API, publishableKey: PUBLISHABLE, accessToken: async () => token(), fetch: counted, functionName: FN, allowLoopbackHttpForTests: true });
  return { client, sent: () => sent };
}
async function walkAll(token: () => string, between?: (pages: number, walk: any) => Promise<void>) {
  const { client, sent } = clientFor(token);
  const first = await client.notificationPage({ limit: FIRST_PAGE_SIZE });
  if (!first.ok) return { error: first, walk: null, sent: sent() };
  let walk = startWalk(first.value);
  const answers: (number | null)[] = [first.value.nextCursor];
  while (walk.next !== null && !walk.stopped) {
    if (between) await between(walk.pages, walk);
    const before = walk.next;
    const page = await client.notificationPage({ limit: MORE_PAGE_SIZE, before });
    if (!page.ok) return { error: page, walk, sent: sent() };
    answers.push(page.value.nextCursor);
    walk = acceptPage(walk, before, page.value).walk;
  }
  return { error: null, walk, sent: sent(), answers };
}
const expectedPages = (n: number) => (n <= FIRST_PAGE_SIZE ? 1 : 1 + Math.ceil((n - FIRST_PAGE_SIZE) / MORE_PAGE_SIZE));
const strictlyDown = (rows: { cursor?: number }[]) => rows.every((r, i) => i === 0 || (rows[i - 1].cursor as number) > (r.cursor as number));

// ---- D1: counts 0/50/51/100/101/150/151/279/300: every row once, strict order, last page null, no request after it
for (const n of [0, 50, 51, 100, 101, 150, 151, 279, 300]) {
  const p = await person(`n${n}`);
  await seed(p, n);
  const r = await walkAll(() => p.token);
  const rows = r.walk?.rows ?? [];
  const ids = new Set(rows.map((x) => x.notificationId));
  const db = await dbIds(p);
  const sameSet = db.length === ids.size && db.every((id) => ids.has(id));
  const lastNull = r.answers !== undefined && r.answers[r.answers.length - 1] === null;
  check(`D1-n${n}`, !r.error && rows.length === n && ids.size === n && sameSet && strictlyDown(rows) && lastNull && r.walk!.stopped === null && r.sent === expectedPages(n),
    `rows=${rows.length} unique=${ids.size} db=${db.length} order=${strictlyDown(rows)} lastNextCursor=${lastNull ? 'null' : 'NOT-null'} requests=${r.sent}/${expectedPages(n)} stopped=${r.walk?.stopped ?? r.error?.code}`);
  if (n === 300) {
    // the server's own answer one step past the end (the walk never sends this): an empty page and null
    const last = rows[rows.length - 1].cursor as number;
    const past = await raw(p.token, { limit: 100, before: last });
    check('D1-past-end', past.status === 200 && past.body?.notifications?.length === 0 && past.body?.nextCursor === null, `server past the last cursor: ${past.status} rows=${past.body?.notifications?.length} next=${past.body?.nextCursor}`);
  }
}

// ---- D2: 20-page cap: 2,001 rows -> 20 pages, 1,950 rows, "capped", no 21st request
{
  const p = await person('cap');
  await seed(p, 2001);
  const r = await walkAll(() => p.token);
  check('D2-cap', !r.error && r.walk!.pages === MAX_PAGES && r.walk!.rows.length === FIRST_PAGE_SIZE + (MAX_PAGES - 1) * MORE_PAGE_SIZE && r.walk!.stopped === 'capped' && r.walk!.next === null && r.sent === MAX_PAGES && new Set(r.walk!.rows.map((x) => x.notificationId)).size === r.walk!.rows.length,
    `pages=${r.walk?.pages} rows=${r.walk?.rows.length} stopped=${r.walk?.stopped} requests=${r.sent}`);
}

// ---- D3: bad cursors: the client never sends them; the server refuses them
{
  const p = await person('bad');
  await seed(p, 60);
  const { client, sent } = clientFor(() => p.token);
  const local = await Promise.all([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((b) => client.notificationPage({ limit: 100, before: b })));
  check('D3-client', local.every((a) => !a.ok && a.code === 'REQUEST_INVALID') && sent() === 0, `client refused ${local.filter((a) => !a.ok).length}/4 locally, requests=${sent()}`);
  const server = await Promise.all([0, -1, 1.5, 'abc', null, 2 ** 53].map((b) => raw(p.token, { limit: 100, before: b })));
  const lim = await Promise.all([0, 101, 'x'].map((l) => raw(p.token, { limit: l })));
  check('D3-server', [...server, ...lim].every((a) => a.status === 400 && !('notifications' in (a.body ?? {}))), `server: ${[...server, ...lim].map((a) => `${a.status}:${a.body?.code}`).join(',')}`);
}

// ---- D4: changes during a walk: newer rows added, a not-yet-read row removed, markRead of a read row -> no duplicate, no reorder, nothing else lost
{
  const p = await person('mid');
  await seed(p, 300);
  const before = await dbIds(p);
  let removed = '';
  let added = 0;
  const r = await walkAll(() => p.token, async (pages, walk) => {
    if (pages === 1) {
      await seed(p, 5); added = 5;                                                     // newer than the walk: never in its later pages
      const target = await psql("select id from postona_x_resv.notifications where user_id = :'u' and id = any(string_to_array(:'ids', ',')::uuid[]) order by created_at limit 1 offset 0", { u: p.userId, ids: before.join(',') });
      removed = (await psql(`with older as (select n.id from postona_x_resv.notifications n where n.user_id = :'u' and n.id <> all(string_to_array(:'seen', ',')::uuid[]) and n.id = any(string_to_array(:'ids', ',')::uuid[]) order by n.id limit 1) delete from postona_x_resv.notifications d using older where d.id = older.id returning d.id`, { u: p.userId, seen: walk.rows.map((x: any) => x.notificationId).join(','), ids: before.join(',') })).trim();
      void target;
      const read = await clientFor(() => p.token).client.markRead(walk.rows[0].notificationId);
      check('D4-markRead', read.ok, `markRead of a shown row during the walk: ${read.ok ? 'ok' : (read as any).code}`);
    }
  });
  const rows = r.walk!.rows;
  const ids = rows.map((x) => x.notificationId);
  check('D4-mid', !r.error && new Set(ids).size === ids.length && strictlyDown(rows) && rows.length === 299 && !ids.includes(removed) && added === 5,
    `rows=${rows.length} (300 - 1 removed, +5 newer not in later pages) unique=${new Set(ids).size === ids.length} order=${strictlyDown(rows)} removedShown=${ids.includes(removed)}`);
}

// ---- D5: A/B: B never sees A's rows, also with A's cursor
{
  const a = await person('iA');
  const b = await person('iB');
  await seed(a, 120); await seed(b, 3);
  const ra = await walkAll(() => a.token);
  const aCursor = ra.walk!.rows[60].cursor as number;
  const rb = await walkAll(() => b.token);
  const withA = await raw(b.token, { limit: 100, before: aCursor });
  const aIds = new Set(ra.walk!.rows.map((x) => x.notificationId));
  const leak = [...rb.walk!.rows, ...(withA.body?.notifications ?? [])].filter((x: any) => aIds.has(x.notificationId)).length;
  check('D5-isolation', rb.walk!.rows.length === 3 && leak === 0 && withA.status === 200, `B rows=${rb.walk!.rows.length} with A's cursor ${withA.status} rows=${withA.body?.notifications?.length} leaked=${leak}`);
}

// ---- D6: service ended: pages still read (read-only), every write refused, nothing written
{
  const p = await person('end');
  await seed(p, 130);
  const w0 = await psql("select count(*) || ':' || count(*) filter (where read_at is not null) from postona_x_resv.notifications where user_id = :'u'", { u: p.userId });
  await psql("update public.service_entitlements set status='ended', ended_at=now() where user_id=:'u' and service_key='x_autopost'", { u: p.userId });
  const r = await walkAll(() => p.token);
  const mr = await clientFor(() => p.token).client.markRead(r.walk!.rows[0].notificationId);
  const sub = await raw(p.token, { socialAccountId: 'sa_none', clientRequestId: randomUUID(), body: 'x', scheduledAt: new Date(Date.now() + 864e5 * 7).toISOString() }, 'submit');
  const w1 = await psql("select count(*) || ':' || count(*) filter (where read_at is not null) from postona_x_resv.notifications where user_id = :'u'", { u: p.userId });
  check('D6-ended', !r.error && r.walk!.rows.length === 130 && !mr.ok && (mr as any).code === 'POSTONA_RESV_SERVICE_NOT_ACTIVE' && sub.status >= 400 && w0 === w1,
    `walk rows=${r.walk?.rows.length} markRead=${(mr as any).code ?? 'ok'} submit=${sub.status}:${sub.body?.code} rows/read before=${w0} after=${w1}`);
}

// ---- D7: a late answer of an earlier walk adds nothing (logout / re-read while a page is on its way)
{
  const p = await person('late');
  await seed(p, 200);
  const { client } = clientFor(() => p.token);
  const first = await client.notificationPage({ limit: 50 });
  const walk1 = startWalk((first as any).value);
  const pending = client.notificationPage({ limit: 100, before: walk1.next as number });
  const fresh = startWalk((await client.notificationPage({ limit: 50 }) as any).value);   // the screen read again: a new walk
  const reread = { ...fresh, next: (fresh.next as number) - 1 };                             // the new walk now waits for another cursor
  const late = await pending;
  const out = acceptPage(reread, walk1.next as number, (late as any).value);
  check('D7-late', out.added === false && out.walk.rows.length === fresh.rows.length, `late page for the old cursor added=${out.added}`);
}

// ---- D8: the session ends between the page and its limit-100 look-ahead (real GoTrue sign-out while the call waits): 401, no rows
{
  // person "d8" was made by g2-15-seed.mjs (X connected, one approved reservation from `dup`), so a pending event can hold the call (as G3's L44)
  const P = JSON.parse(readFileSync(`${S}/g2-15-people.json`, 'utf8')).d8;
  const p: Person = { userId: P.userId, email: P.email, password: P.password, token: '' };
  await seed(p, 150);
  const rid = await psql("select c.reservation_id || ' ' || c.id from postona_x_resv.approval_candidates c where c.user_id = :'u' and c.state = 'approved' and c.reservation_id is not null limit 1", { u: p.userId });
  const [res, cid] = rid.split(' ');
  await psql("insert into postona_x_resv.reservation_events (reservation_id, revision, status, user_id, brand_id, candidate_id, scheduled_at) select :'i', 4001, 'planned', :'u', brand_id, :'c', now() from postona_x_resv.approval_candidates where id = :'c'", { i: res, u: p.userId, c: cid });   // SYNTHETIC
  await psql("create function public.g2y15_barrier() returns trigger language plpgsql as $$ begin perform pg_sleep(3); return new; end $$; create trigger g2y15_barrier before insert on postona_x_resv.notifications for each row execute function public.g2y15_barrier();");
  const token = await login(p);
  const { client } = clientFor(() => token);
  const listing = client.notificationPage({ limit: 100 });
  await new Promise((r) => setTimeout(r, 1000));
  const out = await fetch(`${API}/auth/v1/logout?scope=local`, { method: 'POST', headers: { apikey: PUBLISHABLE, authorization: `Bearer ${token}` } });
  const answered = await listing;
  await psql("drop trigger g2y15_barrier on postona_x_resv.notifications; drop function public.g2y15_barrier();");
  const again = await raw(token, { limit: 100 });
  check('D8-auth', !answered.ok && (answered as any).status === 401 && (answered as any).code === 'POSTONA_RESV_AUTH_REQUIRED' && again.status === 401,
    `logout=${out.status} page=${(answered as any).status ?? 200}:${(answered as any).code ?? 'ok'} rows=${answered.ok ? (answered as any).value.rows.length : 0} next call=${again.status}`);
}

// ---- D9: a TEMPORARY failure of the look-ahead (TEST-ONLY fault on limit-1 calls: SERVICE_BUSY) keeps the page and its cursor; the next page then ends
{
  const p = await person('la');
  await seed(p, 150);
  await psql("create table public.g2y15_lookahead_fail (one int)");
  await psql(readFileSync(`${S}/g2-15-listfn-fail.sql`, 'utf8'));
  await psql("insert into public.g2y15_lookahead_fail values (1)");
  const first = await raw(p.token, { limit: 100 });
  await psql("drop table public.g2y15_lookahead_fail cascade");
  await psql(readFileSync(`${S}/g2-15-listfn-orig.sql`, 'utf8'));
  const rows = first.body?.notifications ?? [];
  const next = first.body?.nextCursor;
  const rest = next ? await raw(p.token, { limit: 100, before: next }) : null;
  const restored = (await psql("select pg_get_functiondef('postona_x_resv.list_notifications(integer,bigint)'::regprocedure)")).includes('g2y15') === false;
  check('D9-lookahead-temp', first.status === 200 && rows.length === 100 && next === rows[99]?.cursor && rest?.status === 200 && rest.body.notifications.length === 50 && rest.body.nextCursor === null && restored,
    `page=${first.status} rows=${rows.length} nextCursor kept=${next === rows[99]?.cursor} -> next page ${rest?.status} rows=${rest?.body?.notifications?.length} next=${rest?.body?.nextCursor} functionRestored=${restored}`);
}

console.log(`G2T15_DRIVER_DONE fails=${fails}`);
