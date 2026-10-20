// G3 TASK 12/50: U8 fail-closed gate (postona_threads_u8_gate_run.sh only, disposable LOCAL PostgreSQL). The REAL 2a-2 CHECK
// social_accounts_meta_publish_disabled stays in force: no test here lifts it. G3's 007 (unchanged) must then create nothing and send
// nothing, whatever else holds -- a verified account with a G4 credential row available included. Rows that bypass create (TEST DATA
// inserted by the owner, standing for legacy / migrated rows) must also be stopped before any Graph request, and nothing is retried.
// Network: 127.0.0.1 only; "Threads" is a FAKE Graph. Neither U8 candidate (a: lift 2a-2 + a person's writer; b: a separate
// scheduled-publish permission) is adopted or modelled here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Client } from "jsr:@db/postgres@0.19.5";
import {
  runThreadsReservationDelivery, type ThreadsCredentialPort, type ThreadsDispatchStore, type ThreadsSendPort,
} from "../../../functions/_shared/postona_reservations/threads_dispatch.ts";
import { createPgPersonStore, createPgWorkerStore } from "../fixture/pg_fixture_ports.ts";
import { createThreadsReservationHttpFixture, type VerifiedCaller } from "../fixture/threads_reservation_http_fixture.ts";

const API_URL = Deno.env.get("THREADS_XO_API_URL")!;
const WORKER_URL = Deno.env.get("THREADS_XO_WORKER_URL")!;
const OWNER_URL = Deno.env.get("THREADS_XO_OWNER_URL")!;
const G4_DIR = Deno.env.get("THREADS_G4_SOCIAL_DIR")!;
assert.ok(API_URL && WORKER_URL && OWNER_URL && G4_DIR, "set by postona_threads_u8_gate_run.sh");

type Statement = (id: string, key: string) => Promise<unknown>;
type G4SendPortModule = {
  parseThreadsCredentialRow(requested: string, answer: unknown): { socialAccountId: string; threadsUserId: string; accessToken: string; generation: string } | null;
  createGatedThreadsCredentialPort(enabled: boolean, key: string | null, statement: Statement | null): ThreadsCredentialPort;
  createGatedThreadsSendPort(enabled: boolean, transport: "threads" | "simulated", fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
    options?: { containerChecks?: number; containerCheckDelayMs?: number }): ThreadsSendPort;
};
const G4 = await import(new URL(`file://${encodeURI(`${G4_DIR}/threads_send_port.ts`)}`).href) as G4SendPortModule;

// ---- database --------------------------------------------------------------------------------------------------------
async function sql<T extends unknown[]>(url: string, text: string, args: unknown[] = [], setup: string[] = []): Promise<T[]> {
  const c = new Client(url);
  await c.connect();
  try {
    if (setup.length === 0) return (await c.queryArray<T>({ text, args })).rows;
    await c.queryArray("BEGIN");
    for (const s of setup) await c.queryArray(s);
    const rows = (await c.queryArray<T>({ text, args })).rows;
    await c.queryArray("ROLLBACK");
    return rows;
  } finally {
    await c.end().catch(() => undefined);
  }
}
const owner = <T extends unknown[]>(text: string, args: unknown[] = []) => sql<T>(OWNER_URL, text, args);
const sqlState = async (url: string, text: string, args: unknown[] = [], setup: string[] = []) => {
  try {
    await sql(url, text, args, setup);
    return "ran";
  } catch (e) {
    const f = (e as { fields?: { code?: string; message?: string } }).fields;
    return f?.message?.startsWith("POSTONA_") ? f.message : f?.code ?? "error";
  }
};
type Person = { user: string; threads: string; brand: string; token: string };
const people = new Map((await owner<[number, string, string, string, string]>("select n, user_id::text, threads_account, brand, token from t_ids.people"))
  .map(([n, user, threads, brand, token]) => [Number(n), { user, threads, brand, token } as Person]));
