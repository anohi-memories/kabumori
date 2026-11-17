// MOCK_ONLY: a scripted Postgres client; the real SQL path is measured on the local stack (local_stack/threads_worker_local_test.ts).
import assert from "node:assert/strict";
import test from "node:test";
import type { PgConnect } from "./postgres_db.ts";
import { createPostgresThreadsDispatchStore, THREADS_WORKER_ROLE } from "./threads_worker_store.ts";

const RID = "11111111-1111-4111-8111-111111111111";
const LEASE = "22222222-2222-4222-8222-222222222222";
const GEN = "a".repeat(64);

function scripted(answer: (text: string, args: unknown[]) => unknown[][] | Error) {
  const log: { text: string; args: unknown[] }[] = [];
  let released = 0;
  const connect: PgConnect = () => Promise.resolve({
    client: {
      queryArray(query: { text: string; args?: unknown[] }) {
        log.push({ text: query.text, args: query.args ?? [] });
        if (/^(BEGIN|SET LOCAL|COMMIT|ROLLBACK)/u.test(query.text)) return Promise.resolve({ rows: [] });
        const result = answer(query.text, query.args ?? []);
        return result instanceof Error ? Promise.reject(result) : Promise.resolve({ rows: result });
      },
    },
    release: () => { released += 1; return Promise.resolve(); },
  });
  return { connect, log, released: () => released };
}
const pgError = (message: string) => Object.assign(new Error("db"), { fields: { code: "P0001", message } });
const claimRow = (over: Record<string, unknown> = {}) => ({ reservation_id: RID, lease_token: LEASE, provider: "threads", social_account_id: "th_acc", body: "本文", ...over });

test("each step is ONE read-committed transaction as the worker role with a statement timeout; only 007's four worker functions, bind parameters only", async () => {
  const db = scripted((text) => {
    if (text.includes("claim_due")) return [[JSON.stringify([claimRow()])]];
    if (text.includes("preflight")) return [[JSON.stringify([{ verdict: "OK", credential_generation: GEN }])]];
    if (text.includes("record")) return [["published"]];
    return [["released"]];
  });
  const store = createPostgresThreadsDispatchStore(db.connect);
  assert.deepEqual(await store.claimDue("postona-threads-worker", 120, 10), [{ reservationId: RID, leaseToken: LEASE, provider: "threads", socialAccountId: "th_acc", body: "本文" }]);
  assert.deepEqual(await store.preflight(RID, LEASE), { verdict: "OK", credentialGeneration: GEN });
  assert.equal(await store.record(RID, LEASE, "published", "1789", "PUBLISHED", "simulated"), "published");
  assert.equal(await store.releaseUnsent(RID, LEASE), "released");
  assert.equal(THREADS_WORKER_ROLE, "postona_resv_worker");
  assert.deepEqual(db.log.slice(0, 5).map((q) => q.text), [
    "BEGIN ISOLATION LEVEL READ COMMITTED", "SET LOCAL ROLE postona_resv_worker", "SET LOCAL statement_timeout = '15s'",
    "SELECT coalesce(json_agg(c), '[]'::json)::text FROM postona_threads_resv.claim_due($1::text, $2::integer, $3::integer) c", "COMMIT"]);
  const calls = db.log.filter((q) => !/^(BEGIN|SET LOCAL|COMMIT|ROLLBACK)/u.test(q.text));
  assert.deepEqual(calls.map((q) => /postona_threads_resv\.([a-z_]+)\(/u.exec(q.text)?.[1]), ["claim_due", "preflight", "record", "release_unsent"]);
  for (const q of calls) assert.doesNotMatch(q.text, /'[^']*(1789|本文|th_acc)/u, "values are never spliced into the SQL text");
  assert.deepEqual(calls[2].args, [RID, LEASE, "published", "1789", "PUBLISHED", "simulated"]);
  assert.equal(db.released(), 4);
});

