// G3-02 #1 / #2 (TEST ONLY, fake data): X / Threads reservations through the REAL local Supabase runtime, run by run.sh after
// `rollout.sh install`. Every HTTP call goes through the real Kong (verify_jwt) and the real Edge runtime; the twins run the real handlers
// with the real GoTrue verifying real user JWTs, and the real database as the test's login member of postona_resv_api / _worker.
// G3-02 #2: the entries' production permission port is the database's own decision (PERMISSIONS_DECIDED_IN_DATABASE), so HTTP create /
// reschedule / reconfirm are decided by G5's person session + service state and G4's verdict inside the owner functions. The person's
// workspace comes from G5's REAL W0 (PR #590, accepted) over PostgREST with the person's JWT. Test-world stand-ins are labelled SYNTHETIC.
// Nothing here calls X, Threads, OAuth, a managed project or a paid API; the worker's X credential source stays NOT_CONNECTED (0 sends).
import assert from "node:assert/strict";
// G3-02 #5: the APP's stores (read-only imports of G3's app client), over the same real HTTP
import { createFetchTransport, createRemoteReservationStore, UNCERTAIN } from "../../../../apps/social-mobile/src/features/schedule/remote-reservation-store.ts";
import { createRemoteThreadsReservationStore } from "../../../../apps/social-mobile/src/features/schedule/remote-threads-reservation-store.ts";
import { reservationErrorAction } from "../../../../apps/social-mobile/src/features/schedule/reservation-error-actions.ts";

const API = Deno.env.get("G3LS_API")!;
const PUBLISHABLE = Deno.env.get("G3LS_PUBLISHABLE")!;
const DB_PORT = Deno.env.get("G3LS_DB_PORT")!;
const API_PW = Deno.env.get("G3LS_API_PW")!;
const WORKER_PW = Deno.env.get("G3LS_WORKER_PW")!;
const WORKER_SECRET = Deno.env.get("G3LS_WORKER_SECRET")!;
const JWT_SECRET = Deno.env.get("G3LS_JWT_SECRET")!; // the local stack's own HS256 secret (only to mint an EXPIRED token)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

type Person = { token: string; userId: string; sessionId: string; email: string; password: string; account?: string };
type Answer = { status: number; body: Record<string, unknown> };

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
const claimsOf = (token: string) => {
  const part = token.split(".")[1];
  return JSON.parse(atob(part.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(part.length / 4) * 4, "="))) as Record<string, unknown>;
};
const sha256 = async (text: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))).map((b) => b.toString(16).padStart(2, "0")).join("");
const at = (days: number, hours = 0) => new Date(Date.now() + days * 86400e3 + hours * 3600e3).toISOString();

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
/** The person's own PostgREST RPC (G5's start / W0), with the person's JWT. */
async function rpc(fn: string, token: string): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${API}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: PUBLISHABLE, authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
  const text = await r.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* raw */ }
  return { status: r.status, body };
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

/** G5's REAL first run over PostgREST with the person's JWT: start the service, then W0 (twice: idempotent). */
async function firstRun(p: Person): Promise<string> {
  const started = await rpc("start_x_autopost_service", p.token);
  assert.deepStrictEqual(started.status, 200, `start: ${JSON.stringify(started.body)}`);
  const w0 = await rpc("postona_ensure_my_personal_workspace", p.token);
  const w = w0.body as Record<string, unknown>;
  assert.deepStrictEqual([w0.status, w.status, w.created], [200, "ready", true], `W0: ${JSON.stringify(w0.body)}`);
  const again = (await rpc("postona_ensure_my_personal_workspace", p.token)).body as Record<string, unknown>;
  assert.deepStrictEqual([again.status, again.workspace_id, again.created], ["ready", w.workspace_id, false]);
  return String(w.workspace_id);
}
/** G4's REAL X connect SQL (begin / complete; fake tokens into the local real Vault) under the person's real claims. The transport is a
 *  stand-in: PR #124's authenticated EXECUTE stays NO_GO, so these run as the owner session carrying the person's claims. */
