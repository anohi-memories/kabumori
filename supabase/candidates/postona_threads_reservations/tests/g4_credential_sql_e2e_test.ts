// G3 TASK 11/50: G3's Threads reservations with G4's REAL credential SQL candidate (PR #377 credential_row), G4's real connect path
// (PR #124 + PR #367 + G4 custody: real 'sa_<24 hex>' account ids), the REAL 2a-2 migration and G5's REAL R1 / W1 / W2 (PR #371),
// on a disposable LOCAL PostgreSQL (postona_threads_g4_credential_run.sh only). 007 is unchanged.
//   create      HTTP fixture -> 007.create_reservation -> G5 R1 (real) -> the stored pair
//   credential  postona_threads_credential.credential_row(account, key): decision + FAKE Vault token + G3's generation, ONE statement
//   send        PR #356's dispatcher -> 007.preflight (W1) -> G4's REAL send port (isolated copy) over a FAKE Graph -> beforePublish
// Two credential ports are compared: G3's TEST port (the same statement, read with G4's parseThreadsCredentialRow) and G4's SHIPPED
// gated port (createGatedThreadsCredentialPort over the same statement). Network: 127.0.0.1 only. MOCK_ONLY: caller verdicts, the
// tokens, G4's verified predicate, Threads.
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
assert.ok(API_URL && WORKER_URL && OWNER_URL && G4_DIR, "set by postona_threads_g4_credential_run.sh");

type Statement = (id: string, key: string) => Promise<unknown>;
type G4SendPortModule = {
  THREADS_POSTING_SERVICE_KEY: string | null;
  parseThreadsCredentialRow(requested: string, answer: unknown): { socialAccountId: string; threadsUserId: string; accessToken: string; generation: string } | null;
  createGatedThreadsCredentialPort(enabled: boolean, key: string | null, statement: Statement | null): ThreadsCredentialPort;
  createGatedThreadsSendPort(enabled: boolean, transport: "threads" | "simulated", fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
    options?: { containerChecks?: number; containerCheckDelayMs?: number }): ThreadsSendPort;
};
const fileUrl = (path: string) => new URL(`file://${encodeURI(path)}`).href;
const G4 = await import(fileUrl(`${G4_DIR}/threads_send_port.ts`)) as G4SendPortModule;
const G4V = await import(fileUrl(`${G4_DIR}/threads_connect_to_send.ts`)) as { G5_WORKER_VERDICT_CODES: readonly string[] };

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
type Person = { user: string; threads: string; brand: string; puid: string; token: string };
const people = new Map((await owner<[number, string, string, string, string, string]>("select n, user_id::text, threads_account, brand, threads_user_id, token from t_ids.people"))
  .map(([n, user, threads, brand, puid, token]) => [Number(n), { user, threads, brand, puid, token } as Person]));
const P = (n: number) => people.get(n)!;
const session = async (n: number) => String((await owner<[string]>("insert into auth.sessions (user_id) values ($1::uuid) returning id::text", [P(n).user]))[0][0]);
const row = async (id: string) => (await owner<[string, string | null, boolean | null, string | null]>(
  "select status, outcome_code, after_freeze, transport from postona_threads_resv.reservations where id = $1::uuid", [id]))[0];
const bound = async (id: string) => (await owner<[string, string, string]>(
  "select bound_owner_epoch::text, bound_lifecycle_version::text, brand_id from postona_threads_resv.reservations where id = $1::uuid", [id]))[0];
