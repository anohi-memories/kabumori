// G3 TASK 13/50: the person-facing HTTP contract over 007 on a disposable LOCAL PostgreSQL (postona_threads_http_contract_run.sh only),
// in the U8 world: the REAL 2a-2 CHECK stays in force (no test-only lift), so no reservation can be CREATED; rows used for cancel /
// receipt / worker cases are TEST DATA written by the owner (standing for rows made before U8 or migrated). G5's R1 / W1 are real
// (PR #371). MOCK_ONLY: the caller verdicts (no JWT is forged or verified here), Threads (a fake Graph that must stay silent).
// Network: 127.0.0.1 only. Every answer is compared as RAW BYTES where the contract says "the same answer".
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Client } from "jsr:@db/postgres@0.19.5";
import { runThreadsReservationDelivery, type ThreadsSendPort } from "../../../functions/_shared/postona_reservations/threads_dispatch.ts";
import { createPgPersonStore, createPgWorkerStore } from "../fixture/pg_fixture_ports.ts";
import { createThreadsReservationHttpFixture, type VerifiedCaller } from "../fixture/threads_reservation_http_fixture.ts";

const API_URL = Deno.env.get("THREADS_XO_API_URL")!;
const WORKER_URL = Deno.env.get("THREADS_XO_WORKER_URL")!;
const OWNER_URL = Deno.env.get("THREADS_XO_OWNER_URL")!;
const G4_DIR = Deno.env.get("THREADS_G4_SOCIAL_DIR")!;
assert.ok(API_URL && WORKER_URL && OWNER_URL && G4_DIR, "set by postona_threads_http_contract_run.sh");
type G4SendPortModule = {
  createGatedThreadsSendPort(enabled: boolean, transport: "threads" | "simulated", fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
    options?: { containerChecks?: number; containerCheckDelayMs?: number }): ThreadsSendPort;
};
const G4 = await import(new URL(`file://${encodeURI(`${G4_DIR}/threads_send_port.ts`)}`).href) as G4SendPortModule;

// ---- database --------------------------------------------------------------------------------------------------------
const owner = async <T extends unknown[]>(text: string, args: unknown[] = []) => {
  const c = new Client(OWNER_URL);
  await c.connect();
  try {
    return (await c.queryArray<T>({ text, args })).rows;
  } finally {
    await c.end();
  }
};
type Person = { user: string; threads: string; brand: string; token: string };
const people = new Map((await owner<[number, string, string, string, string]>("select n, user_id::text, threads_account, brand, token from t_ids.people"))
  .map(([n, user, threads, brand, token]) => [Number(n), { user, threads, brand, token } as Person]));
const P = (n: number) => people.get(n)!;
const reservations = async () => Number((await owner<[bigint]>("select count(*) from postona_threads_resv.reservations"))[0][0]);
const rowOf = async (id: string) => (await owner<[string, string | null, string]>(
  "select status, outcome_code, updated_at::text from postona_threads_resv.reservations where id = $1::uuid", [id]))[0];
type Planted = { id: string; clientId: string };
/** TEST DATA (owner): a row that did not come through create, with the account's CURRENT G5 pair unless told otherwise. */
async function plant(n: number, text: string, extra = ""): Promise<Planted> {
  const [[id, clientId]] = await owner<[string, string]>(
    `insert into postona_threads_resv.reservations (user_id, brand_id, social_account_id, client_request_id, body, content_sha256, scheduled_at,
       bound_owner_epoch, bound_lifecycle_version)
     select p.user_id, p.brand, p.threads_account, gen_random_uuid(), $2, encode(sha256(convert_to($2, 'UTF8')), 'hex'), now() + interval '1 hour',
       private.account_lifecycle_brand_owner_epoch(p.brand), (select a.lifecycle_version from public.common_accounts a where a.user_id = p.user_id)
     from t_ids.people p where p.n = $1 returning id::text, client_request_id::text`, [n, text]);
  if (extra) await owner(`update postona_threads_resv.reservations set ${extra} where id = $1::uuid`, [id]);
  return { id, clientId };
}
const due = (id: string) => owner("update postona_threads_resv.reservations set scheduled_at = now() - interval '1 second' where id = $1::uuid", [id]);
async function restartService(n: number) {
  await owner("update public.service_entitlements set status = 'ended', ended_at = now() where user_id = $1::uuid and service_key = 'x_autopost'", [P(n).user]);
  await owner("update public.service_entitlements set status = 'active', ended_at = null where user_id = $1::uuid and service_key = 'x_autopost'", [P(n).user]);
}

