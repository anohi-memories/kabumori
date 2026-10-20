// G3 TASK 3/50 end to end on a disposable LOCAL PostgreSQL (postona_threads_http_worker_run.sh only):
//   HTTP fixture (MOCK caller verdict) -> person store (postona_resv_api) -> 007 -> worker fixture: PR #334 dispatcher
//   + 007 worker store + the PROPOSED pre-publish hook around a SIMULATED two-step send -> receipt over HTTP.
// MOCK_ONLY: caller verdicts, G4's credential port (fake token + the database's generation), Threads. No network beyond
// 127.0.0.1; every would-be provider request is counted.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Client } from "jsr:@db/postgres@0.19.5";
import { runThreadsReservationDelivery, type ThreadsCredentialPort, type ThreadsSendOutcome } from "../../../functions/_shared/postona_reservations/threads_dispatch.ts";
import { createPgPersonStore, createPgWorkerStore } from "../fixture/pg_fixture_ports.ts";
import { createThreadsReservationHttpFixture, type VerifiedCaller } from "../fixture/threads_reservation_http_fixture.ts";
import { createFixtureTwoStepSendPort, PR337_DEPLOYABLE_SHAPE, withPrepublishRecheck } from "../fixture/threads_worker_fixture.ts";

const API_URL = Deno.env.get("THREADS_HTTP_API_URL")!;
const WORKER_URL = Deno.env.get("THREADS_HTTP_WORKER_URL")!;
const OWNER_URL = Deno.env.get("THREADS_HTTP_OWNER_URL")!;
assert.ok(API_URL && WORKER_URL && OWNER_URL, "set by postona_threads_http_worker_run.sh");

const owner = async <T extends unknown[]>(text: string, args: unknown[] = []) => {
  const c = new Client(OWNER_URL);
  await c.connect();
  try {
    return (await c.queryArray<T>({ text, args })).rows;
  } finally {
    await c.end();
  }
};
const people = new Map((await owner<[number, string, string, string]>("select n, user_id::text, threads_account, brand from t_ids.people")).map(([n, u, t, b]) => [Number(n), { user: u, threads: t, brand: b }]));
const P = (n: number) => people.get(n)!;