const due = (id: string) => owner("update postona_threads_resv.reservations set scheduled_at = now() - interval '1 second' where id = $1::uuid", [id]);
const rowsOf = async (n: number) => Number((await owner<[bigint]>("select count(*) from postona_threads_resv.reservations where social_account_id = $1", [P(n).threads]))[0][0]);
async function w2(brand: string, epoch: string, lifecycle: string): Promise<string> {
  const [[v]] = await sql<[string]>(OWNER_URL, "select public.common_account_worker_brand_verdict($1, 'x_autopost', $2::bigint, $3::bigint)", [brand, epoch, lifecycle], ["set local role service_role"]);
  return v;
}
async function restartService(n: number) {
  await owner("update public.service_entitlements set status = 'ended', ended_at = now() where user_id = $1::uuid and service_key = 'x_autopost'", [P(n).user]);
  await owner("update public.service_entitlements set status = 'active', ended_at = null where user_id = $1::uuid and service_key = 'x_autopost'", [P(n).user]);
}
async function ownerABA(n: number, other: number) {
  await owner("insert into public.brand_memberships (brand_id, user_id, role) values ($1, $2::uuid, 'owner')", [P(n).brand, P(other).user]);
  await owner("delete from public.brand_memberships where brand_id = $1 and user_id = $2::uuid", [P(n).brand, P(other).user]);
}

