// G3 TASK 14/50: P7 -- 007's cancel_reservation / receipt identify the person by postona_x_resv.caller() = auth.uid() only; they do
// not check that the session in the request is still live, belongs to that person, or is not anonymous. create does (G5's R1).
// Run by postona_threads_p7_session_run.sh only, twice:
//   P7_MODE=current  "P7 Cn" record what 007 did before G3-34 (since caller() asks G5's S2-2 first they FAIL: the runner checks C1-C5)
//   P7_MODE=desired  "Dn"    what a fixed 007 must do (they PASS with G3-34; the runner checks the whole suite passes)
//   "P7 In" / "In"           invariants that must hold in both modes (privilege boundary, no existence leak, U8, R1 evidence)
// The calls are made exactly as the reservation Edge would make them: the API login, SET ROLE postona_resv_api, the request's JWT claims
// as settings (MOCK claims, as a verifier that checked only the signature and expiry would pass them). No JWT is forged or verified.
// The U8 world: the REAL 2a-2 CHECK stays in force; rows are TEST DATA written by the owner. Network: 127.0.0.1 only.
import assert from "node:assert/strict";
import { Client } from "jsr:@db/postgres@0.19.5";

const MODE = Deno.env.get("P7_MODE");
assert.ok(MODE === "current" || MODE === "desired", "P7_MODE=current|desired");
const API_URL = Deno.env.get("THREADS_XO_API_URL")!;
const WORKER_URL = Deno.env.get("THREADS_XO_WORKER_URL")!;
const OWNER_URL = Deno.env.get("THREADS_XO_OWNER_URL")!;
assert.ok(API_URL && WORKER_URL && OWNER_URL, "set by postona_threads_p7_session_run.sh");

async function sql<T extends unknown[]>(url: string, text: string, args: unknown[] = [], setup: string[] = [], commit = false): Promise<T[]> {
  const c = new Client(url);
  await c.connect();
  try {
    if (setup.length === 0) return (await c.queryArray<T>({ text, args })).rows;
    await c.queryArray("BEGIN");
    for (const s of setup) await c.queryArray(s);
    const rows = (await c.queryArray<T>({ text, args })).rows;
    await c.queryArray(commit ? "COMMIT" : "ROLLBACK");
    return rows;
  } finally {
    await c.end().catch(() => undefined);
  }
}
const owner = <T extends unknown[]>(text: string, args: unknown[] = []) => sql<T>(OWNER_URL, text, args);
type Person = { user: string; threads: string; brand: string };
const people = new Map((await owner<[number, string, string, string]>("select n, user_id::text, threads_account, brand from t_ids.people"))
  .map(([n, user, threads, brand]) => [Number(n), { user, threads, brand } as Person]));
const P = (n: number) => people.get(n)!;
// current suite: people 101-115; desired suite: 116-130 (each mode writes its own rows)
const base = MODE === "current" ? 100 : 115;
const N = (k: number) => base + k;

const liveSession = async (user: string) => String((await owner<[string]>("insert into auth.sessions (user_id) values ($1::uuid) returning id::text", [user]))[0][0]);
async function plant(n: number, text: string): Promise<{ id: string; clientId: string }> {
  const [[id, clientId]] = await owner<[string, string]>(
    `insert into postona_threads_resv.reservations (user_id, brand_id, social_account_id, client_request_id, body, content_sha256, scheduled_at,
       bound_owner_epoch, bound_lifecycle_version)
     select p.user_id, p.brand, p.threads_account, gen_random_uuid(), $2, encode(sha256(convert_to($2, 'UTF8')), 'hex'), now() + interval '1 hour',
       private.account_lifecycle_brand_owner_epoch(p.brand), (select a.lifecycle_version from public.common_accounts a where a.user_id = p.user_id)
     from t_ids.people p where p.n = $1 returning id::text, client_request_id::text`, [n, text]);
  return { id, clientId };
}
const status = async (id: string) => (await owner<[string]>("select status from postona_threads_resv.reservations where id = $1::uuid", [id]))[0][0];
type Claims = Record<string, unknown>;
const claimsOf = (user: string, session: string, extra: Claims = {}) => JSON.stringify({ sub: user, role: "authenticated", session_id: session, is_anonymous: false, ...extra });
/** As the reservation Edge would call 007: API login, SET ROLE postona_resv_api, the request's claims. Commits like the person store. */
async function asEdge(claims: string | null, text: string, args: unknown[]): Promise<{ ok: true; rows: unknown[][] } | { ok: false; code: string }> {
  const setup = ["set local role postona_resv_api"];
  if (claims !== null) setup.push(`select set_config('request.jwt.claims', '${claims}', true)`);
  try {
    return { ok: true, rows: await sql<unknown[]>(API_URL, text, args, setup, true) };
  } catch (e) {
    const f = (e as { fields?: { code?: string; message?: string } }).fields;
    return { ok: false, code: f?.message?.startsWith("POSTONA") ? f.message : f?.code ?? "error" };
  }
}
const receipt = (claims: string | null, account: string, clientId: string) =>
  asEdge(claims, "select reservation_id::text, state from postona_threads_resv.receipt($1, $2::uuid)", [account, clientId]);
