// G3-02 #27 (TEST ONLY, fake data): the Threads reservation ledger and its delivery worker as ONE flow on the REAL local Supabase runtime,
// run by run.sh after local_test.ts. A person's real GoTrue JWT -> Kong (verify_jwt) -> the Threads reservations Edge twin -> PG17
// (postona_threads_resv 007 / 009 / 011 / 013 as rollout.sh installed them) creates / cancels / reads; the worker twin
// (postona-threads-reservation-worker-e2etest: G3's createThreadsWorkerHandler over 007's worker functions as the test's login member of
// postona_resv_worker) sends through G4's REAL two-step send port (G4 PR #701 pin) into a FAKE Threads Graph API (fake_threads.ts).
// Nothing here calls Threads, Meta, OAuth, X, a managed project or a paid API.
// SYNTHETIC (labelled where used; not G3's to decide and not a GO for anything):
//   * the Threads connection: G4's binding_row shape as L10 writes it, with G4's publish switch (U8) set ON in this throw-away world only.
//     G4's world forbids that with the CHECK social_accounts_meta_publish_disabled (measured: the insert is refused), so L47 drops that
//     CHECK here and L58 puts the same definition back (switch OFF first) and reads it back. G4's U8 stays OFF in every real source;
//     L10 / L14 prove create is refused while it is OFF. A real Threads reservation send needs G4 to lift U8: NOT G3's decision.
//   * the credential: a FAKE snapshot (g3ls_test.threads_token_snapshot) standing in for G4's generation-bound credential statement, which
//     does not exist yet (G4 threads_send_port.ts THREADS_POSTING_SERVICE_KEY = null). It proves nothing about G4's token read.
//   * the clock: a row is made due by moving scheduled_at (as the X e2e steps do); a lease is expired by moving lease_expires_at.
//   * a reconnect: the binding's oauth_state_id replaced (what G4's completed connect does to the generation 'g4t1:<oauth_state_id>').
//   * a service end: the entitlement row as G5's end leaves it (as L8).
import assert from "node:assert/strict";

const API = Deno.env.get("G3LS_API")!;
const PUBLISHABLE = Deno.env.get("G3LS_PUBLISHABLE")!;
const DB_PORT = Deno.env.get("G3LS_DB_PORT")!;
const WORKER_PW = Deno.env.get("G3LS_WORKER_PW")!;
const WORKER_SECRET = Deno.env.get("G3LS_WORKER_SECRET")!;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TH = "postona-threads-reservations-localtest";
const TW = "postona-threads-reservation-worker-e2etest";
const FAKE_TOKEN = "g3ls-FAKE-threads-access-token-0001";
const THREADS_USER = "17841400000062777";

type Person = { token: string; userId: string; sessionId: string; account?: string };
type Answer = { status: number; body: Record<string, unknown>; text: string };

const claimsOf = (token: string) => {
  const part = token.split(".")[1];
  return JSON.parse(atob(part.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(part.length / 4) * 4, "="))) as Record<string, unknown>;
};
const sha256 = async (text: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))).map((b) => b.toString(16).padStart(2, "0")).join("");
const at = (days: number) => new Date(Date.now() + days * 86400e3).toISOString();

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
/** The owner session; no step here expects a database error, so one fails the step with its message. */
const owner = async (script: string, vars: Record<string, string> = {}) => {
  const out = await psql("postgres", "postgres", script, vars);
  if (out.startsWith("ERR:")) throw new Error(`G3LS_OWNER_SQL ${out}`);
  return out;
};
const countOf = (sql: string, vars: Record<string, string> = {}) => owner(sql, vars).then(Number);

