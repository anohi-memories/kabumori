// G3-02 #1 (TEST ONLY, fake data): X / Threads reservations through the REAL local Supabase runtime, run by run.sh after
// `rollout.sh install`. Every HTTP call goes through the real Kong (verify_jwt) and the real Edge runtime; the twins run the real handlers
// with the real GoTrue verifying real user JWTs, and the real database as the test's login member of postona_resv_api / _worker.
// Rows the HTTP API cannot create today (create is permission-gated: PERMISSIONS_NOT_CONNECTED) are written through the API role's own
// SQL path (postona_x_resv.create_batch) by the same login member -- labelled SEED. Test-world stand-ins are labelled SYNTHETIC.
// Nothing here calls X, Threads, OAuth, a managed project or a paid API.
import assert from "node:assert/strict";

const API = Deno.env.get("G3LS_API")!;
const PUBLISHABLE = Deno.env.get("G3LS_PUBLISHABLE")!;
const DB_PORT = Deno.env.get("G3LS_DB_PORT")!;
const API_PW = Deno.env.get("G3LS_API_PW")!;
const WORKER_PW = Deno.env.get("G3LS_WORKER_PW")!;
const WORKER_SECRET = Deno.env.get("G3LS_WORKER_SECRET")!;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

type Person = { token: string; userId: string; sessionId: string; email: string; password: string; account?: string };
type Answer = { status: number; body: Record<string, unknown> };

const claimsOf = (token: string) => {
  const part = token.split(".")[1];
  return JSON.parse(atob(part.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(part.length / 4) * 4, "="))) as Record<string, unknown>;
};