const cancel = (claims: string | null, id: string) => asEdge(claims, "select postona_threads_resv.cancel_reservation($1::uuid)", [id]);

/** The P7 cases: the same request is answered today; a fixed 007 must refuse it and change nothing. */
type Case = { label: string; claims: (n: number) => Promise<string> };
const cases: Case[] = [
  { label: "the session row was revoked (deleted: signed out)", claims: async (n) => {
    const s = await liveSession(P(n).user);
    await owner("delete from auth.sessions where id = $1::uuid", [s]);
    return claimsOf(P(n).user, s);
  } },
  { label: "the session expired (not_after in the past)", claims: async (n) => {
    const s = await liveSession(P(n).user);
    await owner("update auth.sessions set not_after = now() - interval '1 minute' where id = $1::uuid", [s]);
    return claimsOf(P(n).user, s);
  } },
  { label: "the subject matches but the session is another person's live session", claims: async (n) => claimsOf(P(n).user, await liveSession(P(N(15)).user)) },
  { label: "a session id that never existed", claims: (n) => Promise.resolve(claimsOf(P(n).user, crypto.randomUUID())) },
  { label: "an anonymous sign-in (is_anonymous: true) with the person's subject and a live session", claims: async (n) => claimsOf(P(n).user, await liveSession(P(n).user), { is_anonymous: true }) },
];

cases.forEach((c, i) => {
  const k = i + 1;
  Deno.test(MODE === "current" ? `P7 C${k} TODAY: ${c.label} -> receipt and cancel still answer the owner` : `D${k} DESIRED: ${c.label} -> receipt and cancel refuse, nothing changes`, async () => {
    const n = N(k);
    const row = await plant(n, `P7 ${k} 本文`);
    const claims = await c.claims(n);
    const r = await receipt(claims, P(n).threads, row.clientId);
    const x = await cancel(claims, row.id);
    if (MODE === "current") {
      assert.deepEqual([r.ok, x.ok, await status(row.id)], [true, true, "cancelled"], "today: answered and cancelled (P7)");
    } else {
      assert.equal(r.ok, false, "receipt must refuse");
      assert.equal(x.ok, false, "cancel must refuse");
      assert.equal(await status(row.id), "planned", "nothing changed");
    }
  });
});

const inv = (k: number, label: string) => (MODE === "current" ? `P7 I${k} ${label}` : `I${k} ${label}`);

Deno.test(inv(1, "the boundary: only the reservation API role can call cancel / receipt; anon, authenticated, service_role and the worker get 42501"), async () => {
  for (const [url, role] of [[OWNER_URL, "anon"], [OWNER_URL, "authenticated"], [OWNER_URL, "service_role"], [WORKER_URL, "postona_resv_worker"]] as const) {
    for (const q of ["select postona_threads_resv.cancel_reservation(gen_random_uuid())", "select * from postona_threads_resv.receipt('sa_x', gen_random_uuid())"]) {
      let code = "ran";
      try {
        await sql(url, q, [], [`set local role ${role}`]);
      } catch (e) {
        code = (e as { fields?: { code?: string } }).fields?.code ?? "error";
      }
      assert.equal(code, "42501", `${role}: ${q}`);
    }
  }
  const [[apiCanLogin, authenticatedReaches]] = await owner<[boolean, boolean]>(`select
    (select rolcanlogin from pg_roles where rolname = 'postona_resv_api'),
    pg_has_role('authenticated', 'postona_resv_api', 'MEMBER')`);
  assert.deepEqual([apiCanLogin, authenticatedReaches], [false, false], "a person's PostgREST role cannot become the API role");
});

