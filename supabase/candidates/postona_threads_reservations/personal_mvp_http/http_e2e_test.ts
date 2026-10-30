// G3-46 (TEST ONLY, fake data): Threads reservations through the NEW app-facing Edge entry in G5's PERSONAL MVP world with G3 007 + 009,
// on a disposable LOCAL PostgreSQL only (loopback TCP 127.0.0.1). Run by postona_threads_personal_mvp_run.sh, phase HT, after
// personal_mvp_http/people.sql.
//   a real Request / Response through the REAL postona-threads-reservations/http.ts (gate forced on here only)
//   -> the REAL threads_api.ts -> the REAL threads_postgres_db.ts + driver, as a login role that is a member of postona_resv_api
//   -> 007's create_reservation / cancel_reservation / receipt, with G5's real S2-2 person-session gate (live auth.sessions rows).
// MOCK_ONLY: GoTrue (fetch) answers by token; the permission port is the PRODUCTION default, THREADS_PERMISSIONS_DECIDED_IN_DATABASE
// (G3-02 #2: 007's create decides; no TS allow anywhere in this file); G4 is G3's TEST DOUBLE list (t_threads.verified). This world has no
// U8 CHECK (local_stack/ and G3-51's smoke run with it). Nothing here proves the real Auth, G5 or G4 boundary. The entry never calls Threads:
// every fetch must be the Auth endpoint.
import assert from "node:assert/strict";
import { createHttpHandler } from "../../../functions/postona-threads-reservations/http.ts";
import { createDriverConnect } from "../../../functions/_shared/postona_reservations/postgres_driver.ts";
import type { PgConnect } from "../../../functions/_shared/postona_reservations/postgres_db.ts";
import { Client } from "jsr:@db/postgres@0.19.5";

const DB_URL = Deno.env.get("RESV_LIVE_DB_URL")!;
const OWNER_URL = Deno.env.get("RESV_LIVE_OWNER_URL")!;
assert.ok(DB_URL && OWNER_URL, "set by postona_threads_personal_mvp_run.sh");

const owner = async <T extends unknown[]>(sql: string, args: unknown[] = []) => {
  const client = new Client(OWNER_URL);
  await client.connect();
  try {
    return (await client.queryArray<T>({ text: sql, args })).rows;
  } finally {
    await client.end();
  }
};
const rows = await owner<[string, string, string]>("select name, id::text, client_request_id::text from t46.ids");
const ids = Object.fromEntries(rows.map(([n, id]) => [n, id]));
const crid = Object.fromEntries(rows.map(([n, , c]) => [n, c]));
const people = Object.fromEntries((await owner<[string, string, string, string]>("select name, user_id::text, session_id::text, account from t46.people"))
  .map(([n, user, session, account]) => [n, { user, session, account }]));
const H = people.h, I = people.i;
const rowOf = async (name: string) =>
  (await owner<[string, string | null, string | null]>("select status, outcome_code, lease_token::text from postona_threads_resv.reservations where id = $1::uuid", [ids[name]]))[0];
const sha = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