async function xConnect(p: Person, label: string, puid: string): Promise<string> {
  const out = await owner(`begin;\n${CLAIMS}
select 1 as began from public.begin_social_mobile_x_oauth_connection(md5(:'l') || md5(:'l' || '#'), 'kabumori-social://oauth-callback', now() + interval '10 minutes') \\gset z_
select public.complete_social_mobile_x_oauth_connection((select id from public.social_account_oauth_states where state_hash = md5(:'l') || md5(:'l' || '#')),
  :'puid', '@h_' || :'puid', 'fakeXat_' || :'l', 'fakeXrt_' || :'l')::text as completed \\gset w_
commit;
select sa.id from public.social_accounts sa where sa.platform = 'x' and sa.brand_id = public.social_mobile_account_deletion_workspace(:'u'::uuid);`,
    { u: p.userId, s: p.sessionId, l: `g3ls-${label}-${p.userId}`, puid });
  assert.match(out, /^sa_[0-9a-f]{24}$/u, `X connect ${label}: ${out}`);
  return out;
}
const xDisconnect = (p: Person) => owner(`begin;\n${CLAIMS}select postona_g4_x_oauth.disconnect_x_connection()::text as d \\gset d_\ncommit;\nselect 'done';`, { u: p.userId, s: p.sessionId });
const xVerdict = (p: Person) =>
  owner("select r.verified::text || '|' || r.code from postona_g4_credential.x_publish_credential_verdict(:'u'::uuid, :'a') r", { u: p.userId, a: p.account! });
const g4Generation = (p: Person) =>
  owner("select coalesce(r.credential_generation, 'null') from postona_g4_credential.x_publish_credential_verdict(:'u'::uuid, :'a') r", { u: p.userId, a: p.account! });

async function createPayload(p: Person, name: string, when: string, batch = crypto.randomUUID(), body = `G3-02 本文 ${name}`) {
  return { action: "create", payload: { socialAccountId: p.account, clientBatchId: batch, revision: 1, mode: "manual_exact", band: null,
    items: [{ draft_id: `g3ls_${name}`, scheduled_at: when, body, consent: { confirmed: true, content_sha256: await sha256(body) } }] } };
}
const rowState = (id: string) => owner("select status || '/' || revision || '/' || coalesce(outcome_code, '-') from postona_x_resv.reservations where id = :'i'", { i: id });
const countOf = (sql: string) => owner(sql).then(Number);

