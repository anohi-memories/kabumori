// PR #334's Threads dispatcher (runThreadsReservationDelivery, THREADS_DISPATCH_ENABLED stays false -- the run is given
// enabled: true explicitly, as a test) against candidate 007 on a disposable LOCAL PostgreSQL (run through
// postona_threads_reservations_run.sh only). The ThreadsDispatchStore below is a TEST FIXTURE (one transaction per call
// as a login in postona_resv_worker), not product code. MOCK_ONLY: G4's credential port (fake token + the database's
// generation) and G4's send port (fake Threads, transport 'simulated'). No Threads, Meta or network beyond 127.0.0.1.
import assert from "node:assert/strict";
import { Client } from "jsr:@db/postgres@0.19.5";
import {
  runThreadsReservationDelivery, type ThreadsCredentialPort, type ThreadsDispatchStore, type ThreadsSendOutcome, type ThreadsSendPort,
} from "../../../functions/_shared/postona_reservations/threads_dispatch.ts";

const WORKER_URL = Deno.env.get("THREADS_RESV_WORKER_URL")!;
const OWNER_URL = Deno.env.get("THREADS_RESV_OWNER_URL")!;
assert.ok(WORKER_URL && OWNER_URL, "set by postona_threads_reservations_run.sh");

async function sql<T extends unknown[]>(url: string, text: string, args: unknown[] = [], role?: string): Promise<T[]> {
  const c = new Client(url);
  await c.connect();
  try {
    if (!role) return (await c.queryArray<T>({ text, args })).rows;
    await c.queryArray("BEGIN ISOLATION LEVEL READ COMMITTED");
    await c.queryArray(`SET LOCAL ROLE ${role}`);
    const rows = (await c.queryArray<T>({ text, args })).rows;
    await c.queryArray("COMMIT");
    return rows;
  } finally {
    await c.end();
  }
}
const owner = <T extends unknown[]>(text: string, args: unknown[] = []) => sql<T>(OWNER_URL, text, args);
const worker = <T extends unknown[]>(text: string, args: unknown[] = []) => sql<T>(WORKER_URL, text, args, "postona_resv_worker");

/** TEST FIXTURE store over 007's four worker functions. */
const store: ThreadsDispatchStore = {
  async claimDue(w, lease, limit) {
    const rows = await worker<[string, string, string, string, string]>(
      "select reservation_id::text, lease_token::text, provider, social_account_id, body from postona_threads_resv.claim_due($1, $2, $3)", [w, lease, limit]);
    return rows.map(([reservationId, leaseToken, provider, socialAccountId, body]) => ({ reservationId, leaseToken, provider, socialAccountId, body }));
  },
  async preflight(id, lease) {
    const [[verdict, credentialGeneration]] = await worker<[string, string | null]>("select verdict, credential_generation from postona_threads_resv.preflight($1::uuid, $2::uuid)", [id, lease]);
    return { verdict: verdict as "OK", credentialGeneration };
  },
  async record(id, lease, outcome, postId, code, transport) {
    return String((await worker<[string]>("select postona_threads_resv.record($1::uuid, $2::uuid, $3, $4, $5, $6)", [id, lease, outcome, postId, code, transport]))[0][0]);
  },
  async releaseUnsent(id, lease) {
    return String((await worker<[string]>("select postona_threads_resv.release_unsent($1::uuid, $2::uuid)", [id, lease]))[0][0]);
  },
};

const people = new Map((await owner<[number, string, string, string]>("select n, user_id::text, threads_account, x_account from t_ids.people where n between 81 and 99"))
  .map(([n, u, t, x]) => [Number(n), { user: u, threads: t, x }]));
const P = (n: number) => people.get(n)!;

/** A due reservation written by the owner (the API's create path is proven in behavior.sql). */
async function reserve(n: number, text: string): Promise<string> {
  return String((await owner<[string]>(
    `insert into postona_threads_resv.reservations (user_id, brand_id, social_account_id, client_request_id, body, content_sha256, scheduled_at)
     select p.user_id, p.brand, p.threads_account, gen_random_uuid(), $2, encode(sha256(convert_to($2, 'UTF8')), 'hex'), now() - interval '1 second'
     from t_ids.people p where p.n = $1 returning id::text`, [n, text]))[0][0]);
}
const row = async (id: string) => (await owner<[string, string | null, string | null, string | null]>(
  "select status, outcome_code, provider_post_id, transport from postona_threads_resv.reservations where id = $1::uuid", [id]))[0];

let afterRead: ((account: string) => Promise<unknown>) | null = null;
const credentials: ThreadsCredentialPort = {
  available: true,
  async credentialFor(account) {
    const [[generation, userId]] = await owner<[string | null, string | null]>(
      "select postona_threads_resv.threads_credential_generation($1), (select platform_user_id from public.social_accounts where id = $1)", [account]);
    if (!generation || !userId) return null;
    const credential = { socialAccountId: account, threadsUserId: userId, accessToken: `fake-threads-token-${account}`, generation };
    if (afterRead) await afterRead(account);
    return credential;
  },
};
const sends: { userId: string; text: string }[] = [];
let script: ((n: number) => ThreadsSendOutcome) | null = null;
let mediaN = 18000000000000100;
const sender: ThreadsSendPort = {
  available: true, transport: "simulated",
  send(credential, text) {
    sends.push({ userId: credential.threadsUserId, text });
    return Promise.resolve(script ? script(sends.length) : { kind: "published", mediaId: String(++mediaN), readBack: "confirmed" });
  },
};
const deliver = (w = "w1") => runThreadsReservationDelivery({ enabled: true, store, credentials, sender, worker: w, leaseSeconds: 60, limit: 50 });

