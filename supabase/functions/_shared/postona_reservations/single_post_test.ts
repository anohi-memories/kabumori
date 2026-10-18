// MOCK_ONLY: Auth verifier, database and publisher are in-memory fakes of their contracts; the real SQL / driver path is
// proven by candidates/postona_x_reservations/single_post_run.sh.
import assert from "node:assert/strict";
import test from "node:test";
import { createSinglePostHandler, POSTONA_X_SINGLE_POST_ENABLED } from "./single_post.ts";
import type { SinglePostDb, SinglePostFunction } from "./single_post_db.ts";
import type { PublishResult } from "./worker.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const RID = "33333333-3333-4333-8333-333333333333";
const LEASE = "44444444-4444-4444-8444-444444444444";
const REQ = "55555555-5555-4555-8555-555555555555";
const b64 = (v: unknown) => btoa(JSON.stringify(v)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
const token = (claims: Record<string, unknown>) => `${b64({ alg: "HS256" })}.${b64(claims)}.sig`;
const TOKEN = token({ sub: USER, session_id: SESSION });
const SHA = "a".repeat(64);
const body = (over: Record<string, unknown> = {}) => JSON.stringify({ socialAccountId: "sa_x", clientRequestId: REQ, text: "本文", consent: { confirmed: true, contentSha256: SHA }, ...over });
const auth = { verify: (t: string) => Promise.resolve(t === TOKEN || t.startsWith(TOKEN.split(".")[0]) ? { userId: USER } : null) };

type Script = Partial<Record<SinglePostFunction, () => Promise<{ ok: true; rows: Record<string, unknown>[] } | { ok: false; code: string }>>>;
function fakeDb(script: Script) {
  const calls: { fn: SinglePostFunction; args: readonly unknown[]; session: string }[] = [];
  const db: SinglePostDb = {
    call(fn, args, subject) {
      calls.push({ fn, args, session: subject.sessionId });
      const answer = script[fn];
      return answer ? answer() : Promise.reject(new Error(`unexpected ${fn}`));
    },
  };
  return { db, calls };
}
const rows = (...r: Record<string, unknown>[]) => () => Promise.resolve({ ok: true as const, rows: r });
const scalar = (answer: string) => rows({ answer });
const publisher = (result: PublishResult | (() => Promise<PublishResult>), available = true) => {
  const sent: string[] = [];
  return { available, sent, publish: (_a: string, text: string) => { sent.push(text); return typeof result === "function" ? result() : Promise.resolve(result); } };
};
const happyDb = (stored: Record<string, unknown> = { state: "sent", provider_post_id: "1790000000000000001" }) => fakeDb({
  begin: rows({ reservation_id: RID, lease_token: LEASE, state: "claimed" }), check: scalar("OK"), finish: scalar("published"),
  get: rows({ reservation_id: RID, ...stored }),
});
const run = (deps: { db: SinglePostDb; readDb?: SinglePostDb; publisher: ReturnType<typeof publisher> }, req: { authorization?: string | null; body?: string; method?: string } = {}) =>
  createSinglePostHandler({ enabled: true, auth, ...deps })({ method: req.method ?? "POST", authorization: req.authorization === undefined ? `Bearer ${TOKEN}` : req.authorization, body: req.body ?? body() });

test("the shipped gate is OFF; a full pass is: begin -> check -> one X create -> finish -> independent read-back = sent", async () => {
  assert.equal(POSTONA_X_SINGLE_POST_ENABLED, false);
  const off = await createSinglePostHandler({ enabled: false, auth, db: happyDb().db, publisher: publisher({ kind: "published", providerPostId: "1" }) })({ method: "POST", authorization: `Bearer ${TOKEN}`, body: body() });
  assert.deepEqual(off, { status: 503, body: { ok: false, code: "NOT_AVAILABLE" } });
  const { db, calls } = happyDb();
  const read = happyDb();
  const pub = publisher({ kind: "published", providerPostId: "1790000000000000001" });
  assert.deepEqual(await run({ db, readDb: read.db, publisher: pub }), { status: 200, body: { ok: true, status: "sent", reservationId: RID, xPostId: "1790000000000000001" } });
  assert.deepEqual(calls.map((c) => c.fn), ["begin", "check", "finish"]);
  assert.deepEqual(read.calls.map((c) => c.fn), ["get"], "the read-back is a separate store");
  assert.deepEqual(calls[0].args, ["sa_x", REQ, "本文", SHA]);
  assert.ok(calls.every((c) => c.session === SESSION), "the verified token's session id travels to T13");
  assert.deepEqual(pub.sent, ["本文"]);
});

test("refused before anything is recorded: bad body, no / unverified token, no session id, publisher unavailable", async () => {
  for (const b of [body({ extra: 1 }), body({ consent: { confirmed: false, contentSha256: SHA } }), body({ clientRequestId: "x" }), body({ text: "" }), "{", "[]"]) {
    const { db, calls } = happyDb();
    assert.equal((await run({ db, publisher: publisher({ kind: "published", providerPostId: "1" }) }, { body: b })).status, 400, b);
    assert.equal(calls.length, 0);
  }
  for (const authorization of [null, "Bearer short", `Basic ${TOKEN}`, `Bearer ${token({ sub: USER })}`, `Bearer ${token({ sub: "other", session_id: SESSION })}`]) {
    const { db, calls } = happyDb();
    const answer = await run({ db, publisher: publisher({ kind: "published", providerPostId: "1" }) }, { authorization });
    assert.equal(answer.status, 401, String(authorization));
    assert.equal(calls.length, 0);
  }
  const { db, calls } = happyDb();
  const pub = publisher({ kind: "published", providerPostId: "1" }, false);
  assert.deepEqual(await run({ db, publisher: pub }), { status: 503, body: { ok: false, code: "X_NOT_AVAILABLE" } });
  assert.equal(calls.length, 0, "nothing recorded when nothing could be sent");
  assert.deepEqual(pub.sent, []);
});

test("database refusals keep their fixed codes; nothing is sent", async () => {
  for (const [code, status] of [["POSTONA_RESV_SERVICE_NOT_ACTIVE", 403], ["POSTONA_RESV_AUTH_REQUIRED", 401], ["POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED", 403],
    ["POSTONA_RESV_PUBLISH_AUTHORITY_REVOKED", 403], ["POSTONA_RESV_ACCOUNT_NOT_FOUND", 404], ["POSTONA_RESV_CONSENT_REQUIRED", 422],
    ["POSTONA_RESV_IDEMPOTENCY_CONFLICT", 409], ["POSTONA_RESV_SERVICE_BUSY", 503], ["SOMETHING_ELSE", 500]] as const) {
    const pub = publisher({ kind: "published", providerPostId: "1" });
    const answer = await run({ db: fakeDb({ begin: () => Promise.resolve({ ok: false, code }) }).db, publisher: pub });
    assert.equal(answer.status, status, code);
    assert.deepEqual(pub.sent, []);
  }
  const pub = publisher({ kind: "published", providerPostId: "1" });
  assert.deepEqual(await run({ db: fakeDb({ begin: () => Promise.reject(new Error("reset")) }).db, publisher: pub }), { status: 503, body: { ok: false, code: "STORE_UNAVAILABLE" } });
  assert.deepEqual(pub.sent, []);
});

test("a repeat of the same request never sends again: in_progress -> pending; stored sent / failed / uncertain are read back", async () => {
  const pub = publisher({ kind: "published", providerPostId: "9" });
  assert.deepEqual(await run({ db: fakeDb({ begin: rows({ reservation_id: RID, state: "in_progress" }) }).db, publisher: pub }),
    { status: 200, body: { ok: true, status: "pending", reservationId: RID, code: "IN_PROGRESS" } });
  for (const stored of [{ state: "sent", provider_post_id: "1790000000000000001" }, { state: "failed", outcome_code: "X_REJECTED_403" }, { state: "uncertain", outcome_code: "X_TIMEOUT" }]) {
    const f = fakeDb({ begin: rows({ reservation_id: RID, state: stored.state }), get: rows({ reservation_id: RID, ...stored }) });
    const answer = await run({ db: f.db, publisher: pub });
    assert.equal(answer.status, 200);
    assert.equal((answer.body as { status: string }).status, stored.state);
    assert.deepEqual(f.calls.map((c) => c.fn), ["begin", "get"]);
  }
  assert.deepEqual(pub.sent, [], "never sent");
});

test("right before the X call: RELEASED -> pending, NOT_PUBLISHABLE -> failed, unreadable -> as stored; never sent", async () => {
  for (const [verdict, stored, expected] of [["RELEASED", { state: "pending" }, "pending"], ["NOT_PUBLISHABLE", { state: "failed", outcome_code: "NOT_PUBLISHABLE_AT_SEND" }, "failed"],
    ["LEASE_LOST", { state: "uncertain", outcome_code: "LEASE_EXPIRED" }, "uncertain"]] as const) {
    const pub = publisher({ kind: "published", providerPostId: "1" });
    const f = fakeDb({ begin: rows({ reservation_id: RID, lease_token: LEASE, state: "claimed" }), check: scalar(verdict), get: rows({ reservation_id: RID, ...stored }) });
    assert.equal(((await run({ db: f.db, publisher: pub })).body as { status: string }).status, expected, verdict);
    assert.deepEqual(pub.sent, []);
  }
  const pub = publisher({ kind: "published", providerPostId: "1" });
  const f = fakeDb({ begin: rows({ reservation_id: RID, lease_token: LEASE, state: "claimed" }), check: () => Promise.reject(new Error("reset")), get: rows({ reservation_id: RID, state: "pending" }) });
  assert.equal(((await run({ db: f.db, publisher: pub })).body as { status: string }).status, "pending");
  assert.deepEqual(pub.sent, []);
});

test("X refused -> failed; X unknown / timeout / thrown / bad id -> uncertain; each sent exactly once", async () => {
  const cases: [PublishResult | (() => Promise<PublishResult>), string, Record<string, unknown>][] = [
    [{ kind: "rejected_before_send", code: "X_REJECTED_403" }, "failed_before_send", { state: "failed", outcome_code: "X_REJECTED_403" }],
    [{ kind: "unknown", code: "X_TIMEOUT" }, "uncertain", { state: "uncertain", outcome_code: "X_TIMEOUT" }],
    [() => Promise.reject(new Error("boom")), "uncertain", { state: "uncertain", outcome_code: "PUBLISHER_THREW" }],
    [{ kind: "published", providerPostId: "12a" }, "uncertain", { state: "uncertain", outcome_code: "PROVIDER_POST_ID_INVALID" }],
  ];
  for (const [result, outcome, stored] of cases) {
    const finishArgs: unknown[][] = [];
    const f = fakeDb({ begin: rows({ reservation_id: RID, lease_token: LEASE, state: "claimed" }), check: scalar("OK"),
      finish: () => Promise.resolve({ ok: true, rows: [{ answer: outcome }] }), get: rows({ reservation_id: RID, ...stored }) });
    const original = f.db.call.bind(f.db);
    f.db.call = (fn, args, s) => { if (fn === "finish") finishArgs.push([...args]); return original(fn, args, s); };
    const pub = publisher(result);
    const answer = await run({ db: f.db, publisher: pub });
    assert.equal((answer.body as { status: string }).status, stored.state, JSON.stringify(stored));
    assert.equal(finishArgs[0][2], outcome);
    assert.equal(pub.sent.length, 1);
  }
});

test("X said published but the result was not recorded, or the read-back differs: uncertain, never sent", async () => {
  for (const finish of [() => Promise.reject(new Error("COMMIT lost")), scalar("lease_lost"), () => Promise.resolve({ ok: false as const, code: "POSTONA_RESV_LEASE_LOST" })]) {
    const f = fakeDb({ begin: rows({ reservation_id: RID, lease_token: LEASE, state: "claimed" }), check: scalar("OK"), finish });
    assert.deepEqual(await run({ db: f.db, publisher: publisher({ kind: "published", providerPostId: "1790000000000000001" }) }),
      { status: 200, body: { ok: true, status: "uncertain", reservationId: RID, code: "RESULT_NOT_RECORDED" } });
  }
  for (const stored of [{ state: "sent", provider_post_id: "1790000000000000999" }, { state: "sent", provider_post_id: null }, { state: "weird" }]) {
    const { db } = happyDb();
    const read = fakeDb({ get: rows({ reservation_id: RID, ...stored }) });
    const answer = await run({ db, readDb: read.db, publisher: publisher({ kind: "published", providerPostId: "1790000000000000001" }) });
    assert.equal((answer.body as { status: string }).status, "uncertain", JSON.stringify(stored));
  }
  const { db } = happyDb();
  const answer = await run({ db, readDb: fakeDb({ get: () => Promise.reject(new Error("down")) }).db, publisher: publisher({ kind: "published", providerPostId: "1790000000000000001" }) });
  assert.deepEqual(answer.body, { ok: true, status: "uncertain", reservationId: RID, code: "READBACK_UNAVAILABLE" });
});

test("source: no Vault, no service-role key, no console, no token or text in any answer", async () => {
  const source = await Deno.readTextFile(new URL("./single_post.ts", import.meta.url));
  for (const banned of ["vault", "SERVICE_ROLE", "console.", "Deno.env"]) assert.ok(!source.includes(banned), banned);
  const answer = await run({ db: happyDb().db, publisher: publisher({ kind: "published", providerPostId: "1790000000000000001" }) });
  assert.ok(!JSON.stringify(answer).includes(TOKEN) && !JSON.stringify(answer).includes("本文"));
});
