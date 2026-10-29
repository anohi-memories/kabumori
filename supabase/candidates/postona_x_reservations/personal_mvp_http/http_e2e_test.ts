// G3-45 (TEST ONLY, fake data): app-near HTTP e2e in G5's PERSONAL MVP world with G3 001-006 + 008 + 010 + 012, on a disposable LOCAL
// PostgreSQL only (loopback TCP 127.0.0.1). Run by personal_mvp_run.sh, phase HE, after personal_mvp_http/people.sql.
//   the app's store (apps/social-mobile remote-reservation-store.ts, imported read-only)
//   -> a real Request / Response through the REAL Edge handler (postona-x-reservations/http.ts; gate forced on here only)
//   -> the REAL api.ts -> the REAL postgres_db.ts + driver, as a login role that is a member of postona_resv_api
//   -> the SQL candidates, with G5's real S2-2 person-session gate (live auth.sessions rows) and the MVP adapters.
// MOCK_ONLY: GoTrue (fetch) answers by token, and the TS permission port is the PRODUCTION default PERMISSIONS_NOT_CONNECTED (deny), so
// create / reschedule / reconfirm answer 403 before the database exactly as a gated-on deployment would until G5 / G4 deliver. Nothing
// here proves the real Auth, G5 or G4 boundary. The Edge never calls X: every fetch must be the Auth endpoint.
import assert from "node:assert/strict";
import { createHttpHandler } from "../../../functions/postona-x-reservations/http.ts";
import { createDriverConnect } from "../../../functions/_shared/postona_reservations/postgres_driver.ts";
import type { PgConnect } from "../../../functions/_shared/postona_reservations/postgres_db.ts";
import { createRemoteReservationStore } from "../../../../apps/social-mobile/src/features/schedule/remote-reservation-store.ts";
import { Client } from "jsr:@db/postgres@0.19.5";

const DB_URL = Deno.env.get("RESV_LIVE_DB_URL")!;
const OWNER_URL = Deno.env.get("RESV_LIVE_OWNER_URL")!;
assert.ok(DB_URL && OWNER_URL, "set by personal_mvp_run.sh");

const owner = async <T extends unknown[]>(sql: string, args: unknown[] = []) => {
  const client = new Client(OWNER_URL);
  await client.connect();
  try {
    return (await client.queryArray<T>({ text: sql, args })).rows;
  } finally {
    await client.end();
  }
};
const ids = Object.fromEntries((await owner<[string, string]>("select name, id::text from t45.ids")).map(([n, id]) => [n, id]));
const people = Object.fromEntries((await owner<[string, string, string, string]>("select name, user_id::text, session_id::text, account from t45.people"))
  .map(([n, user, session, account]) => [n, { user, session, account }]));
const H = people.h, I = people.i;
const rowOf = async (name: string) => (await owner<[string, number]>("select status, revision from postona_x_resv.reservations where id = $1::uuid", [ids[name]]))[0];
const auditCount = async () => Number((await owner<[bigint]>("select count(*) from postona_x_resv.audit"))[0][0]);