async function psql(user: string, password: string, script: string, vars: Record<string, string> = {}): Promise<string> {
  const args = ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", DB_PORT, "-U", user, "-d", "postgres"];
  for (const [k, v] of Object.entries(vars)) args.push("-v", `${k}=${v}`);
  const child = new Deno.Command("psql", { args, env: { PGPASSWORD: password }, stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(script));
  await writer.close();
  const out = await child.output();
  const text = new TextDecoder().decode(out.stdout).trim();
  const err = new TextDecoder().decode(out.stderr);
  if (!out.success) return "ERR:" + (err.match(/ERROR:\s+(.*)/u)?.[1] ?? err.trim().split("\n")[0].slice(0, 200));
  return text;
}
const owner = (script: string, vars: Record<string, string> = {}) => psql("postgres", "postgres", script, vars);
const CLAIMS = "select set_config('request.jwt.claims', json_build_object('sub', :'u', 'role', 'authenticated', 'session_id', :'s', 'is_anonymous', false)::text, true) \\gset x_\n";

async function http(fn: string, body: unknown, token?: string, extra: Record<string, string> = {}): Promise<Answer> {
  const headers: Record<string, string> = { apikey: PUBLISHABLE, "content-type": "application/json", ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`${API}/functions/v1/${fn}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  const text = await r.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
}
const X = "postona-x-reservations-localtest";
const TH = "postona-threads-reservations-localtest";
const WK = "postona-x-reservation-worker-localtest";
const code = (a: Answer) => `${a.status} ${a.body.code ?? (a.body.ok === true ? "ok" : JSON.stringify(a.body).slice(0, 80))}`;
const rows = (a: Answer) => (a.body.reservations ?? []) as Array<Record<string, unknown>>;

async function auth(path: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { apikey: PUBLISHABLE, "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return await fetch(`${API}/auth/v1/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}
async function signUp(label: string): Promise<Person> {
  const email = `g3ls-${label}-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const password = crypto.randomUUID();
  const r = await auth("signup", { email, password });
  const j = await r.json();
  assert.deepStrictEqual(r.status, 200, `sign-up ${label}`);
  const c = claimsOf(j.access_token);
  assert.deepStrictEqual([c.role, c.is_anonymous, UUID_RE.test(String(c.session_id))], ["authenticated", false, true], `GoTrue claims ${label}`);
  return { token: j.access_token, userId: String(c.sub), sessionId: String(c.session_id), email, password };
}

// SYNTHETIC G5 W0 (G5 #320 TASK 51 is in progress): G5's own start_x_autopost_service() under the person's real claims. Then G4's REAL X
// connect SQL (begin / complete; fake tokens into the local real Vault). Returns the X account id.
async function seedPerson(p: Person, label: string): Promise<string> {
  const out = await owner(`begin;\n${CLAIMS}
select public.start_x_autopost_service() \\gset y_
update public.brands set code_profile_key = 'social_mobile_user_v1' where id = public.social_mobile_account_deletion_workspace(:'u'::uuid);
select 1 as began from public.begin_social_mobile_x_oauth_connection(md5(:'l') || md5(:'l' || '#'), 'kabumori-social://oauth-callback', now() + interval '10 minutes') \\gset z_
select public.complete_social_mobile_x_oauth_connection((select id from public.social_account_oauth_states where state_hash = md5(:'l') || md5(:'l' || '#')),
  :'puid', '@h_' || :'puid', 'fakeXat_' || :'l', 'fakeXrt_' || :'l')::text as completed \\gset w_
commit;
select sa.id from public.social_accounts sa where sa.platform = 'x' and sa.brand_id = public.social_mobile_account_deletion_workspace(:'u'::uuid);`,
    { u: p.userId, s: p.sessionId, l: `g3ls-${label}-${p.userId}`, puid: String(62000 + Math.floor(Math.random() * 900)) });
  assert.match(out, /^sa_[0-9a-f]{24}$/u, `X connect ${label}: ${out}`);
  return out;
}
const xVerdict = (p: Person) =>
  owner("select r.verified::text || '|' || r.code from postona_g4_credential.x_publish_credential_verdict(:'u'::uuid, :'a') r", { u: p.userId, a: p.account! });

// SEED through the API role's own SQL path (the HTTP create is permission-gated today), as the test login member
async function seedReservation(p: Person, name: string, hours: number): Promise<string> {
  const body = `G3-02 本文 ${name}`;
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))).map((b) => b.toString(16).padStart(2, "0")).join("");
  const out = await psql("g3ls_api_login", API_PW, `begin;\n${CLAIMS}set local role postona_resv_api;
select string_agg(reservation_id::text, ',') from postona_x_resv.create_batch(:'a', gen_random_uuid(), 1, 'manual_exact', null,
  jsonb_build_array(jsonb_build_object('draft_id', :'d', 'scheduled_at', now() + make_interval(hours => :h), 'body', :'b',
    'consent', jsonb_build_object('confirmed', true, 'content_sha256', :'sha'))));
commit;`, { u: p.userId, s: p.sessionId, a: p.account!, d: `g3ls${name}`, h: String(hours), b: body, sha });
  assert.match(out, UUID_RE, `seed ${name}: ${out}`);
  return out;
}
const rowState = (id: string) => owner("select status || '/' || revision || '/' || coalesce(outcome_code, '-') from postona_x_resv.reservations where id = :'i'", { i: id });

Deno.test("G3-02 #1 reservations on the real local Supabase runtime", async (t) => {
  const a = await signUp("a");
  const b = await signUp("b");

  await t.step("L0 the real entries (release gates OFF in source) answer 503 NOT_AVAILABLE on the real runtime", async () => {
    for (const fn of ["postona-x-reservations", "postona-threads-reservations", "postona-x-single-post"]) {
      assert.deepStrictEqual(code(await http(fn, { action: "list", payload: {} }, a.token)), "503 NOT_AVAILABLE", fn);
    }
    assert.deepStrictEqual(code(await http("postona-x-reservation-worker", {}, undefined, { "x-postona-worker-secret": WORKER_SECRET })), "503 NOT_AVAILABLE", "worker");
  });

  await t.step("L1 two real GoTrue people, workspace (SYNTHETIC W0) + G4's real X connect; G4 verdict VERIFIED", async () => {
    a.account = await seedPerson(a, "a");
    b.account = await seedPerson(b, "b");
    assert.deepStrictEqual(await xVerdict(a), "true|VERIFIED");
    assert.deepStrictEqual(await xVerdict(b), "true|VERIFIED");
  });

  let r1 = "";
  await t.step("L2 401: no apikey / garbage token at the gateway; no bearer, anonymous sign-in, signed-out session at the handler", async () => {
    const list = { action: "list", payload: { socialAccountId: a.account } };
    const bare = await fetch(`${API}/functions/v1/${X}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(list) });
    await bare.body?.cancel();
    assert.deepStrictEqual(bare.status, 401, "no apikey, no token: the gateway");
    assert.deepStrictEqual((await http(X, list, "not.a.jwt.at-all-0000")).status, 401, "garbage token: the gateway");
    assert.deepStrictEqual(code(await http(X, list)), "401 AUTH_REQUIRED", "apikey only");
    const anon = await (await auth("signup", {})).json();
    assert.deepStrictEqual(claimsOf(anon.access_token).is_anonymous, true);
    assert.deepStrictEqual(code(await http(X, list, anon.access_token)), "401 AUTH_REQUIRED", "anonymous sign-in");
    // a second session of A, signed out (scope local): refused, while A's first session still answers
    const a2 = await (await auth("token?grant_type=password", { email: a.email, password: a.password })).json();
    assert.ok(claimsOf(a2.access_token).session_id !== a.sessionId);
    assert.deepStrictEqual(code(await http(X, list, a2.access_token)), "200 ok", "A's second session before sign-out");
    const out = await fetch(`${API}/auth/v1/logout?scope=local`, { method: "POST", headers: { apikey: PUBLISHABLE, authorization: `Bearer ${a2.access_token}` } });
    await out.body?.cancel();
    assert.deepStrictEqual(out.status, 204);
    assert.deepStrictEqual(code(await http(X, list, a2.access_token)), "401 AUTH_REQUIRED", "A's signed-out session");
    assert.deepStrictEqual(code(await http(X, list, a.token)), "200 ok", "A's first session still live");
  });

  await t.step("L3 A lists (empty), SEED r1, A lists / gets it back over HTTP", async () => {
    assert.deepStrictEqual(rows(await http(X, { action: "list", payload: { socialAccountId: a.account } }, a.token)).length, 0);
    r1 = await seedReservation(a, "r1", 3);
    const listed = rows(await http(X, { action: "list", payload: { socialAccountId: a.account } }, a.token));
    assert.deepStrictEqual(listed.map((r) => `${r.reservationId}/${r.status}/${r.revision}/${r.consentState}`), [`${r1}/planned/1/confirmed`]);
    const got = rows(await http(X, { action: "get", payload: { reservationId: r1 } }, a.token));
    assert.deepStrictEqual(got.map((r) => r.body), ["G3-02 本文 r1"]);
  });

  await t.step("L4 workspace / person separation: B cannot read, list or cancel A's row (404 / empty), A's row unchanged", async () => {
    assert.deepStrictEqual(code(await http(X, { action: "get", payload: { reservationId: r1 } }, b.token)), "404 POSTONA_RESV_NOT_FOUND");
    assert.deepStrictEqual(rows(await http(X, { action: "list", payload: { socialAccountId: a.account } }, b.token)).length, 0);
    assert.deepStrictEqual(code(await http(X, { action: "cancel", payload: { reservationId: r1, expectedRevision: 1 } }, b.token)), "404 POSTONA_RESV_NOT_FOUND");
    assert.deepStrictEqual(await rowState(r1), "planned/1/-");
  });

  await t.step("L5 STALE_REVISION 409 -> re-read -> cancel with the read revision; a second cancel is refused (ALREADY_FINAL)", async () => {
    assert.deepStrictEqual(code(await http(X, { action: "cancel", payload: { reservationId: r1, expectedRevision: 2 } }, a.token)), "409 POSTONA_RESV_STALE_REVISION");
    assert.deepStrictEqual(await rowState(r1), "planned/1/-");
    const rev = rows(await http(X, { action: "get", payload: { reservationId: r1 } }, a.token))[0].revision as number;
    const done = await http(X, { action: "cancel", payload: { reservationId: r1, expectedRevision: rev } }, a.token);
    assert.deepStrictEqual(rows(done).map((r) => r.status), ["cancelled"]);
    const again = rows(await http(X, { action: "get", payload: { reservationId: r1 } }, a.token))[0].revision as number;
    assert.deepStrictEqual(code(await http(X, { action: "cancel", payload: { reservationId: r1, expectedRevision: again } }, a.token)), "409 POSTONA_RESV_ALREADY_FINAL");
  });

  await t.step("L6 default DENY: HTTP create / reschedule / reconfirm answer 403 before the database (nothing written)", async () => {
    const before = await owner("select count(*) from postona_x_resv.reservations");
    const r2 = await seedReservation(a, "r2", 5);
    const sha = "a".repeat(64);
    const create = { action: "create", payload: { socialAccountId: a.account, clientBatchId: crypto.randomUUID(), revision: 1, mode: "manual_exact", band: null,
      items: [{ draft_id: "g3lsc1", scheduled_at: new Date(Date.now() + 9 * 3600e3).toISOString(), body: "x", consent: { confirmed: true, content_sha256: sha } }] } };
    assert.deepStrictEqual(code(await http(X, create, a.token)), "403 POSTONA_RESV_SERVICE_NOT_ACTIVE");
    assert.deepStrictEqual(code(await http(X, { action: "reschedule", payload: { reservationId: r2, expectedRevision: 1, scheduledAt: new Date(Date.now() + 11 * 3600e3).toISOString() } }, a.token)), "403 POSTONA_RESV_SERVICE_NOT_ACTIVE");
    assert.deepStrictEqual(code(await http(X, { action: "reconfirm", payload: { reservationId: r2, expectedRevision: 1, contentSha256: sha } }, a.token)), "403 POSTONA_RESV_SERVICE_NOT_ACTIVE");
    assert.deepStrictEqual(await owner("select count(*) from postona_x_resv.reservations"), String(Number(before) + 1));
    assert.deepStrictEqual(await rowState(r2), "planned/1/-");
  });

  await t.step("L7 service end (SYNTHETIC, the entitlement as G5's end leaves it): the person still cancels their own planned row", async () => {
    const r3 = await seedReservation(a, "r3", 7);
    await owner("update public.service_entitlements set status = 'ended', ended_at = now() where user_id = :'u' and service_key = 'x_autopost'", { u: a.userId });
    const done = rows(await http(X, { action: "cancel", payload: { reservationId: r3, expectedRevision: 1 } }, a.token));
    assert.deepStrictEqual(done.map((r) => r.status), ["cancelled"]);
    assert.deepStrictEqual(await xVerdict(a), "false|SERVICE_NOT_ACTIVE");
    await owner("update public.service_entitlements set status = 'active', ended_at = null where user_id = :'u' and service_key = 'x_autopost'", { u: a.userId });
    assert.deepStrictEqual(await xVerdict(a), "true|VERIFIED");
  });

  await t.step("L8 unknown send: an uncertain row is never re-sent nor cancelled; the worker entry claims nothing (credential source deny)", async () => {
    const r4 = await seedReservation(a, "r4", 9);
    const r5 = await seedReservation(a, "r5", 11);
    // SYNTHETIC time: both due now (as smoke.sql's g51.xdue)
    await owner("update postona_x_resv.reservations set scheduled_at = now() - interval '1 minute', consent_scheduled_at = now() - interval '1 minute', expires_at = now() + interval '6 hours' where id in (:'i', :'j')", { i: r4, j: r5 });
    // the worker entry first: deny -> nothing claimed, r4 / r5 still planned
    const run = await http(WK, {}, undefined, { "x-postona-worker-secret": WORKER_SECRET });
    assert.deepStrictEqual(run.status, 200);
    assert.deepStrictEqual((run.body.report as Record<string, unknown>).claimed, 0);
    assert.deepStrictEqual((run.body.report as Record<string, unknown>).notAvailable, true);
    assert.deepStrictEqual(code(await http(WK, {}, undefined, { "x-postona-worker-secret": "w".repeat(48) })), "401 WORKER_AUTH_REQUIRED");
    assert.deepStrictEqual([await rowState(r4), await rowState(r5)], ["planned/1/-", "planned/1/-"]);
    // the worker role's own SQL (claim -> finish uncertain), as the test login member: r4 may have been sent
    const fin = await psql("g3ls_worker_login", WORKER_PW, `set role postona_resv_worker;
create temp table c as select * from postona_x_resv.claim_due('g3ls', 120, 50);
select postona_x_resv.finish(:'i', (select lease_token from c where reservation_id = :'i'), 'uncertain', null, 'X_OUTCOME_UNKNOWN');
select postona_x_resv.release_unsent(:'j', (select lease_token from c where reservation_id = :'j'));`, { i: r4, j: r5 });
    assert.deepStrictEqual(fin.split("\n")[0], "uncertain", fin);
    const got = rows(await http(X, { action: "get", payload: { reservationId: r4 } }, a.token))[0];
    assert.deepStrictEqual(got.status, "uncertain");
    assert.deepStrictEqual(code(await http(X, { action: "cancel", payload: { reservationId: r4, expectedRevision: got.revision } }, a.token)), "409 POSTONA_RESV_ALREADY_FINAL");
    const again = await http(WK, {}, undefined, { "x-postona-worker-secret": WORKER_SECRET });
    assert.deepStrictEqual((again.body.report as Record<string, unknown>).claimed, 0);
    assert.match(await rowState(r4), /^uncertain\/[0-9]+\/X_OUTCOME_UNKNOWN$/u);
    assert.match(await rowState(r5), /^planned\//u);
  });

  await t.step("L9 Threads: G4 VERIFIED (SYNTHETIC binding), create refused by U8 in SQL and 403 over HTTP; receipt / cancel 404", async () => {
    const acct = `th_g3ls_${a.userId.slice(0, 8)}`;
    // SYNTHETIC connected Threads account in G4's binding_row shape (as smoke.sql's g51.tconnect)
    await owner(`insert into public.social_accounts (id, brand_id, platform, handle, platform_user_id, publish_enabled, connection_status, verified_at, vault_access_token_secret_id)
values (:'t', public.social_mobile_account_deletion_workspace(:'u'::uuid), 'threads', '@' || :'t', '17841400000062001', false, 'identity_verified', now(), gen_random_uuid());
insert into public.threads_account_credential_custody (social_account_id, vault_secret_id, expires_at, recorded_by)
select :'t', vault_access_token_secret_id, now() + interval '50 days', :'u'::uuid from public.social_accounts where id = :'t';
insert into postona_threads_binding.bindings (social_account_id, brand_id, threads_user_id, bound_by, oauth_state_id, connect_proof, lifecycle_version, bound_at)
select :'t', brand_id, '17841400000062001', :'u'::uuid, gen_random_uuid(), gen_random_uuid(), (select lifecycle_version from public.common_accounts where user_id = :'u'::uuid), now()
from public.social_accounts where id = :'t';`, { t: acct, u: a.userId });
    assert.deepStrictEqual(await owner("select r.verified::text || '|' || r.code from postona_g4_credential.threads_publish_credential_verdict(:'u'::uuid, :'t') r", { u: a.userId, t: acct }), "true|VERIFIED");
    const sql = await psql("g3ls_api_login", API_PW, `begin;\n${CLAIMS}set local role postona_resv_api;
select reservation_id from postona_threads_resv.create_reservation(:'t', gen_random_uuid(), 'G3-02 Threads', encode(sha256(convert_to('G3-02 Threads', 'UTF8')), 'hex'), now() + interval '5 hours');
commit;`, { u: a.userId, s: a.sessionId, t: acct });
    assert.deepStrictEqual(sql, "ERR:POSTONA_THREADS_RESV_PUBLISH_DISABLED");
    const create = { action: "create", payload: { socialAccountId: acct, clientRequestId: crypto.randomUUID(), text: "G3-02 Threads", contentSha256: "b".repeat(64), scheduledAt: new Date(Date.now() + 5 * 3600e3).toISOString() } };
    assert.deepStrictEqual(code(await http(TH, create, a.token)), "403 POSTONA_THREADS_RESV_SERVICE_NOT_ACTIVE");
    assert.deepStrictEqual(code(await http(TH, { action: "receipt", payload: { socialAccountId: acct, clientRequestId: crypto.randomUUID() } }, a.token)), "404 POSTONA_THREADS_RESV_NOT_FOUND");
    assert.deepStrictEqual(code(await http(TH, { action: "cancel", payload: { reservationId: crypto.randomUUID() } }, a.token)), "404 POSTONA_THREADS_RESV_NOT_FOUND");
    assert.deepStrictEqual(code(await http(TH, { action: "receipt", payload: { socialAccountId: acct, clientRequestId: crypto.randomUUID() } })), "401 AUTH_REQUIRED");
    assert.deepStrictEqual(await owner("select count(*) from postona_threads_resv.reservations"), "0");
  });

  await t.step("L10 no grant: PostgREST does not expose G3 / G4; the API and worker roles cannot execute G4's verdicts", async () => {
    for (const [schema, fn] of [["postona_x_resv", "list_reservations"], ["postona_threads_resv", "receipt"], ["postona_g4_credential", "x_publish_credential_verdict"]]) {
      const r = await fetch(`${API}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: PUBLISHABLE, authorization: `Bearer ${a.token}`, "content-type": "application/json", "content-profile": schema }, body: "{}" });
      const j = await r.json();
      assert.deepStrictEqual([r.status, j.code], [406, "PGRST106"], `${schema}.${fn}`);
    }
    for (const [user, pw, role] of [["g3ls_api_login", API_PW, "postona_resv_api"], ["g3ls_worker_login", WORKER_PW, "postona_resv_worker"]]) {
      for (const verdict of ["x_publish_credential_verdict", "threads_publish_credential_verdict"]) {
        const out = await psql(user, pw, `set role ${role}; select count(*) from postona_g4_credential.${verdict}(:'u'::uuid, :'a');`, { u: a.userId, a: a.account! });
        assert.match(out, /^ERR:permission denied for (schema|function)/u, `${role} -> ${verdict}`);
      }
      assert.match(await psql(user, pw, "select count(*) from postona_x_resv.reservations;"), /^ERR:permission denied/u, `${user} without SET ROLE`);
    }
  });

  await t.step("L11 the database unreachable for the API login -> 503 STORE_UNAVAILABLE (never a guess); restored -> 200", async () => {
    await owner("alter role g3ls_api_login nologin");
    assert.deepStrictEqual(code(await http(X, { action: "list", payload: { socialAccountId: a.account } }, a.token)), "503 STORE_UNAVAILABLE");
    await owner("alter role g3ls_api_login login");
    assert.deepStrictEqual(code(await http(X, { action: "list", payload: { socialAccountId: a.account } }, a.token)), "200 ok");
  });
});