const b64url = (s: string) => btoa(s).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
type Fake = { user: Record<string, unknown>; claims: Record<string, unknown> };
const FAKES: Record<string, Fake> = {
  h: { user: { id: H.user, aud: "authenticated", role: "authenticated" }, claims: { sub: H.user, session_id: H.session, is_anonymous: false } },
  i: { user: { id: I.user, aud: "authenticated", role: "authenticated" }, claims: { sub: I.user, session_id: I.session, is_anonymous: false } },
  h_anon: { user: { id: H.user, aud: "authenticated", role: "authenticated", is_anonymous: true }, claims: { sub: H.user, session_id: H.session, is_anonymous: true } },
  h_unknown: { user: { id: H.user, aud: "authenticated", role: "authenticated" }, claims: { sub: H.user, session_id: H.session } },
  h_no_session: { user: { id: H.user, aud: "authenticated", role: "authenticated" }, claims: { sub: H.user, is_anonymous: false } },
  h_as_i: { user: { id: H.user, aud: "authenticated", role: "authenticated" }, claims: { sub: I.user, session_id: I.session, is_anonymous: false } },
  h_other_session: { user: { id: H.user, aud: "authenticated", role: "authenticated" }, claims: { sub: H.user, session_id: crypto.randomUUID(), is_anonymous: false } },
};
const tokenOf = (alias: string) => FAKES[alias] ? `eyJhbGciOiJIUzI1NiJ9.${b64url(JSON.stringify(FAKES[alias].claims))}.sig-${alias}` : `unknown-token-${alias}-0123456789`;
const ALIAS: Record<string, string> = Object.fromEntries(Object.keys(FAKES).map((a) => [tokenOf(a), a]));
const fetched: string[] = [];
const fakeAuth = (url: string, init?: RequestInit) => {
  fetched.push(url);
  const token = String((init?.headers as Record<string, string>).Authorization).replace(/^Bearer /u, "");
  const fake = FAKES[ALIAS[token] ?? ""];
  return Promise.resolve(fake ? Response.json(fake.user) : new Response(JSON.stringify({ message: "invalid JWT" }), { status: 401 }));
};
const ENV = new Map([["SUPABASE_URL", "https://project.example.invalid"], ["SUPABASE_ANON_KEY", "publishable"]]);
const realConnect = createDriverConnect({ databaseUrl: DB_URL, allowInsecureLoopback: true });
let connects = 0;
const connect: PgConnect = () => { connects += 1; return realConnect(); };
// the production defaults except the gate: no `permissions` override -> THREADS_PERMISSIONS_DECIDED_IN_DATABASE
const handler = createHttpHandler({ get: (n) => ENV.get(n) }, { enabled: true, fetch: fakeAuth, connect });
const post = async (alias: string, call: unknown, h = handler) => {
  const response = await h(new Request("http://localhost/functions/v1/postona-threads-reservations", {
    method: "POST", headers: { authorization: `Bearer ${tokenOf(alias)}`, "content-type": "application/json" }, body: JSON.stringify(call),
  }));
  return { status: response.status, body: await response.json().catch(() => null) };
};
const receipt = (alias: string, name: string, account = H.account) => post(alias, { action: "receipt", payload: { socialAccountId: account, clientRequestId: crid[name] } });
const cancel = (alias: string, name: string) => post(alias, { action: "cancel", payload: { reservationId: ids[name] } });
const createCall = async (account: string, clientRequestId: string, text: string, hours: number) => ({
  action: "create",
  payload: { socialAccountId: account, clientRequestId, text, contentSha256: await sha(text), scheduledAt: new Date(Date.now() + hours * 3600e3).toISOString() },
});

Deno.test("HT1 the person's receipt reads their own row (pending)", async () => {
  const r = await receipt("h", "h1");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, receipt: { reservationId: ids.h1, state: "pending", providerPostId: null, outcomeCode: null, afterFreeze: false, simulated: true } });
});