// MOCK_ONLY GoTrue: alias -> user; the token carries sub / session_id / is_anonymous as an Auth token would (read only after Auth accepted it).
const b64url = (s: string) => btoa(s).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
type Fake = { user: { id: string; aud: string; role: string; is_anonymous?: boolean }; claims: Record<string, unknown> };
const FAKES: Record<string, Fake> = {
  h: { user: { id: H.user, aud: "authenticated", role: "authenticated" }, claims: { sub: H.user, session_id: H.session, is_anonymous: false } },
  i: { user: { id: I.user, aud: "authenticated", role: "authenticated" }, claims: { sub: I.user, session_id: I.session, is_anonymous: false } },
  h_anon: { user: { id: H.user, aud: "authenticated", role: "authenticated", is_anonymous: true }, claims: { sub: H.user, session_id: H.session, is_anonymous: true } },
  h_unknown: { user: { id: H.user, aud: "authenticated", role: "authenticated" }, claims: { sub: H.user, session_id: H.session } },
  h_no_session: { user: { id: H.user, aud: "authenticated", role: "authenticated" }, claims: { sub: H.user, is_anonymous: false } },
  h_other_session: { user: { id: H.user, aud: "authenticated", role: "authenticated" }, claims: { sub: H.user, session_id: crypto.randomUUID(), is_anonymous: false } },
  h_as_i: { user: { id: H.user, aud: "authenticated", role: "authenticated" }, claims: { sub: I.user, session_id: I.session, is_anonymous: false } },
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
// the production defaults except the gate: no `permissions` override -> PERMISSIONS_NOT_CONNECTED (deny)
const handler = createHttpHandler({ get: (n) => ENV.get(n) }, { enabled: true, fetch: fakeAuth, connect });
const post = async (alias: string, call: unknown, h = handler) => {
  const response = await h(new Request("http://localhost/functions/v1/postona-x-reservations", {
    method: "POST", headers: { authorization: `Bearer ${tokenOf(alias)}`, "content-type": "application/json" }, body: JSON.stringify(call),
  }));
  return { status: response.status, body: await response.json().catch(() => null) };
};
const store = (alias: string) => createRemoteReservationStore({
  transport: (call, token) => post(token, call),
  getAccessToken: () => Promise.resolve(alias),
});

Deno.test("HE1 after the service ended the app's store lists and gets the person's own rows (current state and revision)", async () => {
  const listed = await store("h").list(H.account);
  assert.equal(listed.ok, true, JSON.stringify(listed));
  const byId = Object.fromEntries((listed.ok ? listed.value : []).map((r) => [r.reservationId, `${r.status}@${r.revision}`]));
  assert.deepEqual(byId, { [ids.h1]: "planned@2", [ids.h2]: "planned@1", [ids.h3]: "uncertain@1", [ids.h4]: "planned@1" });
  const got = await store("h").get(ids.h1);
  assert.deepEqual(got.ok && [got.value.status, got.value.revision], ["planned", 2]);
});

Deno.test("HE2 409 STALE_REVISION -> the app re-reads -> cancels with the read revision; the store's read-back confirms", async () => {
  const before = await auditCount();
  const stale = await post("h", { action: "cancel", payload: { reservationId: ids.h1, expectedRevision: 1 } });
  assert.deepEqual(stale, { status: 409, body: { ok: false, code: "POSTONA_RESV_STALE_REVISION" } });
  const s = store("h");
  assert.deepEqual(await s.cancel(ids.h1, 1), { ok: false, code: "POSTONA_RESV_STALE_REVISION" }, "a definite refusal, not UNCERTAIN");
  const reread = await s.get(ids.h1);
  assert.ok(reread.ok);
  const done = await s.cancel(ids.h1, reread.value.revision);
  assert.equal(done.ok && done.value.status, "cancelled");
  assert.deepEqual(await rowOf("h1"), ["cancelled", 3]);
  assert.equal(await auditCount(), before + 1, "one cancel audit row, nothing else written");
  assert.deepEqual(await post("h", { action: "cancel", payload: { reservationId: ids.h1, expectedRevision: 3 } }),
    { status: 409, body: { ok: false, code: "POSTONA_RESV_ALREADY_FINAL" } }, "a second cancel: final, nothing written");
  assert.deepEqual(await rowOf("h1"), ["cancelled", 3]);
});

Deno.test("HE3 the uncertain row reads uncertain and is final (409); never re-sent", async () => {
  const got = await store("h").get(ids.h3);
  assert.deepEqual(got.ok && got.value.status, "uncertain");
  assert.deepEqual(await post("h", { action: "cancel", payload: { reservationId: ids.h3, expectedRevision: 1 } }),
    { status: 409, body: { ok: false, code: "POSTONA_RESV_ALREADY_FINAL" } });
  assert.deepEqual(await rowOf("h3"), ["uncertain", 1]);
});

Deno.test("HE4 another person: H's row 404, H's account lists nothing (200, no oracle), H's row not cancellable; I's own list is I's", async () => {
  assert.deepEqual(await post("i", { action: "get", payload: { reservationId: ids.h2 } }), { status: 404, body: { ok: false, code: "POSTONA_RESV_NOT_FOUND" } });
  assert.deepEqual(await post("i", { action: "get", payload: { reservationId: crypto.randomUUID() } }), { status: 404, body: { ok: false, code: "POSTONA_RESV_NOT_FOUND" } });
  assert.deepEqual(await post("i", { action: "list", payload: { socialAccountId: H.account } }), { status: 200, body: { ok: true, reservations: [] } });
  assert.deepEqual(await post("i", { action: "cancel", payload: { reservationId: ids.h2, expectedRevision: 1 } }), { status: 404, body: { ok: false, code: "POSTONA_RESV_NOT_FOUND" } });
  const own = await store("i").list(I.account);
  assert.deepEqual(own.ok && own.value.map((r) => r.reservationId), [ids.i1]);
  assert.deepEqual(await rowOf("h2"), ["planned", 1]);
});

Deno.test("HE5 anonymous, unknown anonymity, no session, an ended / foreign session, a token of another subject, an unknown token: 401, no database", async () => {
  const c0 = connects;
  for (const alias of ["h_anon", "h_unknown", "h_no_session", "h_as_i", "nobody"]) {
    for (const call of [{ action: "get", payload: { reservationId: ids.h2 } }, { action: "list", payload: { socialAccountId: H.account } },
                        { action: "cancel", payload: { reservationId: ids.h2, expectedRevision: 1 } }]) {
      assert.deepEqual(await post(alias, call), { status: 401, body: { ok: false, code: "AUTH_REQUIRED" } }, `${alias} ${call.action}`);
    }
  }
  assert.equal(connects, c0, "none of them reached the database");
  // a live-looking token whose session is not H's live session: the database's S2-2 gate refuses (401 from SQL)
  assert.deepEqual(await post("h_other_session", { action: "get", payload: { reservationId: ids.h2 } }), { status: 401, body: { ok: false, code: "POSTONA_RESV_AUTH_REQUIRED" } });
  await owner("update auth.sessions set not_after = now() - interval '1 second' where user_id = $1::uuid", [H.user]);
  try {
    assert.deepEqual(await post("h", { action: "list", payload: { socialAccountId: H.account } }), { status: 401, body: { ok: false, code: "POSTONA_RESV_AUTH_REQUIRED" } });
    assert.deepEqual(await post("h", { action: "cancel", payload: { reservationId: ids.h2, expectedRevision: 1 } }), { status: 401, body: { ok: false, code: "POSTONA_RESV_AUTH_REQUIRED" } });
  } finally {
    await owner("update auth.sessions set not_after = null where user_id = $1::uuid", [H.user]);
  }
  assert.deepEqual(await rowOf("h2"), ["planned", 1]);
});

Deno.test("HE6 create / reschedule / reconfirm answer 403 before the database (the production permission default); the store's save is a definite failure", async () => {
  const c0 = connects;
  assert.deepEqual(await post("i", { action: "reschedule", payload: { reservationId: ids.i1, expectedRevision: 1, scheduledAt: new Date(Date.now() + 600 * 3600e3).toISOString() } }),
    { status: 403, body: { ok: false, code: "POSTONA_RESV_SERVICE_NOT_ACTIVE" } });
  assert.deepEqual(await post("h", { action: "reconfirm", payload: { reservationId: ids.h2, expectedRevision: 1, contentSha256: "a".repeat(64) } }),
    { status: 403, body: { ok: false, code: "POSTONA_RESV_SERVICE_NOT_ACTIVE" } });
  const created = await post("i", { action: "create", payload: { socialAccountId: I.account, clientBatchId: crypto.randomUUID(), revision: 1, mode: "manual_exact", band: null,
    items: [{ draft_id: "g45new", scheduled_at: new Date(Date.now() + 700 * 3600e3).toISOString(), body: "G3-45 本文", consent: { confirmed: true, content_sha256: "b".repeat(64) } }] } });
  assert.deepEqual(created, { status: 403, body: { ok: false, code: "POSTONA_RESV_SERVICE_NOT_ACTIVE" } });
  assert.equal(connects, c0, "no write reached the database");
  assert.deepEqual(await rowOf("i1"), ["planned", 1]);
});

Deno.test("HE7 H cancels h4 with the revision from a fresh list; I's row stays; the gate OFF answers 503 and touches nothing", async () => {
  const s = store("h");
  const listed = await s.list(H.account);
  const h4 = listed.ok ? listed.value.find((r) => r.reservationId === ids.h4) : undefined;
  assert.ok(h4);
  const done = await s.cancel(ids.h4, h4.revision);
  assert.equal(done.ok && done.value.status, "cancelled");
  assert.deepEqual(await rowOf("i1"), ["planned", 1]);
  const f0 = fetched.length, c0 = connects;
  const off = createHttpHandler({ get: (n) => ENV.get(n) }, { fetch: fakeAuth, connect });
  assert.deepEqual(await post("h", { action: "list", payload: { socialAccountId: H.account } }, off), { status: 503, body: { ok: false, code: "NOT_AVAILABLE" } });
  assert.equal(fetched.length, f0, "gate OFF: no Auth call");
  assert.equal(connects, c0, "gate OFF: no database");
});

Deno.test("HE8 provider send 0: every outbound call of the Edge was the Auth endpoint; nothing was claimed or published", async () => {
  assert.ok(fetched.length > 0);
  assert.deepEqual([...new Set(fetched)], ["https://project.example.invalid/auth/v1/user"]);
  const sent = await owner<[bigint]>("select count(*) from postona_x_resv.reservations r join t45.ids i on i.id = r.id where r.status in ('claimed', 'published')");
  assert.equal(Number(sent[0][0]), 0);
});