Deno.test(inv(2, "no existence leak, even with a dead session: another person's reservation answers exactly like an unknown id"), async () => {
  const n = N(8);
  const theirs = await plant(N(9), "P7 I2 theirs");
  const s = await liveSession(P(n).user);
  await owner("delete from auth.sessions where id = $1::uuid", [s]);
  const claims = claimsOf(P(n).user, s);
  assert.deepEqual(await receipt(claims, P(N(9)).threads, theirs.clientId), await receipt(claims, P(N(9)).threads, crypto.randomUUID()));
  assert.deepEqual(await cancel(claims, theirs.id), await cancel(claims, crypto.randomUUID()));
  assert.equal(await status(theirs.id), "planned");
});

Deno.test(inv(3, "no claims at all -> AUTH_REQUIRED for both (caller() refuses a missing subject)"), async () => {
  const row = await plant(N(10), "P7 I3");
  assert.deepEqual(await receipt(null, P(N(10)).threads, row.clientId), { ok: false, code: "POSTONA_RESV_AUTH_REQUIRED" });
  assert.deepEqual(await cancel(null, row.id), { ok: false, code: "POSTONA_RESV_AUTH_REQUIRED" });
  assert.equal(await status(row.id), "planned");
});

Deno.test(inv(4, "evidence for fix (A): G5's REAL R1, asked with the SAME claims, refuses every P7 case (SESSION_REVOKED / SESSION_EXPIRED / AUTH_REQUIRED)"), async () => {
  const seen: string[] = [];
  for (const [i, c] of cases.entries()) {
    const n = N(11 + (i % 2));
    const claims = await c.claims(n);
    const [[v]] = await sql<[Record<string, unknown>]>(OWNER_URL, "select public.common_account_authorization_verdict('postona', 'read_workspace', $1)", [P(n).brand],
      [`select set_config('request.jwt.claims', '${claims}', true)`, "set local role authenticated"]);
    assert.notEqual(v.decision, "allow", c.label);
    seen.push(String(v.reason));
  }
  console.log(`P7 I4 R1 reasons: ${seen.join(",")}`);
});

Deno.test(inv(5, "U8 stays fail-closed: create is refused (PUBLISH_DISABLED) with a live session; nothing is published"), async () => {
  const n = N(13);
  const claims = claimsOf(P(n).user, await liveSession(P(n).user));
  const r = await asEdge(claims, "select * from postona_threads_resv.create_reservation($1, gen_random_uuid(), 'P7 I5', encode(sha256(convert_to('P7 I5', 'UTF8')), 'hex'), now() + interval '10 minutes')", [P(n).threads]);
  assert.deepEqual(r, { ok: false, code: "POSTONA_THREADS_RESV_PUBLISH_DISABLED" });
  const [[published, on]] = await owner<[bigint, bigint]>(`select (select count(*) from postona_threads_resv.reservations where status = 'published'),
    (select count(*) from public.social_accounts where platform = 'threads' and publish_enabled)`);
  assert.deepEqual([Number(published), Number(on)], [0, 0]);
});

if (MODE === "current") {
  Deno.test("P7 Q1 TODAY (an IF question, not asserted as right or wrong): after the workspace owner changes A -> B, A still reads and cancels A's own row", async () => {
    const a = N(14), b = N(15);
    const row = await plant(a, "P7 Q1");
    await owner("insert into public.brand_memberships (brand_id, user_id, role) values ($1, $2::uuid, 'owner')", [P(a).brand, P(b).user]);
    await owner("delete from public.brand_memberships where brand_id = $1 and user_id = $2::uuid", [P(a).brand, P(a).user]);
    const claims = claimsOf(P(a).user, await liveSession(P(a).user));
    const r = await receipt(claims, P(a).threads, row.clientId);
    const x = await cancel(claims, row.id);
    assert.deepEqual([r.ok, x.ok, await status(row.id)], [true, true, "cancelled"]);
    console.log("P7 Q1: 007 keys cancel / receipt on the row's user_id, not on the workspace's current owner");
  });
}