const P = (n: number) => people.get(n)!;
const session = async (user: string) => String((await owner<[string]>("insert into auth.sessions (user_id) values ($1::uuid) returning id::text", [user]))[0][0]);
const claims = (user: string, sessionId: string) => JSON.stringify({ sub: user, role: "authenticated", session_id: sessionId });
const reservations = async () => Number((await owner<[bigint]>("select count(*) from postona_threads_resv.reservations"))[0][0]);
const switchesOn = async () => Number((await owner<[bigint]>("select count(*) from public.social_accounts where platform = 'threads' and publish_enabled"))[0][0]);
const counters = async (n: number) => (await owner<[string, string]>(
  "select private.account_lifecycle_brand_owner_epoch($1)::text, (select a.lifecycle_version::text from public.common_accounts a where a.user_id = $2::uuid)", [P(n).brand, P(n).user]))[0];
const row = async (id: string) => (await owner<[string, string | null]>("select status, outcome_code from postona_threads_resv.reservations where id = $1::uuid", [id]))[0];
/** TEST DATA: a reservation row that did NOT come through create (a legacy / migrated row), with the account's CURRENT G5 pair. */
async function plant(n: number, text: string): Promise<{ id: string; clientId: string }> {
  const [[id, clientId]] = await owner<[string, string]>(
    `insert into postona_threads_resv.reservations (user_id, brand_id, social_account_id, client_request_id, body, content_sha256, scheduled_at,
       bound_owner_epoch, bound_lifecycle_version)
     select p.user_id, p.brand, p.threads_account, gen_random_uuid(), $2, encode(sha256(convert_to($2, 'UTF8')), 'hex'), now() - interval '1 second',
       private.account_lifecycle_brand_owner_epoch(p.brand), (select a.lifecycle_version from public.common_accounts a where a.user_id = p.user_id)
     from t_ids.people p where p.n = $1 returning id::text, client_request_id::text`, [n, text]);
  return { id, clientId };
}
async function restartService(n: number) {
  await owner("update public.service_entitlements set status = 'ended', ended_at = now() where user_id = $1::uuid and service_key = 'x_autopost'", [P(n).user]);
  await owner("update public.service_entitlements set status = 'active', ended_at = null where user_id = $1::uuid and service_key = 'x_autopost'", [P(n).user]);
}

