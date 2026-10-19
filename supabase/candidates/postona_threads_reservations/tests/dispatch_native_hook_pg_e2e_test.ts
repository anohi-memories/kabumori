// G3 TASK 6/50: the dispatcher's NATIVE pre-publish hook against candidate 007 on a disposable LOCAL PostgreSQL (run by
// postona_threads_http_worker_run.sh only). No wrapper composition: runThreadsReservationDelivery hands { beforePublish }
// to the send port itself. MOCK_ONLY: G4's credential port (fake token + the database's generation) and a SIMULATED
// two-step send that honours the proposed hook and counts every would-be publish request. No network beyond 127.0.0.1.
import assert from "node:assert/strict";
import { Client } from "jsr:@db/postgres@0.19.5";
import {
  runThreadsReservationDelivery, type ThreadsCredentialPort, type ThreadsDispatchStore, type ThreadsSendOutcome, type ThreadsSendPort,
} from "../../../functions/_shared/postona_reservations/threads_dispatch.ts";
import { createPgWorkerStore } from "../fixture/pg_fixture_ports.ts";
import { PR337_DEPLOYABLE_SHAPE } from "../fixture/threads_worker_fixture.ts";

const WORKER_URL = Deno.env.get("THREADS_HTTP_WORKER_URL")!;
const OWNER_URL = Deno.env.get("THREADS_HTTP_OWNER_URL")!;
assert.ok(WORKER_URL && OWNER_URL, "set by postona_threads_http_worker_run.sh");
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
async function reserve(n: number, text: string): Promise<string> {
  return String((await owner<[string]>(
    `insert into postona_threads_resv.reservations (user_id, brand_id, social_account_id, client_request_id, body, content_sha256, scheduled_at)
     select p.user_id, p.brand, p.threads_account, gen_random_uuid(), $2, encode(sha256(convert_to($2, 'UTF8')), 'hex'), now() - interval '1 second'
     from t_ids.people p where p.n = $1 returning id::text`, [n, text]))[0][0]);
}
const row = async (id: string) => (await owner<[string, string | null, boolean | null]>(
  "select status, outcome_code, after_freeze from postona_threads_resv.reservations where id = $1::uuid", [id]))[0];
const credentials: ThreadsCredentialPort = {
  available: true,
  async credentialFor(account) {
    const [[generation, userId]] = await owner<[string | null, string | null]>(
      "select postona_threads_resv.threads_credential_generation($1), (select platform_user_id from public.social_accounts where id = $1)", [account]);
    return generation && userId ? { socialAccountId: account, threadsUserId: userId, accessToken: `fake-threads-token-${account}`, generation } : null;
  },
};
const store = createPgWorkerStore(WORKER_URL);
function port(opts: { duringWait?: () => Promise<unknown>; afterHook?: () => Promise<unknown>; outcome?: ThreadsSendOutcome } = {}) {
  const log = { publishes: 0, hookAnswers: [] as boolean[] };
  let media = 18000000000000800;
  const p: ThreadsSendPort = {
    available: true, transport: "simulated",
    async send(_c, _t, hooks) {
      if (opts.duringWait) await opts.duringWait();
      const ok = hooks ? await hooks.beforePublish() : true;
      log.hookAnswers.push(ok);
      if (!ok) return { kind: "not_written", stage: "publish", code: "THREADS_PREPUBLISH_REFUSED" };
      if (opts.afterHook) await opts.afterHook();
      log.publishes += 1;
      return opts.outcome ?? { kind: "published", mediaId: String(++media), readBack: "confirmed" };
    },
  };
  return { p, log };
}
const deliver = (sender: ThreadsSendPort, extra: { store?: ThreadsDispatchStore; worker?: string; prepublishTimeoutMs?: number } = {}) =>
  runThreadsReservationDelivery({ enabled: true, store: extra.store ?? store, credentials, sender, worker: extra.worker ?? "w1", leaseSeconds: 60, limit: 50, prepublishTimeoutMs: extra.prepublishTimeoutMs });

Deno.test("N1 nothing changes: the native hook re-runs 007's preflight for the claimed row, one publish, published", async () => {
  const id = await reserve(85, "N1 送信");
  const s = port();
  const r = await deliver(s.p);
  assert.deepEqual([s.log.publishes, s.log.hookAnswers, r.prepublishRechecks, r.published], [1, [true], 1, 1]);
  assert.deepEqual(await row(id), ["published", "PUBLISHED", false]);
});

