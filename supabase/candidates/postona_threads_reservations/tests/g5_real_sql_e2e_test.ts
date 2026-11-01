// G3 TASK 10/50: G3's Threads reservations on G5's REAL SQL candidates (run by postona_threads_g5_real_run.sh only, disposable LOCAL
// PostgreSQL). No test double of R1 / W1 / W2: G3 PR #370 -> G5 PR #303 (owner epoch) -> G5 PR #371 (R1 / W1 / W2 on #351 / #358) -> 007.
//   create   the HTTP fixture -> 007.create_reservation -> G5's REAL R1 (JWT claims + a REAL auth.sessions row) -> the two numbers of
//            g5oe:<owner_epoch>:<lifecycle_version> stored on the row, never rewritten afterwards
//   claim    007.claim_due -> G5's REAL W1 with the stored numbers
//   send     PR #356's dispatcher -> 007.preflight (REAL W1) -> G4's REAL send port (isolated copy) over a FAKE Graph -> beforePublish
//            (007.preflight again: REAL W1) -> publish -> read-back -> 007.record (after_freeze from REAL W1)
//   W2       G5's service_role wrapper, asked with the SAME stored numbers at every stage: it must answer what 007 recorded
// Network: 127.0.0.1 only. MOCK_ONLY: the caller verdicts (but the sessions are real rows), the token, G4's verified predicate, Threads.
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
assert.ok(API_URL && WORKER_URL && OWNER_URL && G4_DIR, "set by postona_threads_g5_real_run.sh");