// ---- HTTP (MOCK verdicts; the session row exists unless a test removes it) ---------------------------------------------
const verdicts = new Map<string, VerifiedCaller>();
async function tokenOf(n: number): Promise<{ token: string; session: string }> {
  const [[session]] = await owner<[string]>("insert into auth.sessions (user_id) values ($1::uuid) returning id::text", [P(n).user]);
  const token = `tok-${n}-${crypto.randomUUID().slice(0, 8)}-0123456789abcdef`;
  verdicts.set(token, { userId: P(n).user, sessionId: session });
  return { token, session };
}
let loseAfterCommit = false;
const http = createThreadsReservationHttpFixture({ enabled: true, verify: (t: string) => Promise.resolve(verdicts.get(t) ?? null),
  store: createPgPersonStore(API_URL, { loseAnswerAfterCommit: () => { const v = loseAfterCommit; loseAfterCommit = false; return v; } }) });
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
type Raw = { status: number; text: string; json: Record<string, unknown> };
async function req(token: string, body: unknown): Promise<Raw> {
  const res = await http(new Request("http://fixture.local/threads-reservations", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
}
const createBody = (account: string, text: string, id = crypto.randomUUID()) =>
  ({ op: "create", socialAccountId: account, clientRequestId: id, text, scheduledAt: new Date(Date.now() + 10 * 60_000).toISOString(), consent: { confirmed: true, contentSha256: sha(text) } });
const receipt = (token: string, account: string, clientId: string) => req(token, { op: "receipt", socialAccountId: account, clientRequestId: clientId });
const cancel = (token: string, id: string) => req(token, { op: "cancel", reservationId: id });

// ---- the worker over a fake Graph that must stay silent -------------------------------------------------------------------
function silentGraph() {
  const events: string[] = [];
  return { events, fetchImpl: (input: string) => { events.push(new URL(input).pathname); return Promise.resolve(new Response("{}", { status: 400 })); } };
}
const credentials = { available: true, credentialFor: () => Promise.resolve(null) };
const deliver = (g: ReturnType<typeof silentGraph>) => runThreadsReservationDelivery({ enabled: true, store: createPgWorkerStore(WORKER_URL), credentials,
  sender: G4.createGatedThreadsSendPort(true, "simulated", g.fetchImpl, { containerChecks: 1, containerCheckDelayMs: 0 }), worker: "http13", leaseSeconds: 60, limit: 50 });

// ---- tests -----------------------------------------------------------------------------------------------------------------
Deno.test("P1 create in the U8 world: the person's own verified account -> 403 PUBLISH_DISABLED, no row; another person's account and a missing account -> the SAME bytes", async () => {
  const me = await tokenOf(101);
  const own = await req(me.token, createBody(P(101).threads, "P1 own"));
  assert.deepEqual([own.status, own.json], [403, { ok: false, code: "PUBLISH_DISABLED" }]);
  const theirs = await req(me.token, createBody(P(102).threads, "P1 theirs"));
  const missing = await req(me.token, createBody("sa_ffffffffffffffffffffffff", "P1 missing"));
  assert.equal(theirs.text, missing.text, "byte-identical");
  assert.deepEqual([theirs.status, theirs.json.code], [404, "NOT_FOUND"]);
  assert.equal(await reservations(), 0);
});

Deno.test("P2 receipt and cancel of another person's reservation are byte-identical to an unknown id / another account", async () => {
  const theirs = await plant(103, "P2 本文 SECRET");
  const me = await tokenOf(104);
  const answers = [
    await receipt(me.token, P(103).threads, theirs.clientId),
    await receipt(me.token, P(104).threads, theirs.clientId),
    await receipt(me.token, P(103).threads, crypto.randomUUID()),
  ];
  assert.deepEqual(new Set(answers.map((a) => `${a.status} ${a.text}`)).size, 1);
  assert.deepEqual([answers[0].status, answers[0].json.code], [404, "RECEIPT_NOT_FOUND"]);
  const c1 = await cancel(me.token, theirs.id);
  const c2 = await cancel(me.token, crypto.randomUUID());
  assert.equal(`${c1.status} ${c1.text}`, `${c2.status} ${c2.text}`);
  assert.deepEqual([c1.status, c1.json.code], [404, "NOT_FOUND"]);
  assert.equal((await rowOf(theirs.id))[0], "planned", "another person's cancel changed nothing");
});

Deno.test("P3 two cancels at once -> exactly one 200 and one 409; cancel racing the worker -> cancelled XOR stopped, never both; the Graph stays silent", async () => {
  const me = await tokenOf(105);
  const a = await plant(105, "P3 double cancel");
  const [r1, r2] = await Promise.all([cancel(me.token, a.id), cancel(me.token, a.id)]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  assert.equal((await rowOf(a.id))[0], "cancelled");
  for (let i = 0; i < 3; i += 1) {
    const b = await plant(105, `P3 race ${i}`);
    await due(b.id);
    const g = silentGraph();
    const [c, w] = await Promise.all([cancel(me.token, b.id), deliver(g)]);
    const [status, code] = await rowOf(b.id);
    if (c.status === 200) assert.deepEqual([status, w.claimed], ["cancelled", 0], `race ${i}`);
    else assert.deepEqual([c.status, c.json.code, status, code], [409, "NOT_CANCELLABLE", "failed", "NOT_PUBLISHABLE_AT_SEND"], `race ${i}`);
    assert.equal(g.events.length, 0);
  }
});

Deno.test("P4 the cancel answer is lost after COMMIT -> 503 OUTCOME_UNKNOWN; the receipt then says cancelled; cancelling again -> 409, nothing else changes", async () => {
  const me = await tokenOf(106);
  const a = await plant(106, "P4 lost cancel");
  loseAfterCommit = true;
  const lost = await cancel(me.token, a.id);
  assert.deepEqual([lost.status, lost.json.code], [503, "OUTCOME_UNKNOWN"]);
  assert.deepEqual([(await receipt(me.token, P(106).threads, a.clientId)).json.state, (await rowOf(a.id))[0]], ["cancelled", "cancelled"]);
  const again = await cancel(me.token, a.id);
  assert.deepEqual([again.status, again.json.code], [409, "NOT_CANCELLABLE"]);
});

Deno.test("P5 uncertain (an expired lease) and a frozen published row: receipts are read-only, text- and token-free; xPostId only for the owner", async () => {
  const me = await tokenOf(107);
  const unsure = await plant(107, "P5 本文 SECRET uncertain", "status = 'claimed', lease_token = gen_random_uuid(), lease_expires_at = now() - interval '1 minute', claimed_by = 'w9'");
  const before = await rowOf(unsure.id);
  const r1 = await receipt(me.token, P(107).threads, unsure.clientId);
  const r2 = await receipt(me.token, P(107).threads, unsure.clientId);
  assert.equal(r1.text, r2.text, "repeatable");
  assert.deepEqual([r1.json.state, r1.json.action, "xPostId" in r1.json], ["uncertain", "none", false]);
  assert.deepEqual(await rowOf(unsure.id), before, "a receipt never writes, re-arms or sends");
  const frozen = await plant(107, "P5 本文 SECRET frozen", "status = 'published', provider_post_id = '18400000000000001', outcome_code = 'PUBLISHED', transport = 'simulated', after_freeze = true");
  const mine = await receipt(me.token, P(107).threads, frozen.clientId);
  assert.deepEqual([mine.json.state, mine.json.xPostId, mine.json.afterFreeze, mine.json.simulated], ["sent", "18400000000000001", true, true]);
  for (const r of [r1, mine]) for (const secret of ["SECRET", P(107).token, P(107).user, P(107).brand]) assert.equal(r.text.includes(secret), false, secret);
  const other = await tokenOf(108);
  const theirs = await receipt(other.token, P(107).threads, frozen.clientId);
  assert.deepEqual([theirs.status, theirs.text.includes("18400000000000001")], [404, false]);
});

Deno.test("P6 G5's REAL W1 stops (stale generation, missing pair) -> receipt asks to reconfirm; the same id never re-arms; the Graph stays silent", async () => {
  const me = await tokenOf(109);
  const stale = await plant(109, "P6 stale");
  await restartService(109);
  const missing = await plant(109, "P6 missing pair", "bound_owner_epoch = null, bound_lifecycle_version = null");
  for (const id of [stale.id, missing.id]) await due(id);
  const g = silentGraph();
  const w = await deliver(g);
  assert.deepEqual([w.claimed, g.events.length], [0, 0]);
  const rs = await receipt(me.token, P(109).threads, stale.clientId);
  const rm = await receipt(me.token, P(109).threads, missing.clientId);
  assert.deepEqual([rs.json.state, rs.json.code, rs.json.action], ["failed", "SERVICE_GENERATION_CHANGED", "reconfirm_and_create_new"]);
  assert.deepEqual([rm.json.state, rm.json.code, rm.json.action], ["failed", "EXPECTED_OWNER_EPOCH_REQUIRED", "reconfirm_and_create_new"]);
  const again = await req(me.token, { ...createBody(P(109).threads, "P6 stale"), clientRequestId: stale.clientId });
  assert.equal(again.status === 200, false, "the same id is never re-armed (U8: create is refused anyway)");
  assert.deepEqual((await rowOf(stale.id)).slice(0, 2), ["failed", "SERVICE_GENERATION_CHANGED"]);
});

Deno.test("P7 FIXED (G3-34): with the person's session row removed or expired, cancel and receipt refuse (401 AUTH_REQUIRED, G5's S2-2 asked first by caller()) and change nothing", async () => {
  const me = await tokenOf(110);
  const a = await plant(110, "P7 session");
  await owner("delete from auth.sessions where id = $1::uuid", [me.session]);
  const r = await receipt(me.token, P(110).threads, a.clientId);
  assert.equal(r.status, 401, "a removed session row: the receipt refuses before any row is read");
  const exp = await tokenOf(110);
  await owner("update auth.sessions set not_after = now() - interval '1 minute' where id = $1::uuid", [exp.session]);
  const c = await cancel(exp.token, a.id);
  assert.equal(c.status, 401, "an expired session row: cancel refuses");
  assert.deepEqual((await owner<[string]>("select status from postona_threads_resv.reservations where id = $1::uuid", [a.id]))[0], ["planned"], "nothing changed");
  const live = await tokenOf(110);
  assert.equal((await receipt(live.token, P(110).threads, a.clientId)).status, 200, "a live session of the same person still reads it");
});

Deno.test("P8 nothing published, nothing pending, the U8 CHECK untouched", async () => {
  const [[published, switchOn]] = await owner<[bigint, bigint]>(`select
    (select count(*) from postona_threads_resv.reservations where status = 'published' and provider_post_id <> '18400000000000001'),
    (select count(*) from public.social_accounts where platform = 'threads' and publish_enabled)`);
  assert.deepEqual([Number(published), Number(switchOn)], [0, 0]);
});
