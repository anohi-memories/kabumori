// G3-49 (TEST ONLY, fake data): the generation-bound X reservation worker on G4's REAL X verdict, in the PERSONAL world G4's own runner
// builds (g4_verdict_run.sh, phase VW, after VB / VR on the same world; G3 001-006 + 008 + 010 + 012 + 014 + 015, 007 + 009 + 011 + 013).
//   the REAL x_bound_delivery.ts -> the REAL postgres_delivery_store.ts (bound store) + driver, as a login role that is a member of
//   postona_resv_worker only -> 004's claim_due / 014's pin / 015's pre_publish_check_bound / finish; the REAL x_publisher.ts with a fake
//   fetch (no network: every request is answered here and recorded).
// MOCK_ONLY (labelled): G4's TS token read does not exist yet. The stand-in answers what the IF asks of it -- one read of G4's REAL X
// verdict (as the lifecycle owner) and a FAKE token, null unless `verified` -- through G3's xGenerationSourceFromG4Raw, which derives
// G3's generation in TS. SYNTHETIC (labelled, as VB): main's refresh-core state. Connect / disconnect go through G4's REAL X SQL (g48.*
// helpers left by VB). Nothing here proves the real G4 token custody, Vault, GoTrue, X or the managed project.
import assert from "node:assert/strict";
import { createDriverConnect } from "../../../functions/_shared/postona_reservations/postgres_driver.ts";
import { createPostgresBoundDeliveryStore } from "../../../functions/_shared/postona_reservations/postgres_delivery_store.ts";
import { runBoundXReservationDelivery } from "../../../functions/_shared/postona_reservations/x_bound_delivery.ts";
import { createXReservationPublisher } from "../../../functions/_shared/postona_reservations/x_publisher.ts";
import { g3CredentialGeneration, xGenerationSourceFromG4Raw } from "../../../functions/_shared/postona_reservations/credential_generation_derivation.ts";
import { Client } from "jsr:@db/postgres@0.19.5";

const DB_URL = Deno.env.get("RESV_LIVE_DB_URL")!;
const OWNER_URL = Deno.env.get("RESV_LIVE_OWNER_URL")!;
assert.ok(DB_URL && OWNER_URL, "set by g4_verdict_run.sh");

const owner = async <T extends unknown[]>(sql: string, args: unknown[] = []) => {
  const client = new Client(OWNER_URL);
  await client.connect();
  try {
    return (await client.queryArray<T>({ text: sql, args })).rows;
  } finally {
    await client.end();
  }
};
const one = async (sql: string, args: unknown[] = []) => String((await owner<[unknown]>(sql, args))[0]?.[0] ?? "null");

const P = 4901; // a fresh person of this phase
await owner("select g48.person($1)", [P]);
assert.match(await one("select g48.xconnect($1, 'w49a', '49001')", [P]), /^OK/u);
const account = await one("select g48.xacct($1)", [P]);
const user = await one("select g48.u($1)::text", [P]);
const tokenFor = (gen: string) => `fake-x-token-${gen.replace(/[^0-9a-z]/gu, "")}-0123456789`; // FAKE, never a real token

// MOCK_ONLY stand-in for G4's future token read: G4's REAL verdict, one read; null unless verified. `after` runs right after the read.
let after: (() => Promise<void>) | null = null;
let stale: string | null = null;
const reads: string[] = [];
const g4Raw = {
  available: true,
  async credentialFor(socialAccountId: string) {
    const [row] = await owner<[boolean, string | null]>(
      "select v.verified, v.credential_generation from postona_g4_credential.x_publish_credential_verdict($1::uuid, $2::text) v", [user, socialAccountId]);
    reads.push(socialAccountId);
    const answer = row && row[0] === true && typeof row[1] === "string" ? { token: tokenFor(stale ?? row[1]), g4Generation: stale ?? row[1] } : null;
    if (after) await after();
    return answer;
  },
};
const credentials = xGenerationSourceFromG4Raw(g4Raw);

