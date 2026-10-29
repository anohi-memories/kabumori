// MOCK_ONLY unit tests for the Threads Postgres adapter (G3-46): a recording fake client stands in for the driver. The real driver and
// SQL are exercised by supabase/candidates/postona_threads_reservations/personal_mvp_http/ (phase HT).
import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresThreadsReservationDb } from "./threads_postgres_db.ts";
import type { PgConnect } from "./postgres_db.ts";
import type { ReservationSubject } from "./api.ts";

const SUBJECT: ReservationSubject = { userId: "00000000-0000-4000-8000-00000000000a", sessionId: "00000000-0000-4000-8000-0000000000c1", isAnonymous: false };
const RID = "00000000-0000-4000-8000-0000000000d1";

function fakeConnect(script: (text: string) => { rows: unknown[][] } | Error) {
  const texts: { text: string; args?: unknown[] }[] = [];
  let connects = 0, releases = 0;
  const connect: PgConnect = () => {
    connects += 1;
    return Promise.resolve({
      client: {
        queryArray(q: { text: string; args?: unknown[] }) {
          texts.push(q);
          const out = script(q.text);
          return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
        },
      },
      release: () => { releases += 1; return Promise.resolve(); },
    });
  };
  return { connect, texts, counts: () => ({ connects, releases }) };
}
const pgError = (code: string, message: string) => Object.assign(new Error(message), { fields: { code, message } });
const ok = (rows: unknown) => (text: string) => (text.startsWith("SELECT coalesce") ? { rows: [[JSON.stringify(rows)]] } : { rows: [] });

test("one transaction as postona_resv_api with the verified claims, then exactly the fixed function with bind parameters", async () => {
  const f = fakeConnect(ok([{ state: "cancelled" }]));
  const db = createPostgresThreadsReservationDb(f.connect);
  assert.deepEqual(await db.call("cancel_reservation", [RID], SUBJECT), { ok: true, rows: [{ state: "cancelled" }] });
  assert.deepEqual(f.texts.map((t) => t.text), [
    "BEGIN ISOLATION LEVEL READ COMMITTED", "SET LOCAL ROLE postona_resv_api", "SET LOCAL statement_timeout = '15s'",
    "SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', '', true)",
    "SELECT coalesce(json_agg(r), '[]'::json)::text FROM (SELECT postona_threads_resv.cancel_reservation($1::uuid) AS state) r", "COMMIT",
  ]);
  assert.deepEqual(JSON.parse(f.texts[3].args?.[0] as string), { sub: SUBJECT.userId, role: "authenticated", session_id: SUBJECT.sessionId, is_anonymous: false });
  assert.deepEqual(f.texts[4].args, [RID]);
  assert.deepEqual(f.counts(), { connects: 1, releases: 1 });
  const g = fakeConnect(ok([]));
  await createPostgresThreadsReservationDb(g.connect).call("create_reservation", ["th_a", RID, "本文", "a".repeat(64), "2026-11-01T00:30:00Z"], SUBJECT);
  assert.match(g.texts[4].text, /FROM postona_threads_resv\.create_reservation\(\$1::text, \$2::uuid, \$3::text, \$4::text, \$5::timestamptz\) r$/u);
  const h = fakeConnect(ok([]));
  await createPostgresThreadsReservationDb(h.connect).call("receipt", ["th_a", RID], SUBJECT);
  assert.match(h.texts[4].text, /FROM postona_threads_resv\.receipt\(\$1::text, \$2::uuid\) r$/u);
});

test("refused before connecting: an unknown function, a wrong arity, a non-string value, a bad subject or a subject not proven non-anonymous", async () => {
  const f = fakeConnect(ok([]));
  const db = createPostgresThreadsReservationDb(f.connect);
  for (const [fn, args, subject] of [
    ["claim_due", ["w", "30", "1"], SUBJECT], ["record", [RID], SUBJECT], ["__proto__", [], SUBJECT], ["cancel_reservation", [], SUBJECT],
    ["cancel_reservation", [RID, RID], SUBJECT], ["cancel_reservation", [{ id: RID }], SUBJECT], ["receipt", ["th_a", null], SUBJECT],
    ["cancel_reservation", [RID], { ...SUBJECT, userId: "x" }], ["cancel_reservation", [RID], { ...SUBJECT, sessionId: "" }],
    ["cancel_reservation", [RID], { ...SUBJECT, isAnonymous: true }],
  ] as [never, unknown[], ReservationSubject][]) {
    assert.deepEqual(await db.call(fn, args, subject), { ok: false, code: "DB_REQUEST_INVALID" }, String(fn));
  }
  assert.deepEqual(f.counts(), { connects: 0, releases: 0 });
});

test("errors: a function code is definite (rolled back); a lock timeout is SERVICE_BUSY; another server error is DB_ERROR; after the call or not a server error -> throws (unknown)", async () => {
  const fnErr = fakeConnect((t) => (t.startsWith("SELECT coalesce") ? pgError("P0001", "POSTONA_THREADS_RESV_NOT_CANCELLABLE") : { rows: [] }));
  assert.deepEqual(await createPostgresThreadsReservationDb(fnErr.connect).call("cancel_reservation", [RID], SUBJECT), { ok: false, code: "POSTONA_THREADS_RESV_NOT_CANCELLABLE" });
  assert.equal(fnErr.texts.at(-1)?.text, "ROLLBACK");
  const auth = fakeConnect((t) => (t.startsWith("SELECT coalesce") ? pgError("P0001", "POSTONA_RESV_AUTH_REQUIRED") : { rows: [] }));
  assert.deepEqual(await createPostgresThreadsReservationDb(auth.connect).call("receipt", ["th_a", RID], SUBJECT), { ok: false, code: "POSTONA_RESV_AUTH_REQUIRED" });
  const lock = fakeConnect((t) => (t.startsWith("SELECT coalesce") ? pgError("55P03", "canceling statement due to lock timeout") : { rows: [] }));
  assert.deepEqual(await createPostgresThreadsReservationDb(lock.connect).call("cancel_reservation", [RID], SUBJECT), { ok: false, code: "POSTONA_RESV_SERVICE_BUSY" });
  const other = fakeConnect((t) => (t.startsWith("SELECT coalesce") ? pgError("42501", "permission denied for function receipt") : { rows: [] }));
  assert.deepEqual(await createPostgresThreadsReservationDb(other.connect).call("receipt", ["th_a", RID], SUBJECT), { ok: false, code: "DB_ERROR" });
  const commitLost = fakeConnect((t) => (t === "COMMIT" ? new Error("connection reset") : ok([{ state: "cancelled" }])(t)));
  await assert.rejects(createPostgresThreadsReservationDb(commitLost.connect).call("cancel_reservation", [RID], SUBJECT), /OUTCOME_UNKNOWN/u);
  assert.deepEqual(commitLost.counts(), { connects: 1, releases: 1 });
  const socket = fakeConnect(() => new Error("socket closed"));
  await assert.rejects(createPostgresThreadsReservationDb(socket.connect).call("cancel_reservation", [RID], SUBJECT), /OUTCOME_UNKNOWN/u);
  const badAnswer = fakeConnect((t) => (t.startsWith("SELECT coalesce") ? { rows: [[JSON.stringify({ not: "an array" })]] } : { rows: [] }));
  await assert.rejects(createPostgresThreadsReservationDb(badAnswer.connect).call("receipt", ["th_a", RID], SUBJECT), /OUTCOME_UNKNOWN/u);
  await assert.rejects(createPostgresThreadsReservationDb(() => Promise.reject(new Error("refused"))).call("receipt", ["th_a", RID], SUBJECT), /refused/u);
});