// MOCK verdicts: token "tok-<n>-..." is person n with a fresh session id.
const verdicts = new Map<string, VerifiedCaller>();
const tokenOf = (n: number) => {
  const token = `tok-${n}-0123456789abcdef`;
  verdicts.set(token, { userId: P(n).user, sessionId: crypto.randomUUID() });
  return token;
};
const verify = (t: string) => Promise.resolve(verdicts.get(t) ?? null);
let loseAfterCommit = false;
const http = createThreadsReservationHttpFixture({ enabled: true, verify, store: createPgPersonStore(API_URL, { loseAnswerAfterCommit: () => { const v = loseAfterCommit; loseAfterCommit = false; return v; } }) });
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
async function req(token: string | null, body: unknown) {
  const res = await http(new Request("http://fixture.local/threads-reservations", { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const create = (token: string, n: number, text: string, id = crypto.randomUUID(), at = inMinutes(10)) =>
  req(token, { op: "create", socialAccountId: P(n).threads, clientRequestId: id, text, scheduledAt: at, consent: { confirmed: true, contentSha256: sha(text) } }).then((r) => ({ ...r, id, at }));
const receipt = (token: string, n: number, id: string) => req(token, { op: "receipt", socialAccountId: P(n).threads, clientRequestId: id });
const due = (rid: string) => owner("update postona_threads_resv.reservations set scheduled_at = now() - interval '1 second' where id = $1::uuid", [rid]);
const status = async (rid: string) => (await owner<[string, string | null]>("select status, outcome_code from postona_threads_resv.reservations where id = $1::uuid", [rid]))[0];
const rows = async () => Number((await owner<[bigint]>("select count(*) from postona_threads_resv.reservations"))[0][0]);

let generationOverride: string | null = null;
const credentials: ThreadsCredentialPort = {
  available: true,
  async credentialFor(account) {
    const [[generation, userId]] = await owner<[string | null, string | null]>(
      "select postona_threads_resv.threads_credential_generation($1), (select platform_user_id from public.social_accounts where id = $1)", [account]);
    return generation && userId ? { socialAccountId: account, threadsUserId: userId, accessToken: `fake-threads-token-${account}`, generation: generationOverride ?? generation } : null;
  },
};
const workerStore = createPgWorkerStore(WORKER_URL);
async function runWorker(opts: { honourHook?: boolean; duringWait?: () => Promise<void>; outcome?: () => ThreadsSendOutcome | null; worker?: string } = {}) {
  const send = createFixtureTwoStepSendPort({ honourHook: opts.honourHook ?? true, duringWait: opts.duringWait, outcome: opts.outcome });
  const wrapped = withPrepublishRecheck(workerStore, send.port);
  const report = await runThreadsReservationDelivery({ enabled: true, store: wrapped.store, credentials, sender: wrapped.sender, worker: opts.worker ?? "w1", leaseSeconds: 60, limit: 50 });
  return { report, log: send.log, rechecks: wrapped.rechecks() };
}

Deno.test("H1 create over HTTP -> 200; the same request -> the same row (created:false); same id + other text / time -> 409; receipt pending, simulated, text-free", async () => {
  const t = tokenOf(61);
  const first = await create(t, 61, "H1 Threads 予約");
  assert.deepEqual([first.status, first.body.created, first.body.status], [200, true, "planned"]);
  const again = await req(t, { op: "create", socialAccountId: P(61).threads, clientRequestId: first.id, text: "H1 Threads 予約", scheduledAt: first.at, consent: { confirmed: true, contentSha256: sha("H1 Threads 予約") } });
  assert.deepEqual([again.status, again.body.reservationId, again.body.created], [200, first.body.reservationId, false]);
  assert.deepEqual((await create(t, 61, "H1 別の本文", first.id, first.at)).body, { ok: false, code: "IDEMPOTENCY_CONFLICT" });
  assert.deepEqual((await create(t, 61, "H1 Threads 予約", first.id, inMinutes(30))).body, { ok: false, code: "IDEMPOTENCY_CONFLICT" });
  const r = await receipt(t, 61, first.id);
  assert.deepEqual(r.body, { ok: true, reservationId: first.body.reservationId, state: "pending", simulated: true, afterFreeze: false, action: "none" });
  assert.ok(!JSON.stringify(r.body).includes("H1 Threads"));
});

Deno.test("H2 another person / account / brand: 404 on create; the receipt of another person's id is byte-identical to an unknown id", async () => {
  const a = tokenOf(62);
  const b = tokenOf(63);
  const before = await rows();
  assert.deepEqual((await create(a, 63, "他人の口座")).body, { ok: false, code: "NOT_FOUND" });
  const mine = await create(b, 63, "H2 本人の予約");
  assert.equal(mine.status, 200);
  const other = await receipt(a, 63, mine.id);
  const unknown = await receipt(a, 63, crypto.randomUUID());
  const ownAccountUnknown = await receipt(a, 62, mine.id);
  assert.deepEqual([other, unknown, ownAccountUnknown].map((x) => JSON.stringify(x)), Array(3).fill(JSON.stringify({ status: 404, body: { ok: false, code: "RECEIPT_NOT_FOUND" } })));
  assert.equal(await rows(), before + 1);
  assert.equal((await req(null, { op: "receipt", socialAccountId: P(63).threads, clientRequestId: mine.id })).status, 401);
});

Deno.test("H3 fail-closed at create (nothing written): G4 not verified, switch OFF, entitlement ended, account deleting, unknown session", async () => {
  const before = await rows();
  const cases: [number, string, string, string][] = [
    [64, "delete from t_threads.verified where social_account_id = $1", "insert into t_threads.verified values ($1)", "ACCOUNT_NOT_VERIFIED"],
    [65, "update public.social_accounts set publish_enabled = false where id = $1", "update public.social_accounts set publish_enabled = true where id = $1", "PUBLISH_DISABLED"],
    [66, "update public.service_entitlements set status = 'ended', ended_at = now() where service_key = 'x_autopost' and user_id = (select user_id from t_ids.people where threads_account = $1)",
      "update public.service_entitlements set status = 'active', ended_at = null where service_key = 'x_autopost' and user_id = (select user_id from t_ids.people where threads_account = $1)", "SERVICE_NOT_ACTIVE"],
    [67, "update public.common_accounts set status = 'deleting' where user_id = (select user_id from t_ids.people where threads_account = $1)",
      "update public.common_accounts set status = 'active' where user_id = (select user_id from t_ids.people where threads_account = $1)", "SERVICE_NOT_ACTIVE"],
  ];
  for (const [n, change, undo, code] of cases) {
    const t = tokenOf(n);
    await owner(change, [P(n).threads]);
    const r = await create(t, n, `H3 ${code}`);
    await owner(undo, [P(n).threads]);
    assert.deepEqual([r.status === 403, r.body.code], [true, code], code);
  }
  assert.equal((await req("never-issued-token-000000", { op: "create", socialAccountId: P(64).threads, clientRequestId: crypto.randomUUID(), text: "x", scheduledAt: inMinutes(10), consent: { confirmed: true, contentSha256: sha("x") } })).status, 401);
  assert.equal(await rows(), before);
});

Deno.test("H4 the answer is lost after COMMIT: 503 OUTCOME_UNKNOWN; the same request again -> created:false, exactly one row", async () => {
  const t = tokenOf(68);
  const id = crypto.randomUUID();
  const at = inMinutes(15);
  const before = await rows();
  loseAfterCommit = true;
  const lost = await create(t, 68, "H4 応答が失われた", id, at);
  assert.deepEqual([lost.status, lost.body.code], [503, "OUTCOME_UNKNOWN"]);
  const again = await create(t, 68, "H4 応答が失われた", id, at);
  assert.deepEqual([again.status, again.body.created], [200, false]);
  assert.equal(await rows(), before + 1);
});

Deno.test("H5 cancel: a planned row -> cancelled and never sent; a claimed row -> 409; another person -> 404", async () => {
  const t = tokenOf(69);
  const c = await create(t, 69, "H5 取消");
  const rid = String(c.body.reservationId);
  assert.equal((await req(tokenOf(70), { op: "cancel", reservationId: rid })).status, 404);
  assert.deepEqual((await req(t, { op: "cancel", reservationId: rid })).body, { ok: true, status: "cancelled" });
  await due(rid);
  const run = await runWorker();
  assert.equal(run.log.publishes, 0);
  assert.equal((await receipt(t, 69, c.id)).body.state, "cancelled");
  const c2 = await create(t, 69, "H5 取得済み");
  await due(String(c2.body.reservationId));
  await workerStore.claimDue("w9", 60, 50);
  assert.deepEqual((await req(t, { op: "cancel", reservationId: c2.body.reservationId })).body, { ok: false, code: "NOT_CANCELLABLE" });
  await owner("update postona_threads_resv.reservations set status = 'cancelled', lease_token = null, lease_expires_at = null where id = $1::uuid", [c2.body.reservationId]);
});

Deno.test("W1 worker: one due reservation is published once (hook re-check passes); receipt sent with the media id, simulated; never again", async () => {
  const t = tokenOf(71);
  const c = await create(t, 71, "W1 送信");
  await due(String(c.body.reservationId));
  const run = await runWorker();
  assert.deepEqual([run.report.published, run.log.publishes, run.rechecks], [1, 1, 1]);
  const r = await receipt(t, 71, c.id);
  assert.equal(r.body.state, "sent");
  assert.match(String(r.body.xPostId), /^[1-9][0-9]+$/u);
  assert.deepEqual([r.body.simulated, r.body.afterFreeze], [true, false]);
  assert.equal((await runWorker()).log.publishes, 0);
});

Deno.test("W2 TOCTOU in the container wait: without the hook (PR #337 today) a freeze still publishes; with the hook -> 0 publish requests", async () => {
  const t = tokenOf(72);
  const freeze = () => owner("update public.service_entitlements set status = 'ended', ended_at = now() where user_id = $1::uuid and service_key = 'x_autopost'", [P(72).user]).then(() => undefined);
  const thaw = () => owner("update public.service_entitlements set status = 'active', ended_at = null where user_id = $1::uuid and service_key = 'x_autopost'", [P(72).user]);
  const before = await create(t, 72, "W2 フックなし");
  await due(String(before.body.reservationId));
  const noHook = await runWorker({ honourHook: false, duringWait: freeze });
  await thaw();
  assert.equal(noHook.log.publishes, 1, "FAIL-BEFORE: the publish happened after the freeze");
  assert.deepEqual([(await receipt(t, 72, before.id)).body.state, (await receipt(t, 72, before.id)).body.afterFreeze], ["sent", true]);
  const after = await create(t, 72, "W2 フックあり");
  await due(String(after.body.reservationId));
  const hooked = await runWorker({ duringWait: freeze });
  await thaw();
  assert.deepEqual([hooked.log.publishes, hooked.rechecks], [0, 1]);
  assert.deepEqual(await status(String(after.body.reservationId)), ["failed", "SERVICE_NOT_ACTIVE"]);
  assert.equal((await receipt(t, 72, after.id)).body.state, "failed");
});

Deno.test("W3 with the hook: credential rotated / switch OFF / second owner during the wait -> 0 publishes; refresh in progress -> handed back, published once later", async () => {
  const cases: [number, string, () => Promise<unknown>, [string, string]][] = [
    [73, "rotation", () => owner("update public.threads_account_credential_custody set vault_secret_id = gen_random_uuid(), recorded_at = now() where social_account_id = $1", [P(73).threads]), ["failed", "CREDENTIAL_CHANGED"]],
    [74, "switch OFF", () => owner("update public.social_accounts set publish_enabled = false where id = $1", [P(74).threads]), ["failed", "NOT_PUBLISHABLE_AT_SEND"]],
    [75, "second owner", () => owner("insert into public.brand_memberships (brand_id, user_id, role) values ($1, $2::uuid, 'owner')", [P(75).brand, P(99).user]), ["failed", "NOT_PUBLISHABLE_AT_SEND"]],
  ];
  for (const [n, label, change, expected] of cases) {
    const c = await create(tokenOf(n), n, `W3 ${label}`);
    await due(String(c.body.reservationId));
    const run = await runWorker({ duringWait: async () => { await change(); } });
    assert.equal(run.log.publishes, 0, label);
    assert.deepEqual(await status(String(c.body.reservationId)), expected, label);
  }
  const c = await create(tokenOf(76), 76, "W3 延長中");
  const rid = String(c.body.reservationId);
  await due(rid);
  const during = await runWorker({ duringWait: async () => { await owner("insert into public.threads_credential_refresh_leases values ($1, gen_random_uuid(), gen_random_uuid(), clock_timestamp() + interval '30 seconds')", [P(76).threads]); } });
  assert.equal(during.log.publishes, 0);
  assert.deepEqual(await status(rid), ["planned", null]);
  await owner("delete from public.threads_credential_refresh_leases where social_account_id = $1", [P(76).threads]);
  const later = await runWorker();
  assert.equal(later.log.publishes, 1);
  assert.equal((await status(rid))[0], "published");
});

Deno.test("W4 PR #337's deployable ports (OFF) claim nothing; a 32-hex generation sends nothing; unknown publish -> uncertain, never resent; two workers -> once each", async () => {
  const c = await create(tokenOf(77), 77, "W4 OFF");
  const rid = String(c.body.reservationId);
  await due(rid);
  const off = await runThreadsReservationDelivery({ enabled: true, store: workerStore, credentials: PR337_DEPLOYABLE_SHAPE.credentials, sender: PR337_DEPLOYABLE_SHAPE.sender, worker: "w1" });
  assert.deepEqual([off.notAvailable, off.claimed], [true, 0]);
  assert.equal((await status(rid))[0], "planned");
  generationOverride = "d4".repeat(16);
  let short;
  try {
    short = await runWorker();
  } finally {
    generationOverride = null;
  }
  assert.equal(short.log.publishes + short.log.containers, 0);
  assert.deepEqual(await status(rid), ["failed", "CREDENTIAL_GENERATION_CHANGED"]);
  const u = await create(tokenOf(78), 78, "W4 不明");
  await due(String(u.body.reservationId));
  await runWorker({ outcome: () => ({ kind: "unknown", stage: "publish", code: "THREADS_UNAVAILABLE" }) });
  assert.deepEqual(await status(String(u.body.reservationId)), ["uncertain", "THREADS_UNAVAILABLE"]);
  assert.equal((await receipt(tokenOf(78), 78, u.id)).body.state, "uncertain");
  assert.equal((await runWorker()).log.publishes, 0, "never resent");
  const ids = await Promise.all([79, 80, 81, 82, 83, 84].map(async (n) => String((await create(tokenOf(n), n, `W4 並行 ${n}`)).body.reservationId)));
  for (const id of ids) await due(id);
  const [a, b] = await Promise.all([runWorker({ worker: "wa" }), runWorker({ worker: "wb" })]);
  assert.equal(a.log.publishes + b.log.publishes, 6);
  for (const id of ids) assert.equal((await status(id))[0], "published");
});

Deno.test("H6 G5 service generation (TASK 7/50): a reservation made before a restart is stopped at the claim; the receipt asks to reconfirm; the same id never re-arms; a NEW id works", async () => {
  const t = tokenOf(79);
  const old = await create(t, 79, "H6 再開前の予約");
  const rid = String(old.body.reservationId);
  await owner("update public.service_entitlements set status = 'ended', ended_at = now() where user_id = $1::uuid and service_key = 'x_autopost'", [P(79).user]);
  await owner("update public.service_entitlements set status = 'active', ended_at = null where user_id = $1::uuid and service_key = 'x_autopost'", [P(79).user]);
  await due(rid);
  const run = await runWorker();
  assert.equal(run.log.publishes, 0);
  assert.deepEqual(await status(rid), ["failed", "SERVICE_GENERATION_CHANGED"]);
  const r = await receipt(t, 79, old.id);
  assert.deepEqual([r.body.state, r.body.code, r.body.action], ["failed", "SERVICE_GENERATION_CHANGED", "reconfirm_and_create_new"]);
  // the same request again (at the row's stored time -- the test moved it to make it due): the stopped row, never re-armed
  const storedAt = new Date(String((await owner<[string]>("select scheduled_at::text from postona_threads_resv.reservations where id = $1::uuid", [rid]))[0][0])).toISOString();
  const again = await req(t, { op: "create", socialAccountId: P(79).threads, clientRequestId: old.id, text: "H6 再開前の予約", scheduledAt: storedAt, consent: { confirmed: true, contentSha256: sha("H6 再開前の予約") } });
  // create validates the schedule before it looks the id up, so a repeat after the stored time is 422 SCHEDULE_INVALID; either way
  // the stopped row stays as it is and no second row exists (the receipt is the way to read it).
  assert.ok(again.status === 422 || (again.status === 200 && again.body.reservationId === rid && again.body.status === "failed" && again.body.created === false), JSON.stringify(again));
  assert.equal(Number((await owner<[bigint]>("select count(*) from postona_threads_resv.reservations where client_request_id = $1::uuid", [old.id]))[0][0]), 1);
  assert.deepEqual(await status(rid), ["failed", "SERVICE_GENERATION_CHANGED"], "nothing is re-armed");
  assert.equal((await runWorker()).log.publishes, 0, "never resent automatically");
  const fresh = await create(t, 79, "H6 再開後の新しい予約");
  await due(String(fresh.body.reservationId));
  assert.equal((await runWorker()).log.publishes, 1, "the person's NEW reservation is sent once");
});