test("a claim answer of another provider, a malformed id or an empty text throws: nothing of it is sent", async () => {
  for (const bad of [claimRow({ provider: "x" }), claimRow({ reservation_id: "nope" }), claimRow({ lease_token: null }), claimRow({ body: "" }),
                     claimRow({ social_account_id: "a b" })]) {
    const store = createPostgresThreadsDispatchStore(scripted(() => [[JSON.stringify([bad])]]).connect);
    await assert.rejects(store.claimDue("w", 120, 10), /THREADS_WORKER_ANSWER_INVALID/u);
  }
  const store = createPostgresThreadsDispatchStore(scripted(() => [["{}"]]).connect);
  await assert.rejects(store.claimDue("w", 120, 10), /THREADS_WORKER_ANSWER_INVALID/u);
});

test("only the known answers are accepted; OK needs a 64-hex generation; a refusal never carries one", async () => {
  for (const verdict of ["LEASE_LOST", "NOT_PUBLISHABLE", "RELEASED"]) {
    const store = createPostgresThreadsDispatchStore(scripted(() => [[JSON.stringify([{ verdict, credential_generation: GEN }])]]).connect);
    assert.deepEqual(await store.preflight(RID, LEASE), { verdict, credentialGeneration: null });
  }
  for (const bad of [{ verdict: "OK", credential_generation: null }, { verdict: "OK", credential_generation: "A".repeat(64) }, { verdict: "ok" }, {}]) {
    const store = createPostgresThreadsDispatchStore(scripted(() => [[JSON.stringify([bad])]]).connect);
    await assert.rejects(store.preflight(RID, LEASE), /THREADS_WORKER_ANSWER_INVALID/u);
  }
  const two = createPostgresThreadsDispatchStore(scripted(() => [[JSON.stringify([{ verdict: "OK", credential_generation: GEN }, { verdict: "OK", credential_generation: GEN }])]]).connect);
  await assert.rejects(two.preflight(RID, LEASE), /THREADS_WORKER_ANSWER_INVALID/u);
  for (const [method, good, bad] of [["record", ["published", "failed_before_send", "uncertain", "lease_lost"], ["PUBLISHED", "failed", ""]],
                                     ["releaseUnsent", ["released", "lease_lost"], ["planned", ""]]] as const) {
    for (const value of good) {
      const store = createPostgresThreadsDispatchStore(scripted(() => [[value]]).connect);
      const answer = method === "record" ? await store.record(RID, LEASE, "uncertain", null, null, "simulated") : await store.releaseUnsent(RID, LEASE);
      assert.equal(answer, value);
    }
    for (const value of bad) {
      const store = createPostgresThreadsDispatchStore(scripted(() => [[value]]).connect);
      const call = method === "record" ? store.record(RID, LEASE, "uncertain", null, null, "simulated") : store.releaseUnsent(RID, LEASE);
      await assert.rejects(call, /THREADS_WORKER_ANSWER_INVALID/u);
    }
  }
});

test("a fixed 007 code passes through; any other error (or a broken connection) is OUTCOME_UNKNOWN, rolled back, released", async () => {
  const fixed = scripted(() => pgError("POSTONA_THREADS_RESV_LEASE_LOST"));
  await assert.rejects(createPostgresThreadsDispatchStore(fixed.connect).record(RID, LEASE, "published", "1789", null, "simulated"), /^Error: POSTONA_THREADS_RESV_LEASE_LOST$/u);
  assert.ok(fixed.log.some((q) => q.text === "ROLLBACK"));
  assert.equal(fixed.released(), 1);
  const other = scripted(() => Object.assign(new Error("secret detail"), { fields: { code: "XX000", message: "internal token=abc" } }));
  await assert.rejects(createPostgresThreadsDispatchStore(other.connect).preflight(RID, LEASE), /^Error: THREADS_WORKER_OUTCOME_UNKNOWN$/u);
  const broken: PgConnect = () => Promise.reject(new Error("ECONNREFUSED"));
  await assert.rejects(createPostgresThreadsDispatchStore(broken).claimDue("w", 120, 10), /ECONNREFUSED/u);
});