// ---- HTTP ------------------------------------------------------------------------------------------------------------------
const verdicts = new Map<string, VerifiedCaller>();
async function tokenOf(n: number): Promise<string> {
  const token = `tok-${n}-${crypto.randomUUID().slice(0, 8)}-0123456789abcdef`;
  verdicts.set(token, { userId: P(n).user, sessionId: await session(P(n).user) });
  return token;
}
const http = createThreadsReservationHttpFixture({ enabled: true, verify: (t: string) => Promise.resolve(verdicts.get(t) ?? null), store: createPgPersonStore(API_URL) });
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
async function req(token: string, body: unknown) {
  const res = await http(new Request("http://fixture.local/threads-reservations", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
const createBody = (account: string, text: string, id = crypto.randomUUID()) =>
  ({ op: "create", socialAccountId: account, clientRequestId: id, text, scheduledAt: new Date(Date.now() + 10 * 60_000).toISOString(), consent: { confirmed: true, contentSha256: sha(text) } });

// ---- G4's shipped ports over the FAKE Graph -------------------------------------------------------------------------------
function fakeGraph() {
  const events: string[] = [];
  const fetchImpl = (input: string, init?: RequestInit): Promise<Response> => {
    events.push(`${init?.method ?? "GET"} ${new URL(input).pathname}`);
    return Promise.resolve(new Response(JSON.stringify({ error: { code: 100 } }), { status: 400 }));
  };
  return { fetchImpl, events };
}
const credentialRow: Statement = async (account, key) => (await owner<[string, string, string, string]>(
  "select social_account_id, threads_user_id, access_token, generation from postona_threads_credential.credential_row($1, $2)", [account, key]))
  .map(([social_account_id, threads_user_id, access_token, generation]) => ({ social_account_id, threads_user_id, access_token, generation }));
const shippedCredentials = () => G4.createGatedThreadsCredentialPort(true, "x_autopost", credentialRow);
const workerStore = createPgWorkerStore(WORKER_URL);
const deliver = (g: ReturnType<typeof fakeGraph>, extra: { store?: ThreadsDispatchStore; creds?: ThreadsCredentialPort; enabled?: boolean } = {}) =>
  runThreadsReservationDelivery({ enabled: extra.enabled ?? true, store: extra.store ?? workerStore, credentials: extra.creds ?? shippedCredentials(),
    sender: G4.createGatedThreadsSendPort(true, "simulated", g.fetchImpl, { containerChecks: 1, containerCheckDelayMs: 0 }), worker: "u8-w1", leaseSeconds: 60, limit: 50 });

// ---- tests -----------------------------------------------------------------------------------------------------------------
Deno.test("U0 the world: the 2a-2 CHECK is in force, no Threads switch is ON, yet G4's credential row IS available -- the switch is the only gate under test", async () => {
  const [[check]] = await owner<[string]>("select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.social_accounts'::regclass and conname = 'social_accounts_meta_publish_disabled'");
  assert.match(check, /publish_enabled/u);
  assert.equal(await switchesOn(), 0);
  assert.equal(await reservations(), 0);
  const shipped = await shippedCredentials().credentialFor(P(101).threads);
  assert.ok(shipped === null || shipped.socialAccountId === P(101).threads, "G4's shipped port: null on #377's TS (U2), the row on #381's");
  assert.ok(G4.parseThreadsCredentialRow(P(101).threads, await credentialRow(P(101).threads, "x_autopost")) !== null, "G4's statement answers");
});

Deno.test("U1 the switch cannot be turned ON: the owner hits the CHECK (23514); service_role and authenticated are refused too; nothing changed", async () => {
  assert.equal(await sqlState(OWNER_URL, "update public.social_accounts set publish_enabled = true where id = $1", [P(101).threads]), "23514");
  const svc = await sqlState(OWNER_URL, "update public.social_accounts set publish_enabled = true where id = $1", [P(101).threads], ["set local role service_role"]);
  const auth = await sqlState(OWNER_URL, "update public.social_accounts set publish_enabled = true where id = $1", [P(101).threads],
    ["set local role authenticated", `select set_config('request.jwt.claims', '${claims(P(101).user, await session(P(101).user))}', true)`]);
  assert.notEqual(svc, "ran", "service_role");
  assert.notEqual(auth, "ran", "authenticated");
  console.log(`U1 refusals: owner 23514, service_role ${svc}, authenticated ${auth}`);
  assert.equal(await switchesOn(), 0);
});

Deno.test("U2 create is refused for verified, credentialed accounts (HTTP and straight at 007), repeats included: no row, no G5 counter moved", async () => {
  for (const n of [101, 102, 103]) {
    const before = await counters(n);
    const t = await tokenOf(n);
    const id = crypto.randomUUID();
    for (let i = 0; i < 2; i += 1) {
      const r = await req(t, createBody(P(n).threads, `U2 ${n}`, id));
      assert.deepEqual([r.status === 200, r.body.code], [false, "PUBLISH_DISABLED"], `${n} try ${i}`);
    }
    const direct = await sqlState(API_URL, "select * from postona_threads_resv.create_reservation($1, gen_random_uuid(), 'U2 direct', $2, now() + interval '10 minutes')",
      [P(n).threads, sha("U2 direct")], ["set local role postona_resv_api", `select set_config('request.jwt.claims', '${claims(P(n).user, await session(P(n).user))}', true)`]);
    assert.equal(direct, "POSTONA_THREADS_RESV_PUBLISH_DISABLED", `${n} direct`);
    assert.deepEqual(await counters(n), before, `${n}: no G5 counter moved`);
  }
  assert.equal(await reservations(), 0);
});

Deno.test("U3 other states also create nothing: G4 verification removed, an account still authorization_pending (never connected), entitlement ended, deletion started", async () => {
  await owner("delete from t_threads.verified where social_account_id = $1", [P(104).threads]);
  // a person who began G4's connect but never completed it: the account row exists, authorization_pending
  const [[pendingUser]] = await owner<[string]>("select g4c.uid(131)::text");
  await owner("select public.fixture_login($1::uuid)", [pendingUser]);
  await owner("insert into auth.sessions (user_id) values ($1::uuid)", [pendingUser]);
  assert.equal((await owner<[string]>("select g4c.as_person($1::uuid, 'select public.start_x_autopost_service() ->> ''status''')", [pendingUser]))[0][0], "active");
  const [[pendingAccount]] = await owner<[string]>(
    "select g4c.as_person($1::uuid, format('select social_account_id from public.begin_social_mobile_threads_oauth_connection(%L, %L, now() + interval ''5 minutes'')', g4c.h('u8pending'), 'https://app.postona.test/oauth/threads/callback'))",
    [pendingUser]);
  assert.match(pendingAccount, /^sa_[0-9a-f]{24}$/u);
  await owner("update public.service_entitlements set status = 'ended', ended_at = now() where user_id = $1::uuid and service_key = 'x_autopost'", [P(105).user]);
  await owner("update public.common_accounts set status = 'deleting' where user_id = $1::uuid", [P(106).user]);
  const cases: [string, string, () => Promise<string>][] = [
    ["G4 verification removed", P(104).threads, () => tokenOf(104)],
    ["authorization_pending", pendingAccount, async () => {
      const token = `tok-pending-${crypto.randomUUID().slice(0, 8)}-0123456789abcdef`;
      verdicts.set(token, { userId: pendingUser, sessionId: await session(pendingUser) });
      return token;
    }],
    ["entitlement ended", P(105).threads, () => tokenOf(105)],
    ["deletion started", P(106).threads, () => tokenOf(106)],
  ];
  for (const [label, account, token] of cases) {
    const r = await req(await token(), createBody(account, `U3 ${label}`));
    assert.equal(r.status === 200, false, label);
    console.log(`U3 ${label}: ${r.status} ${String(r.body.code)}`);
  }
  assert.equal(await reservations(), 0);
});

Deno.test("U4 no existence leak: another person's 'sa_' account and an account that does not exist get the SAME answer", async () => {
  const t = await tokenOf(107);
  const theirs = await req(t, createBody(P(108).threads, "U4 theirs"));
  const none = await req(t, createBody("sa_ffffffffffffffffffffffff", "U4 none"));
  assert.deepEqual([theirs.status, theirs.body.code], [none.status, none.body.code]);
  assert.notEqual(theirs.body.code, "PUBLISH_DISABLED", "the switch of another person's account is not revealed");
  assert.equal(await reservations(), 0);
});

Deno.test("U5 rows that bypassed create are stopped before any Graph request (switch OFF at preflight; G5's W1 at claim), and never retried", async () => {
  const off = await plant(108, "U5 switch off");
  const stale = await plant(109, "U5 stale generation");
  await restartService(109);
  const deleting = await plant(110, "U5 deletion");
  await owner("update public.common_accounts set status = 'deleting' where user_id = $1::uuid", [P(110).user]);
  const aba = await plant(111, "U5 owner A->B->A");
  await owner("insert into public.brand_memberships (brand_id, user_id, role) values ($1, $2::uuid, 'owner')", [P(111).brand, P(130).user]);
  await owner("delete from public.brand_memberships where brand_id = $1 and user_id = $2::uuid", [P(111).brand, P(130).user]);
  const g = fakeGraph();
  const r = await deliver(g);
  assert.deepEqual([g.events.length, r.sends, r.published, r.uncertain], [0, 0, 0, 0]);
  assert.deepEqual(await row(off.id), ["failed", "NOT_PUBLISHABLE_AT_SEND"], "007's fence at preflight: switch OFF");
  assert.deepEqual(await row(stale.id), ["failed", "SERVICE_GENERATION_CHANGED"]);
  assert.deepEqual(await row(deleting.id), ["failed", "ACCOUNT_DELETION_IN_PROGRESS"]);
  assert.deepEqual(await row(aba.id), ["failed", "OWNER_EPOCH_CHANGED"]);
  const g2 = fakeGraph();
  assert.deepEqual([(await deliver(g2)).claimed, g2.events.length], [0, 0], "no automatic retry");
});

Deno.test("U6 unknown answers (credential statement throws, preflight unreadable) with the switch OFF -> 0 Graph requests across runs; the row ends failed, never uncertain", async () => {
  const planted = await plant(112, "U6 unknowns");
  const g = fakeGraph();
  const throwing: ThreadsCredentialPort = { available: true, credentialFor: () => Promise.reject(new Error("statement unavailable")) };
  let unreadable = true;
  const flaky: ThreadsDispatchStore = { ...workerStore, preflight: async (id, l) => {
    if (unreadable) { unreadable = false; throw new Error("preflight answer lost"); }
    return await workerStore.preflight(id, l);
  } };
  const r1 = await deliver(g, { creds: throwing, store: flaky });
  assert.deepEqual([r1.claimed, r1.released, r1.sends], [1, 1, 0], "an unreadable preflight hands the row back (nothing was sent)");
  const r2 = await deliver(g, { creds: throwing });
  assert.deepEqual([r2.claimed, r2.sends], [1, 0]);
  assert.deepEqual(await row(planted.id), ["failed", "NOT_PUBLISHABLE_AT_SEND"]);
  const r3 = await deliver(g);
  assert.deepEqual([r3.claimed, g.events.length], [0, 0]);
});

Deno.test("U7 receipts: the owner sees failed / action none / no post id / no text; another person gets the constant 404", async () => {
  const planted = await plant(113, "U7 receipt text");
  await deliver(fakeGraph());
  const mine = await req(await tokenOf(113), { op: "receipt", socialAccountId: P(113).threads, clientRequestId: planted.clientId });
  assert.deepEqual([mine.status, mine.body.state, mine.body.action, "xPostId" in mine.body], [200, "failed", "none", false]);
  assert.ok(!JSON.stringify(mine.body).includes("U7 receipt text") && !JSON.stringify(mine.body).includes(P(113).token));
  const theirs = await req(await tokenOf(114), { op: "receipt", socialAccountId: P(113).threads, clientRequestId: planted.clientId });
  assert.equal(theirs.status, 404);
});

Deno.test("U8 neither U8 candidate is adopted here: 007's fence still reads publish_enabled and no other permission table exists; the dispatcher OFF claims nothing", async () => {
  const [[fence, permissionTable]] = await owner<[string, string]>(`select
    (select p.prosrc from pg_proc p where p.oid = 'postona_threads_resv.fence(uuid,text)'::regprocedure),
    (select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and c.relname ~ '(manual|scheduled)_publish_permission')`);
  assert.ok(fence.includes("publish_enabled is not true"));
  assert.equal(permissionTable, "0");
  const planted = await plant(115, "U8 OFF");
  const g = fakeGraph();
  const r = await deliver(g, { enabled: false });
  assert.deepEqual([r.notAvailable, r.claimed, g.events.length], [true, 0, 0]);
  await owner("update postona_threads_resv.reservations set status = 'cancelled' where id = $1::uuid", [planted.id]);
});

Deno.test("U9 nothing published, nothing pending, the CHECK untouched", async () => {
  const [[published, due, uncertain]] = await owner<[bigint, bigint, bigint]>(`select
    (select count(*) from postona_threads_resv.reservations where status = 'published'),
    (select count(*) from postona_threads_resv.reservations where status = 'planned' and scheduled_at <= now()),
    (select count(*) from postona_threads_resv.reservations where status = 'uncertain')`);
  assert.deepEqual([Number(published), Number(due), Number(uncertain)], [0, 0, 0]);
  assert.equal(await switchesOn(), 0);
});
