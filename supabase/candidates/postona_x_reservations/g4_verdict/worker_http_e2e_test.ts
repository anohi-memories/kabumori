// G3-50 (TEST ONLY, fake data): the PRODUCT X reservation worker entry (postona-x-reservation-worker/http.ts) on G4's REAL X verdict, in
// the PERSONAL world G4's own runner builds (g4_verdict_run.sh, phase VH, after VW on the same world with 015 applied).
//   a real Request -> the REAL createWorkerHandler (gate forced on here only; scheduler secret checked) -> the REAL bound delivery
//   (x_bound_delivery.ts) -> the REAL bound store + driver, as a login that is a member of postona_resv_worker only -> 004 / 014 / 015
//   -> the REAL x_publisher.ts with a fake fetch (no network: every request is answered here and recorded).
// MOCK_ONLY (labelled): G4's X token read does not exist. The stand-in reads G4's REAL verdict (as the lifecycle owner) and answers a
// FAKE token with G4's raw generation, through G3's xGenerationSourceFromG4Raw. Connect / disconnect go through G4's REAL X SQL (g48.*
// helpers left by VB). Nothing here proves the real G4 token custody, Vault, GoTrue, X, a scheduler or the managed project.
import assert from "node:assert/strict";
import { createWorkerHandler } from "../../../functions/postona-x-reservation-worker/http.ts";
import { createDriverConnect } from "../../../functions/_shared/postona_reservations/postgres_driver.ts";
import type { PgConnect } from "../../../functions/_shared/postona_reservations/postgres_db.ts";
import { xGenerationSourceFromG4Raw } from "../../../functions/_shared/postona_reservations/credential_generation_derivation.ts";
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

const P = 4921; // a fresh person of this phase
await owner("select g48.person($1)", [P]);
assert.match(await one("select g48.xconnect($1, 'h50a', '49021')", [P]), /^OK/u);
const account = await one("select g48.xacct($1)", [P]);
const user = await one("select g48.u($1)::text", [P]);
const tokenFor = (gen: string) => `fake-x-token-${gen.replace(/[^0-9a-z]/gu, "")}-0123456789`; // FAKE, never a real token
const g4raw = () => one("select r.credential_generation from postona_g4_credential.x_publish_credential_verdict($1::uuid, $2::text) r", [user, account]);

// MOCK_ONLY stand-in for G4's future token read (as VW). `after` runs right after the read.
let after: (() => Promise<void>) | null = null;
let stale: string | null = null;
const credentials = xGenerationSourceFromG4Raw({
  available: true,
  async credentialFor(socialAccountId: string) {
    const [row] = await owner<[boolean, string | null]>(
      "select v.verified, v.credential_generation from postona_g4_credential.x_publish_credential_verdict($1::uuid, $2::text) v", [user, socialAccountId]);
    const answer = row && row[0] === true && typeof row[1] === "string" ? { token: tokenFor(stale ?? row[1]), g4Generation: stale ?? row[1] } : null;
    if (after) await after();
    return answer;
  },
});

const sent: { auth: string; text: string }[] = [];
let xAnswer: () => Response = () => Response.json({ data: { id: String(1850000 + sent.length), text: "x" } }, { status: 201 });
const fakeFetch = (url: string, init?: RequestInit) => {
  assert.equal(String(url), "https://api.x.com/2/tweets");
  sent.push({ auth: String(new Headers(init?.headers).get("authorization")), text: JSON.parse(String(init?.body)).text });
  return Promise.resolve(xAnswer());
};
let connects = 0;
const realConnect = createDriverConnect({ databaseUrl: DB_URL, allowInsecureLoopback: true });
const connect: PgConnect = () => { connects += 1; return realConnect(); };
const SECRET = "worker-secret-g3-50-0123456789abcdef"; // FAKE scheduler secret of this test only
const env = { get: (n: string) => ({ POSTONA_RESV_WORKER_SECRET: SECRET, POSTONA_RESV_WORKER_DATABASE_URL: "postgres://unused.invalid/x" } as Record<string, string>)[n] };
const request = (secret = SECRET) => new Request("http://localhost/functions/v1/postona-x-reservation-worker", { method: "POST", headers: { "x-postona-worker-secret": secret } });
type Report = Record<string, number | boolean>;
const call = async (overrides: Record<string, unknown> = { credentials }, secret = SECRET) => {
  const response = await createWorkerHandler(env, { enabled: true, connect, fetch: fakeFetch, ...overrides })(request(secret));
  return { status: response.status, body: await response.json() as { ok: boolean; code?: string; report?: Report } };
};
const run = async () => {
  const r = await call();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.report!;
};
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
const results: string[] = [];
const ok = (label: string) => results.push(label);

// H0 the PRODUCTION default (no credential override) and a token-only source: 200 notAvailable, nothing claimed, no connection, no X
{
  await reserve("h0");
  for (const overrides of [{}, { credentials: { available: true, accessTokenFor: () => Promise.resolve(tokenFor("x")) } }]) {
    const before = connects;
    const r = await call(overrides);
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.report!.notAvailable, r.body.report!.claimed, r.body.report!.sends], [true, 0, 0]);
    assert.equal(connects, before, "no database connection");
  }
  assert.equal(await row("h0"), "planned/-");
  assert.equal(sent.length, 0);
  ok("H0 production default / token-only source -> notAvailable, claim 0, connection 0, X 0");
}