Deno.test("HT2 G3-02 #3: create is decided in the database with the production default (no TS allow): idempotent on clientRequestId, a changed body 409, a wrong hash 422; publish disabled, an unverified account and another person's account refused with nothing written", async () => {
  const c0 = connects;
  const call = await createCall(H.account, crypto.randomUUID(), "G3-46 本文 new", 540);
  const first = await post("h", call);
  assert.equal(first.status, 200, JSON.stringify(first));
  assert.equal(first.body.reservation.created, true);
  assert.equal(first.body.reservation.status, "planned");
  assert.ok(connects > c0, "decided in the database (THREADS_PERMISSIONS_DECIDED_IN_DATABASE)");
  const again = await post("h", call);
  assert.deepEqual(again, { status: 200, body: { ok: true, reservation: { reservationId: first.body.reservation.reservationId, status: "planned", created: false } } });
  const changed = { ...call, payload: { ...call.payload, text: "G3-46 本文 changed", contentSha256: await sha("G3-46 本文 changed") } };
  assert.deepEqual(await post("h", changed), { status: 409, body: { ok: false, code: "POSTONA_THREADS_RESV_IDEMPOTENCY_CONFLICT" } });
  assert.deepEqual(await post("h", { ...call, payload: { ...call.payload, contentSha256: "0".repeat(64) } }),
    { status: 422, body: { ok: false, code: "POSTONA_THREADS_RESV_CONSENT_REQUIRED" } });
  const count = async () => Number((await owner<[bigint]>("select count(*) from postona_threads_resv.reservations"))[0][0]);
  const n0 = await count();
  // the account publish-disabled (the column G4's U8 CHECK pins to false; this world has no U8): 007's fence refuses
  await owner("update public.social_accounts set publish_enabled = false where id = $1", [H.account]);
  try {
    assert.deepEqual(await post("h", await createCall(H.account, crypto.randomUUID(), "G3-46 本文 disabled", 542)),
      { status: 403, body: { ok: false, code: "POSTONA_THREADS_RESV_PUBLISH_DISABLED" } });
  } finally {
    await owner("update public.social_accounts set publish_enabled = true where id = $1", [H.account]);
  }
  // G4 (TEST DOUBLE) no longer lists H's account: refused; the receipt still reads
  await owner("delete from t_threads.verified where social_account_id = $1", [H.account]);
  try {
    assert.deepEqual(await post("h", await createCall(H.account, crypto.randomUUID(), "G3-46 本文 unverified", 545)),
      { status: 403, body: { ok: false, code: "POSTONA_THREADS_RESV_ACCOUNT_NOT_VERIFIED" } });
    assert.deepEqual(await receipt("h", "h1"), { status: 200, body: { ok: true, receipt: { reservationId: ids.h1, state: "pending", providerPostId: null, outcomeCode: null, afterFreeze: false, simulated: true } } },
      "the receipt still reads with the account unverified");
  } finally {
    await owner("insert into t_threads.verified values ($1)", [H.account]);
  }
  // another person on H's account: one answer, no oracle
  assert.deepEqual(await post("i", await createCall(H.account, crypto.randomUUID(), "G3-46 本文 I on H", 548)),
    { status: 404, body: { ok: false, code: "POSTONA_THREADS_RESV_ACCOUNT_NOT_FOUND" } });
  assert.equal(await count(), n0, "no refusal wrote a row");
  // the extra row is cancelled again so the rollback phases see only the rows they expect
  assert.equal((await post("h", { action: "cancel", payload: { reservationId: first.body.reservation.reservationId } })).status, 200);
});

Deno.test("HT3 the person cancels their planned row; the receipt then reads cancelled; a second cancel is 409", async () => {
  assert.deepEqual(await cancel("h", "h1"), { status: 200, body: { ok: true, reservation: { reservationId: ids.h1, status: "cancelled" } } });
  assert.equal((await receipt("h", "h1")).body.receipt.state, "cancelled");
  assert.deepEqual(await cancel("h", "h1"), { status: 409, body: { ok: false, code: "POSTONA_THREADS_RESV_NOT_CANCELLABLE" } });
});

Deno.test("HT4 another person: H's receipt 404 (same answer as an unknown request id), H's row not cancellable (404); I reads I's own", async () => {
  assert.deepEqual(await receipt("i", "h2"), { status: 404, body: { ok: false, code: "POSTONA_THREADS_RESV_NOT_FOUND" } });
  assert.deepEqual(await post("i", { action: "receipt", payload: { socialAccountId: H.account, clientRequestId: crypto.randomUUID() } }),
    { status: 404, body: { ok: false, code: "POSTONA_THREADS_RESV_NOT_FOUND" } });
  assert.deepEqual(await cancel("i", "h2"), { status: 404, body: { ok: false, code: "POSTONA_THREADS_RESV_NOT_FOUND" } });
  assert.deepEqual(await post("i", { action: "cancel", payload: { reservationId: crypto.randomUUID() } }), { status: 404, body: { ok: false, code: "POSTONA_THREADS_RESV_NOT_FOUND" } });
  assert.equal((await receipt("i", "i1", I.account)).body.receipt.state, "pending");
  assert.deepEqual(await rowOf("h2"), ["planned", null, null]);
});