const sent: { auth: string; text: string }[] = [];
let xAnswer: () => Response = () => Response.json({ data: { id: String(1849000 + sent.length), text: "x" } }, { status: 201 });
const fakeFetch = (url: string | URL | Request, init?: RequestInit) => {
  assert.equal(String(url), "https://api.x.com/2/tweets");
  sent.push({ auth: String(new Headers(init?.headers).get("authorization")), text: JSON.parse(String(init?.body)).text });
  return Promise.resolve(xAnswer());
};
const store = createPostgresBoundDeliveryStore(createDriverConnect({ databaseUrl: DB_URL, allowInsecureLoopback: true }));
const run = (leaseSeconds = 120) => runBoundXReservationDelivery({
  store, credentials, worker: "w49", leaseSeconds, limit: 50,
  publisherFor: (src) => createXReservationPublisher({ credentials: src, fetch: fakeFetch as typeof fetch }),
});
let hours = 1;
const reserve = async (name: string) => {
  // finished rows of this phase sit at "now - 1 minute" from xdue: spread them 2 h apart in the past so the 60-minute slot rule
  // (001) is about the new row only (test bookkeeping, finished rows only)
  await owner(`update postona_x_resv.reservations r set scheduled_at = now() - make_interval(hours => (100 + 2 * o.n)::int), consent_scheduled_at = now() - make_interval(hours => (100 + 2 * o.n)::int)
    from (select id, row_number() over (order by id) as n from postona_x_resv.reservations where social_account_id = $1 and status in ('published', 'uncertain', 'failed')) o
    where r.id = o.id`, [account]);
  const id = await one("select g48.xreserve($1, $2, $3)", [P, name, (hours += 2)]);
  assert.match(id, /^[0-9a-f-]{36}$/u, `${name}: ${id}`);
  await owner("select g48.xdue($1)", [name]);
  return id;
};
const row = (name: string) => one("select g48.xrow($1)", [name]);
const bodyOf = (name: string) => `G3-48 本文 ${name}`;
const results: string[] = [];
const ok = (label: string) => results.push(label);

// W0 TS == DB: G3's TS derivation of G4's real raw generation equals 014's x_credential_generation(account)
{
  const raw = await one("select r.credential_generation from postona_g4_credential.x_publish_credential_verdict($1::uuid, $2::text) r", [user, account]);
  assert.match(raw, /^g4x1:[0-9]+$/u);
  assert.equal(await g3CredentialGeneration("x", raw), await one("select postona_x_resv.x_credential_generation($1)", [account]));
  ok("W0 X TS derivation == x_credential_generation (014)");
}

// W1 claim pins, the token read and the bound check agree: exactly one X create with that token, recorded published
{
  await reserve("w1");
  const pin = await one("select postona_x_resv.x_credential_generation($1)", [account]);
  const report = await run();
  assert.deepEqual([report.claimed, report.sends, report.published], [1, 1, 1], JSON.stringify(report));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, bodyOf("w1"));
  const raw = await one("select r.credential_generation from postona_g4_credential.x_publish_credential_verdict($1::uuid, $2::text) r", [user, account]);
  assert.equal(sent[0].auth, `Bearer ${tokenFor(raw)}`);
  assert.equal(await row("w1"), "published/PUBLISHED");
  assert.equal(await one("select g48.xpin('w1')"), pin);
  ok("W1 pinned == token generation -> one send with that token, published");
}

// W2 disconnect between the token read and the bound check: G4 DISCONNECTED -> NOT_PUBLISHABLE recorded, nothing sent
{
  await reserve("w2");
  after = async () => { after = null; assert.doesNotMatch(await one("select g48.xdisconnect($1)", [P]), /^ERR/u); };
  const report = await run();
  assert.deepEqual([report.claimed, report.sends, report.skipped], [1, 0, 1], JSON.stringify(report));
  assert.equal(sent.length, 1);
  assert.equal(await row("w2"), "failed/NOT_PUBLISHABLE_AT_SEND");
  assert.match(await one("select g48.xconnect($1, 'w49b', '49001')", [P]), /^OK/u);
  ok("W2 disconnect after the token read -> NOT_PUBLISHABLE, 0 sends");
}