// H1 gate OFF (the shipped constant) and a wrong scheduler secret: refused before any connection
{
  const before = connects;
  const off = await createWorkerHandler(env, { connect, credentials, fetch: fakeFetch })(request());
  assert.deepEqual([off.status, (await off.json()).code], [503, "NOT_AVAILABLE"]);
  const wrong = await call({ credentials }, SECRET + "x");
  assert.deepEqual([wrong.status, wrong.body.code], [401, "WORKER_AUTH_REQUIRED"]);
  assert.equal(connects, before);
  assert.equal(await row("h0"), "planned/-");
  ok("H1 gate OFF -> 503, wrong secret -> 401, connection 0");
}

// H2 the same generation: the entry sends h0 exactly once with that generation's token; the answer holds counts only
{
  const r = await call();
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body.report!).sort(), ["claimed", "failedBeforeSend", "notAvailable", "published", "released", "sends", "skipped", "stopped", "uncertain"]);
  assert.deepEqual([r.body.report!.claimed, r.body.report!.sends, r.body.report!.published], [1, 1, 1], JSON.stringify(r.body));
  assert.deepEqual(sent.map((s) => s.text), ["G3-48 本文 h0"]);
  assert.equal(sent[0].auth, `Bearer ${tokenFor(await g4raw())}`);
  assert.equal(await row("h0"), "published/PUBLISHED");
  ok("H2 same generation -> one send with that token, published; counts only");
}

// H3 disconnect after the token read -> NOT_PUBLISHABLE, 0 sends
{
  await reserve("h3");
  after = async () => { after = null; assert.doesNotMatch(await one("select g48.xdisconnect($1)", [P]), /^ERR/u); };
  const report = await run();
  assert.deepEqual([report.claimed, report.sends, report.skipped], [1, 0, 1], JSON.stringify(report));
  assert.equal(await row("h3"), "failed/NOT_PUBLISHABLE_AT_SEND");
  assert.match(await one("select g48.xconnect($1, 'h50b', '49021')", [P]), /^OK/u);
  ok("H3 disconnect after the token read -> NOT_PUBLISHABLE, 0 sends");
}

// H4 A->B->A after the token read -> verified again, the pin moved -> 0 sends
{
  await reserve("h4");
  after = async () => {
    after = null;
    await owner("select g48.xdisconnect($1)", [P]);
    assert.match(await one("select g48.xconnect($1, 'h50c', '49021')", [P]), /^OK/u);
  };
  const report = await run();
  assert.deepEqual([report.sends, report.skipped], [0, 1], JSON.stringify(report));
  assert.equal(await one("select g48.xv($1)", [P]), "true|VERIFIED");
  assert.equal(await row("h4"), "failed/NOT_PUBLISHABLE_AT_SEND");
  ok("H4 A->B->A after the token read -> NOT_PUBLISHABLE, 0 sends");
}

// H5 a token of another (earlier) generation with the database consistent -> CREDENTIAL_GENERATION_CHANGED, 0 sends
{
  stale = await g4raw();
  await owner("select g48.xdisconnect($1)", [P]);
  assert.match(await one("select g48.xconnect($1, 'h50d', '49021')", [P]), /^OK/u);
  await reserve("h5");
  const report = await run();
  stale = null;
  assert.deepEqual([report.sends, report.failedBeforeSend], [0, 1], JSON.stringify(report));
  assert.equal(await row("h5"), "failed/CREDENTIAL_GENERATION_CHANGED");
  ok("H5 other token generation -> CREDENTIAL_GENERATION_CHANGED, 0 sends");
}

// H6 the lease shortened right after the token read (SYNTHETIC, a slow read) -> RELEASED unsent; the next request sends it once
{
  const h6 = await reserve("h6");
  after = async () => { after = null; await owner("update postona_x_resv.reservations set lease_expires_at = now() + interval '10 seconds' where id = $1::uuid", [h6]); };
  const short = await run();
  assert.deepEqual([short.sends, short.released], [0, 1], JSON.stringify(short));
  assert.equal(await row("h6"), "planned/-");
  const before = sent.length;
  const again = await run();
  assert.deepEqual([again.claimed, again.sends, again.published], [1, 1, 1], JSON.stringify(again));
  assert.equal(sent.length, before + 1);
  assert.equal(await row("h6"), "published/PUBLISHED");
  ok("H6 lease too short -> RELEASED unsent; the next request sends once");
}

// H7 X answers an unknown outcome -> uncertain; the next request never re-claims or re-sends it
{
  await reserve("h7");
  xAnswer = () => new Response("upstream", { status: 503 });
  const report = await run();
  xAnswer = () => Response.json({ data: { id: String(1850000 + sent.length), text: "x" } }, { status: 201 });
  assert.deepEqual([report.sends, report.uncertain], [1, 1], JSON.stringify(report));
  assert.equal(await row("h7"), "uncertain/X_HTTP_503");
  const before = sent.length;
  const again = await run();
  assert.deepEqual([again.claimed, sent.length], [0, before]);
  ok("H7 unknown X outcome -> uncertain, never re-sent");
}

assert.ok(sent.every((s) => /^G3-48 本文 h[0-9]$/u.test(s.text)), "only this phase's rows were sent");
assert.equal(sent.length, 3);
console.log(`G3_WORKER_HTTP_E2E_PASS ${results.length} sends=${sent.length}`);
for (const r of results) console.log(`ok ${r}`);
