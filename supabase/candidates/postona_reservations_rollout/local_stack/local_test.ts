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
const genGet = async (s: { get(id: string): Promise<{ ok: boolean; value?: { connectionGeneration?: string } }> }, id: string) => {
  const read = await s.get(id);
  assert.ok(read.ok, JSON.stringify(read));
  return read.value?.connectionGeneration;
};
const rowDump = (id: string) => owner("select md5(r::text) from postona_x_resv.reservations r where id = :'i'", { i: id });
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
    // G3-02 #14: the end + restore moved G5's generation, so the old connection writes nothing until it is made again
    assert.deepStrictEqual(code(await http(X, await createPayload(a, "r6b", at(12)), a.token)), "403 POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED");
    assert.deepStrictEqual(await xConnect(a, "a2b", "62001"), a.account);
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

  await t.step("L17 a send now handed back before any send (SYNTHETIC shape) is not a reservation: the app store's reschedule -> NOT_PLANNED (final)", async () => {
    const s = appX(a.token);
    const made = await s.save(await saveRequest(a, "sn", at(50)));
    assert.ok(made.kind === "saved", JSON.stringify(made));
    const id = made.reservations[0].reservationId;
    // SYNTHETIC: the row as 005 / 006 leave a released send now -- draft `single:...`, planned, due, expires_at = its own time
    await owner("update postona_x_resv.reservations set draft_id = 'single:' || replace(id::text, '-', ''), scheduled_at = now() - interval '1 minute', consent_scheduled_at = now() - interval '1 minute', expires_at = now() - interval '1 minute' where id = :'i'", { i: id });
    const state = () => owner("select concat_ws('/', status, revision, consent_state, scheduled_at::text, expires_at::text) from postona_x_resv.reservations where id = :'i'", { i: id });
    const before = await state();
    const moved = await s.reschedule(id, made.reservations[0].revision, at(51));
    assert.deepStrictEqual([moved, reservationErrorAction(moved.ok ? "" : moved.code)], [{ ok: false, code: "POSTONA_RESV_NOT_PLANNED" }, "final"]);
    assert.deepStrictEqual(await state(), before, "the row is unchanged");
  });

  await t.step("L18 the send-now draft namespace is reserved (G3-02 #8): a `single:` draft from the app store -> 422 ITEM_INVALID (fix_input), nothing written", async () => {
    const s = appX(a.token);
    const withDraft = async (draft: string, when: string) => {
      const req = await saveRequest(a, draft, when);
      return { ...req, items: [{ ...req.items[0], draft_id: draft }] };
    };
    const n0 = await countOf("select count(*) from postona_x_resv.reservations");
    const spoof = await s.save(await withDraft(`single:${crypto.randomUUID().replace(/-/gu, "")}`, at(55)));
    assert.deepStrictEqual([spoof, reservationErrorAction(spoof.kind === "failed" ? spoof.code : "")], [{ kind: "failed", code: "POSTONA_RESV_ITEM_INVALID" }, "fix_input"]);
    assert.deepStrictEqual(await countOf("select count(*) from postona_x_resv.reservations"), n0, "the refused spoof wrote nothing");
    const lookAlike = await s.save(await withDraft("x_single:1", at(56)));
    assert.deepStrictEqual(lookAlike.kind, "saved", JSON.stringify(lookAlike));
  });

  // ---- G3-02 #9: one throw-away runtime end to end -- a person's HTTP create -> the delivery worker over HTTP -> claim (014's generation
  // pin) -> ONE TEST_ONLY credentialFor -> 015's bound pre-send check -> the fake X -> finish -> the person's read-back. The fake snapshot
  // and the fake X are the e2e twin's (TEST_ONLY); the production worker entry keeps NOT_CONNECTED. Nothing reaches the real X.
  const WK2 = "postona-x-reservation-worker-e2etest";
  const FAKE_TOKEN = "g3ls-FAKE-x-access-token-0001";
  const deliver = async (secret = WORKER_SECRET) => {
    const answer = await http(WK2, {}, undefined, { "x-postona-worker-secret": secret });
    return { status: answer.status, report: answer.body.report as Record<string, number | boolean> | undefined, code: answer.body.code };
  };
  const xCalls = () => countOf("select count(*) from g3ls_test.x_calls");
  const generationOf = (account: string) => owner("select postona_x_resv.x_credential_generation(:'a')", { a: account });
  const snapshot = (account: string, generation: string) =>
    owner("insert into g3ls_test.x_token_snapshot values (:'a', :'t', :'g') on conflict (social_account_id) do update set token = excluded.token, generation = excluded.generation", { a: account, t: FAKE_TOKEN, g: generation });
  const xMode = (mode: string) => owner("update g3ls_test.x_mode set mode = :'m'", { m: mode });
  // SYNTHETIC clock: the row is due now (its consent instant moves with it, as a confirmed reschedule would leave it)
  const makeDue = (id: string) => owner("update postona_x_resv.reservations set scheduled_at = now() - interval '1 minute', consent_scheduled_at = now() - interval '1 minute', expires_at = now() + interval '6 hours' where id = :'i'", { i: id });
  const saved = async (name: string, days: number) => {
    const made = await appX(a.token).save(await saveRequest(a, name, at(days)));
    assert.ok(made.kind === "saved", JSON.stringify(made));
    return made.reservations[0].reservationId;
  };
  const outcome = (id: string) => owner("select status || '/' || coalesce(outcome_code, '-') || '/' || coalesce(provider_post_id, '-') from postona_x_resv.reservations where id = :'i'", { i: id });
  const zero = { claimed: 0, sends: 0, published: 0, failedBeforeSend: 0, uncertain: 0 };
  const counts = (r: Record<string, number | boolean> | undefined) => r && { claimed: r.claimed, sends: r.sends, published: r.published, failedBeforeSend: r.failedBeforeSend, uncertain: r.uncertain };

  await t.step("L19 E2E one send: HTTP create -> due -> worker HTTP -> generation-bound claim / pre-send -> fake X once -> published; read back; never again", async () => {
    // SYNTHETIC housekeeping: earlier steps' due rows leave the run (expired by the sweep), so each step below counts only its own rows
    await owner("update postona_x_resv.reservations set expires_at = now() - interval '1 second' where status = 'planned' and scheduled_at <= now()");
    const id = await saved("e1", 60);
    await makeDue(id);
    // the production worker entry (NOT_CONNECTED) still claims nothing, even with a due row
    const prod = await http(WK, {}, undefined, { "x-postona-worker-secret": WORKER_SECRET });
    assert.deepStrictEqual([prod.status, (prod.body.report as Record<string, unknown>).claimed, (prod.body.report as Record<string, unknown>).notAvailable], [200, 0, true]);
    // the e2e twin: no / wrong secret -> 401 before anything
    assert.deepStrictEqual((await deliver("w".repeat(48))).status, 401);
    assert.deepStrictEqual([await xCalls(), await rowState(id)], [0, "planned/1/-"]);
    await snapshot(a.account!, await generationOf(a.account!));
    const run = await deliver();
    assert.deepStrictEqual([run.status, counts(run.report)], [200, { ...zero, claimed: 1, sends: 1, published: 1 }], JSON.stringify(run));
    assert.deepStrictEqual(await xCalls(), 1);
    assert.deepStrictEqual(await owner("select bearer_sha256 = encode(sha256(convert_to(:'b', 'UTF8')), 'hex') and text = 'G3-02 app e1' from g3ls_test.x_calls", { b: `Bearer ${FAKE_TOKEN}` }), "t", "the fake X got the snapshot's token and the stored text");
    assert.match(await outcome(id), /^published\/PUBLISHED\/9[0-9]{9}$/u);
    const back = await appX(a.token).get(id);
    assert.ok(back.ok && back.value.status === "published", JSON.stringify(back));
    const other = await appX(b.token).get(id);
    assert.deepStrictEqual(other, { ok: false, code: "POSTONA_RESV_NOT_FOUND" });
    const again = await deliver();
    assert.deepStrictEqual([counts(again.report), await xCalls()], [zero, 1], "a second run sends nothing");
  });

  await t.step("L20 E2E reconnect between snapshot and claim (generation changed): claimed, NOT sent (CREDENTIAL_GENERATION_CHANGED)", async () => {
    const id = await saved("e2", 61);
    await makeDue(id);
    const g0 = await generationOf(a.account!);
    await snapshot(a.account!, g0);   // the source's snapshot, taken before the reconnect
    assert.deepStrictEqual(await xDisconnect(a), "done");
    assert.deepStrictEqual(await xConnect(a, "a4", "62001"), a.account);
    const g1 = await generationOf(a.account!);
    assert.notDeepStrictEqual(g1, g0, "a reconnect changes the generation");
    const run = await deliver();
    assert.deepStrictEqual(counts(run.report), { ...zero, claimed: 1, failedBeforeSend: 1 }, JSON.stringify(run));
    assert.deepStrictEqual([await outcome(id), await xCalls()], ["failed/CREDENTIAL_GENERATION_CHANGED/-", 1]);
    await snapshot(a.account!, g1);
  });

  await t.step("L21 E2E no claim while disconnected or after the service ended; a cancel before the run is never sent", async () => {
    const id = await saved("e3", 62);
    await makeDue(id);
    assert.deepStrictEqual(await xDisconnect(a), "done");
    assert.deepStrictEqual([counts((await deliver()).report), await rowState(id)], [zero, "planned/1/-"]);
    assert.deepStrictEqual(await xConnect(a, "a5", "62001"), a.account);
    await snapshot(a.account!, await generationOf(a.account!));
    await owner("update public.service_entitlements set status = 'ended', ended_at = now() where user_id = :'u' and service_key = 'x_autopost'", { u: a.userId });   // SYNTHETIC end
    const ended = await deliver();
    await owner("update public.service_entitlements set status = 'active', ended_at = null where user_id = :'u' and service_key = 'x_autopost'", { u: a.userId });
    assert.deepStrictEqual([counts(ended.report), await rowState(id)], [zero, "planned/1/-"]);
    const cancelled = await appX(a.token).cancel(id, 1);
    assert.ok(cancelled.ok && cancelled.value.status === "cancelled", JSON.stringify(cancelled));
    assert.deepStrictEqual([counts((await deliver()).report), await xCalls()], [zero, 1]);
    // G3-02 #14: the end + restore moved G5's generation: the connection is made again before the next steps write
    assert.deepStrictEqual(await xConnect(a, "a6", "62001"), a.account);
    await snapshot(a.account!, await generationOf(a.account!));
  });

  await t.step("L22 E2E an unknown X answer -> uncertain, never re-sent, not cancellable (final)", async () => {
    const id = await saved("e4", 63);
    await makeDue(id);
    await xMode("unknown");
    const run = await deliver();
    await xMode("ok");
    assert.deepStrictEqual(counts(run.report), { ...zero, claimed: 1, sends: 1, uncertain: 1 }, JSON.stringify(run));
    assert.deepStrictEqual([await outcome(id), await xCalls()], ["uncertain/X_TRANSPORT_UNKNOWN/-", 2]);
    assert.deepStrictEqual([counts((await deliver()).report), await xCalls()], [zero, 2], "never re-sent");
    const cancel = await appX(a.token).cancel(id, 1);
    assert.deepStrictEqual([cancel, reservationErrorAction(cancel.ok ? "" : cancel.code)], [{ ok: false, code: "POSTONA_RESV_ALREADY_FINAL" }, "final"]);
  });

  await t.step("L23 E2E X refuses (401) -> recorded failed before send (X_REJECTED_401), never retried", async () => {
    const id = await saved("e5", 64);
    await makeDue(id);
    await xMode("reject_401");
    const run = await deliver();
    await xMode("ok");
    assert.deepStrictEqual(counts(run.report), { ...zero, claimed: 1, sends: 1, failedBeforeSend: 1 }, JSON.stringify(run));
    assert.deepStrictEqual([await outcome(id), await xCalls()], ["failed/X_REJECTED_401/-", 3]);
    assert.deepStrictEqual([counts((await deliver()).report), await xCalls()], [zero, 3]);
  });

  await t.step("L24 E2E two workers at once: each due row is claimed and sent exactly once", async () => {
    const ids = [await saved("e6", 65), await saved("e7", 66), await saved("e8", 67)];
    for (const id of ids) await makeDue(id);
    const runs = await Promise.all([deliver(), deliver()]);
    const sum = (k: string) => runs.reduce((n, r) => n + Number(r.report?.[k] ?? 0), 0);
    assert.deepStrictEqual([sum("claimed"), sum("sends"), sum("published")], [3, 3, 3], JSON.stringify(runs));
    assert.deepStrictEqual(await xCalls(), 6);
    assert.deepStrictEqual(await owner("select count(distinct text) || '/' || count(*) from g3ls_test.x_calls where text in ('G3-02 app e6', 'G3-02 app e7', 'G3-02 app e8')"), "3/3");
    for (const id of ids) assert.match(await outcome(id), /^published\/PUBLISHED\/9[0-9]{9}$/u);
  });

  // ---- G3-02 #10 / #11: the scheduler's call (016 tick: the pinned project ref + the Vault key -> a signed one-use ticket -> pg_net -> the
  // worker entry), on this stack's real pg_net. run.sh installed 016 and the TEST ONLY target (g3ls_test.tick_target: this stack's kong
  // entries, used only while a ref is pinned); the real pg_cron job is run.sh's own step after these. The Vault key is this stack's only.
  const admin = (script: string, vars: Record<string, string> = {}) => psql("supabase_admin", "postgres", script, vars);
  const setKey = async (value: string | null) => {
    await admin("delete from vault.secrets where name = 'postona_resv_worker_secret'");
    if (value !== null) assert.doesNotMatch(await admin("select vault.create_secret(:'v', 'postona_resv_worker_secret')", { v: value }), /^ERR:/u);
  };
  const REF = "g3lslocalref00000000";   // the e2e twin's TEST ref
  const pin = async (ref: string | null) => {
    await owner("delete from postona_x_resv.worker_target");
    if (ref !== null) assert.doesNotMatch(await owner("insert into postona_x_resv.worker_target (project_ref) values (:'r')", { r: ref }), /^ERR:/u);
  };
  const KONG_FN = "http://kong:8000/functions/v1";
  const target = (url: string) => owner("insert into g3ls_test.tick_target (url) values (:'u') on conflict (one) do update set url = excluded.url", { u: url });
  const tick = () => owner("select postona_x_resv.tick_delivery_worker()");
  /** One tick, committed, with the header pg_net queued for it (read inside the tick's own transaction, before pg_net sends it). */
  const tickSeen = async () => {
    const out = (await owner("begin; select postona_x_resv.tick_delivery_worker(); select url || '|' || headers::text from net.http_request_queue order by id desc limit 1; commit;")).split("\n");
    return { outcome: out[0], queued: out[out.length - 1] };
  };
  const invoked = () => countOf("select count(*) from postona_x_resv.worker_ticks where outcome = 'INVOKED'");
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** The last call's answer as pg_net recorded it: "<status>|<body>", "error|<message>" or "timeout|". */
  const lastAnswer = async () => {
    const rid = await owner("select request_id from postona_x_resv.worker_ticks where outcome = 'INVOKED' order by id desc limit 1");
    for (let i = 0; i < 60; i++) {
      const r = await owner("select coalesce(status_code::text, case when timed_out then 'timeout' else 'error' end) || '|' || coalesce(content, error_msg, '') from net._http_response where id = :'r'", { r: rid });
      if (r) return r;
      await sleep(500);
    }
    return "none|";
  };
  const reportOf = (answer: string) => (JSON.parse(answer.slice(answer.indexOf("|") + 1)) as { report: Record<string, number | boolean> }).report;
  const ticketOf = (queued: string) => (JSON.parse(queued.slice(queued.indexOf("|") + 1)) as Record<string, string>)["x-postona-worker-tick"];
  const hmacHex = async (key: string, message: string) => {
    const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message))), (b) => b.toString(16).padStart(2, "0")).join("");
  };
  const forged = async (o: { ref?: string; at?: number; nonce?: string } = {}) => {
    const message = `v1.${o.ref ?? REF}.${o.at ?? Math.floor(Date.now() / 1000)}.${o.nonce ?? "cd".repeat(32)}`;
    return `${message}.${await hmacHex(WORKER_SECRET, message)}`;
  };
  const byTicket = (value: string) => http(WK2, {}, undefined, { "x-postona-worker-tick": value });

  await t.step("L25 tick: nothing is called without a pinned ref, without / with a short Vault key, or when the ref yields no target", async () => {
    await pin(null);
    await setKey(WORKER_SECRET);
    await target(`${KONG_FN}/${WK2}`);
    assert.deepStrictEqual(await tick(), "NOT_CONFIGURED", "no pinned ref");
    await pin(REF);
    await setKey(null);
    assert.deepStrictEqual(await tick(), "NOT_CONFIGURED", "no key");
    await setKey("short-secret");
    assert.deepStrictEqual(await tick(), "NOT_CONFIGURED", "short key");
    assert.match(await owner("insert into postona_x_resv.worker_target (project_ref) values ('Not.A.Ref')"), /^ERR:/u, "a malformed ref cannot be pinned");
    assert.deepStrictEqual(await invoked(), 0, "no HTTP call was made");
  });

  await t.step("L26 tick -> the production worker entry (release gate OFF): 503, nothing claimed; the real queue holds the ticket, never the key", async () => {
    const id = await saved("t1", 70);
    await makeDue(id);
    const calls = await xCalls();
    await setKey(WORKER_SECRET);
    await target(`${KONG_FN}/postona-x-reservation-worker`);
    const seen = await tickSeen();
    assert.deepStrictEqual(seen.outcome, "INVOKED");
    assert.ok(!seen.queued.includes(WORKER_SECRET), "H4-17 P1: no key in pg_net's queue");
    assert.ok(!seen.queued.includes("x-postona-worker-secret"), "no secret header");
    assert.match(ticketOf(seen.queued), new RegExp(`^v1\\.${REF}\\.[0-9]{10}\\.[0-9a-f]{64}\\.[0-9a-f]{64}$`, "u"));
    assert.deepStrictEqual(await lastAnswer(), '503|{"ok":false,"code":"NOT_AVAILABLE"}');
    assert.deepStrictEqual([await rowState(id), await xCalls()], ["planned/1/-", calls]);
    // measured, not assumed: a worker entry left at verify_jwt = true (the localtest twin) against a call without a user JWT
    await target(`${KONG_FN}/postona-x-reservation-worker-localtest`);
    assert.deepStrictEqual(await tick(), "INVOKED");
    const gated = await lastAnswer();
    console.log(`G3LS_TICK_VERIFY_JWT_TRUE ${gated.slice(0, 80)}`);
    assert.match(gated, /^(200|401)\|/u);
    assert.deepStrictEqual(await rowState(id), "planned/1/-");
  });

  await t.step("L27 tick signed with another key / pinned to another project -> the worker's 401, nothing claimed or sent", async () => {
    const calls = await xCalls();
    await target(`${KONG_FN}/${WK2}`);
    await setKey("w".repeat(48));
    assert.deepStrictEqual(await tick(), "INVOKED");
    assert.deepStrictEqual(await lastAnswer(), '401|{"ok":false,"code":"WORKER_AUTH_REQUIRED"}');
    await setKey(WORKER_SECRET);
    await pin("otherprojectref00001");   // H4-17 P2: a ticket for another project is refused by this one
    assert.deepStrictEqual(await tick(), "INVOKED");
    assert.deepStrictEqual(await lastAnswer(), '401|{"ok":false,"code":"WORKER_AUTH_REQUIRED"}');
    await pin(REF);
    assert.deepStrictEqual([await xCalls(), await rowState(await owner("select id from postona_x_resv.reservations where draft_id = 'g3app_t1'"))], [calls, "planned/1/-"]);
  });

  await t.step("L28 tick -> the e2e worker: the due row sent once, a future row not; the ticket is one-use; forged / stale / foreign tickets refused", async () => {
    await snapshot(a.account!, await generationOf(a.account!));
    const due = await owner("select id from postona_x_resv.reservations where draft_id = 'g3app_t1'");
    const future = await saved("t2", 71);
    const calls = await xCalls();
    const seen = await tickSeen();
    assert.deepStrictEqual(seen.outcome, "INVOKED");
    const first = await lastAnswer();
    assert.match(first, /^200\|/u, first);
    assert.deepStrictEqual([reportOf(first).claimed, reportOf(first).sends, reportOf(first).published], [1, 1, 1], first);
    assert.match(await outcome(due), /^published\/PUBLISHED\/9[0-9]{9}$/u);
    assert.deepStrictEqual([await rowState(future), await xCalls()], ["planned/1/-", calls + 1]);
    // whoever read the queue holds at most that one ticket: already used -> refused, nothing claimed
    const used = ticketOf(seen.queued);
    assert.deepStrictEqual(code(await byTicket(used)), "401 WORKER_TICK_REJECTED");
    assert.deepStrictEqual(code(await byTicket(used.slice(0, -1) + (used.endsWith("0") ? "1" : "0"))), "401 WORKER_AUTH_REQUIRED");
    assert.deepStrictEqual(code(await byTicket(await forged())), "401 WORKER_TICK_REJECTED", "validly signed but never issued by a tick");
    assert.deepStrictEqual(code(await byTicket(await forged({ at: Math.floor(Date.now() / 1000) - 300 }))), "401 WORKER_AUTH_REQUIRED");
    assert.deepStrictEqual(code(await byTicket(await forged({ ref: "otherprojectref00001" }))), "401 WORKER_AUTH_REQUIRED");
    assert.deepStrictEqual(await xCalls(), calls + 1);
    assert.deepStrictEqual(await tick(), "INVOKED");
    const second = await lastAnswer();
    assert.deepStrictEqual([second.split("|")[0], reportOf(second).claimed, await xCalls()], ["200", 0, calls + 1], "the next tick re-sends nothing");
    const health = await owner("select last_report::text from postona_x_resv.worker_tick_health() where outcome = 'HTTP' and http_status = 200");
    assert.match(health, /"claimed": 0/u, health);
  });

  await t.step("L29 tick: an unknown X answer -> uncertain; the next tick never re-sends it", async () => {
    const id = await saved("t3", 72);
    await makeDue(id);
    const calls = await xCalls();
    await xMode("unknown");
    assert.deepStrictEqual(await tick(), "INVOKED");
    const run = await lastAnswer();
    await xMode("ok");
    assert.deepStrictEqual([reportOf(run).sends, reportOf(run).uncertain], [1, 1], run);
    assert.deepStrictEqual(await tick(), "INVOKED");
    assert.deepStrictEqual([reportOf(await lastAnswer()).claimed, await xCalls(), await rowState(id)], [0, calls + 1, "uncertain/1/X_TRANSPORT_UNKNOWN"]);
  });

  await t.step("L30 tick never stacks: a previous call still without an answer -> PREVIOUS_IN_FLIGHT; a tick already running -> TICK_BUSY", async () => {
    const before = await invoked();
    // SYNTHETIC: a call pg_net has not answered yet (request id -1 never gets a response)
    await owner("insert into postona_x_resv.worker_ticks (outcome, request_id, nonce_sha256) values ('INVOKED', -1, repeat('0', 64))");
    assert.deepStrictEqual(await tick(), "PREVIOUS_IN_FLIGHT");
    await owner("delete from postona_x_resv.worker_ticks where request_id = -1");
    const holder = owner("begin; select pg_advisory_xact_lock(hashtextextended('postona_x_resv:worker_tick', 0)); select pg_sleep(4); commit;");
    await sleep(1500);
    assert.deepStrictEqual(await tick(), "TICK_BUSY");
    await holder;
    assert.deepStrictEqual(await invoked(), before, "neither made a call");
  });

  await t.step("L31 tick to an unreachable host: pg_net's failure shows in the health read (TRANSPORT_ERROR), nothing claimed", async () => {
    await target("http://g3ls-unreachable.invalid/functions/v1/postona-x-reservation-worker");
    assert.deepStrictEqual(await tick(), "INVOKED");
    const answer = await lastAnswer();
    assert.match(answer, /^(error|timeout)\|/u, answer);
    const outcomes = await owner("select string_agg(outcome || coalesce('/' || http_status, ''), ',' order by outcome, http_status) from postona_x_resv.worker_tick_health()");
    for (const o of ["NOT_CONFIGURED", "HTTP/503", "HTTP/401", "HTTP/200", "PREVIOUS_IN_FLIGHT", "TICK_BUSY"]) assert.ok(outcomes.split(",").includes(o), `${o} in ${outcomes}`);
    assert.ok(outcomes.includes("TRANSPORT_ERROR") || outcomes.includes("TIMED_OUT"), outcomes);
    await target(`${KONG_FN}/${WK2}`);   // left for run.sh's pg_cron step
  });

  // ---- G3-02 #14: a service end + restart moves G5's lifecycle generation; the X connection made before it must not write or send.
  const d = await signUp("d");
  const rpcAs = async (p: Person, fn: string, body: unknown) => {
    const r = await fetch(`${API}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: PUBLISHABLE, authorization: `Bearer ${p.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const dSave = async (name: string, days: number) => {
    const made = await appX(d.token).save(await saveRequest(d, name, at(days)));
    assert.ok(made.kind === "saved", JSON.stringify(made));
    return made.reservations[0];
  };
  const precheck = () => owner("select public.postona_x_refresh_precheck_v1(:'a')", { a: d.account! });
  const NOT_VERIFIED = { ok: false, code: "POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED" };
  let rEdit: { reservationId: string; revision: number }; let rConfirm: { reservationId: string; revision: number }; let rDue: { reservationId: string; revision: number };

  await t.step("L32 restart, old connection: create / reschedule / reconfirm 403 (reconnect), nothing written, nothing sent; list / get / cancel go on; others 404; bad JWT 401", async () => {
    await firstRun(d);
    d.account = await xConnect(d, "d1", "62301");
    assert.deepStrictEqual(await precheck(), "allow");
    rEdit = await dSave("r1", 77);
    const toCancel = await dSave("r2", 78);
    const pending = await dSave("r3", 79);
    rDue = await dSave("r4", 80);
    const moved = await appX(d.token).reschedule(pending.reservationId, pending.revision, at(81));
    assert.ok(moved.ok);
    rConfirm = moved.value;
    const life = () => owner("select lifecycle_version from public.common_accounts where user_id = :'u'", { u: d.userId });
    const before = Number(await life());
    await owner("update public.service_entitlements set status = 'ended', ended_at = now() where user_id = :'u' and service_key = 'x_autopost'", { u: d.userId });   // SYNTHETIC end
    const asked = await rpcAs(d, "start_x_autopost_service", {});
    assert.deepStrictEqual(asked.body.status, "reenroll_required");
    const back = await rpcAs(d, "reactivate_x_autopost_service", { p_expected_lifecycle_version: asked.body.lifecycle_version });
    assert.deepStrictEqual(back.body.status, "active", JSON.stringify(back.body));
    assert.ok(Number(await life()) > before, "G5's generation moved");
    assert.deepStrictEqual(await owner("select connection_status from public.social_accounts where id = :'a'", { a: d.account! }), "identity_verified", "G1's measurement: the connection still reads verified");
    assert.deepStrictEqual(await xVerdict(d), "true|VERIFIED", "and so does G4's verdict");
    assert.deepStrictEqual(await precheck(), "SERVICE_GENERATION_CHANGED", "G4's generation check");
    const s = appX(d.token);
    const n0 = await countOf("select count(*) from postona_x_resv.reservations");
    const created = await s.save(await saveRequest(d, "stale", at(82)));
    assert.deepStrictEqual([created, reservationErrorAction(created.kind === "failed" ? created.code : "")], [{ kind: "failed", code: "POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED" }, "reconnect_x"]);
    assert.deepStrictEqual(await countOf("select count(*) from postona_x_resv.reservations"), n0, "nothing written");
    assert.deepStrictEqual(await s.reschedule(rEdit.reservationId, rEdit.revision, at(83)), NOT_VERIFIED);
    assert.deepStrictEqual(await s.reconfirm(rConfirm.reservationId, rConfirm.revision, await sha256("G3-02 app r3")), NOT_VERIFIED);
    assert.deepStrictEqual([await rowState(rEdit.reservationId), await rowState(rConfirm.reservationId)], ["planned/1/-", "planned/2/-"]);
    const listed = await s.list(d.account!);
    assert.ok(listed.ok && listed.value.length === 4, JSON.stringify(listed));
    assert.deepStrictEqual(listed.value.map((row) => row.connectionGeneration), ["earlier", "earlier", "earlier", "earlier"], "G3-02 #15: the rows made before the restart");
    assert.deepStrictEqual(await genGet(s, rEdit.reservationId), "earlier");
    assert.ok((await s.get(rEdit.reservationId)).ok);
    const cancelled = await s.cancel(toCancel.reservationId, toCancel.revision);
    assert.ok(cancelled.ok && cancelled.value.status === "cancelled", JSON.stringify(cancelled));
    assert.deepStrictEqual(await appX(b.token).get(rEdit.reservationId), { ok: false, code: "POSTONA_RESV_NOT_FOUND" });
    assert.deepStrictEqual(await appX(b.token).reschedule(rEdit.reservationId, 1, at(84)), { ok: false, code: "POSTONA_RESV_NOT_FOUND" });
    const foreign = await appX(b.token).save(await saveRequest(d, "foreign", at(85)));
    assert.deepStrictEqual(foreign, { kind: "failed", code: "POSTONA_RESV_ACCOUNT_NOT_FOUND" }, "another workspace's account");
    assert.deepStrictEqual(await appX("not.a.jwt.at-all-0000").list(d.account!), { ok: false, code: "AUTH_REQUIRED" });
    // the worker: a row of the new generation over the old connection (SYNTHETIC: this fix refuses to create one) is not claimed, not sent
    const fresh = await owner("select lifecycle_version from public.common_accounts where user_id = :'u'", { u: d.userId });
    await owner("update postona_x_resv.reservations set bound_lifecycle_version = :'l' where id = :'i'", { l: fresh, i: rDue.reservationId });
    await makeDue(rDue.reservationId);
    await snapshot(d.account!, await generationOf(d.account!));
    const calls = await xCalls();
    const run = await deliver();
    assert.deepStrictEqual([run.report?.claimed, run.report?.sends, await xCalls(), await rowState(rDue.reservationId)], [0, 0, calls, "planned/1/-"], JSON.stringify(run));
  });

  await t.step("L33 after an explicit reconnect: create and send work once; rows of the earlier generation stay unmovable (final) but cancellable; never sent", async () => {
    assert.deepStrictEqual(await appX(d.token).cancel(rDue.reservationId, rDue.revision).then((r) => r.ok), true);
    assert.deepStrictEqual(await xConnect(d, "d2", "62301"), d.account);
    assert.deepStrictEqual(await precheck(), "allow", "a new connect records the current generation");
    const s = appX(d.token);
    const moved = await s.reschedule(rEdit.reservationId, rEdit.revision, at(83));
    assert.deepStrictEqual([moved, reservationErrorAction(moved.ok ? "" : moved.code)], [{ ok: false, code: "POSTONA_RESV_NOT_PLANNED" }, "final"]);
    assert.deepStrictEqual(await s.reconfirm(rConfirm.reservationId, rConfirm.revision, await sha256("G3-02 app r3")), { ok: false, code: "POSTONA_RESV_NOT_PLANNED" });
    assert.deepStrictEqual([await rowState(rEdit.reservationId), await rowState(rConfirm.reservationId)], ["planned/1/-", "planned/2/-"]);
    const cancelled = await s.cancel(rConfirm.reservationId, rConfirm.revision);
    assert.ok(cancelled.ok && cancelled.value.status === "cancelled", JSON.stringify(cancelled));
    const made = await s.save(await saveRequest(d, "after", at(86)));
    assert.ok(made.kind === "saved", JSON.stringify(made));
    const id = made.reservations[0].reservationId;
    assert.deepStrictEqual([await genGet(s, id), await genGet(s, rEdit.reservationId)], ["current", "earlier"], "G3-02 #15: after the reconnect, a new row is current and an old one stays earlier");
    const read = await s.list(d.account!);
    assert.ok(read.ok);
    assert.deepStrictEqual(read.value.find((row) => row.reservationId === id)?.connectionGeneration, "current");
    assert.deepStrictEqual(read.value.find((row) => row.reservationId === rEdit.reservationId)?.connectionGeneration, "earlier");
    await makeDue(id);
    await makeDue(rEdit.reservationId);
    await snapshot(d.account!, await generationOf(d.account!));
    const calls = await xCalls();
    const run = await deliver();
    assert.deepStrictEqual([run.report?.sends, run.report?.published, await xCalls()], [1, 1, calls + 1], JSON.stringify(run));
    assert.match(await outcome(id), /^published\/PUBLISHED\/9[0-9]{9}$/u);
    assert.deepStrictEqual(await outcome(rEdit.reservationId), "failed/SERVICE_GENERATION_CHANGED/-", "the earlier generation's row is closed, never sent");
    const again = await deliver();
    assert.deepStrictEqual([again.report?.claimed, await xCalls()], [0, calls + 1], "not re-sent");
  });

  await t.step("L34 connectionGeneration: unknown when it cannot be proven (unbound row, disconnected, service not active); read-only; never another person's; old clients and write answers unchanged", async () => {
    const s = appX(d.token);
    const raw = async (action: string, payload: unknown) => (await http(X, { action, payload }, d.token)).body as { ok: boolean; reservations: Record<string, unknown>[] };
    const a = await dSave("g1", 88);
    const c = await dSave("g2", 89);
    const w = await dSave("g3", 87);
    const written = await raw("reschedule", { reservationId: w.reservationId, expectedRevision: w.revision, scheduledAt: at(85) });
    assert.ok(written.ok, JSON.stringify(written));
    assert.ok(!("connectionGeneration" in written.reservations[0]), "a write answer has no field");
    const viaStore = await s.reschedule(w.reservationId, written.reservations[0].revision as number, at(84));
    assert.ok(viaStore.ok && viaStore.value.connectionGeneration === "current", "the app store's write returns its read-back row, so it has the field");
    const shape = Object.keys((await raw("get", { reservationId: a.reservationId })).reservations[0]).sort();
    assert.deepStrictEqual(shape, ["batchId", "body", "connectionGeneration", "consentState", "draftId", "fixed", "mode", "origin", "position", "reservationId", "revision", "scheduledAt", "status"], "one field added, nothing else; no generation number, no token");
    assert.deepStrictEqual(await genGet(s, a.reservationId), "current");
    const before = await rowDump(a.reservationId);
    await s.list(d.account!);
    await s.get(a.reservationId);
    assert.deepStrictEqual(await rowDump(a.reservationId), before, "reading writes nothing");
    // another person: no row, no field
    assert.deepStrictEqual(await appX(b.token).get(a.reservationId), { ok: false, code: "POSTONA_RESV_NOT_FOUND" });
    const others = await appX(b.token).list(d.account!);
    assert.deepStrictEqual(others, { ok: true, value: [] });
    // a row with no recorded generation (SYNTHETIC)
    await owner("update postona_x_resv.reservations set bound_lifecycle_version = null where id = :'i'", { i: c.reservationId });
    assert.deepStrictEqual(await genGet(s, c.reservationId), "unknown", "unbound");
    assert.deepStrictEqual(await genGet(s, a.reservationId), "current", "the other row is not affected");
    // disconnected (G4's real SQL): unknown; list / get / cancel go on
    await xDisconnect(d);
    assert.deepStrictEqual(await genGet(s, a.reservationId), "unknown", "disconnected");
    assert.deepStrictEqual(await xConnect(d, "d3", "62301"), d.account);
    assert.deepStrictEqual(await genGet(s, a.reservationId), "current", "reconnected without a restart: the same generation");
    // service ended, not restarted (SYNTHETIC end): unknown, not earlier; the row can be read and cancelled
    await owner("update public.service_entitlements set status = 'ended', ended_at = now() where user_id = :'u' and service_key = 'x_autopost'", { u: d.userId });
    assert.deepStrictEqual(await genGet(s, a.reservationId), "unknown", "service not active");
    assert.ok((await s.cancel(c.reservationId, c.revision)).ok);
    const asked = await rpcAs(d, "start_x_autopost_service", {});
    const back = await rpcAs(d, "reactivate_x_autopost_service", { p_expected_lifecycle_version: asked.body.lifecycle_version });
    assert.deepStrictEqual(back.body.status, "active", JSON.stringify(back.body));
    assert.deepStrictEqual(await genGet(s, a.reservationId), "earlier", "restarted");
    assert.deepStrictEqual(await xConnect(d, "d4", "62301"), d.account);
    assert.deepStrictEqual(await genGet(s, a.reservationId), "earlier", "a reconnect does not revive it");
    // it is not sent, and a store on an older client ignores the field
    await makeDue(a.reservationId);
    await snapshot(d.account!, await generationOf(d.account!));
    const calls = await xCalls();
    const run = await deliver();
    assert.deepStrictEqual([run.report?.sends, await xCalls(), await outcome(a.reservationId)], [0, calls, "failed/SERVICE_GENERATION_CHANGED/-"], JSON.stringify(run));
  });

  await t.step("L35 approvals + notifications (G3-02 #16): submit / revise / approve / reject over real JWT -> Kong -> Edge -> PG; not approved = not a reservation, never sent; approved = one reservation, sent once; another person sees nothing; events once each", async () => {
    const AP = "postona-x-approvals-localtest";
    const ap = (action: string, payload: unknown, token = d.token) => http(AP, { action, payload }, token);
    const cands = (a: Answer) => (a.body.candidates ?? []) as Array<Record<string, unknown>>;
    const notes = async (token = d.token) => {
      const a = await ap("notifications", { limit: 100 }, token);
      assert.strictEqual(a.status, 200, JSON.stringify(a.body));
      return (a.body.notifications ?? []) as Array<Record<string, unknown>>;
    };
    const resvCount = () => countOf(`select count(*) from postona_x_resv.reservations where user_id = '${d.userId}'`);
    const submit = (name: string, days: number, client = crypto.randomUUID()) =>
      ap("submit", { socialAccountId: d.account, clientRequestId: client, body: `G3-02 #16 ${name}`, scheduledAt: at(days) });
    // submit: pending, one event; a retry of the same request is the same row; another person sees nothing
    const client = crypto.randomUUID();
    const when = at(70);
    const s1 = await ap("submit", { socialAccountId: d.account, clientRequestId: client, body: "G3-02 #16 c1", scheduledAt: when });
    assert.deepStrictEqual([s1.status, cands(s1)[0]?.state, cands(s1)[0]?.revision, cands(s1)[0]?.reservationId], [200, "pending_approval", 1, null], JSON.stringify(s1.body));
    const c1 = cands(s1)[0];
    const again = await ap("submit", { socialAccountId: d.account, clientRequestId: client, body: "G3-02 #16 c1", scheduledAt: when });
    assert.deepStrictEqual(cands(again)[0]?.candidateId, c1.candidateId, "the same request, the same row");
    assert.deepStrictEqual(code(await ap("submit", { socialAccountId: d.account, clientRequestId: client, body: "another", scheduledAt: when })), "409 POSTONA_RESV_IDEMPOTENCY_CONFLICT");
    assert.deepStrictEqual((await notes()).filter((n) => n.candidateId === c1.candidateId).map((n) => `${n.kind}/${n.subjectRevision}`), ["approval_requested/1"]);
    assert.deepStrictEqual(code(await ap("get", { candidateId: c1.candidateId }, b.token)), "404 POSTONA_RESV_NOT_FOUND");
    assert.deepStrictEqual(code(await ap("approve", { candidateId: c1.candidateId, expectedRevision: 1, contentSha256: c1.contentSha256 }, b.token)), "404 POSTONA_RESV_NOT_FOUND");
    assert.deepStrictEqual(cands(await ap("list", { socialAccountId: d.account }, b.token)), []);
    assert.ok((await notes(b.token)).every((n) => n.candidateId !== c1.candidateId), "B never sees A's events");
    const mine = (await notes())[0];
    assert.deepStrictEqual(code(await ap("markRead", { notificationId: mine.notificationId }, b.token)), "404 POSTONA_RESV_NOT_FOUND");
    assert.deepStrictEqual((await ap("notifications", {}, "not.a.jwt.at-all-0000")).status, 401, "a bad token: the gateway");
    assert.deepStrictEqual((await ap("notifications", {})).status, 200);
    // not approved: no reservation, nothing for the worker
    const n0 = await resvCount();
    const idle = await deliver();
    assert.deepStrictEqual([idle.report?.claimed ?? 0, await resvCount()], [0, n0], JSON.stringify(idle));
    // revision: stale refused; revise; the old hash no longer approves
    assert.deepStrictEqual(code(await ap("approve", { candidateId: c1.candidateId, expectedRevision: 9, contentSha256: c1.contentSha256 })), "409 POSTONA_RESV_STALE_REVISION");
    const r2 = await ap("revise", { candidateId: c1.candidateId, expectedRevision: 1, body: "G3-02 #16 c1 v2", scheduledAt: at(71) });
    assert.deepStrictEqual([r2.status, cands(r2)[0]?.revision], [200, 2], JSON.stringify(r2.body));
    assert.deepStrictEqual(code(await ap("approve", { candidateId: c1.candidateId, expectedRevision: 2, contentSha256: c1.contentSha256 })), "422 POSTONA_RESV_CONSENT_REQUIRED");
    assert.deepStrictEqual(await resvCount(), n0);
    // approve: one reservation (create_batch, planned, confirmed); five concurrent retries of the same approval make nothing more
    const sha2 = cands(r2)[0].contentSha256 as string;
    const many = await Promise.all(Array.from({ length: 5 }, () => ap("approve", { candidateId: c1.candidateId, expectedRevision: 2, contentSha256: sha2 })));
    assert.deepStrictEqual(many.map((m) => `${m.status}/${cands(m)[0]?.state}`), Array(5).fill("200/approved"), JSON.stringify(many.map((m) => m.body)));
    const rid = cands(many[0])[0].reservationId as string;
    assert.ok(many.every((m) => cands(m)[0].reservationId === rid), "the same reservation each time");
    assert.deepStrictEqual(await resvCount(), n0 + 1, "exactly one reservation");
    const made = await appX(d.token).get(rid);
    assert.ok(made.ok && made.value.status === "planned" && made.value.consentState === "confirmed" && made.value.body === "G3-02 #16 c1 v2", JSON.stringify(made));
    assert.deepStrictEqual(code(await ap("reject", { candidateId: c1.candidateId, expectedRevision: 3 })), "409 POSTONA_RESV_APPROVAL_NOT_PENDING");
    // approve vs reject at once: exactly one wins
    const c2 = cands(await submit("c2", 72))[0];
    const race = await Promise.all([
      ap("approve", { candidateId: c2.candidateId, expectedRevision: 1, contentSha256: c2.contentSha256 }),
      ap("reject", { candidateId: c2.candidateId, expectedRevision: 1 }),
    ]);
    assert.deepStrictEqual(race.map((r) => r.status).sort(), [200, 409], JSON.stringify(race.map((r) => r.body)));
    const c2state = cands(await ap("get", { candidateId: c2.candidateId }))[0].state;
    assert.deepStrictEqual(await resvCount(), n0 + 1 + (c2state === "approved" ? 1 : 0), `race winner ${c2state}`);
    // reservation_changed: a reschedule of the approved reservation shows once, on the next list
    const moved = await appX(d.token).reschedule(rid, made.ok ? made.value.revision : 1, at(73));
    assert.ok(moved.ok, JSON.stringify(moved));
    const changed = (await notes()).filter((n) => n.reservationId === rid && n.kind === "reservation_changed");
    assert.deepStrictEqual(changed.map((n) => `${n.state}/${n.subjectRevision}`), ["planned/2"]);
    assert.deepStrictEqual((await notes()).filter((n) => n.reservationId === rid && n.kind === "reservation_changed").length, 1, "listed twice: once");
    // mark read: idempotent
    const read1 = await ap("markRead", { notificationId: changed[0].notificationId });
    const readAt = ((read1.body.notifications ?? []) as Array<Record<string, unknown>>)[0]?.readAt;
    assert.ok(typeof readAt === "string");
    const read2 = await ap("markRead", { notificationId: changed[0].notificationId });
    assert.deepStrictEqual(((read2.body.notifications ?? []) as Array<Record<string, unknown>>)[0]?.readAt, readAt);
    // the approved reservation is sent once by the worker (fake X); the result shows as an event
    assert.ok((await appX(d.token).reconfirm(rid, 2, await sha256("G3-02 #16 c1 v2"))).ok);
    if (c2state === "approved") assert.ok((await appX(d.token).cancel(cands(await ap("get", { candidateId: c2.candidateId }))[0].reservationId as string, 1)).ok);
    await makeDue(rid);
    await snapshot(d.account!, await generationOf(d.account!));
    const calls = await xCalls();
    const run = await deliver();
    assert.deepStrictEqual([run.report?.sends, await xCalls()], [1, calls + 1], JSON.stringify(run));
    assert.match(await outcome(rid), /^published\/PUBLISHED\//u);
    assert.ok((await notes()).some((n) => n.reservationId === rid && n.kind === "reservation_changed" && n.state === "published"));
    // service ended (SYNTHETIC): approve refused, reject works; restarted: the old connection refused; reconnected: the earlier generation refused
    const c3 = cands(await submit("c3", 74))[0];
    const c4 = cands(await submit("c4", 75))[0];
    await owner("update public.service_entitlements set status = 'ended', ended_at = now() where user_id = :'u' and service_key = 'x_autopost'", { u: d.userId });
    assert.deepStrictEqual(code(await ap("approve", { candidateId: c3.candidateId, expectedRevision: 1, contentSha256: c3.contentSha256 })), "403 POSTONA_RESV_SERVICE_NOT_ACTIVE");
    assert.deepStrictEqual(code(await ap("reject", { candidateId: c4.candidateId, expectedRevision: 1 })), "200 ok");
    const asked = await rpcAs(d, "start_x_autopost_service", {});
    const back = await rpcAs(d, "reactivate_x_autopost_service", { p_expected_lifecycle_version: asked.body.lifecycle_version });
    assert.deepStrictEqual(back.body.status, "active", JSON.stringify(back.body));
    assert.deepStrictEqual(code(await ap("approve", { candidateId: c3.candidateId, expectedRevision: 1, contentSha256: c3.contentSha256 })), "403 POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED");
    assert.deepStrictEqual(await xConnect(d, "d5", "62301"), d.account);
    assert.deepStrictEqual(code(await ap("approve", { candidateId: c3.candidateId, expectedRevision: 1, contentSha256: c3.contentSha256 })), "409 POSTONA_RESV_APPROVAL_GENERATION_CHANGED");
    const c5 = cands(await submit("c5", 76))[0];
    assert.deepStrictEqual(code(await ap("approve", { candidateId: c5.candidateId, expectedRevision: 1, contentSha256: c5.contentSha256 })), "200 ok", "a new candidate after the reconnect");
    assert.deepStrictEqual(await owner("select count(*) from postona_x_resv.push_outbox where user_id = :'u'", { u: d.userId }),
      await owner("select count(*) from postona_x_resv.notifications where user_id = :'u'", { u: d.userId }), "one outbox row per notification; nothing sends them");
  });

  await t.step("L36 G3-02 #17 (H1 #37): a G4-only reconnect refuses an earlier candidate (P2-1); a former owner's list writes nothing (P2-2); expired / anonymous tokens 401", async () => {
    const AP = "postona-x-approvals-localtest";
    const ap = (action: string, payload: unknown, token = d.token) => http(AP, { action, payload }, token);
    const cands = (a: Answer) => (a.body.candidates ?? []) as Array<Record<string, unknown>>;
    const resvCount = () => countOf(`select count(*) from postona_x_resv.reservations where user_id = '${d.userId}'`);
    const noteRows = async () => `${await owner("select count(*) from postona_x_resv.notifications where user_id = :'u'", { u: d.userId })}/${await owner("select count(*) from postona_x_resv.push_outbox where user_id = :'u'", { u: d.userId })}`;
    const submit = async (name: string, days: number) => {
      const a = await ap("submit", { socialAccountId: d.account, clientRequestId: crypto.randomUUID(), body: `G3-02 #17 ${name}`, scheduledAt: at(days) });
      assert.strictEqual(a.status, 200, JSON.stringify(a.body));
      return cands(a)[0];
    };
    // P2-1: the same account disconnected and connected again (G4's real SQL); G5's generation unchanged
    const life = () => owner("select lifecycle_version from public.common_accounts where user_id = :'u'", { u: d.userId });
    const k1 = await submit("k1", 66);
    const k2 = await submit("k2", 67);
    const life0 = await life();
    const gen0 = await generationOf(d.account!);
    await xDisconnect(d);
    assert.deepStrictEqual(await xConnect(d, "d6", "62301"), d.account, "the same social_account_id");
    assert.deepStrictEqual(await life(), life0, "G5's generation did not move");
    assert.notDeepStrictEqual(await generationOf(d.account!), gen0, "G4's connection generation moved");
    const n0 = await resvCount();
    assert.deepStrictEqual(code(await ap("approve", { candidateId: k1.candidateId, expectedRevision: 1, contentSha256: k1.contentSha256 })), "409 POSTONA_RESV_APPROVAL_GENERATION_CHANGED");
    assert.deepStrictEqual([await resvCount(), cands(await ap("get", { candidateId: k1.candidateId }))[0].state], [n0, "pending_approval"], "nothing written");
    const calls0 = await xCalls();
    const idle = await deliver();
    assert.deepStrictEqual([idle.report?.sends ?? 0, await xCalls()], [0, calls0], "the worker sends nothing for it");
    const revised = await ap("revise", { candidateId: k2.candidateId, expectedRevision: 1, body: "G3-02 #17 k2 v2", scheduledAt: at(68) });
    assert.strictEqual(revised.status, 200, JSON.stringify(revised.body));
    const k2v2 = cands(revised)[0];
    const approved = await ap("approve", { candidateId: k2.candidateId, expectedRevision: 2, contentSha256: k2v2.contentSha256 });
    assert.deepStrictEqual([approved.status, cands(approved)[0]?.state], [200, "approved"], "the person's explicit revise under the new connection");
    const rid = cands(approved)[0].reservationId as string;
    // P2-2: the reservation changes, then the person is no longer the owner; two lists at once answer nothing and write nothing
    await owner("update postona_x_resv.reservations set status = 'cancelled', revision = revision + 1 where id = :'i'", { i: rid });   // SYNTHETIC (operator)
    await owner("create table public.g3ls17_bm as select * from public.brand_memberships where user_id = :'u' and role = 'owner'", { u: d.userId });
    await owner("delete from public.brand_memberships where user_id = :'u' and role = 'owner'", { u: d.userId });   // SYNTHETIC ownership loss
    const before = await noteRows();
    const lost = await Promise.all([ap("notifications", { limit: 100 }), ap("notifications", { limit: 100 })]);
    assert.deepStrictEqual(lost.map((l) => `${l.status}/${((l.body.notifications ?? []) as unknown[]).length}`), ["200/0", "200/0"]);
    assert.deepStrictEqual(await noteRows(), before, "no notification and no outbox row for a former owner");
    await owner("insert into public.brand_memberships select * from public.g3ls17_bm", {});
    await owner("drop table public.g3ls17_bm", {});
    // the owner again: two lists at once write the event once
    const both = await Promise.all([ap("notifications", { limit: 100 }), ap("notifications", { limit: 100 })]);
    assert.deepStrictEqual(both.map((l) => l.status), [200, 200]);
    assert.deepStrictEqual(await owner("select count(*) from postona_x_resv.notifications where reservation_id = :'i' and kind = 'reservation_changed' and state = 'cancelled'", { i: rid }), "1");
    const [nb, ob] = before.split("/").map(Number);
    assert.deepStrictEqual(await noteRows(), `${nb + 1}/${ob + 1}`);
    // expired (signed with the stack's secret) and anonymous tokens
    const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${enc({ alg: "HS256", typ: "JWT" })}.${enc({ ...claimsOf(d.token), iat: now - 7200, exp: now - 3600 })}`;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const expired = `${unsigned}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned))))}`;
    assert.deepStrictEqual((await ap("notifications", {}, expired)).status, 401, "expired token");
    const anon = await (await auth("signup", {})).json();
    assert.deepStrictEqual(code(await ap("notifications", {}, anon.access_token)), "401 AUTH_REQUIRED", "anonymous sign-in");
    assert.deepStrictEqual(await noteRows(), `${nb + 1}/${ob + 1}`, "401s wrote nothing");
  });
});
