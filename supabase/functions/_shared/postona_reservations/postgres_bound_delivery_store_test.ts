// MOCK_ONLY: a scripted Postgres client; the real SQL path is proven by candidates/postona_x_reservations/g4_verdict_run.sh (phase VW).
import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresBoundDeliveryStore } from "./postgres_delivery_store.ts";
import type { PgConnect } from "./postgres_db.ts";

const RID = "11111111-1111-4111-8111-111111111111";
const LEASE = "22222222-2222-4222-8222-222222222222";
const GEN = "c".repeat(64);

function scripted(answer: (text: string) => unknown[][]) {
  const log: string[] = [];
  const connect: PgConnect = () => Promise.resolve({
    client: {
      queryArray(query: { text: string; args?: unknown[] }) {
        log.push(query.text);
        if (/^(BEGIN|SET LOCAL|COMMIT|ROLLBACK)/u.test(query.text)) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: answer(query.text) });
      },
    },
    release: () => Promise.resolve(),
  });
  return { connect, log };
}

test("S1 the bound check: one fixed statement as the worker role, bind parameters only; OK carries the pinned generation", async () => {
  const db = scripted(() => [[JSON.stringify([{ verdict: "OK", credential_generation: GEN }])]]);
  const store = createPostgresBoundDeliveryStore(db.connect);
  assert.deepEqual(await store.prePublishCheckBound(RID, LEASE), { verdict: "OK", credentialGeneration: GEN });
  assert.deepEqual(db.log, ["BEGIN ISOLATION LEVEL READ COMMITTED", "SET LOCAL ROLE postona_resv_worker", "SET LOCAL statement_timeout = '15s'",
    "SELECT coalesce(json_agg(r), '[]'::json)::text FROM postona_x_resv.pre_publish_check_bound($1::uuid, $2::uuid) r", "COMMIT"]);
  for (const verdict of ["LEASE_LOST", "NOT_PUBLISHABLE", "RELEASED"]) {
    const s = createPostgresBoundDeliveryStore(scripted(() => [[JSON.stringify([{ verdict, credential_generation: null }])]]).connect);
    assert.deepEqual(await s.prePublishCheckBound(RID, LEASE), { verdict, credentialGeneration: null });
  }
  const noPin = createPostgresBoundDeliveryStore(scripted(() => [[JSON.stringify([{ verdict: "OK", credential_generation: null }])]]).connect);
  assert.deepEqual(await noPin.prePublishCheckBound(RID, LEASE), { verdict: "OK", credentialGeneration: null }); // the worker refuses it
});

test("S2 any other answer throws (never sent): a generation with another verdict, a malformed generation, an unknown verdict, not one row", async () => {
  for (const rows of [
    [{ verdict: "NOT_PUBLISHABLE", credential_generation: GEN }], [{ verdict: "LEASE_LOST", credential_generation: GEN }],
    [{ verdict: "OK", credential_generation: "C".repeat(64) }], [{ verdict: "OK", credential_generation: GEN.slice(1) }], [{ verdict: "OK", credential_generation: 7 }],
    [{ verdict: "ok", credential_generation: GEN }], [{ verdict: "OK" }], [], [{ verdict: "OK", credential_generation: GEN }, { verdict: "OK", credential_generation: GEN }], [null],
  ]) {
    const store = createPostgresBoundDeliveryStore(scripted(() => [[JSON.stringify(rows)]]).connect);
    await assert.rejects(store.prePublishCheckBound(RID, LEASE), /RESERVATION_WORKER_ANSWER_INVALID/u, JSON.stringify(rows));
  }
});

test("S3 the other worker steps are the base store's", () => {
  const store = createPostgresBoundDeliveryStore(scripted(() => []).connect);
  assert.deepEqual(Object.keys(store).sort(), ["claimDue", "finish", "prePublishCheckBound", "releaseUnsent"]);
});