async function http(fn: string, body: unknown, token?: string, extra: Record<string, string> = {}): Promise<Answer> {
  const headers: Record<string, string> = { apikey: PUBLISHABLE, "content-type": "application/json", ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`${API}/functions/v1/${fn}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await r.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed, text };
}
async function auth(path: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { apikey: PUBLISHABLE, "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return await fetch(`${API}/auth/v1/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}
async function signUp(label: string): Promise<Person> {
  const r = await auth("signup", { email: `g3ls-${label}-${crypto.randomUUID().slice(0, 8)}@example.test`, password: crypto.randomUUID() });
  const j = await r.json();
  assert.strictEqual(r.status, 200, `sign-up ${label}`);
  const c = claimsOf(j.access_token);
  assert.deepStrictEqual([c.role, c.is_anonymous, UUID_RE.test(String(c.session_id))], ["authenticated", false, true]);
  return { token: j.access_token, userId: String(c.sub), sessionId: String(c.session_id) };
}
async function rpc(fn: string, token: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${API}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: PUBLISHABLE, authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// ---- the person's side (real HTTP) ------------------------------------------------------------------------------------------------------
const createBody = async (p: Person, text: string, when: string, clientRequestId = crypto.randomUUID()) =>
  ({ action: "create", payload: { socialAccountId: p.account, clientRequestId, text, contentSha256: await sha256(text), scheduledAt: when } });
async function create(p: Person, text: string, when = at(3)): Promise<{ id: string; crid: string }> {
  const body = await createBody(p, text, when);
  const answer = await http(TH, body, p.token);
  const r = answer.body.reservation as Record<string, unknown> | undefined;
  assert.deepStrictEqual([answer.status, r?.status, r?.created], [200, "planned", true], answer.text);
  return { id: String(r!.reservationId), crid: body.payload.clientRequestId };
}
const receipt = async (p: Person, crid: string) =>
  (await http(TH, { action: "receipt", payload: { socialAccountId: p.account, clientRequestId: crid } }, p.token)).body.receipt as Record<string, unknown>;
const cancel = (p: Person, id: string) => http(TH, { action: "cancel", payload: { reservationId: id } }, p.token);

// ---- the worker's side (real HTTP, the scheduler's secret) ------------------------------------------------------------------------------
async function deliver(secret = WORKER_SECRET) {
  const answer = await http(TW, {}, undefined, secret ? { "x-postona-worker-secret": secret } : {});
  assert.ok(!answer.text.includes(FAKE_TOKEN), "the worker's answer never carries the token");
  return { status: answer.status, code: answer.body.code, report: answer.body.report as Record<string, number | boolean> | undefined, text: answer.text };
}
const pick = (r: Record<string, number | boolean> | undefined, ...keys: string[]) => Object.fromEntries(keys.map((k) => [k, r?.[k]]));
const calls = (step: string) => countOf("select count(*) from g3ls_test.threads_calls where step = :'s'", { s: step });
const mode = (m: string) => owner("update g3ls_test.threads_mode set mode = :'m'", { m });
const makeDue = (id: string) => owner("update postona_threads_resv.reservations set scheduled_at = now() - interval '1 minute' where id = :'i'", { i: id });
const stateOf = (id: string) =>
  owner("select status || '/' || coalesce(outcome_code, '-') || '/' || coalesce(provider_post_id, '-') || '/' || coalesce(transport, '-') from postona_threads_resv.reservations where id = :'i'", { i: id });
const generationOf = (account: string) => owner("select coalesce(postona_threads_resv.threads_credential_generation(:'a'), 'null')", { a: account });
const snapshot = (account: string, generation: string) =>
  owner("insert into g3ls_test.threads_token_snapshot values (:'a', :'u', :'t', :'g') on conflict (social_account_id) do update set generation = excluded.generation",
    { a: account, u: THREADS_USER, t: FAKE_TOKEN, g: generation });
const publishSwitch = (account: string, on: boolean) =>
  owner("update public.social_accounts set publish_enabled = :'v'::boolean where id = :'a'", { a: account, v: String(on) });
const sleeping = async (app: string) => {
  for (let i = 0; i < 300; i++) {
    const n = Number(await psql("supabase_admin", "postgres", "select count(*) from pg_stat_activity where wait_event = 'PgSleep' and application_name = :'a'", { a: app }));
    if (n >= 1) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`G3LS_RACE_SETUP: no session of '${app}' parked in pg_sleep within 30 s`);
};
/** Every planned row of earlier steps leaves the run (SYNTHETIC housekeeping), so each step counts only its own rows. */
const quiet = () => owner("update postona_threads_resv.reservations set scheduled_at = now() + interval '30 days' where status = 'planned'");

Deno.test("G3-02 #27 Threads reservation ledger + delivery worker on the real local Supabase runtime", async (t) => {
  const p = await signUp("t27");
  const other = await signUp("t27o");
  let u8Check = "";

  await t.step("L47 setup: G5's real first run; a SYNTHETIC Threads connection with U8 ON in this world only; G4's real verdict VERIFIED", async () => {
    for (const person of [p, other]) {
      assert.strictEqual((await rpc("start_x_autopost_service", person.token)).status, 200);
      const w0 = await rpc("postona_ensure_my_personal_workspace", person.token);
      assert.deepStrictEqual([w0.status, w0.body.status], [200, "ready"], JSON.stringify(w0.body));
    }
    p.account = `th_g3t27_${p.userId.slice(0, 8)}`;
    u8Check = await owner("select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.social_accounts'::regclass and conname = 'social_accounts_meta_publish_disabled'");
    assert.ok(u8Check.length > 0, "G4's U8 CHECK is present in this world");
    console.log(`G3LS_L47 G4 U8 CHECK: ${u8Check}`);
    await owner("alter table public.social_accounts drop constraint social_accounts_meta_publish_disabled");   // SYNTHETIC, this world only
    await owner(`insert into public.social_accounts (id, brand_id, platform, handle, platform_user_id, publish_enabled, connection_status, verified_at, vault_access_token_secret_id)
values (:'t', public.social_mobile_account_deletion_workspace(:'u'::uuid), 'threads', '@' || :'t', :'tu', true, 'identity_verified', now(), gen_random_uuid());
insert into public.threads_account_credential_custody (social_account_id, vault_secret_id, expires_at, recorded_by)
select :'t', vault_access_token_secret_id, now() + interval '50 days', :'u'::uuid from public.social_accounts where id = :'t';
insert into postona_threads_binding.bindings (social_account_id, brand_id, threads_user_id, bound_by, oauth_state_id, connect_proof, lifecycle_version, bound_at)
select :'t', brand_id, :'tu', :'u'::uuid, gen_random_uuid(), gen_random_uuid(), (select lifecycle_version from public.common_accounts where user_id = :'u'::uuid), now()
from public.social_accounts where id = :'t';`, { t: p.account, u: p.userId, tu: THREADS_USER });
    assert.strictEqual(await owner("select r.verified::text || '|' || r.code from postona_g4_credential.threads_publish_credential_verdict(:'u'::uuid, :'t') r", { u: p.userId, t: p.account }), "true|VERIFIED");
    const generation = await generationOf(p.account);
    assert.match(generation, /^[0-9a-f]{64}$/u, "013: the reservation schema's generation of G4's verdict");
    await snapshot(p.account, generation);
    assert.strictEqual(await countOf("select count(*) from postona_threads_resv.reservations"), 0);
  });

  await t.step("L48 the person's ledger over real HTTP: create (idempotent per request id), conflict / consent / time / other person / no token refused; receipt; cancel; nothing sent", async () => {
    const text = "G3-02 #27 予約 1";
    const body = await createBody(p, text, at(4));
    const first = await http(TH, body, p.token);
    const again = await http(TH, body, p.token);
    const r1 = first.body.reservation as Record<string, unknown>;
    const r2 = again.body.reservation as Record<string, unknown>;
    assert.deepStrictEqual([first.status, r1.status, r1.created, again.status, r2.reservationId, r2.created], [200, "planned", true, 200, r1.reservationId, false]);
    const refusals: Record<string, Answer> = {
      conflict: await http(TH, { ...body, payload: { ...body.payload, text: "別の本文", contentSha256: await sha256("別の本文") } }, p.token),
      consent: await http(TH, { ...(await createBody(p, text, at(4))), payload: { ...(await createBody(p, text, at(4))).payload, contentSha256: "0".repeat(64) } }, p.token),
      past: await http(TH, await createBody(p, text, new Date(Date.now() - 60e3).toISOString()), p.token),
      far: await http(TH, await createBody(p, text, at(61)), p.token),
      otherPerson: await http(TH, await createBody({ ...other, account: p.account }, text, at(4)), other.token),
      noToken: await http(TH, await createBody(p, text, at(4))),
    };
    assert.deepStrictEqual(Object.fromEntries(Object.entries(refusals).map(([k, a]) => [k, a.body.code])), {
      conflict: "POSTONA_THREADS_RESV_IDEMPOTENCY_CONFLICT", consent: "POSTONA_THREADS_RESV_CONSENT_REQUIRED", past: "POSTONA_THREADS_RESV_SCHEDULE_INVALID",
      far: "POSTONA_THREADS_RESV_SCHEDULE_INVALID", otherPerson: "POSTONA_THREADS_RESV_ACCOUNT_NOT_FOUND", noToken: "AUTH_REQUIRED",
    });
    for (const a of Object.values(refusals)) assert.ok(a.status >= 400 && a.status < 500, `${a.status} ${a.text}`);
    assert.deepStrictEqual(await receipt(p, body.payload.clientRequestId), { reservationId: r1.reservationId, state: "pending", providerPostId: null, outcomeCode: null, afterFreeze: false, simulated: true });
    const foreign = await http(TH, { action: "receipt", payload: { socialAccountId: p.account, clientRequestId: body.payload.clientRequestId } }, other.token);
    assert.strictEqual(foreign.body.code, "POSTONA_THREADS_RESV_NOT_FOUND", "another person's receipt: no oracle");
    assert.strictEqual((await cancel(other, String(r1.reservationId))).body.code, "POSTONA_THREADS_RESV_NOT_FOUND");
    assert.strictEqual(await countOf("select count(*) from postona_threads_resv.reservations where user_id = :'u'", { u: p.userId }), 1, "one row, refusals wrote nothing");
    assert.strictEqual((await cancel(p, String(r1.reservationId))).status, 200);
    assert.strictEqual((await cancel(p, String(r1.reservationId))).body.code, "POSTONA_THREADS_RESV_NOT_CANCELLABLE");
    assert.strictEqual((await receipt(p, body.payload.clientRequestId)).state, "cancelled");
    assert.strictEqual(await countOf("select count(*) from postona_threads_resv.audit where reservation_id = :'i' and action = 'cancel'", { i: String(r1.reservationId) }), 1);
    assert.strictEqual(await countOf("select count(*) from g3ls_test.threads_calls"), 0, "nothing sent");
  });

  await t.step("L49 E2E one send: create -> due -> worker HTTP -> 007 claim (generation bound) -> G4 two-step send with the pre-publish re-check -> published once; receipt; never again", async () => {
    await quiet();
    const r = await create(p, "G3-02 #27 E2E 1");
    await makeDue(r.id);
    const run = await deliver();
    assert.deepStrictEqual([run.status, pick(run.report, "claimed", "sends", "published", "prepublishRechecks", "uncertain", "failedBeforeSend")],
      [200, { claimed: 1, sends: 1, published: 1, prepublishRechecks: 1, uncertain: 0, failedBeforeSend: 0 }], run.text);
    assert.deepStrictEqual([await calls("container"), await calls("status"), await calls("publish"), await calls("readback")], [1, 1, 1, 1]);
    const state = await stateOf(r.id);
    assert.match(state, /^published\/PUBLISHED\/2[0-9]{9}\/simulated$/u, state);
    const rc = await receipt(p, r.crid);
    assert.deepStrictEqual([rc.state, rc.providerPostId, rc.simulated, rc.afterFreeze], ["sent", state.split("/")[2], true, false]);
    assert.strictEqual(await owner("select text from g3ls_test.threads_calls where step = 'container'"), "G3-02 #27 E2E 1", "exactly the consented text");
    const second = await deliver();
    assert.deepStrictEqual(pick(second.report, "claimed", "sends"), { claimed: 0, sends: 0 });
    assert.strictEqual(await calls("publish"), 1, "never again");
    assert.strictEqual((await cancel(p, r.id)).body.code, "POSTONA_THREADS_RESV_NOT_CANCELLABLE", "a published row is final");
  });

  await t.step("L50 change of time = cancel + a new consented reservation (the ledger has no in-place reschedule): only the new one is sent", async () => {
    await quiet();
    const old = await create(p, "G3-02 #27 旧時刻", at(5));
    assert.strictEqual((await cancel(p, old.id)).status, 200);
    const moved = await create(p, "G3-02 #27 旧時刻", at(6));
    await owner("update postona_threads_resv.reservations set scheduled_at = now() - interval '1 minute' where id in (:'a', :'b')", { a: old.id, b: moved.id });
    const p0 = await calls("publish");
    const run = await deliver();
    assert.deepStrictEqual(pick(run.report, "claimed", "published"), { claimed: 1, published: 1 }, run.text);
    assert.deepStrictEqual([(await stateOf(old.id)).split("/")[0], (await stateOf(moved.id)).split("/")[0], await calls("publish")], ["cancelled", "published", p0 + 1]);
  });

  await t.step("L51 workers at once (the twin claims one row per run): three HTTP runs in parallel over 4 due rows take 3 distinct rows, the 4th run the last; each row sent exactly once", async () => {
    await quiet();
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await create(p, `G3-02 #27 並行 ${i}`)).id);
    await owner("update postona_threads_resv.reservations set scheduled_at = now() - interval '1 minute' where id = any(string_to_array(:'ids', ',')::uuid[])", { ids: ids.join(",") });
    const p0 = await calls("publish");
    const c0 = await calls("container");
    const runs = await Promise.all([deliver(), deliver(), deliver()]);
    const total = (rs: Awaited<ReturnType<typeof deliver>>[], k: string) => rs.reduce((n, r) => n + Number(r.report?.[k] ?? 0), 0);
    console.log(`G3LS_L51 ${JSON.stringify(runs.map((r) => pick(r.report, "claimed", "published")))}`);
    assert.deepStrictEqual(runs.map((r) => pick(r.report, "claimed", "published")), [1, 1, 1].map(() => ({ claimed: 1, published: 1 })), "three runs, three distinct rows");
    const rest = await Promise.all([deliver(), deliver()]);
    assert.deepStrictEqual([total(rest, "claimed"), total(rest, "published")], [1, 1], "the last row once; the other run finds nothing");
    assert.deepStrictEqual([await calls("container") - c0, await calls("publish") - p0], [4, 4]);
    const states = await Promise.all(ids.map(stateOf));
    assert.ok(states.every((s) => s.startsWith("published/")), states.join(" "));
    assert.strictEqual(new Set(states.map((s) => s.split("/")[2])).size, 4, "four distinct media ids");
    assert.strictEqual(await countOf("select count(*) from (select text from g3ls_test.threads_calls where step = 'container' group by text having count(*) > 1) d"), 0, "no text sent twice");
  });

  await t.step("L52 provider answers (G4's real mapping): container refused / unknown and publish refused -> failed before send, never retried; publish unknown / read-back unknown -> uncertain, never re-sent, not cancellable", async () => {
    const results: Record<string, string> = {};
    for (const m of ["container_reject", "container_unknown", "publish_reject", "publish_unknown", "readback_unknown"]) {
      await quiet();
      const r = await create(p, `G3-02 #27 ${m}`);
      await makeDue(r.id);
      await mode(m);
      const c0 = await calls("container");
      const run = await deliver();
      await mode("ok");
      results[m] = (await stateOf(r.id)).split("/").slice(0, 2).join("/");
      assert.strictEqual(run.report?.sends, 1, `${m}: one send`);
      const again = await deliver();
      assert.deepStrictEqual([pick(again.report, "claimed", "sends"), await calls("container") - c0], [{ claimed: 0, sends: 0 }, 1], `${m}: never again`);
      const rc = await receipt(p, r.crid);
      assert.strictEqual(rc.state, results[m].startsWith("uncertain") ? "uncertain" : "failed", `${m}: receipt ${JSON.stringify(rc)}`);
      assert.strictEqual((await cancel(p, r.id)).body.code, "POSTONA_THREADS_RESV_NOT_CANCELLABLE", `${m}: final`);
    }
    console.log(`G3LS_L52 ${JSON.stringify(results)}`);
    assert.deepStrictEqual(results, {
      container_reject: "failed/THREADS_REQUEST_REJECTED",
      container_unknown: "failed/THREADS_CONTAINER_UNKNOWN_NOT_POSTED",
      publish_reject: "failed/THREADS_TOKEN_INVALID",
      publish_unknown: "uncertain/THREADS_UNAVAILABLE",
      readback_unknown: "uncertain/THREADS_READBACK_UNKNOWN",
    });
  });

  await t.step("L53 fail closed before the provider: a credential of another generation, U8 OFF at send, a reconnect between claim and send -> not sent (0 provider calls)", async () => {
    const before = await countOf("select count(*) from g3ls_test.threads_calls");
    const good = await generationOf(p.account!);
    // (a) the credential port answers another generation than 007 bound at claim
    await quiet();
    const a = await create(p, "G3-02 #27 世代違い");
    await makeDue(a.id);
    await snapshot(p.account!, "f".repeat(64));
    const ra = await deliver();
    await snapshot(p.account!, good);
    assert.deepStrictEqual([pick(ra.report, "claimed", "sends", "failedBeforeSend"), await stateOf(a.id)],
      [{ claimed: 1, sends: 0, failedBeforeSend: 1 }, "failed/CREDENTIAL_GENERATION_CHANGED/-/simulated"]);
    // (b) G4's publish switch OFF after create (SYNTHETIC: what U8 OFF leaves): 007 preflight refuses
    await quiet();
    const b = await create(p, "G3-02 #27 U8 OFF");
    await makeDue(b.id);
    await publishSwitch(p.account!, false);
    const rb = await deliver();
    await publishSwitch(p.account!, true);
    assert.deepStrictEqual([pick(rb.report, "claimed", "sends", "skipped"), await stateOf(b.id)], [{ claimed: 1, sends: 0, skipped: 1 }, "failed/NOT_PUBLISHABLE_AT_SEND/-/-"]);
    // (c) a reconnect after the claim (SYNTHETIC: a new oauth_state_id = G4's new generation): 007 preflight -> CREDENTIAL_CHANGED
    await quiet();
    const c = await create(p, "G3-02 #27 再接続");
    await makeDue(c.id);
    const claimed = await psql("g3ls_worker_login", WORKER_PW, "set role postona_resv_worker;\nselect count(*) from postona_threads_resv.claim_due('g3ls-manual', 60, 1);");
    assert.strictEqual(claimed, "1", "claimed by another worker run (generation bound now)");
    const lease = await owner("select lease_token from postona_threads_resv.reservations where id = :'i'", { i: c.id });
    await owner("update postona_threads_binding.bindings set oauth_state_id = gen_random_uuid() where social_account_id = :'a'", { a: p.account! });
    const fresh = await generationOf(p.account!);
    assert.notStrictEqual(fresh, good);
    await snapshot(p.account!, fresh);
    const pre = await psql("g3ls_worker_login", WORKER_PW, "set role postona_resv_worker;\nselect verdict from postona_threads_resv.preflight(:'i'::uuid, :'l'::uuid);", { i: c.id, l: lease });
    assert.deepStrictEqual([pre, await stateOf(c.id)], ["NOT_PUBLISHABLE", "failed/CREDENTIAL_CHANGED/-/-"]);
    assert.strictEqual(await countOf("select count(*) from g3ls_test.threads_calls"), before, "no provider call in (a) / (b) / (c)");
  });

  await t.step("L54 the pre-publish re-check (G4 awaits G3's hook after the container, before the publish): U8 OFF or a reconnect while the container waits -> no publish request", async () => {
    const out: Record<string, unknown> = {};
    for (const change of ["u8_off", "reconnect"]) {
      await quiet();
      const r = await create(p, `G3-02 #27 hook ${change}`);
      await makeDue(r.id);
      await mode("status_hold");
      const [c0, p0] = [await calls("container"), await calls("publish")];
      const running = deliver();
      await sleeping("g3ls-threads-fake-hold");   // the container exists; the status read is parked
      if (change === "u8_off") await publishSwitch(p.account!, false);
      else await owner("update postona_threads_binding.bindings set oauth_state_id = gen_random_uuid() where social_account_id = :'a'", { a: p.account! });
      const run = await running;
      await mode("ok");
      if (change === "u8_off") await publishSwitch(p.account!, true);
      else await snapshot(p.account!, await generationOf(p.account!));
      out[change] = { report: pick(run.report, "sends", "prepublishRechecks", "prepublishRefused", "published"), state: await stateOf(r.id) };
      assert.deepStrictEqual([await calls("container") - c0, await calls("publish") - p0], [1, 0], `${change}: a container, never a publish`);
      assert.deepStrictEqual(pick(run.report, "sends", "prepublishRechecks", "prepublishRefused", "published"), { sends: 1, prepublishRechecks: 1, prepublishRefused: 1, published: 0 });
      assert.strictEqual(await stateOf(r.id), change === "u8_off" ? "failed/NOT_PUBLISHABLE_AT_SEND/-/-" : "failed/CREDENTIAL_CHANGED/-/-");
    }
    console.log(`G3LS_L54 ${JSON.stringify(out)}`);
  });

  await t.step("L55 a worker that died holding a lease: no other run takes the row while the lease runs; once it ran out the next claim fences it to uncertain (never sent, no timer retry)", async () => {
    await quiet();
    const r = await create(p, "G3-02 #27 lease");
    await makeDue(r.id);
    assert.strictEqual(await psql("g3ls_worker_login", WORKER_PW, "set role postona_resv_worker;\nselect count(*) from postona_threads_resv.claim_due('g3ls-dead', 60, 1);"), "1");
    const c0 = await countOf("select count(*) from g3ls_test.threads_calls");
    assert.deepStrictEqual(pick((await deliver()).report, "claimed", "sends"), { claimed: 0, sends: 0 }, "the live lease is not taken");
    assert.strictEqual((await receipt(p, r.crid)).state, "pending");
    await owner("update postona_threads_resv.reservations set lease_expires_at = now() - interval '1 second' where id = :'i'", { i: r.id });   // SYNTHETIC clock
    assert.strictEqual((await receipt(p, r.crid)).state, "uncertain", "an expired lease may have reached Threads");
    assert.deepStrictEqual(pick((await deliver()).report, "claimed", "sends"), { claimed: 0, sends: 0 });
    assert.strictEqual(await stateOf(r.id), "uncertain/LEASE_EXPIRED/-/-");
    assert.deepStrictEqual(pick((await deliver()).report, "claimed", "sends"), { claimed: 0, sends: 0 });
    assert.strictEqual(await countOf("select count(*) from g3ls_test.threads_calls"), c0, "never sent");
    assert.strictEqual((await cancel(p, r.id)).body.code, "POSTONA_THREADS_RESV_NOT_CANCELLABLE");
  });

  await t.step("L56 the worker entry: no / wrong secret -> 401, nothing claimed; a signed-out person: 401 on create / cancel / receipt, the consented row is still the ledger's", async () => {
    await quiet();
    const r = await create(p, "G3-02 #27 auth");
    await makeDue(r.id);
    for (const secret of ["", "wrong-" + WORKER_SECRET]) {
      const run = await deliver(secret);
      assert.deepStrictEqual([run.status, run.code], [401, "WORKER_AUTH_REQUIRED"]);
    }
    assert.strictEqual((await stateOf(r.id)).split("/")[0], "planned", "nothing claimed");
    const s = await signUp("t27s");
    const out = await auth("logout", {}, s.token);
    await out.body?.cancel();
    assert.strictEqual(out.status, 204);
    const signedOut = { ...s, account: p.account };
    assert.deepStrictEqual([(await http(TH, await createBody(signedOut, "x", at(3)), s.token)).status, (await cancel(signedOut, r.id)).status,
      (await http(TH, { action: "receipt", payload: { socialAccountId: p.account, clientRequestId: r.crid } }, s.token)).status], [401, 401, 401]);
    const run = await deliver();
    assert.deepStrictEqual(pick(run.report, "claimed", "published"), { claimed: 1, published: 1 });
  });

  await t.step("L57 G5 service end (SYNTHETIC, as L8): a due row is never claimed nor sent -- stopped with G5's code; create refused; cancel / receipt go on", async () => {
    await quiet();
    const r = await create(p, "G3-02 #27 service end");
    const later = await create(p, "G3-02 #27 service end later", at(9));
    await makeDue(r.id);
    await owner("update public.service_entitlements set status = 'ended', ended_at = now() where user_id = :'u' and service_key = 'x_autopost'", { u: p.userId });
    const c0 = await countOf("select count(*) from g3ls_test.threads_calls");
    const run = await deliver();
    const state = await stateOf(r.id);
    console.log(`G3LS_L57 ${JSON.stringify(run.report)} row ${state}`);
    assert.deepStrictEqual(pick(run.report, "claimed", "sends"), { claimed: 0, sends: 0 });
    assert.match(state, /^failed\/[A-Z][A-Z0-9_]+\/-\/-$/u);
    assert.strictEqual(await countOf("select count(*) from g3ls_test.threads_calls"), c0, "nothing sent");
    assert.ok((await http(TH, await createBody(p, "after end", at(3)), p.token)).status >= 400);
    assert.strictEqual((await cancel(p, later.id)).status, 200, "the person still stops own rows");
    assert.strictEqual((await receipt(p, r.crid)).state, "failed");
    await owner("update public.service_entitlements set status = 'active', ended_at = null where user_id = :'u' and service_key = 'x_autopost'", { u: p.userId });
  });

  await t.step("L58 token safety and roles: the fake saw only the snapshot's token (by hash); no token in the ledger or its audit; no Threads notification table (receipt only); API / worker roles hold only their 007 functions", async () => {
    const hashes = await owner("select string_agg(distinct bearer_sha256, ',') from g3ls_test.threads_calls");
    assert.strictEqual(hashes, await sha256(FAKE_TOKEN));
    assert.strictEqual(await countOf("select count(*) from postona_threads_resv.reservations r where r::text like '%' || :'t' || '%'", { t: FAKE_TOKEN }), 0);
    assert.strictEqual(await countOf("select count(*) from postona_threads_resv.audit a where a::text like '%' || :'t' || '%'", { t: FAKE_TOKEN }), 0);
    assert.strictEqual(await owner("select coalesce(to_regclass('postona_threads_resv.notifications')::text, 'none')"), "none", "Threads results reach the person through receipt only (G3 open item)");
    const grants = await owner(`select string_agg(r.rolname || ':' || p.proname, ',' order by r.rolname, p.proname) from pg_proc p cross join pg_roles r
where p.pronamespace = 'postona_threads_resv'::regnamespace and r.rolname in ('postona_resv_api', 'postona_resv_worker', 'anon', 'authenticated', 'service_role')
  and has_function_privilege(r.oid, p.oid, 'EXECUTE')`);
    assert.strictEqual(grants, "postona_resv_api:cancel_reservation,postona_resv_api:create_reservation,postona_resv_api:receipt,postona_resv_worker:claim_due,postona_resv_worker:preflight,postona_resv_worker:record,postona_resv_worker:release_unsent");
    const totals = await owner("select string_agg(status || '=' || n, ',' order by status) from (select status, count(*) n from postona_threads_resv.reservations where user_id = :'u' group by status) s", { u: p.userId });
    const published = await countOf("select count(*) from postona_threads_resv.reservations where status = 'published'");
    // every publish request is a published row except L52's three: publish_reject (refused), publish_unknown and readback_unknown (uncertain)
    assert.strictEqual(await calls("publish") - 3, published);
    // G4's U8 CHECK back exactly as it was (the switch OFF first), and read back
    await owner("update public.social_accounts set publish_enabled = false where id = :'a'", { a: p.account! });
    await owner(`alter table public.social_accounts add constraint social_accounts_meta_publish_disabled ${u8Check}`);
    assert.strictEqual(await owner("select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.social_accounts'::regclass and conname = 'social_accounts_meta_publish_disabled' and convalidated"), u8Check);
    assert.ok((await psql("postgres", "postgres", "update public.social_accounts set publish_enabled = true where id = :'a'", { a: p.account! })).startsWith("ERR:"), "U8 refuses ON again");
    console.log(`G3LS_L58 rows ${totals}; provider calls ${await owner("select string_agg(step || '=' || n, ',' order by step) from (select step, count(*) n from g3ls_test.threads_calls group by step) s")}`);
  });
});
