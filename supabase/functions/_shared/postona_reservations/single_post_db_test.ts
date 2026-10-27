// MOCK_ONLY: a scripted Postgres client; the real driver path is proven by single_post_run.sh.
import assert from "node:assert/strict";
import test from "node:test";
import type { PgConnect } from "./postgres_db.ts";
import { createSinglePostDb } from "./single_post_db.ts";

const SUBJECT = { userId: "11111111-1111-4111-8111-111111111111", sessionId: "22222222-2222-4222-8222-222222222222", isAnonymous: false as const };
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
  assert.deepEqual(JSON.parse(String(s.log[3].args?.[0])), { sub: SUBJECT.userId, role: "authenticated", session_id: SUBJECT.sessionId, is_anonymous: false });
  assert.ok(s.log[4].text.includes("postona_x_resv.post_now_begin($1::text, $2::uuid, $3::text, $4::text)"));
  assert.equal(s.log.at(-1)?.text, "COMMIT");
});

test("006 steps only: preflight / record / readback call the M1-F1 functions; 005's check / finish / get are unreachable", async () => {
  for (const [fn, args, sql] of [
    ["preflight", ["r", "l"], "FROM postona_x_resv.post_now_preflight($1::uuid, $2::uuid) r"],
    ["record", ["r", "l", "published", "1", null, "x"], "postona_x_resv.post_now_record($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text)"],
    ["readback", ["r"], "FROM postona_x_resv.post_now_readback($1::uuid) r"],
  ] as const) {
    const s = scripted(() => [[JSON.stringify([{ answer: "ok" }])]]);
    assert.equal((await createSinglePostDb(s.connect).call(fn, args, SUBJECT)).ok, true, fn);
    assert.ok(s.log[4].text.includes(sql), `${fn}: ${s.log[4].text}`);
  }
  for (const fn of ["check", "finish", "get"]) {
    const s = scripted(() => [[]]);
    assert.deepEqual(await createSinglePostDb(s.connect).call(fn as never, ["r"], SUBJECT), { ok: false, code: "DB_REQUEST_INVALID" }, fn);
    assert.equal(s.log.length, 0);
  }
  const short = scripted(() => [[]]);
  assert.deepEqual(await createSinglePostDb(short.connect).call("record", ["r", "l", "published", "1", null], SUBJECT), { ok: false, code: "DB_REQUEST_INVALID" }, "the transport is required");
});

test("refusals keep POSTONA_RESV_* codes; a lock timeout is SERVICE_BUSY; anything else after the call is unknown (throw)", async () => {
  assert.deepEqual(await createSinglePostDb(scripted(() => pgError("POSTONA_RESV_SERVICE_NOT_ACTIVE")).connect).call("preflight", ["r", "l"], SUBJECT), { ok: false, code: "POSTONA_RESV_SERVICE_NOT_ACTIVE" });
  assert.deepEqual(await createSinglePostDb(scripted(() => pgError("canceling statement due to lock timeout", "55P03")).connect).call("preflight", ["r", "l"], SUBJECT), { ok: false, code: "POSTONA_RESV_SERVICE_BUSY" });
  assert.deepEqual(await createSinglePostDb(scripted(() => pgError("relation x secret")).connect).call("readback", ["r"], SUBJECT), { ok: false, code: "DB_ERROR" });
  await assert.rejects(() => createSinglePostDb(scripted(() => new TypeError("reset")).connect).call("record", ["r", "l", "published", "1", null, "x"], SUBJECT), /SINGLE_POST_DB_OUTCOME_UNKNOWN/u);
  assert.deepEqual(await createSinglePostDb(scripted(() => [[]]).connect).call("readback", ["r"], { userId: "x", sessionId: SUBJECT.sessionId, isAnonymous: false }), { ok: false, code: "DB_REQUEST_INVALID" });
  assert.deepEqual(await createSinglePostDb(scripted(() => [[]]).connect).call("readback", ["r"], { userId: SUBJECT.userId, sessionId: "", isAnonymous: false }), { ok: false, code: "DB_REQUEST_INVALID" });
});

test("G3-34 F1: a subject without the token's explicit non-anonymous false never reaches the database (refused before connecting)", async () => {
  let connected = 0;
  const db = createSinglePostDb(() => { connected += 1; return Promise.reject(new Error("x")); });
  for (const isAnonymous of [undefined, null, "false", true]) {
    const subject = { ...SUBJECT, isAnonymous } as unknown as typeof SUBJECT;
    assert.deepEqual(await db.call("readback", [SUBJECT.userId], subject), { ok: false, code: "DB_REQUEST_INVALID" }, String(isAnonymous));
  }
  assert.equal(connected, 0);
});

test("G3-37 readiness: one read-only function as the API role with the verified claims; its scalar answer comes back as one row", async () => {
  const s = scripted(() => [[JSON.stringify([{ answer: "READY" }])]]);
  const result = await createSinglePostDb(s.connect).call("readiness", ["sa_x"], SUBJECT);
  assert.deepEqual(result, { ok: true, rows: [{ answer: "READY" }] });
  assert.ok(s.log.some((q) => q.text.includes("postona_x_resv.post_now_readiness($1::text)")));
  assert.deepEqual(JSON.parse(String(s.log[3].args?.[0])), { sub: SUBJECT.userId, role: "authenticated", session_id: SUBJECT.sessionId, is_anonymous: false });
  const refused = scripted(() => pgError("POSTONA_RESV_PUBLISH_DISABLED"));
  assert.deepEqual(await createSinglePostDb(refused.connect).call("readiness", ["sa_x"], SUBJECT), { ok: false, code: "POSTONA_RESV_PUBLISH_DISABLED" });
  assert.deepEqual(await createSinglePostDb(s.connect).call("readiness", [], SUBJECT), { ok: false, code: "DB_REQUEST_INVALID" });
});