// W3 A->B->A between the token read and the bound check: verified again, the pinned generation moved -> nothing sent
{
  await reserve("w3");
  after = async () => {
    after = null;
    await owner("select g48.xdisconnect($1)", [P]);
    assert.match(await one("select g48.xconnect($1, 'w49c', '49001')", [P]), /^OK/u);
  };
  const report = await run();
  assert.deepEqual([report.sends, report.skipped], [0, 1], JSON.stringify(report));
  assert.equal(await one("select g48.xv($1)", [P]), "true|VERIFIED");
  assert.equal(await row("w3"), "failed/NOT_PUBLISHABLE_AT_SEND");
  ok("W3 A->B->A after the token read -> NOT_PUBLISHABLE, 0 sends");
}

// W4 a stale token source (G4's raw value of an earlier connection) with the database consistent: CREDENTIAL_GENERATION_CHANGED, nothing sent
{
  stale = await one("select r.credential_generation from postona_g4_credential.x_publish_credential_verdict($1::uuid, $2::text) r", [user, account]);
  await owner("select g48.xdisconnect($1)", [P]);
  assert.match(await one("select g48.xconnect($1, 'w49d', '49001')", [P]), /^OK/u);
  await reserve("w4");
  const report = await run();
  stale = null;
  assert.deepEqual([report.sends, report.failedBeforeSend], [0, 1], JSON.stringify(report));
  assert.equal(await row("w4"), "failed/CREDENTIAL_GENERATION_CHANGED");
  ok("W4 stale token generation -> CREDENTIAL_GENERATION_CHANGED, 0 sends");
}

// W5 a refresh in progress (SYNTHETIC refresh-core state): before the claim -> not claimed (planned); after the token read -> the check
// refuses (G4 REFRESH_IN_PROGRESS), nothing sent
{
  await reserve("w5");
  await owner("insert into public.x_account_refresh_state_v2 (social_account_id) values ($1) on conflict (social_account_id) do nothing", [account]);
  const refreshing = (status: string) => owner("update public.x_account_refresh_state_v2 set status = $2 where social_account_id = $1", [account, status]);
  await refreshing("refreshing");
  const before = await run();
  await refreshing("idle");
  assert.deepEqual([before.claimed, before.sends], [0, 0], JSON.stringify(before));
  assert.equal(await row("w5"), "planned/-");
  after = async () => { after = null; await refreshing("refreshing"); };
  const report = await run();
  assert.equal(await one("select g48.xv($1)", [P]), "false|REFRESH_IN_PROGRESS");
  await refreshing("idle");
  assert.deepEqual([report.claimed, report.sends, report.skipped], [1, 0, 1], JSON.stringify(report));
  assert.equal(await row("w5"), "failed/NOT_PUBLISHABLE_AT_SEND");
  assert.equal(await one("select g48.xv($1)", [P]), "true|VERIFIED");
  ok("W5 refresh in progress: before the claim -> not claimed; after the token read -> NOT_PUBLISHABLE, 0 sends");
}

// W6 a lease too short for one X call (SYNTHETIC: a slow token read, the lease moved to 10 s left right after it): handed back unsent
// (RELEASED, planned again, pin cleared); the next run sends it exactly once
{
  const w6 = await reserve("w6");
  after = async () => { after = null; await owner("update postona_x_resv.reservations set lease_expires_at = now() + interval '10 seconds' where id = $1::uuid", [w6]); };
  const short = await run(30);
  assert.deepEqual([short.sends, short.released], [0, 1], JSON.stringify(short));
  assert.equal(await row("w6"), "planned/-");
  assert.equal(await one("select g48.xpin('w6')"), "null");
  const again = await run();
  assert.deepEqual([again.claimed, again.sends, again.published], [1, 1, 1], JSON.stringify(again));
  assert.equal(await row("w6"), "published/PUBLISHED");
  ok("W6 lease too short at the check -> RELEASED unsent, pin cleared; the next run sends once");
}