type G4SendPortModule = {
  THREADS_POSTING_SERVICE_KEY: string | null;
  parseThreadsCredentialRow(requested: string, answer: unknown): { socialAccountId: string; threadsUserId: string; accessToken: string; generation: string } | null;
  createGatedThreadsCredentialPort(enabled: boolean, key: string | null, statement: ((id: string, key: string) => Promise<unknown>) | null): ThreadsCredentialPort;
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
const people = new Map((await owner<[number, string, string, string]>("select n, user_id::text, threads_account, brand from t_ids.people")).map(([n, u, t, b]) => [Number(n), { user: u, threads: t, brand: b }]));
const P = (n: number) => people.get(n)!;
const session = async (n: number, notAfter: string | null = null) =>
  String((await owner<[string]>("insert into auth.sessions (user_id, not_after) values ($1::uuid, $2::timestamptz) returning id::text", [P(n).user, notAfter]))[0][0]);
const claims = (n: number, sessionId: string, extra: Record<string, unknown> = {}) => JSON.stringify({ sub: P(n).user, role: "authenticated", session_id: sessionId, is_anonymous: false, ...extra });
/** G5's REAL R1, asked as the person (authenticated, the person's JWT claims). */
async function r1(n: number, sessionId: string): Promise<Record<string, unknown>> {
  const [[v]] = await sql<[Record<string, unknown>]>(OWNER_URL, "select public.common_account_authorization_verdict('postona', 'threads_publish', $1)", [P(n).brand],
    [`select set_config('request.jwt.claims', '${claims(n, sessionId)}', true)`, "set local role authenticated"]);
  return v;
}
/** G5's REAL W2, asked as service_role with the given numbers. */
async function w2(brand: string, epoch: string | null, lifecycle: string | null): Promise<string> {
  const [[v]] = await sql<[string]>(OWNER_URL, "select public.common_account_worker_brand_verdict($1, 'x_autopost', $2::bigint, $3::bigint)", [brand, epoch, lifecycle],
    ["set local role service_role"]);
  return v;
}
const current = async (n: number) => (await owner<[string, string]>(
  "select private.account_lifecycle_brand_owner_epoch($1)::text, (select a.lifecycle_version::text from public.common_accounts a where a.user_id = $2::uuid)", [P(n).brand, P(n).user]))[0];
const bound = async (id: string) => (await owner<[string | null, string | null, string]>(
  "select bound_owner_epoch::text, bound_lifecycle_version::text, brand_id from postona_threads_resv.reservations where id = $1::uuid", [id]))[0];
const row = async (id: string) => (await owner<[string, string | null, boolean | null, string | null]>(
  "select status, outcome_code, after_freeze, transport from postona_threads_resv.reservations where id = $1::uuid", [id]))[0];
const due = (id: string) => owner("update postona_threads_resv.reservations set scheduled_at = now() - interval '1 second' where id = $1::uuid", [id]);
const rowsOf = async (n: number) => Number((await owner<[bigint]>("select count(*) from postona_threads_resv.reservations where social_account_id = $1", [P(n).threads]))[0][0]);
async function endService(n: number) {
  await owner("update public.service_entitlements set status = 'ended', ended_at = now() where user_id = $1::uuid and service_key = 'x_autopost'", [P(n).user]);
}
async function restartService(n: number) {
  await endService(n);
  await owner("update public.service_entitlements set status = 'active', ended_at = null where user_id = $1::uuid and service_key = 'x_autopost'", [P(n).user]);
}
async function restartServiceInOneTransaction(n: number) {
  const c = new Client(OWNER_URL);
  await c.connect();
  try {
    await c.queryArray("BEGIN");
    await c.queryArray({ text: "update public.service_entitlements set status = 'ended', ended_at = now() where user_id = $1::uuid and service_key = 'x_autopost'", args: [P(n).user] });
    await c.queryArray({ text: "update public.service_entitlements set status = 'active', ended_at = null where user_id = $1::uuid and service_key = 'x_autopost'", args: [P(n).user] });
    await c.queryArray("COMMIT");
  } finally {
    await c.end();
  }
}
async function ownerABA(n: number, other: number) {
  await owner("insert into public.brand_memberships (brand_id, user_id, role) values ($1, $2::uuid, 'owner')", [P(n).brand, P(other).user]);
  await owner("delete from public.brand_memberships where brand_id = $1 and user_id = $2::uuid", [P(n).brand, P(other).user]);
}

// ---- HTTP (person path: the REAL R1 runs inside 007.create_reservation) --------------------------------------------------
const verdicts = new Map<string, VerifiedCaller>();
async function tokenOf(n: number, sessionId?: string): Promise<string> {
  const token = `tok-${n}-${crypto.randomUUID().slice(0, 8)}-0123456789abcdef`;
  verdicts.set(token, { userId: P(n).user, sessionId: sessionId ?? await session(n) });
  return token;
}
let failBeforeCommit = false;
const http = createThreadsReservationHttpFixture({ enabled: true, verify: (t: string) => Promise.resolve(verdicts.get(t) ?? null),
  store: createPgPersonStore(API_URL, { beforeCommit: () => (failBeforeCommit ? Promise.reject(new Error("rolled back on purpose")) : Promise.resolve()) }) });
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
async function req(token: string, body: unknown) {
  const res = await http(new Request("http://fixture.local/threads-reservations", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
async function create(token: string, n: number, text: string, id = crypto.randomUUID(), at = inMinutes(10), account = P(n).threads) {
  const r = await req(token, { op: "create", socialAccountId: account, clientRequestId: id, text, scheduledAt: at, consent: { confirmed: true, contentSha256: sha(text) } });
  return { ...r, id, at };
}
async function reserve(n: number, text: string): Promise<string> {
  const r = await create(await tokenOf(n), n, text);
  assert.deepEqual([r.status, r.body.created], [200, true], `create ${n}: ${JSON.stringify(r.body)}`);
  return String(r.body.reservationId);
}

// ---- G4's real send port over a FAKE Graph ------------------------------------------------------------------------------
type GraphEvent = "container" | "status" | "hook" | "publish" | "readback";
function fakeGraph(opts: { duringWait?: () => Promise<unknown>; duringPublish?: () => Promise<unknown>; publish?: "unknown" } = {}) {
  const events: GraphEvent[] = [];
  const containers = new Set<string>(), media = new Map<string, string>();
  let next = 18200000000000000n;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (url.origin !== "https://graph.threads.net") throw new TypeError("fake graph: origin refused");
    const parts = url.pathname.split("/").filter(Boolean);
    if (init?.method === "POST" && parts[2] === "threads") {
      events.push("container");
      const id = String(++next);
      containers.add(id);
      return json({ id });
    }
    if (init?.method === "POST" && parts[2] === "threads_publish") {
      events.push("publish");
      if (opts.duringPublish) await opts.duringPublish();
      if (opts.publish === "unknown") return new Response("", { status: 503 });
      const id = String(++next);
      media.set(id, parts[1]);
      return json({ id });
    }
    if (init?.method === "GET" && containers.has(parts[1])) {
      events.push("status");
      if (opts.duringWait) await opts.duringWait();
      return json({ id: parts[1], status: "FINISHED" });
    }
    if (init?.method === "GET" && media.has(parts[1])) {
      events.push("readback");
      return json({ id: parts[1], owner: { id: media.get(parts[1]) }, permalink: `https://www.threads.net/@g3/post/${parts[1]}` });
    }
    return json({ error: { code: 100 } }, 400);
  };
  return { fetchImpl, events, publishes: () => events.filter((e) => e === "publish").length };
}
const g4Sender = (g: ReturnType<typeof fakeGraph>) => G4.createGatedThreadsSendPort(true, "simulated", g.fetchImpl, { containerChecks: 1, containerCheckDelayMs: 0 });
const oneStatement = async (account: string) => (await owner<[string, string, string, string]>(
  `select sa.id, sa.platform_user_id, 'fake-threads-token-' || sa.id, postona_threads_resv.threads_credential_generation(sa.id)
     from public.social_accounts sa where sa.id = $1 and sa.platform = 'threads' and sa.connection_status = 'identity_verified'`, [account]))
  .map(([social_account_id, threads_user_id, access_token, generation]) => ({ social_account_id, threads_user_id, access_token, generation }));
const credentials: ThreadsCredentialPort = { available: true, credentialFor: async (a) => G4.parseThreadsCredentialRow(a, await oneStatement(a)) };
const workerStore = createPgWorkerStore(WORKER_URL);
const traced = (g: ReturnType<typeof fakeGraph>): ThreadsDispatchStore => ({
  ...workerStore, preflight: async (id, lease) => { if (g.events.includes("container")) g.events.push("hook"); return await workerStore.preflight(id, lease); },
});
const deliver = (sender: ThreadsSendPort, extra: { store?: ThreadsDispatchStore; creds?: ThreadsCredentialPort } = {}) =>
  runThreadsReservationDelivery({ enabled: true, store: extra.store ?? workerStore, credentials: extra.creds ?? credentials, sender, worker: "g5-real-w1", leaseSeconds: 60, limit: 50 });

// ---- tests -----------------------------------------------------------------------------------------------------------------
Deno.test("R0 the world: R1 / W1 / W2 are G5's real candidates (no double), 007 calls the real W1, #370's revoke is in, the G5 exposure check is clean", async () => {
  const [[r1src, w1src, w2src, doubles, w1call, trig, exposure, covered]] = await owner<[string, string, string, string, string, string, string, string]>(`select
     (select p.prosrc from pg_proc p where p.oid = 'public.common_account_authorization_verdict(text,text,text)'::regprocedure),
     (select p.prosrc from pg_proc p where p.oid = 'private.account_lifecycle_worker_brand_verdict(text,text,bigint,bigint)'::regprocedure),
     (select p.prosrc from pg_proc p where p.oid = 'public.common_account_worker_brand_verdict(text,text,bigint,bigint)'::regprocedure),
     (select count(*)::text from pg_namespace where nspname = 't_g5'),
     (select p.prosrc from pg_proc p where p.oid = 'postona_threads_resv.g5_bound_state(postona_threads_resv.reservations)'::regprocedure),
     has_table_privilege('authenticated', 'public.brand_memberships', 'TRIGGER')::text,
     coalesce(private.account_lifecycle_owner_epoch_exposure(), 'NONE'),
     private.account_lifecycle_generation_covered()::text`);
  assert.ok(!/TEST_DOUBLE/u.test(r1src + w1src + w2src), "no test double");
  assert.ok(r1src.includes("auth.sessions") && w1src.includes("account_lifecycle_generation_covered") && w2src.includes("account_lifecycle_worker_brand_verdict"));
  assert.ok(w1call.includes("private.account_lifecycle_worker_brand_verdict"), "007 asks the real W1");
  assert.deepEqual([doubles, trig, exposure, covered], ["0", "false", "NONE", "true"]);
});

Deno.test("R1 one reservation: the REAL R1 allow's two numbers are stored; W1 at claim, W1 before send and in beforePublish, W2 with the same numbers -> exactly one simulated publish; nothing is rewritten", async () => {
  const s = await session(61);
  const verdict = await r1(61, s);
  assert.equal(verdict.decision, "allow");
  const [, epoch, lifecycle] = String(verdict.owner_epoch).match(/^g5oe:([1-9][0-9]*):([1-9][0-9]*)$/u)!;
  const id = await reserve(61, "R1 本物の G5");
  const [be, bl, brand] = await bound(id);
  assert.deepEqual([be, bl], [epoch, lifecycle], "the stored pair is R1's");
  assert.deepEqual(await current(61), [epoch, lifecycle]);
  assert.equal(await w2(brand, be, bl), "active");
  await due(id);
  const g = fakeGraph();
  const r = await deliver(g4Sender(g), { store: traced(g) });
  assert.deepEqual(g.events, ["container", "status", "hook", "publish", "readback"]);
  assert.deepEqual([r.claimed, r.sends, r.prepublishRechecks, r.published, r.uncertain], [1, 1, 1, 1, 0]);
  assert.deepEqual(await row(id), ["published", "PUBLISHED", false, "simulated"]);
  assert.deepEqual((await bound(id)).slice(0, 2), [be, bl], "never rewritten");
  assert.deepEqual(await current(61), [epoch, lifecycle], "the flow moved no G5 counter");
});

Deno.test("R2 G5 changes during G4's container wait (REAL W1 in beforePublish) -> 0 publish requests; W2 with the stored numbers answers the same code", async () => {
  const cases: [number, string, () => Promise<unknown>, string][] = [
    [62, "service end + restart", () => restartService(62), "SERVICE_GENERATION_CHANGED"],
    [63, "end + restart inside ONE transaction", () => restartServiceInOneTransaction(63), "SERVICE_GENERATION_CHANGED"],
    [64, "owner A -> B -> A", () => ownerABA(64, 99), "OWNER_EPOCH_CHANGED"],
    [65, "account deletion starts", () => owner("update public.common_accounts set status = 'deleting' where user_id = $1::uuid", [P(65).user]), "ACCOUNT_DELETION_IN_PROGRESS"],
    [66, "x_autopost ended", () => endService(66), "SERVICE_NOT_ACTIVE"],
  ];
  for (const [n, label, change, code] of cases) {
    const id = await reserve(n, `R2 ${label}`);
    const [be, bl, brand] = await bound(id);
    await due(id);
    const g = fakeGraph({ duringWait: change });
    const r = await deliver(g4Sender(g), { store: traced(g) });
    assert.deepEqual([g.events, g.publishes()], [["container", "status", "hook"], 0], label);
    assert.deepEqual([r.prepublishRefused, r.uncertain, r.published], [1, 0, 0], label);
    assert.deepEqual((await row(id)).slice(0, 2), ["failed", code], label);
    assert.equal(await w2(brand, be, bl), code, `${label}: W2 agrees`);
    assert.deepEqual((await bound(id)).slice(0, 2), [be, bl], `${label}: stored pair unchanged`);
  }
});

Deno.test("R3 the REAL W1 at claim: a stale generation, a missing pair and an unknown owner are failed at claim (no Graph request)", async () => {
  const stale = await reserve(67, "R3 stale");
  await restartService(67);
  const missing = await reserve(68, "R3 missing pair");
  await owner("update postona_threads_resv.reservations set bound_owner_epoch = null, bound_lifecycle_version = null where id = $1::uuid", [missing]);
  const unknownOwner = await reserve(69, "R3 two owners");
  await owner("insert into public.brand_memberships (brand_id, user_id, role) values ($1, $2::uuid, 'owner')", [P(69).brand, P(98).user]);
  for (const id of [stale, missing, unknownOwner]) await due(id);
  const g = fakeGraph();
  const r = await deliver(g4Sender(g));
  assert.deepEqual([r.claimed, g.events.length], [0, 0]);
  assert.deepEqual((await row(stale)).slice(0, 2), ["failed", "SERVICE_GENERATION_CHANGED"]);
  assert.deepEqual((await row(missing)).slice(0, 2), ["failed", "EXPECTED_OWNER_EPOCH_REQUIRED"]);
  assert.deepEqual((await row(unknownOwner)).slice(0, 2), ["failed", "WORKSPACE_OWNER_UNKNOWN"]);
  await owner("delete from public.brand_memberships where brand_id = $1 and user_id = $2::uuid", [P(69).brand, P(98).user]);
});

Deno.test("R4 the REAL R1 refuses at create -> no row: revoked / expired session, entitlement ended, another workspace's account, two owners", async () => {
  const revoked = await session(70);
  await owner("delete from auth.sessions where id = $1::uuid", [revoked]);
  const expired = await session(70, new Date(Date.now() - 60_000).toISOString());
  for (const [label, s] of [["revoked session", revoked], ["expired session", expired]] as const) {
    assert.notEqual((await r1(70, s)).decision, "allow", label);
    const r = await create(await tokenOf(70, s), 70, `R4 ${label}`);
    assert.notEqual(r.status, 200, label);
  }
  assert.equal(await rowsOf(70), 0);
  await endService(71);
  assert.notEqual((await create(await tokenOf(71), 71, "R4 ended")).status, 200);
  assert.equal(await rowsOf(71), 0);
  assert.notEqual((await create(await tokenOf(72), 72, "R4 cross", crypto.randomUUID(), inMinutes(10), P(73).threads)).status, 200);
  assert.equal(await rowsOf(73), 0);
  await owner("insert into public.brand_memberships (brand_id, user_id, role) values ($1, $2::uuid, 'owner')", [P(74).brand, P(97).user]);
  assert.equal((await r1(74, await session(74))).decision, "unknown");
  assert.notEqual((await create(await tokenOf(74), 74, "R4 two owners")).status, 200);
  assert.equal(await rowsOf(74), 0);
  await owner("delete from public.brand_memberships where brand_id = $1 and user_id = $2::uuid", [P(74).brand, P(97).user]);
});

Deno.test("R5 missing / wrong JWT straight at 007 (API role): no claims, role anon, anonymous user -> refused, no row", async () => {
  const s = await session(75);
  const attempts: [string, string | null][] = [
    ["no claims", null],
    ["role anon", claims(75, s, { role: "anon" })],
    ["anonymous", claims(75, s, { is_anonymous: true })],
  ];
  for (const [label, c] of attempts) {
    const setup = ["set local role postona_resv_api"];
    if (c) setup.push(`select set_config('request.jwt.claims', '${c}', true)`);
    let code = "ran";
    try {
      await sql(API_URL, "select * from postona_threads_resv.create_reservation($1, gen_random_uuid(), 'R5', $2, now() + interval '10 minutes')", [P(75).threads, sha("R5")], setup);
    } catch (e) {
      code = (e as { fields?: { message?: string } }).fields?.message ?? "error";
    }
    assert.match(code, /^POSTONA_/u, label);
  }
  assert.equal(await rowsOf(75), 0);
});

Deno.test("R6 roles: the worker cannot ask R1 / W1 / W2; the API role cannot ask W1 / W2; service_role cannot ask W1 or R1 (42501)", async () => {
  const deny = async (url: string, role: string, text: string) => {
    try {
      await sql(url, text, [], [`set local role ${role}`]);
      return "ran";
    } catch (e) {
      return (e as { fields?: { code?: string } }).fields?.code ?? "error";
    }
  };
  const w1 = `select private.account_lifecycle_worker_brand_verdict('${P(76).brand}', 'x_autopost', 1, 1)`;
  const w2q = `select public.common_account_worker_brand_verdict('${P(76).brand}', 'x_autopost', 1, 1)`;
  const r1q = `select public.common_account_authorization_verdict('postona', 'threads_publish', '${P(76).brand}')`;
  for (const q of [r1q, w1, w2q]) assert.equal(await deny(WORKER_URL, "postona_resv_worker", q), "42501", `worker: ${q}`);
  for (const q of [w1, w2q]) assert.equal(await deny(API_URL, "postona_resv_api", q), "42501", `api: ${q}`);
  for (const q of [w1, r1q]) assert.equal(await deny(OWNER_URL, "service_role", q), "42501", `service_role: ${q}`);
});

Deno.test("R7 a G5 change after beforePublish said yes (during the publish request) -> published once, after_freeze = true (REAL W1 at record)", async () => {
  const id = await reserve(77, "R7 late freeze");
  await due(id);
  const g = fakeGraph({ duringPublish: () => restartService(77) });
  const r = await deliver(g4Sender(g));
  assert.deepEqual([g.publishes(), r.published], [1, 1]);
  assert.deepEqual((await row(id)).slice(0, 3), ["published", "PUBLISHED", true]);
});

Deno.test("R8 the same id again AFTER a restart returns the SAME row and keeps the OLD pair (never re-bound to the current numbers) -> refused at claim", async () => {
  const t = await tokenOf(78);
  const id = crypto.randomUUID(), at = inMinutes(10);
  const first = await create(t, 78, "R8 同じ ID", id, at);
  const before = await bound(String(first.body.reservationId));
  await restartService(78);
  const again = await create(t, 78, "R8 同じ ID", id, at);
  assert.deepEqual([again.status, again.body.created, again.body.reservationId], [200, false, first.body.reservationId]);
  assert.deepEqual(await bound(String(first.body.reservationId)), before, "the stored pair is not overwritten");
  assert.notDeepEqual((await current(78))[1], before[1], "the current generation moved");
  await due(String(first.body.reservationId));
  const g = fakeGraph();
  await deliver(g4Sender(g));
  assert.deepEqual([g.events.length, ...(await row(String(first.body.reservationId))).slice(0, 2)], [0, "failed", "SERVICE_GENERATION_CHANGED"]);
});

Deno.test("R9 a create whose transaction rolls back leaves no row and moves no G5 counter; the lease lost during the wait sends nothing", async () => {
  const before = await current(79);
  failBeforeCommit = true;
  try {
    await create(await tokenOf(79), 79, "R9 rollback").catch(() => undefined);
  } finally {
    failBeforeCommit = false;
  }
  assert.equal(await rowsOf(79), 0);
  assert.deepEqual(await current(79), before);
  const id = await reserve(80, "R9 lease lost");
  await due(id);
  const g = fakeGraph({ duringWait: () => owner("update postona_threads_resv.reservations set lease_token = gen_random_uuid() where id = $1::uuid", [id]) });
  const r = await deliver(g4Sender(g));
  assert.deepEqual([g.publishes(), r.prepublishRefused, r.skipped], [0, 1, 1]);
  await owner("update postona_threads_resv.reservations set lease_expires_at = now() - interval '1 second' where id = $1::uuid", [id]);
  const g2 = fakeGraph();
  await deliver(g4Sender(g2));
  assert.deepEqual([g2.events.length, ...(await row(id)).slice(0, 2)], [0, "uncertain", "LEASE_EXPIRED"]);
});

Deno.test("R10 an unknown publish is uncertain and never re-sent; G4's shipped credential gates still stop real-shaped ids (U1 / U2, regression only)", async () => {
  const id = await reserve(81, "R10 unknown");
  await due(id);
  const g = fakeGraph({ publish: "unknown" });
  const r = await deliver(g4Sender(g));
  assert.deepEqual([g.publishes(), r.uncertain, (await row(id))[0]], [1, 1, "uncertain"]);
  const g2 = fakeGraph();
  assert.deepEqual([(await deliver(g4Sender(g2))).claimed, g2.events.length], [0, 0]);

  const id2 = await reserve(82, "R10 G4 gates");
  await due(id2);
  const statement = (a: string) => oneStatement(a);
  const common = G4.createGatedThreadsCredentialPort(true, "x_autopost", statement);
  assert.equal(common.available, G4.THREADS_POSTING_SERVICE_KEY === "x_autopost", "U1: PR #364 refuses x_autopost, G4-10 accepts it");
  const open = G4.createGatedThreadsCredentialPort(true, G4.THREADS_POSTING_SERVICE_KEY ?? "g3_synthetic_test_key", statement);
  const g3 = fakeGraph();
  const r3 = await deliver(g4Sender(g3), { creds: open });
  assert.deepEqual([r3.claimed, g3.events.length, (await row(id2)).slice(0, 2)], [1, 0, ["failed", "THREADS_CREDENTIALS_UNAVAILABLE"]], "U2: a real text account id gets no credential");
});

Deno.test("R11 nothing left behind: no due planned row; the G5 exposure check is still clean", async () => {
  assert.equal(Number((await owner<[bigint]>("select count(*) from postona_threads_resv.reservations where status = 'planned' and scheduled_at <= now()"))[0][0]), 0);
  assert.equal((await owner<[string]>("select coalesce(private.account_lifecycle_owner_epoch_exposure(), 'NONE')"))[0][0], "NONE");
});