Deno.test("N2 changes during the container wait -> 0 publish requests; 007 records the refusal once; the report never says uncertain", async () => {
  const cases: [number, string, () => Promise<unknown>, [string, string | null]][] = [
    [86, "entitlement ended", () => owner("update t_threads.entitlement set status = 'ended' where user_id = $1::uuid", [P(86).user]), ["failed", "NOT_PUBLISHABLE_AT_SEND"]],
    [87, "account deleting", () => owner("update public.common_accounts set status = 'deleting' where user_id = $1::uuid", [P(87).user]), ["failed", "NOT_PUBLISHABLE_AT_SEND"]],
    [88, "second owner", () => owner("insert into public.brand_memberships (brand_id, user_id, role) values ($1, $2::uuid, 'owner')", [P(88).brand, P(99).user]), ["failed", "NOT_PUBLISHABLE_AT_SEND"]],
    [89, "G4 verification removed", () => owner("delete from t_threads.verified where social_account_id = $1", [P(89).threads]), ["failed", "NOT_PUBLISHABLE_AT_SEND"]],
    [90, "publish switch OFF", () => owner("update public.social_accounts set publish_enabled = false where id = $1", [P(90).threads]), ["failed", "NOT_PUBLISHABLE_AT_SEND"]],
    [91, "credential rotated", () => owner("update public.threads_account_credential_custody set vault_secret_id = gen_random_uuid(), recorded_at = now() where social_account_id = $1", [P(91).threads]), ["failed", "CREDENTIAL_CHANGED"]],
  ];
  for (const [n, label, change, expected] of cases) {
    const id = await reserve(n, `N2 ${label}`);
    const s = port({ duringWait: change });
    const r = await deliver(s.p);
    assert.deepEqual([s.log.publishes, s.log.hookAnswers], [0, [false]], label);
    assert.deepEqual((await row(id)).slice(0, 2), expected, label);
    assert.deepEqual([r.prepublishRefused, r.skipped, r.uncertain, r.failedBeforeSend], [1, 1, 0, 0], label);
  }
});

Deno.test("N3 a refresh starts during the wait -> handed back (planned, released), published once after the refresh ends", async () => {
  const id = await reserve(92, "N3 延長");
  const s = port({ duringWait: () => owner("insert into public.threads_credential_refresh_leases values ($1, gen_random_uuid(), gen_random_uuid(), clock_timestamp() + interval '30 seconds')", [P(92).threads]) });
  const r = await deliver(s.p);
  assert.deepEqual([s.log.publishes, r.released, r.uncertain, (await row(id))[0]], [0, 1, 0, "planned"]);
  await owner("delete from public.threads_credential_refresh_leases where social_account_id = $1", [P(92).threads]);
  const s2 = port();
  await deliver(s2.p);
  assert.deepEqual([s2.log.publishes, (await row(id))[0]], [1, "published"]);
});

Deno.test("N4 the re-check is late (timeout) -> 0 publishes, the still-claimed row recorded failed THREADS_PREPUBLISH_UNVERIFIED", async () => {
  const id = await reserve(93, "N4 遅延");
  let n = 0;
  const slow: ThreadsDispatchStore = { ...store, preflight: async (rid, lease) => { if (++n === 2) await new Promise((r) => setTimeout(r, 300)); return store.preflight(rid, lease); } };
  const s = port();
  const r = await deliver(s.p, { store: slow, prepublishTimeoutMs: 50 });
  await new Promise((resolve) => setTimeout(resolve, 400)); // let the late re-check finish (it answers OK but is ignored)
  assert.deepEqual([s.log.publishes, r.failedBeforeSend, r.prepublishRefused], [0, 1, 1]);
  assert.deepEqual((await row(id)).slice(0, 2), ["failed", "THREADS_PREPUBLISH_UNVERIFIED"]);
});

Deno.test("N5 a freeze AFTER the hook (during the publish request) is published once with after_freeze; unknown publish -> uncertain, never resent", async () => {
  const id = await reserve(94, "N5 送信中の停止");
  const s = port({ afterHook: () => owner("update t_threads.entitlement set status = 'ended' where user_id = $1::uuid", [P(94).user]) });
  await deliver(s.p);
  assert.deepEqual([s.log.publishes, ...(await row(id))], [1, "published", "PUBLISHED", true]);
  const u = await reserve(95, "N5 不明");
  const su = port({ outcome: { kind: "unknown", stage: "publish", code: "THREADS_UNAVAILABLE" } });
  await deliver(su.p);
  assert.deepEqual((await row(u)).slice(0, 2), ["uncertain", "THREADS_UNAVAILABLE"]);
  assert.equal((await deliver(port().p)).sends, 0, "never resent");
});

Deno.test("N6 two workers with hooks over 6 rows: each published once, each hook re-checks its own row; deployable PR #337 ports claim nothing", async () => {
  const ids = await Promise.all([61, 62, 63, 64, 65, 66].map((n) => reserve(n, `N6 並行 ${n}`)));
  const s = port();
  const [a, b] = await Promise.all([deliver(s.p, { worker: "wa" }), deliver(s.p, { worker: "wb" })]);
  assert.deepEqual([s.log.publishes, a.prepublishRechecks + b.prepublishRechecks], [6, 6]);
  for (const id of ids) assert.equal((await row(id))[0], "published");
  const off = await runThreadsReservationDelivery({ enabled: true, store, credentials: PR337_DEPLOYABLE_SHAPE.credentials, sender: PR337_DEPLOYABLE_SHAPE.sender, worker: "w1" });
  assert.deepEqual([off.notAvailable, off.claimed], [true, 0]);
});