// W7 X answers an unknown outcome: uncertain, and never re-claimed or re-sent
{
  await reserve("w7");
  xAnswer = () => new Response("upstream", { status: 503 });
  const report = await run();
  xAnswer = () => Response.json({ data: { id: String(1849000 + sent.length), text: "x" } }, { status: 201 });
  assert.deepEqual([report.sends, report.uncertain], [1, 1], JSON.stringify(report));
  assert.equal(await row("w7"), "uncertain/X_HTTP_503");
  const before = sent.length;
  const again = await run();
  assert.deepEqual([again.claimed, sent.length], [0, before]);
  ok("W7 unknown X outcome -> uncertain, never re-sent");
}

// W8 the worker role reaches exactly the bound check, never G4: G4's verdict is owner-only
{
  const worker = new Client(DB_URL);
  await worker.connect();
  try {
    await worker.queryArray("begin");
    await worker.queryArray("set local role postona_resv_worker");
    // a pinned row that is no longer this lease's (published, its old lease) answers no generation
    const w1 = await one("select g48.id('w1')::text");
    const oldLease = await one("select coalesce(lease_token::text, gen_random_uuid()::text) from postona_x_resv.reservations where id = $1::uuid", [w1]);
    assert.notEqual(await one("select g48.xpin('w1')"), "null");
    const answered = (await worker.queryArray<[string, string | null]>({ text: "select verdict, credential_generation from postona_x_resv.pre_publish_check_bound($1::uuid, $2::uuid)", args: [w1, oldLease] })).rows;
    assert.deepEqual(answered, [["LEASE_LOST", null]]);
    await worker.queryArray("savepoint g4");
    await assert.rejects(worker.queryArray({ text: "select * from postona_g4_credential.x_publish_credential_verdict($1::uuid, $2::text)", args: [user, account] }), /permission denied/u);
  } finally {
    await worker.queryArray("rollback").catch(() => undefined);
    await worker.end();
  }
  ok("W8 a finished pinned row answers LEASE_LOST/null; the worker login cannot call G4's verdict");
}

// T1 Threads TS == DB on the labelled stand-in data (VB's TEST STAND-IN dropped the 2a-2 CHECK in this disposable world only; VB TV0
// proved the CHECK refuses Threads publishing while it is in force, U8): G3's TS derivation equals 013's threads_credential_generation
{
  const state = crypto.randomUUID();
  await owner("select public.fixture_user_with_workspace(g48.u(4911), 's494911')");
  await owner("select g48.person(4911)");
  await owner("select g48.tconnect(4911, $1::uuid)", [state]);
  const [t] = await owner<[boolean, string]>("select v.verified, v.credential_generation from postona_g4_credential.threads_publish_credential_verdict(g48.u(4911), g48.tacct(4911)) v");
  assert.equal(t[0], true);
  assert.equal(t[1], `g4t1:${state}`);
  assert.equal(await g3CredentialGeneration("threads", t[1]), await one("select postona_threads_resv.threads_credential_generation(g48.tacct(4911))"));
  ok("T1 Threads TS derivation == threads_credential_generation (013)");
}

assert.ok(reads.length >= 8 && reads.every((a) => a === account), "only this person's account was read");
assert.ok(sent.every((s) => s.text.startsWith("G3-48 本文 w")), "only this phase's rows were sent");
console.log(`G3_BOUND_WORKER_E2E_PASS ${results.length} sends=${sent.length}`);
for (const r of results) console.log(`ok ${r}`);