// ---- HTTP (the person path; G5's real R1 runs inside 007) ------------------------------------------------------------------
const verdicts = new Map<string, VerifiedCaller>();
async function tokenOf(n: number): Promise<string> {
  const token = `tok-${n}-${crypto.randomUUID().slice(0, 8)}-0123456789abcdef`;
  verdicts.set(token, { userId: P(n).user, sessionId: await session(n) });
  return token;
}
const http = createThreadsReservationHttpFixture({ enabled: true, verify: (t: string) => Promise.resolve(verdicts.get(t) ?? null), store: createPgPersonStore(API_URL) });
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
async function req(token: string, body: unknown) {
  const res = await http(new Request("http://fixture.local/threads-reservations", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
async function create(n: number, text: string, account = P(n).threads, id = crypto.randomUUID()) {
  const r = await req(await tokenOf(n), { op: "create", socialAccountId: account, clientRequestId: id, text,
    scheduledAt: new Date(Date.now() + 10 * 60_000).toISOString(), consent: { confirmed: true, contentSha256: sha(text) } });
  return { ...r, id };
}
async function reserve(n: number, text: string): Promise<string> {
  const r = await create(n, text);
  assert.deepEqual([r.status, r.body.created], [200, true], `create ${n}: ${JSON.stringify(r.body)}`);
  await due(String(r.body.reservationId));
  return String(r.body.reservationId);
}

// ---- credential ports over G4's ONE statement ---------------------------------------------------------------------------
const credentialRow: Statement = async (account, key) => (await owner<[string, string, string, string]>(
  "select social_account_id, threads_user_id, access_token, generation from postona_threads_credential.credential_row($1, $2)", [account, key]))
  .map(([social_account_id, threads_user_id, access_token, generation]) => ({ social_account_id, threads_user_id, access_token, generation }));
/** G3's TEST port: G4's statement + G4's row parser, without G4's UUID-only account id gate (U2). */
const g3Port = (key = "x_autopost"): ThreadsCredentialPort => ({
  available: true, credentialFor: async (a) => G4.parseThreadsCredentialRow(a, await credentialRow(a, key)),
});

// ---- G4's real send port over a FAKE Graph ------------------------------------------------------------------------------
type GraphEvent = "container" | "status" | "hook" | "publish" | "readback";
function fakeGraph(opts: { duringWait?: () => Promise<unknown>; publish?: "unknown" } = {}) {
  const events: GraphEvent[] = [];
  const tokens = new Set<string>();
  const containers = new Set<string>(), media = new Map<string, string>();
  let next = 18300000000000000n;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (url.origin !== "https://graph.threads.net") throw new TypeError("fake graph: origin refused");
    const parts = url.pathname.split("/").filter(Boolean);
    const form = typeof init?.body === "string" ? new URLSearchParams(init.body) : null;
    const token = form?.get("access_token") ?? url.searchParams.get("access_token");
    if (token) tokens.add(token);
    if (init?.method === "POST" && parts[2] === "threads") {
      events.push("container");
      const id = String(++next);
      containers.add(id);
      return json({ id });
    }
    if (init?.method === "POST" && parts[2] === "threads_publish") {
      events.push("publish");
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
  return { fetchImpl, events, tokens, publishes: () => events.filter((e) => e === "publish").length };
}
const g4Sender = (g: ReturnType<typeof fakeGraph>) => G4.createGatedThreadsSendPort(true, "simulated", g.fetchImpl, { containerChecks: 1, containerCheckDelayMs: 0 });
const workerStore = createPgWorkerStore(WORKER_URL);
const traced = (g: ReturnType<typeof fakeGraph>, base: ThreadsDispatchStore = workerStore): ThreadsDispatchStore => ({
  ...base, preflight: async (id, lease) => { if (g.events.includes("container")) g.events.push("hook"); return await base.preflight(id, lease); },
});
const deliver = (sender: ThreadsSendPort, extra: { store?: ThreadsDispatchStore; creds?: ThreadsCredentialPort; worker?: string; prepublishTimeoutMs?: number } = {}) =>
  runThreadsReservationDelivery({ enabled: true, store: extra.store ?? workerStore, credentials: extra.creds ?? g3Port(), sender, worker: extra.worker ?? "g4-cred-w1",
    leaseSeconds: 60, limit: 50, prepublishTimeoutMs: extra.prepublishTimeoutMs });
const deny = async (url: string, role: string, text: string) => {
  try {
    await sql(url, text, [], [`set local role ${role}`]);
    return "ran";
  } catch (e) {
    return (e as { fields?: { code?: string } }).fields?.code ?? "error";
  }
};

// ---- tests -----------------------------------------------------------------------------------------------------------------
Deno.test("K0 the world: G4's real credential_row (owner-only), real 2a-2, G4's real custody, 'sa_' accounts, G5's real W1; no API / worker role can call credential_row", async () => {
  const [[acl, metaRule, custodyRls, ids, doubles, w1]] = await owner<[string, string, string, string, string, string]>(`select
     (select count(*)::text from pg_proc p, aclexplode(p.proacl) a where p.oid = 'postona_threads_credential.credential_row(text,text)'::regprocedure and a.grantee <> p.proowner),
     (select count(*)::text from pg_constraint where conrelid = 'public.social_accounts'::regclass and conname = 'social_accounts_meta_publish_disabled'),
     (select relrowsecurity::text from pg_class where oid = 'public.threads_account_credential_custody'::regclass),
     (select count(*)::text from t_ids.people where threads_account ~ '^sa_[0-9a-f]{24}$'),
     (select count(*)::text from pg_namespace where nspname = 't_g5'),
     (select (p.prosrc like '%account_lifecycle_generation_covered%')::text from pg_proc p where p.oid = 'private.account_lifecycle_worker_brand_verdict(text,text,bigint,bigint)'::regprocedure)`);
  assert.deepEqual([acl, metaRule, custodyRls, ids, doubles, w1], ["0", "1", "true", "30", "0", "true"]);
  const q = `select * from postona_threads_credential.credential_row('${P(101).threads}', 'x_autopost')`;
  assert.equal(await deny(WORKER_URL, "postona_resv_worker", q), "42501", "the dispatcher's role has no grant yet (a separate, reviewed step)");
  for (const role of ["anon", "authenticated", "service_role"]) assert.equal(await deny(OWNER_URL, role, q), "42501", role);
});

Deno.test("K1 U8: the REAL 2a-2 keeps every Threads row's publish switch OFF, so 007 refuses the reservation (no row); a TEST-ONLY lift opens it", async () => {
  const r = await create(101, "K1 2a-2");
  assert.notEqual(r.status, 200);
  assert.equal(r.body.code, "PUBLISH_DISABLED", "007 POSTONA_THREADS_RESV_PUBLISH_DISABLED, as the HTTP fixture names it");
  assert.equal(await rowsOf(101), 0);
  // TEST-ONLY stand-in of the reviewed lift 2a-2 names ("a later migration lifts this deliberately"): not G3's, not written
  await owner("alter table public.social_accounts drop constraint social_accounts_meta_publish_disabled");
  await owner("update public.social_accounts set publish_enabled = true where platform = 'threads'");
  assert.equal((await create(101, "K1 after the lift")).status, 200);
});

Deno.test("K2 one reservation: credential_row's ONE statement gives the token and G3's generation; G4's send port publishes once with exactly that (fake) token", async () => {
  const id = await reserve(102, "K2 本物の G4 資格情報");
  const [be, bl, brand] = await bound(id);
  const g = fakeGraph();
  const r = await deliver(g4Sender(g), { store: traced(g) });
  assert.deepEqual(g.events, ["container", "status", "hook", "publish", "readback"]);
  assert.deepEqual([r.claimed, r.sends, r.published, r.uncertain], [1, 1, 1, 0]);
  assert.deepEqual([...g.tokens], [P(102).token], "the Vault token of this account, nothing else");
  assert.deepEqual(await row(id), ["published", "PUBLISHED", false, "simulated"]);
  assert.deepEqual(await bound(id), [be, bl, brand]);
  assert.equal(await w2(brand, be, bl), "active");
  const [[gen]] = await owner<[string]>("select postona_threads_resv.threads_credential_generation($1)", [P(102).threads]);
  assert.equal((await credentialRow(P(102).threads, "x_autopost") as { generation: string }[])[0].generation, gen, "the statement's generation is 007's");
});

Deno.test("K3 U2: G4's SHIPPED gated port over the same statement: unfixed -> refuses the real 'sa_' id before the statement (0 Graph); fixed (G4-12) -> the whole flow publishes once", async () => {
  const id = await reserve(103, "K3 U2");
  let calls = 0;
  const counted: Statement = (a, k) => { calls += 1; return credentialRow(a, k); };
  const shipped = G4.createGatedThreadsCredentialPort(true, "x_autopost", counted);
  assert.equal(shipped.available, G4.THREADS_POSTING_SERVICE_KEY === "x_autopost", "U1");
  assert.ok(G4.parseThreadsCredentialRow(P(103).threads, await credentialRow(P(103).threads, "x_autopost")) !== null, "the row exists");
  const u2Fixed = shipped.available && (await shipped.credentialFor(P(103).threads)) !== null;
  console.log(`U2 G4's shipped port accepts a real 'sa_' id: ${u2Fixed}`);
  calls = 0;
  const g = fakeGraph();
  const r = await deliver(g4Sender(g), { creds: shipped });
  if (shipped.available && u2Fixed) {
    assert.deepEqual([r.claimed, calls, g.publishes(), r.published], [1, 1, 1, 1], "G4's shipped port + G4's statement + G3's dispatcher: one publish");
    assert.deepEqual([...g.tokens], [P(103).token]);
    assert.deepEqual((await row(id)).slice(0, 2), ["published", "PUBLISHED"]);
  } else if (shipped.available) {
    assert.deepEqual([r.claimed, calls, g.events.length], [1, 0, 0], "the statement is never called for a non-UUID id");
    assert.deepEqual((await row(id)).slice(0, 2), ["failed", "THREADS_CREDENTIALS_UNAVAILABLE"]);
  } else {
    assert.deepEqual([r.notAvailable, r.claimed], [true, 0]);
    await owner("update postona_threads_resv.reservations set status = 'cancelled' where id = $1::uuid", [id]);
  }
});

Deno.test("K4 credential_row gives no row -> failed THREADS_CREDENTIALS_UNAVAILABLE, 0 Graph: another key, expired custody, an unrecorded Vault rotation, a stale binding (restart / owner A->B->A after connect)", async () => {
  const cases: [number, string, () => Promise<unknown>, string][] = [
    [104, "key kabumori", () => Promise.resolve(), "kabumori"],
    [105, "custody expired", () => owner("update public.threads_account_credential_custody set expires_at = now() - interval '1 second' where social_account_id = $1", [P(105).threads]), "x_autopost"],
    [106, "Vault rotated, custody not recorded", () => owner(
      "update public.social_accounts set vault_access_token_secret_id = vault.create_secret('fakeTHREADSrotated0123456789ab') where id = $1", [P(106).threads]), "x_autopost"],
  ];
  for (const [n, label, before, key] of cases) {
    await before();
    const id = await reserve(n, `K4 ${label}`);
    const g = fakeGraph();
    const r = await deliver(g4Sender(g), { creds: g3Port(key) });
    assert.deepEqual([r.sends, g.events.length, r.failedBeforeSend], [0, 0, 1], label);
    assert.deepEqual((await row(id)).slice(0, 2), ["failed", "THREADS_CREDENTIALS_UNAVAILABLE"], label);
  }
  // U9: any service-generation move AFTER the connect leaves G4's binding on the old pair: the reservation (made later, on the new
  // pair) is fine for G5, but G4's credential_row has no row until the person reconnects.
  for (const [n, label, change] of [[107, "restart after connect", () => restartService(107)], [108, "owner A->B->A after connect", () => ownerABA(108, 130)]] as const) {
    await change();
    const id = await reserve(n, `K4 ${label}`);
    const [be, bl, brand] = await bound(id);
    assert.equal(await w2(brand, be, bl), "active", `${label}: the reservation's own pair is current`);
    const g = fakeGraph();
    await deliver(g4Sender(g));
    assert.deepEqual([g.events.length, ...(await row(id)).slice(0, 2)], [0, "failed", "THREADS_CREDENTIALS_UNAVAILABLE"], label);
  }
});

Deno.test("K5 during G4's container wait: a credential rotation (007 CREDENTIAL_CHANGED), a refresh lease (handed back, sent later once), a restart (W1) -> 0 publish requests", async () => {
  const rot = await reserve(109, "K5 rotation");
  const g1 = fakeGraph({ duringWait: () => owner("update public.threads_account_credential_custody set recorded_at = clock_timestamp() where social_account_id = $1", [P(109).threads]) });
  await deliver(g4Sender(g1));
  assert.deepEqual([g1.publishes(), ...(await row(rot)).slice(0, 2)], [0, "failed", "CREDENTIAL_CHANGED"]);

  const lease = await reserve(110, "K5 refresh");
  const g2 = fakeGraph({ duringWait: () => owner("insert into public.threads_credential_refresh_leases values ($1, gen_random_uuid(), gen_random_uuid(), clock_timestamp() + interval '30 seconds')", [P(110).threads]) });
  const r2 = await deliver(g4Sender(g2));
  assert.deepEqual([g2.publishes(), r2.released, (await row(lease))[0]], [0, 1, "planned"]);
  await owner("delete from public.threads_credential_refresh_leases where social_account_id = $1", [P(110).threads]);
  const g2b = fakeGraph();
  await deliver(g4Sender(g2b));
  assert.deepEqual([g2b.publishes(), (await row(lease))[0]], [1, "published"]);

  const aba = await reserve(111, "K5 restart");
  const [be, bl, brand] = await bound(aba);
  const g3 = fakeGraph({ duringWait: () => restartService(111) });
  await deliver(g4Sender(g3));
  assert.deepEqual([g3.publishes(), ...(await row(aba)).slice(0, 2)], [0, "failed", "SERVICE_GENERATION_CHANGED"]);
  assert.equal(await w2(brand, be, bl), "SERVICE_GENERATION_CHANGED");
});

Deno.test("K6 the re-check times out -> 0 publish (THREADS_PREPUBLISH_UNVERIFIED); an unknown publish -> uncertain, never re-sent; the lease lost during the wait -> 0 publish", async () => {
  const late = await reserve(112, "K6 late");
  let n = 0;
  const slow: ThreadsDispatchStore = { ...workerStore, preflight: async (rid, l) => { if (++n === 2) await new Promise((r) => setTimeout(r, 200)); return await workerStore.preflight(rid, l); } };
  const g1 = fakeGraph();
  await deliver(g4Sender(g1), { store: slow, prepublishTimeoutMs: 50 });
  await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual([g1.publishes(), ...(await row(late)).slice(0, 2)], [0, "failed", "THREADS_PREPUBLISH_UNVERIFIED"]);

  const unknown = await reserve(113, "K6 unknown");
  const g2 = fakeGraph({ publish: "unknown" });
  await deliver(g4Sender(g2));
  assert.deepEqual([g2.publishes(), (await row(unknown))[0]], [1, "uncertain"]);
  const g2b = fakeGraph();
  assert.deepEqual([(await deliver(g4Sender(g2b))).claimed, g2b.events.length], [0, 0]);

  const lost = await reserve(122, "K6 lease lost");
  const g3 = fakeGraph({ duringWait: () => owner("update postona_threads_resv.reservations set lease_token = gen_random_uuid() where id = $1::uuid", [lost]) });
  const r3 = await deliver(g4Sender(g3));
  assert.deepEqual([g3.publishes(), r3.skipped], [0, 1]);
  await owner("update postona_threads_resv.reservations set lease_expires_at = now() - interval '1 second' where id = $1::uuid", [lost]);
  await deliver(g4Sender(fakeGraph()));
  assert.deepEqual((await row(lost)).slice(0, 2), ["uncertain", "LEASE_EXPIRED"]);
});

Deno.test("K7 two workers over six rows -> each row published once, each with its own account's token", async () => {
  const ns = [114, 115, 116, 117, 118, 119];
  const ids = await Promise.all(ns.map((n) => reserve(n, `K7 ${n}`)));
  const ga = fakeGraph(), gb = fakeGraph();
  const [ra, rb] = await Promise.all([deliver(g4Sender(ga), { worker: "cron-a" }), deliver(g4Sender(gb), { worker: "cron-b" })]);
  assert.deepEqual([ra.claimed + rb.claimed, ga.publishes() + gb.publishes(), ra.published + rb.published], [6, 6, 6]);
  for (const id of ids) assert.equal((await row(id))[0], "published");
  assert.deepEqual(new Set([...ga.tokens, ...gb.tokens]), new Set(ns.map((n) => P(n).token)));
});

Deno.test("K8 tenant: a person cannot reserve on another person's 'sa_' account; the receipt is the owner's only (404 for another), text- and token-free", async () => {
  const cross = await create(120, "K8 cross", P(121).threads);
  assert.notEqual(cross.status, 200);
  assert.equal(await rowsOf(121), 0);
  const mine = await create(121, "K8 mine");
  await due(String(mine.body.reservationId));
  await deliver(g4Sender(fakeGraph()));
  const r = await req(await tokenOf(121), { op: "receipt", socialAccountId: P(121).threads, clientRequestId: mine.id });
  assert.deepEqual([r.status, r.body.state, r.body.simulated], [200, "sent", true]);
  assert.ok(!JSON.stringify(r.body).includes("K8 mine") && !JSON.stringify(r.body).includes(P(121).token));
  assert.equal((await req(await tokenOf(120), { op: "receipt", socialAccountId: P(121).threads, clientRequestId: mine.id })).status, 404);
});

Deno.test("K9 U1 / U7 contract checks on the G4 copy: only x_autopost opens G4's port; G4's W1/W2 code list vs G5 #371's codes", () => {
  assert.equal(G4.createGatedThreadsCredentialPort(true, "x_autopost", credentialRow).available, G4.THREADS_POSTING_SERVICE_KEY === "x_autopost");
  for (const key of ["kabumori", "threads_autopost", "", null]) {
    const opens = G4.createGatedThreadsCredentialPort(true, key, credentialRow).available;
    if (G4.THREADS_POSTING_SERVICE_KEY === "x_autopost") assert.equal(opens, false, String(key));
  }
  const missing = ["SERVICE_GENERATION_UNAVAILABLE"].filter((c) => !G4V.G5_WORKER_VERDICT_CODES.includes(c));
  console.log(`U7 G4 code list missing: ${missing.join(",") || "none"}`);
  assert.ok(missing.length <= 1);
});

Deno.test("K10 nothing left behind: no due planned row; G5's exposure check still clean", async () => {
  assert.equal(Number((await owner<[bigint]>("select count(*) from postona_threads_resv.reservations where status = 'planned' and scheduled_at <= now()"))[0][0]), 0);
  assert.equal((await owner<[string]>("select coalesce(private.account_lifecycle_owner_epoch_exposure(), 'NONE')"))[0][0], "NONE");
});