Deno.test("G3-02 reservations on the real local Supabase runtime (create decided in the database)", async (t) => {
  const a = await signUp("a");
  const b = await signUp("b");
  const c = await signUp("c");   // signs up only: no service, no workspace

  await t.step("L0 the real entries (release gates OFF in source) answer 503 NOT_AVAILABLE on the real runtime", async () => {
    for (const fn of ["postona-x-reservations", "postona-threads-reservations", "postona-x-single-post"]) {
      assert.deepStrictEqual(code(await http(fn, { action: "list", payload: {} }, a.token)), "503 NOT_AVAILABLE", fn);
    }
    assert.deepStrictEqual(code(await http("postona-x-reservation-worker", {}, undefined, { "x-postona-worker-secret": WORKER_SECRET })), "503 NOT_AVAILABLE", "worker");
  });

  await t.step("L1 G5's real first run over PostgREST (start + W0, idempotent) for A and B; G4's real X connect; G4 verdict VERIFIED", async () => {
    const wa = await firstRun(a);
    const wb = await firstRun(b);
    assert.notDeepStrictEqual(wa, wb);
    // C has not started the service: W0 refuses (G5's own answer), nothing written
    const wc = (await rpc("postona_ensure_my_personal_workspace", c.token)).body as Record<string, unknown>;
    assert.notDeepStrictEqual(wc.status, "ready", `C's W0 without the service: ${JSON.stringify(wc)}`);
    assert.deepStrictEqual(await owner("select count(*) from public.brand_memberships where user_id = :'u'::uuid", { u: c.userId }), "0");
    a.account = await xConnect(a, "a1", "62001");
    b.account = await xConnect(b, "b1", "62002");
    assert.deepStrictEqual([await xVerdict(a), await xVerdict(b)], ["true|VERIFIED", "true|VERIFIED"]);
  });

  await t.step("L2 401: gateway (no apikey, garbage, EXPIRED token) and handler (no bearer, anonymous, signed-out session) -- create included", async () => {
    const create = await createPayload(a, "l2", at(2));
    const bare = await fetch(`${API}/functions/v1/${X}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(create) });
    await bare.body?.cancel();
    assert.deepStrictEqual(bare.status, 401, "no apikey, no token: the gateway");
    assert.deepStrictEqual((await http(X, create, "not.a.jwt.at-all-0000")).status, 401, "garbage token: the gateway");
    // an EXPIRED token for A's own live session, signed with the local stack's HS256 secret (a token Auth itself would have issued)
    const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${enc({ alg: "HS256", typ: "JWT" })}.${enc({ ...claimsOf(a.token), iat: now - 7200, exp: now - 3600 })}`;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const expired = `${unsigned}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned))))}`;
    assert.deepStrictEqual((await http(X, create, expired)).status, 401, "expired token");
    assert.deepStrictEqual(code(await http(X, create)), "401 AUTH_REQUIRED", "apikey only");
    const anon = await (await auth("signup", {})).json();
    assert.deepStrictEqual(claimsOf(anon.access_token).is_anonymous, true);
    assert.deepStrictEqual(code(await http(X, create, anon.access_token)), "401 AUTH_REQUIRED", "anonymous sign-in");
    const a2 = await (await auth("token?grant_type=password", { email: a.email, password: a.password })).json();
    assert.ok(claimsOf(a2.access_token).session_id !== a.sessionId);
    const out = await fetch(`${API}/auth/v1/logout?scope=local`, { method: "POST", headers: { apikey: PUBLISHABLE, authorization: `Bearer ${a2.access_token}` } });
    await out.body?.cancel();
    assert.deepStrictEqual(out.status, 204);
    assert.deepStrictEqual(code(await http(X, create, a2.access_token)), "401 AUTH_REQUIRED", "A's signed-out session");
    assert.deepStrictEqual(await countOf("select count(*) from postona_x_resv.reservations"), 0, "no 401 wrote anything");
  });

  let r1 = "";
  await t.step("L3 HTTP create (real JWT, G5 W0 workspace, active service, G4 VERIFIED) -> planned; list / get read it back", async () => {
    const created = await http(X, await createPayload(a, "r1", at(2)), a.token);
    assert.deepStrictEqual(created.status, 200, code(created));
    const [row] = rows(created);
    assert.deepStrictEqual([row.status, row.revision, row.consentState, row.origin, row.mode], ["planned", 1, "confirmed", "user_authored", "manual_exact"]);
    r1 = String(row.reservationId);
    const listed = rows(await http(X, { action: "list", payload: { socialAccountId: a.account } }, a.token));
    assert.deepStrictEqual(listed.map((r) => r.reservationId), [r1]);
    assert.deepStrictEqual(rows(await http(X, { action: "get", payload: { reservationId: r1 } }, a.token)).map((r) => r.body), ["G3-02 本文 r1"]);
  });

  await t.step("L4 double post: the same clientBatchId + payload answers the same row (one row); the same id with another body -> 409", async () => {
    const batch = crypto.randomUUID();
    const first = await createPayload(a, "r2", at(3), batch);
    const one = rows(await http(X, first, a.token));
    const two = rows(await http(X, first, a.token));
    assert.deepStrictEqual(two.map((r) => r.reservationId), one.map((r) => r.reservationId), "a repeat answers the same reservation");
    assert.deepStrictEqual(await countOf("select count(*) from postona_x_resv.reservations"), 2);
    const changed = await createPayload(a, "r2", at(3), batch, "G3-02 本文 r2 (changed)");
    assert.deepStrictEqual(code(await http(X, changed, a.token)), "409 POSTONA_RESV_IDEMPOTENCY_CONFLICT");
    // the same time again under a new batch: the slot rule (60 min) refuses
    assert.deepStrictEqual(code(await http(X, await createPayload(a, "r2b", at(3)), a.token)), "409 POSTONA_RESV_SLOT_CONFLICT");
    assert.deepStrictEqual(await countOf("select count(*) from postona_x_resv.reservations"), 2);
  });

  await t.step("L5 other person / workspace: B and C cannot create on, read or cancel A's account / rows (404, no oracle); A's rows unchanged", async () => {
    const onA = await createPayload(a, "b_on_a", at(4));
    assert.deepStrictEqual(code(await http(X, onA, b.token)), "404 POSTONA_RESV_ACCOUNT_NOT_FOUND", "B on A's account");
    assert.deepStrictEqual(code(await http(X, onA, c.token)), "404 POSTONA_RESV_ACCOUNT_NOT_FOUND", "C (no service) on A's account");
    assert.deepStrictEqual(code(await http(X, { action: "get", payload: { reservationId: r1 } }, b.token)), "404 POSTONA_RESV_NOT_FOUND");
    assert.deepStrictEqual(code(await http(X, { action: "cancel", payload: { reservationId: r1, expectedRevision: 1 } }, b.token)), "404 POSTONA_RESV_NOT_FOUND");
    assert.deepStrictEqual(code(await http(X, { action: "reschedule", payload: { reservationId: r1, expectedRevision: 1, scheduledAt: at(5) } }, b.token)), "404 POSTONA_RESV_NOT_FOUND");
    assert.deepStrictEqual(rows(await http(X, { action: "list", payload: { socialAccountId: a.account } }, b.token)).length, 0);
    assert.deepStrictEqual(code(await http(X, await createPayload(b, "b1", at(4)), b.token)), "200 ok", "B on B's own account");
    assert.deepStrictEqual(await rowState(r1), "planned/1/-");
  });

  await t.step("L6 reschedule -> needs_reconfirm; a stale revision 409; reconfirm with the content hash; cancel; ALREADY_FINAL", async () => {
    const moved = rows(await http(X, { action: "reschedule", payload: { reservationId: r1, expectedRevision: 1, scheduledAt: at(6) } }, a.token))[0];
    assert.deepStrictEqual([moved.revision, moved.consentState], [2, "needs_reconfirm"]);
    assert.deepStrictEqual(code(await http(X, { action: "reschedule", payload: { reservationId: r1, expectedRevision: 1, scheduledAt: at(7) } }, a.token)), "409 POSTONA_RESV_STALE_REVISION");
    assert.deepStrictEqual(code(await http(X, { action: "reconfirm", payload: { reservationId: r1, expectedRevision: 2, contentSha256: "0".repeat(64) } }, a.token)), "422 POSTONA_RESV_CONSENT_REQUIRED");
    const ok = rows(await http(X, { action: "reconfirm", payload: { reservationId: r1, expectedRevision: 2, contentSha256: await sha256("G3-02 本文 r1") } }, a.token))[0];
    assert.deepStrictEqual(ok.consentState, "confirmed");
    const rev = Number(rows(await http(X, { action: "get", payload: { reservationId: r1 } }, a.token))[0].revision);
    assert.deepStrictEqual(rows(await http(X, { action: "cancel", payload: { reservationId: r1, expectedRevision: rev } }, a.token)).map((r) => r.status), ["cancelled"]);
    const after = Number(rows(await http(X, { action: "get", payload: { reservationId: r1 } }, a.token))[0].revision);
    assert.deepStrictEqual(code(await http(X, { action: "cancel", payload: { reservationId: r1, expectedRevision: after } }, a.token)), "409 POSTONA_RESV_ALREADY_FINAL");
  });

  await t.step("L7 X disconnected (G4's real disconnect): create / reschedule 403 X_ACCOUNT_NOT_VERIFIED, own rows still readable / cancellable; reconnect -> new generation, create 200", async () => {
    const gen1 = await g4Generation(a);
    const r3 = String(rows(await http(X, await createPayload(a, "r3", at(8)), a.token))[0].reservationId);
    assert.deepStrictEqual(await xDisconnect(a), "done");
    assert.match(await xVerdict(a), /^false\|/u);
    assert.deepStrictEqual(code(await http(X, await createPayload(a, "r4", at(9)), a.token)), "403 POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED");
    assert.deepStrictEqual(code(await http(X, { action: "reschedule", payload: { reservationId: r3, expectedRevision: 1, scheduledAt: at(10) } }, a.token)), "403 POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED");
    assert.deepStrictEqual(rows(await http(X, { action: "get", payload: { reservationId: r3 } }, a.token)).length, 1, "the owner still reads it");
    assert.deepStrictEqual(await xConnect(a, "a2", "62001"), a.account, "reconnect keeps the account id");
    assert.deepStrictEqual(await xVerdict(a), "true|VERIFIED");
    assert.notDeepStrictEqual(await g4Generation(a), gen1, "a reconnect is a new G4 generation");
    assert.deepStrictEqual(code(await http(X, await createPayload(a, "r4", at(9)), a.token)), "200 ok");
    assert.deepStrictEqual(rows(await http(X, { action: "cancel", payload: { reservationId: r3, expectedRevision: 1 } }, a.token)).map((r) => r.status), ["cancelled"]);
  });

  await t.step("L8 service end (SYNTHETIC, the entitlement as G5's end leaves it): create 403 SERVICE_NOT_ACTIVE; the person still cancels own rows", async () => {
    const r5 = String(rows(await http(X, await createPayload(a, "r5", at(11)), a.token))[0].reservationId);
    await owner("update public.service_entitlements set status = 'ended', ended_at = now() where user_id = :'u' and service_key = 'x_autopost'", { u: a.userId });
    assert.deepStrictEqual(code(await http(X, await createPayload(a, "r6", at(12)), a.token)), "403 POSTONA_RESV_SERVICE_NOT_ACTIVE");
    assert.deepStrictEqual(code(await http(X, { action: "reconfirm", payload: { reservationId: r5, expectedRevision: 1, contentSha256: await sha256("G3-02 本文 r5") } }, a.token)), "403 POSTONA_RESV_SERVICE_NOT_ACTIVE");
    assert.deepStrictEqual(rows(await http(X, { action: "cancel", payload: { reservationId: r5, expectedRevision: 1 } }, a.token)).map((r) => r.status), ["cancelled"]);
    await owner("update public.service_entitlements set status = 'active', ended_at = null where user_id = :'u' and service_key = 'x_autopost'", { u: a.userId });
    assert.deepStrictEqual(await xVerdict(a), "true|VERIFIED");
  });

  await t.step("L9 nothing is sent: the worker entry claims nothing (credential source deny); an uncertain row is never re-sent nor cancelled", async () => {
    const r7 = String(rows(await http(X, await createPayload(a, "r7", at(13)), a.token))[0].reservationId);
    const r8 = String(rows(await http(X, await createPayload(a, "r8", at(14)), a.token))[0].reservationId);
    // SYNTHETIC time: both due now, two hours apart (the 60-minute slot rule keeps holding between them)
    await owner("update postona_x_resv.reservations set scheduled_at = now() - interval '1 minute', consent_scheduled_at = now() - interval '1 minute', expires_at = now() + interval '6 hours' where id = :'i'", { i: r7 });
    await owner("update postona_x_resv.reservations set scheduled_at = now() - interval '121 minutes', consent_scheduled_at = now() - interval '121 minutes', expires_at = now() + interval '6 hours' where id = :'j'", { j: r8 });
    const run = await http(WK, {}, undefined, { "x-postona-worker-secret": WORKER_SECRET });
    assert.deepStrictEqual([run.status, (run.body.report as Record<string, unknown>).claimed, (run.body.report as Record<string, unknown>).notAvailable], [200, 0, true]);
    assert.deepStrictEqual(code(await http(WK, {}, undefined, { "x-postona-worker-secret": "w".repeat(48) })), "401 WORKER_AUTH_REQUIRED");
    assert.deepStrictEqual([await rowState(r7), await rowState(r8)], ["planned/1/-", "planned/1/-"]);
    // the worker role's own SQL (claim -> finish uncertain) as the test login member: r7 may have been sent
    const fin = await psql("g3ls_worker_login", WORKER_PW, `set role postona_resv_worker;
create temp table c as select * from postona_x_resv.claim_due('g3ls', 120, 50);
select postona_x_resv.finish(:'i', (select lease_token from c where reservation_id = :'i'), 'uncertain', null, 'X_OUTCOME_UNKNOWN');
select postona_x_resv.release_unsent(:'j', (select lease_token from c where reservation_id = :'j'));`, { i: r7, j: r8 });
    assert.deepStrictEqual(fin.split("\n")[0], "uncertain", fin);
    const got = rows(await http(X, { action: "get", payload: { reservationId: r7 } }, a.token))[0];
    assert.deepStrictEqual(got.status, "uncertain");
    assert.deepStrictEqual(code(await http(X, { action: "cancel", payload: { reservationId: r7, expectedRevision: got.revision } }, a.token)), "409 POSTONA_RESV_ALREADY_FINAL");
    assert.deepStrictEqual(code(await http(X, { action: "reschedule", payload: { reservationId: r7, expectedRevision: got.revision, scheduledAt: at(15) } }, a.token)), "409 POSTONA_RESV_NOT_PLANNED");
    const again = await http(WK, {}, undefined, { "x-postona-worker-secret": WORKER_SECRET });
    assert.deepStrictEqual((again.body.report as Record<string, unknown>).claimed, 0);
    assert.match(await rowState(r7), /^uncertain\/[0-9]+\/X_OUTCOME_UNKNOWN$/u);
    assert.deepStrictEqual(await countOf("select count(*) from postona_x_resv.reservations where status = 'published' or provider_post_id is not null"), 0, "zero sends");
  });

  await t.step("L10 Threads through HTTP: G4 VERIFIED (SYNTHETIC binding) but create 403 PUBLISH_DISABLED from the database (U8); receipt / cancel 404", async () => {
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
    const text = "G3-02 Threads";
    const create = { action: "create", payload: { socialAccountId: acct, clientRequestId: crypto.randomUUID(), text, contentSha256: await sha256(text), scheduledAt: at(5) } };
    assert.deepStrictEqual(code(await http(TH, create, a.token)), "403 POSTONA_THREADS_RESV_PUBLISH_DISABLED", "U8, decided in the database");
    assert.deepStrictEqual(code(await http(TH, create, b.token)), "404 POSTONA_THREADS_RESV_ACCOUNT_NOT_FOUND", "another person");
    assert.deepStrictEqual(code(await http(TH, { action: "receipt", payload: { socialAccountId: acct, clientRequestId: crypto.randomUUID() } }, a.token)), "404 POSTONA_THREADS_RESV_NOT_FOUND");
    assert.deepStrictEqual(code(await http(TH, { action: "cancel", payload: { reservationId: crypto.randomUUID() } }, a.token)), "404 POSTONA_THREADS_RESV_NOT_FOUND");
    assert.deepStrictEqual(code(await http(TH, create)), "401 AUTH_REQUIRED");
    assert.deepStrictEqual(await owner("select publish_enabled::text from public.social_accounts where id = :'t'", { t: acct }), "false", "U8 untouched");
    assert.deepStrictEqual(await countOf("select count(*) from postona_threads_resv.reservations"), 0);
  });

  await t.step("L11 no grant: PostgREST does not expose G3 / G4; the API and worker roles cannot execute G4's verdicts", async () => {
    for (const [schema, fn] of [["postona_x_resv", "create_batch"], ["postona_threads_resv", "create_reservation"], ["postona_g4_credential", "x_publish_credential_verdict"]]) {
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

  await t.step("L12 the database unreachable for the API login -> create 503 STORE_UNAVAILABLE (never a guess), nothing written; restored -> 200", async () => {
    const before = await countOf("select count(*) from postona_x_resv.reservations");
    await owner("alter role g3ls_api_login nologin");
    assert.deepStrictEqual(code(await http(X, await createPayload(a, "r9", at(16)), a.token)), "503 STORE_UNAVAILABLE");
    await owner("alter role g3ls_api_login login");
    assert.deepStrictEqual(await countOf("select count(*) from postona_x_resv.reservations"), before);
    assert.deepStrictEqual(code(await http(X, { action: "list", payload: { socialAccountId: a.account } }, a.token)), "200 ok");
  });
  // ---- G3-02 #5: the app's stores through the real Kong / GoTrue / Edge / Postgres -----------------------------------------------------
  const appX = (token: string | null, apiKey: string | undefined = PUBLISHABLE) => createRemoteReservationStore({
    transport: createFetchTransport({ url: `${API}/functions/v1/${X}`, fetch, apiKey, allowLoopbackHttpForTests: true }),
    getAccessToken: () => Promise.resolve(token),
  });
  const appTh = (token: string | null) => createRemoteThreadsReservationStore({
    transport: createFetchTransport({ url: `${API}/functions/v1/${TH}`, fetch, apiKey: PUBLISHABLE, allowLoopbackHttpForTests: true }) as never,
    getAccessToken: () => Promise.resolve(token),
  });
  const saveRequest = async (p: Person, name: string, when: string, batch = crypto.randomUUID()) => {
    const body = `G3-02 app ${name}`;
    return { socialAccountId: p.account!, clientBatchId: batch, revision: 1, mode: "manual_exact" as const, band: null,
      items: [{ draft_id: `g3app_${name}`, scheduled_at: when, body, consent: { confirmed: true as const, content_sha256: await sha256(body) } }] };
  };

  await t.step("L13 the app's X store: save -> read-back saved; edit -> reconfirm -> cancel; each refusal routed to the screen action; unknown never saved", async () => {
    const s = appX(a.token);
    const req = await saveRequest(a, "s1", at(20));
    const saved = await s.save(req);
    assert.deepStrictEqual(saved.kind, "saved", JSON.stringify(saved));
    const row = saved.kind === "saved" ? saved.reservations[0] : null;
    assert.ok(row);
    assert.deepStrictEqual((await s.save(req)).kind, "saved", "a retry of the same request: the same row, still saved");
    assert.deepStrictEqual(rows(await http(X, { action: "list", payload: { socialAccountId: a.account } }, a.token)).filter((r) => r.draftId === "g3app_s1").length, 1);
    const moved = await s.reschedule(row.reservationId, row.revision, at(21));
    assert.ok(moved.ok && moved.value.consentState === "needs_reconfirm", JSON.stringify(moved));
    const confirmed = await s.reconfirm(row.reservationId, moved.value.revision, await sha256("G3-02 app s1"));
    assert.ok(confirmed.ok && confirmed.value.consentState === "confirmed", JSON.stringify(confirmed));
    const stale = await s.cancel(row.reservationId, row.revision);
    assert.deepStrictEqual([stale, reservationErrorAction(stale.ok ? "" : stale.code)], [{ ok: false, code: "POSTONA_RESV_STALE_REVISION" }, "reload"]);
    const reread = await s.get(row.reservationId);
    assert.ok(reread.ok);
    const cancelled = await s.cancel(row.reservationId, reread.value.revision);
    assert.ok(cancelled.ok && cancelled.value.status === "cancelled", JSON.stringify(cancelled));
    // another person: not found (no oracle)
    const other = await appX(b.token).get(row.reservationId);
    assert.deepStrictEqual([other, reservationErrorAction(other.ok ? "" : other.code)], [{ ok: false, code: "POSTONA_RESV_NOT_FOUND" }, "not_found"]);
    // 401s are definite (nothing written): a garbage token at the gateway, a signed-out session at the handler
    const n0 = await countOf("select count(*) from postona_x_resv.reservations");
    const garbage = await appX("not.a.jwt.at-all-0000").save(await saveRequest(a, "s2", at(22)));
    assert.deepStrictEqual([garbage, reservationErrorAction(garbage.kind === "failed" ? garbage.code : "")], [{ kind: "failed", code: "AUTH_REQUIRED" }, "sign_in"]);
    const a3 = await (await auth("token?grant_type=password", { email: a.email, password: a.password })).json();
    const out = await fetch(`${API}/auth/v1/logout?scope=local`, { method: "POST", headers: { apikey: PUBLISHABLE, authorization: `Bearer ${a3.access_token}` } });
    await out.body?.cancel();
    const signedOut = await appX(a3.access_token).save(await saveRequest(a, "s3", at(23)));
    assert.deepStrictEqual(signedOut, { kind: "failed", code: "AUTH_REQUIRED" });
    assert.deepStrictEqual(await countOf("select count(*) from postona_x_resv.reservations"), n0, "no 401 wrote anything");
    // service ended (SYNTHETIC, as G5's end leaves it) -> start_service; X disconnected (G4's real SQL) -> reconnect_x
    await owner("update public.service_entitlements set status = 'ended', ended_at = now() where user_id = :'u' and service_key = 'x_autopost'", { u: a.userId });
    const ended = await s.save(await saveRequest(a, "s4", at(24)));
    await owner("update public.service_entitlements set status = 'active', ended_at = null where user_id = :'u' and service_key = 'x_autopost'", { u: a.userId });
    assert.deepStrictEqual([ended, reservationErrorAction(ended.kind === "failed" ? ended.code : "")], [{ kind: "failed", code: "POSTONA_RESV_SERVICE_NOT_ACTIVE" }, "start_service"]);
    assert.deepStrictEqual(await xDisconnect(a), "done");
    const unverified = await s.save(await saveRequest(a, "s5", at(25)));
    assert.deepStrictEqual(await xConnect(a, "a3", "62001"), a.account);
    assert.deepStrictEqual([unverified, reservationErrorAction(unverified.kind === "failed" ? unverified.code : "")], [{ kind: "failed", code: "POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED" }, "reconnect_x"]);
    // the uncertain row from L9 is final for the store too (never re-sent, never cancelled)
    const unsure = rows(await http(X, { action: "list", payload: { socialAccountId: a.account } }, a.token)).find((r) => r.status === "uncertain")!;
    const final = await s.cancel(String(unsure.reservationId), Number(unsure.revision));
    assert.deepStrictEqual([final, reservationErrorAction(final.ok ? "" : final.code)], [{ ok: false, code: "POSTONA_RESV_ALREADY_FINAL" }, "final"]);
    // the store unreachable from the Edge (API login NOLOGIN -> 503 STORE_UNAVAILABLE): unknown, never saved; nothing written
    await owner("alter role g3ls_api_login nologin");
    const unknown = await s.save(await saveRequest(a, "s6", at(26)));
    await owner("alter role g3ls_api_login login");
    assert.deepStrictEqual([unknown, reservationErrorAction(unknown.kind === "uncertain" ? unknown.code : "")], [{ kind: "uncertain", code: UNCERTAIN }, "check"]);
    assert.deepStrictEqual(await countOf("select count(*) from postona_x_resv.reservations"), n0);
    assert.deepStrictEqual(await countOf("select count(*) from postona_x_resv.reservations where status = 'published' or provider_post_id is not null"), 0, "zero sends");
  });

  await t.step("L14 the app's Threads store: create refused by U8 (not available), another person's account not found, a receipt for nothing not found", async () => {
    const acct = `th_g3ls_${a.userId.slice(0, 8)}`;   // L10's SYNTHETIC binding
    const text = "G3-02 app Threads";
    const req = { socialAccountId: acct, clientRequestId: crypto.randomUUID(), text, contentSha256: await sha256(text), scheduledAt: at(6) };
    const refusedU8 = await appTh(a.token).create(req);
    assert.deepStrictEqual([refusedU8, reservationErrorAction(refusedU8.kind === "failed" ? refusedU8.code : "")], [{ kind: "failed", code: "POSTONA_THREADS_RESV_PUBLISH_DISABLED" }, "not_available"]);
    const otherPerson = await appTh(b.token).create({ ...req, clientRequestId: crypto.randomUUID() });
    assert.deepStrictEqual([otherPerson, reservationErrorAction(otherPerson.kind === "failed" ? otherPerson.code : "")], [{ kind: "failed", code: "POSTONA_THREADS_RESV_ACCOUNT_NOT_FOUND" }, "not_found"]);
    assert.deepStrictEqual(await appTh(a.token).receipt(acct, req.clientRequestId), { ok: false, code: "POSTONA_THREADS_RESV_NOT_FOUND" });
    assert.deepStrictEqual(await appTh(null).create(req), { kind: "failed", code: "AUTH_REQUIRED" });
    assert.deepStrictEqual(await countOf("select count(*) from postona_threads_resv.reservations"), 0);
  });

  await t.step("L15 measured: the app store without the apikey header (the gateway's answer is recorded, not assumed)", async () => {
    const without = await appX(a.token, undefined).list(a.account!);
    console.log(`G3LS_APIKEY_OMITTED ${JSON.stringify(without).slice(0, 120)}`);
    assert.ok(without.ok || (!without.ok && typeof without.code === "string"));
  });

  await t.step("L16 gap scope (G3-02 #6): two EXISTING rows 20 minutes apart never block a far save / reschedule; near ones still refused", async () => {
    const s = appX(a.token);
    const e1At = at(40);
    const e1 = await s.save(await saveRequest(a, "g1", e1At));
    const e2 = await s.save(await saveRequest(a, "g2", at(40, 3)));
    assert.ok(e1.kind === "saved" && e2.kind === "saved", JSON.stringify([e1, e2]));
    const plus = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60e3).toISOString();
    // SYNTHETIC: e2 moved 20 minutes after e1 -- what a "post now" (005 / 006, no gap check) next to a reservation leaves
    await owner("update postona_x_resv.reservations set scheduled_at = :'t'::timestamptz, consent_scheduled_at = :'t'::timestamptz, expires_at = :'t'::timestamptz + interval '6 hours' where id = :'i'",
      { t: plus(e1At, 20), i: e2.reservations[0].reservationId });
    const pair = () => owner("select string_agg(status || '@' || scheduled_at::text, ',' order by scheduled_at) from postona_x_resv.reservations where id in (:'i', :'j')",
      { i: e1.reservations[0].reservationId, j: e2.reservations[0].reservationId });
    const before = await pair();
    const far = await s.save(await saveRequest(a, "g3", at(45)));
    assert.deepStrictEqual(far.kind, "saved", `a far save is not this pair's conflict: ${JSON.stringify(far)}`);
    const near = await s.save(await saveRequest(a, "g4", plus(e1At, 40)));
    assert.deepStrictEqual([near, reservationErrorAction(near.kind === "failed" ? near.code : "")], [{ kind: "failed", code: "POSTONA_RESV_SLOT_CONFLICT" }, "fix_input"]);
    const row = far.kind === "saved" ? far.reservations[0] : null;
    assert.ok(row);
    const moved = await s.reschedule(row.reservationId, row.revision, at(46));
    assert.ok(moved.ok, `a far reschedule: ${JSON.stringify(moved)}`);
    const intoPair = await s.reschedule(row.reservationId, moved.value.revision, plus(e1At, 10));
    assert.deepStrictEqual(intoPair, { ok: false, code: "POSTONA_RESV_SLOT_CONFLICT" });
    assert.deepStrictEqual(await pair(), before, "the existing pair is left as it was");
    assert.deepStrictEqual(await countOf("select count(*) from postona_x_resv.reservations where draft_id = 'g3app_g4'"), 0, "the refused save wrote nothing");
  });
});