Deno.test("E1 one due Threads reservation: claimed, preflight OK, sent once with the account's own credential, recorded published (simulated)", async () => {
  const id = await reserve(81, "E1 Threads 予約");
  const before = sends.length;
  const report = await deliver();
  assert.deepEqual([report.claimed, report.published, report.sends], [1, 1, 1]);
  assert.deepEqual(sends.slice(before), [{ userId: "17841400000000081", text: "E1 Threads 予約" }]);
  const [status, code, postId, transport] = await row(id);
  assert.deepEqual([status, code, transport], ["published", "PUBLISHED", "simulated"]);
  assert.match(String(postId), /^[1-9][0-9]+$/u);
  assert.equal((await deliver()).sends, 0, "never again");
});

Deno.test("E2 two dispatchers at the same time over 8 due rows: every row sent exactly once", async () => {
  const ids = await Promise.all([82, 83, 84, 85, 82, 83, 84, 85].map((n, i) => reserve(n, `E2 並行 ${i}`)));
  const before = sends.length;
  const [a, b] = await Promise.all([deliver("w1"), deliver("w2")]);
  assert.equal(a.sends + b.sends, 8);
  assert.equal(new Set(sends.slice(before).map((s) => s.text)).size, 8);
  for (const id of ids) assert.equal((await row(id))[0], "published");
});

Deno.test("E3 unknown publish -> uncertain, never resent; unknown container -> failed (not a post); read-back mismatch -> uncertain", async () => {
  for (const [outcome, status, code] of [
    [{ kind: "unknown", stage: "publish", code: "THREADS_UNAVAILABLE" }, "uncertain", "THREADS_UNAVAILABLE"],
    [{ kind: "unknown", stage: "container", code: "THREADS_UNAVAILABLE" }, "failed", "THREADS_CONTAINER_UNKNOWN_NOT_POSTED"],
    [{ kind: "published", mediaId: "18000000000009999", readBack: "mismatch" }, "uncertain", "THREADS_READBACK_MISMATCH"],
  ] as const) {
    const id = await reserve(86, `E3 ${code}`);
    script = () => outcome as ThreadsSendOutcome;
    const before = sends.length;
    try {
      await deliver();
    } finally {
      script = null;
    }
    assert.deepEqual((await row(id)).slice(0, 3), [status, code, null], code);
    assert.equal(sends.length, before + 1);
    assert.equal((await deliver()).sends, 0, `${code}: never resent`);
  }
});

Deno.test("E4 changes after the credential was read, before the send: rotation / switch OFF / entitlement ended / second owner -> 0 sends", async () => {
  const cases: [number, string, (account: string) => Promise<unknown>][] = [
    [87, "CREDENTIAL_CHANGED", (a) => owner("update public.threads_account_credential_custody set vault_secret_id = gen_random_uuid(), recorded_at = now() where social_account_id = $1", [a])],
    [88, "NOT_PUBLISHABLE_AT_SEND", (a) => owner("update public.social_accounts set publish_enabled = false where id = $1", [a])],
    [89, "NOT_PUBLISHABLE_AT_SEND", () => owner("update t_threads.entitlement set status = 'ended' where user_id = $1::uuid", [P(89).user])],
    [90, "NOT_PUBLISHABLE_AT_SEND", () => owner("insert into public.brand_memberships (brand_id, user_id, role) select brand, $1::uuid, 'owner' from t_ids.people where n = 90", [P(99).user])],
  ];
  for (const [n, code, change] of cases) {
    const id = await reserve(n, `E4 ${n}`);
    afterRead = change;
    const before = sends.length;
    try {
      await deliver();
    } finally {
      afterRead = null;
    }
    assert.equal(sends.length, before, `${code}: not sent`);
    assert.deepEqual((await row(id)).slice(0, 2), ["failed", code]);
  }
});

Deno.test("E5 refresh in progress -> handed back (planned), sent later once the refresh is over; X rows are never touched", async () => {
  const id = await reserve(91, "E5 更新中");
  await owner("insert into public.threads_credential_refresh_leases values ($1, gen_random_uuid(), gen_random_uuid(), clock_timestamp() + interval '30 seconds')", [P(91).threads]);
  const before = sends.length;
  const first = await deliver();
  assert.deepEqual([first.released, sends.length, (await row(id))[0]], [1, before, "planned"]);
  await owner("delete from public.threads_credential_refresh_leases where social_account_id = $1", [P(91).threads]);
  const second = await deliver();
  assert.deepEqual([second.published, sends.length, (await row(id))[0]], [1, before + 1, "published"]);
  const xRows = Number((await owner<[bigint]>("select count(*) from postona_x_resv.reservations r join public.social_accounts sa on sa.id = r.social_account_id where sa.platform = 'threads'"))[0][0]);
  assert.equal(xRows, 0);
});
