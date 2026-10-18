// MOCK_ONLY: a scripted Postgres client; the real driver path is proven by single_post_run.sh.
import assert from "node:assert/strict";
import test from "node:test";
import type { PgConnect } from "./postgres_db.ts";
import { createSinglePostDb } from "./single_post_db.ts";

const SUBJECT = { userId: "11111111-1111-4111-8111-111111111111", sessionId: "22222222-2222-4222-8222-222222222222" };
function scripted(answer: (text: string) => unknown[][] | Error) {
  const log: { text: string; args?: unknown[] }[] = [];
  const connect: PgConnect = () => Promise.resolve({
    client: {
      queryArray(q: { text: string; args?: unknown[] }) {
        log.push(q);
        if (/^(BEGIN|SET LOCAL|COMMIT|ROLLBACK)/u.test(q.text) || q.text.startsWith("SELECT set_config")) return Promise.resolve({ rows: [] });
        const out = answer(q.text);
        return out instanceof Error ? Promise.reject(out) : Promise.resolve({ rows: out });
      },
    },
    release: () => Promise.resolve(),
  });
  return { connect, log };
}
const pgError = (message: string, code = "P0001") => Object.assign(new Error("db"), { fields: { code, message } });

test("one read-committed transaction as postona_resv_api with the verified subject AND the session id in the claims", async () => {
  const s = scripted(() => [[JSON.stringify([{ reservation_id: "r", state: "claimed" }])]]);
  const result = await createSinglePostDb(s.connect).call("begin", ["sa_x", SUBJECT.userId, "t", "a".repeat(64)], SUBJECT);
  assert.deepEqual(result, { ok: true, rows: [{ reservation_id: "r", state: "claimed" }] });
  assert.deepEqual(s.log.slice(0, 3).map((q) => q.text), ["BEGIN ISOLATION LEVEL READ COMMITTED", "SET LOCAL ROLE postona_resv_api", "SET LOCAL statement_timeout = '15s'"]);
  assert.deepEqual(JSON.parse(String(s.log[3].args?.[0])), { sub: SUBJECT.userId, role: "authenticated", session_id: SUBJECT.sessionId });
  assert.ok(s.log[4].text.includes("postona_x_resv.post_now_begin($1::text, $2::uuid, $3::text, $4::text)"));
  assert.equal(s.log.at(-1)?.text, "COMMIT");
});

test("refusals keep POSTONA_RESV_* codes; a lock timeout is SERVICE_BUSY; anything else after the call is unknown (throw)", async () => {
  assert.deepEqual(await createSinglePostDb(scripted(() => pgError("POSTONA_RESV_SERVICE_NOT_ACTIVE")).connect).call("check", ["r", "l"], SUBJECT), { ok: false, code: "POSTONA_RESV_SERVICE_NOT_ACTIVE" });
  assert.deepEqual(await createSinglePostDb(scripted(() => pgError("canceling statement due to lock timeout", "55P03")).connect).call("check", ["r", "l"], SUBJECT), { ok: false, code: "POSTONA_RESV_SERVICE_BUSY" });
  assert.deepEqual(await createSinglePostDb(scripted(() => pgError("relation x secret")).connect).call("get", ["r"], SUBJECT), { ok: false, code: "DB_ERROR" });
  await assert.rejects(() => createSinglePostDb(scripted(() => new TypeError("reset")).connect).call("finish", ["r", "l", "published", "1", null], SUBJECT), /SINGLE_POST_DB_OUTCOME_UNKNOWN/u);
  assert.deepEqual(await createSinglePostDb(scripted(() => [[]]).connect).call("get", ["r"], { userId: "x", sessionId: SUBJECT.sessionId }), { ok: false, code: "DB_REQUEST_INVALID" });
  assert.deepEqual(await createSinglePostDb(scripted(() => [[]]).connect).call("get", ["r"], { userId: SUBJECT.userId, sessionId: "" }), { ok: false, code: "DB_REQUEST_INVALID" });
});