Deno.test("HT5 anonymous, unknown anonymity, no session, another subject, an unknown token: 401 with no database; a foreign or ended session: 401 from the S2-2 gate", async () => {
  const c0 = connects;
  for (const alias of ["h_anon", "h_unknown", "h_no_session", "h_as_i", "nobody"]) {
    for (const call of [{ action: "receipt", payload: { socialAccountId: H.account, clientRequestId: crid.h2 } }, { action: "cancel", payload: { reservationId: ids.h2 } },
                        await createCall(H.account, crypto.randomUUID(), "G3-46 本文 anon", 550)]) {
      assert.deepEqual(await post(alias, call), { status: 401, body: { ok: false, code: "AUTH_REQUIRED" } }, `${alias} ${call.action}`);
    }
  }
  assert.equal(connects, c0, "none of them reached the database");
  assert.deepEqual(await post("h_other_session", { action: "cancel", payload: { reservationId: ids.h2 } }), { status: 401, body: { ok: false, code: "POSTONA_RESV_AUTH_REQUIRED" } });
  await owner("update auth.sessions set not_after = now() - interval '1 second' where user_id = $1::uuid", [H.user]);
  try {
    assert.deepEqual(await receipt("h", "h2"), { status: 401, body: { ok: false, code: "POSTONA_RESV_AUTH_REQUIRED" } });
    assert.deepEqual(await cancel("h", "h2"), { status: 401, body: { ok: false, code: "POSTONA_RESV_AUTH_REQUIRED" } });
  } finally {
    await owner("update auth.sessions set not_after = null where user_id = $1::uuid", [H.user]);
  }
  assert.deepEqual(await rowOf("h2"), ["planned", null, null]);
});

Deno.test("HT6 the uncertain row: receipt uncertain, cancel 409, never claimed again (no lease), nothing re-sent", async () => {
  assert.equal((await receipt("h", "h3")).body.receipt.state, "uncertain");
  assert.equal((await receipt("h", "h3")).body.receipt.outcomeCode, "LEASE_EXPIRED");
  assert.deepEqual(await cancel("h", "h3"), { status: 409, body: { ok: false, code: "POSTONA_THREADS_RESV_NOT_CANCELLABLE" } });
  assert.deepEqual(await rowOf("h3"), ["uncertain", "LEASE_EXPIRED", null]);
});

Deno.test("HT7 after H's service-end saga begins: create 403 (decided in the database, production default); H reads and cancels h2; h4 receipt still reads", async () => {
  // as G5's end saga starts it (service_role), on one owner connection
  const client = new Client(OWNER_URL);
  await client.connect();
  try {
    await client.queryArray({ text: "set role service_role" });
    await client.queryArray({ text: "select public.begin_service_deletion($1::uuid, 'x_autopost')::text", args: [H.user] });
  } finally {
    await client.end();
  }
  const refused = await post("h", await createCall(H.account, crypto.randomUUID(), "G3-46 本文 after end", 560));
  assert.equal(refused.status, 403, JSON.stringify(refused));
  assert.equal((await receipt("h", "h2")).body.receipt.state, "pending");
  assert.deepEqual(await cancel("h", "h2"), { status: 200, body: { ok: true, reservation: { reservationId: ids.h2, status: "cancelled" } } });
  assert.equal((await receipt("h", "h2")).body.receipt.state, "cancelled");
  assert.equal((await receipt("h", "h4")).body.receipt.state, "pending");
});

Deno.test("HT8 the gate OFF answers 503 and touches nothing; every outbound call was the Auth endpoint (Threads sends 0); nothing claimed or published", async () => {
  const f0 = fetched.length, c0 = connects;
  const off = createHttpHandler({ get: (n) => ENV.get(n) }, { fetch: fakeAuth, connect });
  assert.deepEqual(await post("h", { action: "receipt", payload: { socialAccountId: H.account, clientRequestId: crid.h4 } }, off), { status: 503, body: { ok: false, code: "NOT_AVAILABLE" } });
  assert.equal(fetched.length, f0);
  assert.equal(connects, c0);
  assert.deepEqual([...new Set(fetched)], ["https://project.example.invalid/auth/v1/user"]);
  const sent = await owner<[bigint]>("select count(*) from postona_threads_resv.reservations r where r.user_id in ($1::uuid, $2::uuid) and r.status in ('claimed', 'published')", [H.user, I.user]);
  assert.equal(Number(sent[0][0]), 0);
});
