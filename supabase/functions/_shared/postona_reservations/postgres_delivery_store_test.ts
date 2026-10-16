// MOCK_ONLY: a scripted Postgres client; the real SQL path is proven by candidates/postona_x_reservations/dispatch_run.sh.
import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresDeliveryStore, WORKER_ROLE } from "./postgres_delivery_store.ts";
import type { PgConnect } from "./postgres_db.ts";

const RID = "11111111-1111-4111-8111-111111111111";
const LEASE = "22222222-2222-4222-8222-222222222222";

function scripted(answer: (text: string, args: unknown[]) => unknown[][] | Error) {
  const log: string[] = [];
  let released = 0;
  const connect: PgConnect = () => Promise.resolve({
    client: {
      queryArray(query: { text: string; args?: unknown[] }) {
        log.push(query.text);
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

test("each step is ONE read-committed transaction as the worker role with a statement timeout; bind parameters only", async () => {
  const db = scripted((text) => (text.includes("claim_due") ? [[JSON.stringify([{ reservation_id: RID, lease_token: LEASE, social_account_id: "x_acc", body: "本文", scheduled_at: "2026-10-16T01:00:00Z" }])]] : [["OK"]]));
  const store = createPostgresDeliveryStore(db.connect);
  assert.deepEqual(await store.claimDue("postona-x-worker", 120, 10), [{ reservationId: RID, leaseToken: LEASE, socialAccountId: "x_acc", body: "本文" }]);
  assert.equal(await store.prePublishCheck(RID, LEASE), "OK");
  assert.equal(WORKER_ROLE, "postona_resv_worker");
  assert.deepEqual(db.log.slice(0, 5), [
    "BEGIN ISOLATION LEVEL READ COMMITTED", "SET LOCAL ROLE postona_resv_worker", "SET LOCAL statement_timeout = '15s'",
    "SELECT coalesce(json_agg(c), '[]'::json)::text FROM postona_x_resv.claim_due($1::text, $2::integer, $3::integer) c", "COMMIT"]);
  assert.equal(db.released(), 2);
});

test("only the known answers are accepted; anything else throws (the worker then never sends)", async () => {
  for (const [method, good, bad] of [["prePublishCheck", ["OK", "LEASE_LOST", "NOT_PUBLISHABLE", "RELEASED"], ["ok", "SENT", ""]],
                                     ["finish", ["published", "failed_before_send", "uncertain", "lease_lost"], ["PUBLISHED", "failed"]],
                                     ["releaseUnsent", ["released", "lease_lost"], ["planned", ""]]] as const) {
    for (const value of good) {
      const store = createPostgresDeliveryStore(scripted(() => [[value]]).connect);
      const answer = method === "finish" ? await store.finish(RID, LEASE, "published", "1", null) : await store[method](RID, LEASE);
      assert.equal(answer, value);
    }
    for (const value of bad) {
      const store = createPostgresDeliveryStore(scripted(() => [[value]]).connect);
      await assert.rejects(() => (method === "finish" ? store.finish(RID, LEASE, "published", "1", null) : store[method](RID, LEASE)), /RESERVATION_WORKER_ANSWER_INVALID/u);
    }
  }
  for (const rows of [[{ reservation_id: "x", lease_token: LEASE, social_account_id: "x_acc", body: "b" }], [{ reservation_id: RID, lease_token: LEASE, social_account_id: "x_acc", body: null }], {}]) {
    const store = createPostgresDeliveryStore(scripted(() => [[JSON.stringify(rows)]]).connect);
    await assert.rejects(() => store.claimDue("w", 120, 1), /RESERVATION_WORKER_ANSWER_INVALID/u);
  }
});

test("a fixed POSTONA_RESV_* error keeps its code; anything else is OUTCOME_UNKNOWN; every failure rolls back", async () => {
  const fixed = scripted(() => pgError("POSTONA_RESV_LEASE_LOST"));
  await assert.rejects(() => createPostgresDeliveryStore(fixed.connect).finish(RID, LEASE, "published", "1", null), /^Error: POSTONA_RESV_LEASE_LOST$/u);
  assert.ok(fixed.log.includes("ROLLBACK"));
  const other = scripted(() => pgError("relation \"x\" secret detail"));
  await assert.rejects(() => createPostgresDeliveryStore(other.connect).prePublishCheck(RID, LEASE), /^Error: RESERVATION_WORKER_OUTCOME_UNKNOWN$/u);
  const broken = scripted(() => new TypeError("connection reset"));
  await assert.rejects(() => createPostgresDeliveryStore(broken.connect).releaseUnsent(RID, LEASE), /^Error: RESERVATION_WORKER_OUTCOME_UNKNOWN$/u);
});
