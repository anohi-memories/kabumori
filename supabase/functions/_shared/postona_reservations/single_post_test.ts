// MOCK_ONLY: Auth verifier, database, credential source and publisher are in-memory fakes of their contracts; the real
// SQL / driver path is proven by candidates/postona_x_reservations/single_post_run.sh and single_post_live_fence_run.sh.
import assert from "node:assert/strict";
import test from "node:test";
import { createSinglePostHandler, POSTONA_X_SINGLE_POST_ENABLED, type SinglePostTransport } from "./single_post.ts";
import type { SinglePostDb, SinglePostFunction } from "./single_post_db.ts";
import type { PublishResult } from "./worker.ts";
import type { XGenerationCredential, XPostingGenerationCredentialSource } from "./x_credential_generation.ts";
import type { XPostingCredentialSource } from "./x_publisher.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const RID = "33333333-3333-4333-8333-333333333333";
const LEASE = "44444444-4444-4444-8444-444444444444";
const REQ = "55555555-5555-4555-8555-555555555555";
const GEN = "c".repeat(64);
const X_TOKEN = "fake-x-token-sa_x-0001";
const b64 = (v: unknown) => btoa(JSON.stringify(v)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
const token = (claims: Record<string, unknown>) => `${b64({ alg: "HS256" })}.${b64(claims)}.sig`;
const TOKEN = token({ sub: USER, session_id: SESSION, is_anonymous: false });
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
const okPreflight = rows({ verdict: "OK", credential_generation: GEN });

/** MOCK_ONLY X: a generation-bound credential source and the publisher the handler builds per send. */
function fakeX(result: PublishResult | (() => Promise<PublishResult>), credential: XGenerationCredential | null | (() => Promise<XGenerationCredential | null>) = { token: X_TOKEN, generation: GEN }, available = true) {
  const sent: { account: string; text: string; token: string | null }[] = [];
  const reasked: (string | null)[] = [];
  const order: string[] = [];
  const credentials: XPostingGenerationCredentialSource = {
    available,
    credentialFor: (_account) => { order.push("credential"); return typeof credential === "function" ? credential() : Promise.resolve(credential); },
  };
  const publisherFor = (source: XPostingCredentialSource) => ({
    available: source.available,
    publish: async (account: string, text: string): Promise<PublishResult> => {
      const t = await source.accessTokenFor(account);
      sent.push({ account, text, token: t });
      reasked.push(await source.accessTokenFor(account), await source.accessTokenFor("sa_other"));
      return typeof result === "function" ? result() : result;
    },
  });
  return { credentials, publisherFor, sent, reasked, order };
}
const happyDb = (stored: Record<string, unknown> = { state: "sent", provider_post_id: "1790000000000000001", after_freeze: false, simulated: false }) => fakeDb({
  begin: rows({ reservation_id: RID, lease_token: LEASE, state: "claimed" }), preflight: okPreflight, record: scalar("published"),
  readback: rows({ reservation_id: RID, ...stored }),
});
type X = ReturnType<typeof fakeX>;
const run = (deps: { db: SinglePostDb; readDb?: SinglePostDb; x: X; transport?: SinglePostTransport }, req: { authorization?: string | null; body?: string; method?: string } = {}) =>
  createSinglePostHandler({ enabled: true, auth, db: deps.db, readDb: deps.readDb, credentials: deps.x.credentials, publisherFor: deps.x.publisherFor, transport: deps.transport ?? "x" })(
    { method: req.method ?? "POST", authorization: req.authorization === undefined ? `Bearer ${TOKEN}` : req.authorization, body: req.body ?? body() });
const published = (id = "1790000000000000001"): PublishResult => ({ kind: "published", providerPostId: id });

test("the shipped gate is OFF; a full pass is: begin -> token+generation -> preflight -> one X create -> record -> independent read-back = sent", async () => {
  assert.equal(POSTONA_X_SINGLE_POST_ENABLED, false);
  const offX = fakeX(published("1"));
  const off = await createSinglePostHandler({ enabled: false, auth, db: happyDb().db, credentials: offX.credentials, publisherFor: offX.publisherFor, transport: "x" })(
    { method: "POST", authorization: `Bearer ${TOKEN}`, body: body() });
  assert.deepEqual(off, { status: 503, body: { ok: false, code: "NOT_AVAILABLE" } });
  const { db, calls } = happyDb();
  const read = happyDb();
  const x = fakeX(published());
  assert.deepEqual(await run({ db, readDb: read.db, x }),
    { status: 200, body: { ok: true, status: "sent", reservationId: RID, xPostId: "1790000000000000001", simulated: false, afterFreeze: false } });
  assert.deepEqual(calls.map((c) => c.fn), ["begin", "preflight", "record"]);
  assert.deepEqual(read.calls.map((c) => c.fn), ["readback"], "the read-back is a separate store");
  assert.deepEqual(calls[0].args, ["sa_x", REQ, "本文", SHA]);
  assert.deepEqual(calls[2].args, [RID, LEASE, "published", "1790000000000000001", null, "x"], "the transport is recorded");
  assert.ok(calls.every((c) => c.session === SESSION), "the verified token's session id travels to T13");
  assert.deepEqual(x.sent, [{ account: "sa_x", text: "本文", token: X_TOKEN }], "sent once with exactly the generation-checked token");
  assert.deepEqual(x.reasked, [null, null], "the publisher's source answers that token once, for that account only");
});

test("M1-F1 order: the token is read BEFORE the last preflight, so a change after the token read is still caught", async () => {
  const order: string[] = [];
  const x = fakeX(published());
  const original = x.credentials.credentialFor;
  x.credentials.credentialFor = (a) => { order.push("credential"); return original(a); };
  const f = happyDb();
  const call = f.db.call.bind(f.db);
  f.db.call = (fn, args, s) => { order.push(fn); return call(fn, args, s); };
  await run({ db: f.db, x });
  assert.deepEqual(order, ["begin", "credential", "preflight", "record", "readback"]);
});

test("refused before anything is recorded: bad body, no / unverified token, no session id, source not connected / accessor-only", async () => {
  for (const b of [body({ extra: 1 }), body({ consent: { confirmed: false, contentSha256: SHA } }), body({ clientRequestId: "x" }), body({ text: "" }), "{", "[]"]) {
    const { db, calls } = happyDb();
    assert.equal((await run({ db, x: fakeX(published("1")) }, { body: b })).status, 400, b);
    assert.equal(calls.length, 0);
  }
  // G3-34 F1: the same token must also state is_anonymous as the JSON false (missing / null / "false" / true are refused)
  for (const authorization of [null, "Bearer short", `Basic ${TOKEN}`, `Bearer ${token({ sub: USER })}`, `Bearer ${token({ sub: "other", session_id: SESSION, is_anonymous: false })}`,
    `Bearer ${token({ sub: USER, session_id: SESSION })}`, `Bearer ${token({ sub: USER, session_id: SESSION, is_anonymous: null })}`,
    `Bearer ${token({ sub: USER, session_id: SESSION, is_anonymous: "false" })}`, `Bearer ${token({ sub: USER, session_id: SESSION, is_anonymous: true })}`]) {
    const { db, calls } = happyDb();
    const answer = await run({ db, x: fakeX(published("1")) }, { authorization });
    assert.equal(answer.status, 401, String(authorization));
    assert.equal(calls.length, 0);
  }
  for (const x of [fakeX(published("1"), undefined, false), { ...fakeX(published("1")), credentials: { available: true, accessTokenFor: () => Promise.resolve(X_TOKEN) } as never }]) {
    const { db, calls } = happyDb();
    assert.deepEqual(await run({ db, x }), { status: 503, body: { ok: false, code: "X_NOT_AVAILABLE" } });
    assert.equal(calls.length, 0, "nothing recorded when nothing could be sent");
    assert.deepEqual(x.sent, []);
  }
});

test("database refusals keep their fixed codes (incl. publish OFF / credential degraded); nothing is sent", async () => {
  for (const [code, status] of [["POSTONA_RESV_SERVICE_NOT_ACTIVE", 403], ["POSTONA_RESV_AUTH_REQUIRED", 401], ["POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED", 403],
    ["POSTONA_RESV_PUBLISH_AUTHORITY_REVOKED", 403], ["POSTONA_RESV_PUBLISH_DISABLED", 403], ["POSTONA_RESV_CREDENTIAL_DEGRADED", 403],
    ["POSTONA_RESV_ACCOUNT_NOT_FOUND", 404], ["POSTONA_RESV_CONSENT_REQUIRED", 422],
    ["POSTONA_RESV_IDEMPOTENCY_CONFLICT", 409], ["POSTONA_RESV_SERVICE_BUSY", 503], ["SOMETHING_ELSE", 500]] as const) {
    const x = fakeX(published("1"));
    const answer = await run({ db: fakeDb({ begin: () => Promise.resolve({ ok: false, code }) }).db, x });
    assert.equal(answer.status, status, code);
    assert.deepEqual(x.sent, []);
  }
  const x = fakeX(published("1"));
  assert.deepEqual(await run({ db: fakeDb({ begin: () => Promise.reject(new Error("reset")) }).db, x }), { status: 503, body: { ok: false, code: "STORE_UNAVAILABLE" } });
  assert.deepEqual(x.sent, []);
});

test("a repeat of the same request never sends again: in_progress -> pending; stored sent / failed / uncertain are read back", async () => {
  const x = fakeX(published("9"));
  assert.deepEqual(await run({ db: fakeDb({ begin: rows({ reservation_id: RID, state: "in_progress" }) }).db, x }),
    { status: 200, body: { ok: true, status: "pending", reservationId: RID, code: "IN_PROGRESS", simulated: false } });
  for (const stored of [{ state: "sent", provider_post_id: "1790000000000000001" }, { state: "failed", outcome_code: "X_REJECTED_403" }, { state: "uncertain", outcome_code: "X_TIMEOUT" }]) {
    const f = fakeDb({ begin: rows({ reservation_id: RID, state: stored.state }), readback: rows({ reservation_id: RID, after_freeze: false, simulated: false, ...stored }) });
    const answer = await run({ db: f.db, x });
    assert.equal(answer.status, 200);
    assert.equal((answer.body as { status: string }).status, stored.state);
    assert.deepEqual(f.calls.map((c) => c.fn), ["begin", "readback"]);
  }
  assert.deepEqual(x.sent, [], "never sent");
  assert.deepEqual(x.order, [], "no token is even read for a repeat");
});

test("right before the X call: RELEASED -> pending, NOT_PUBLISHABLE -> failed, unreadable -> as stored; never sent", async () => {
  for (const [verdict, stored, expected] of [["RELEASED", { state: "pending" }, "pending"], ["NOT_PUBLISHABLE", { state: "failed", outcome_code: "CREDENTIAL_CHANGED" }, "failed"],
    ["LEASE_LOST", { state: "uncertain", outcome_code: "LEASE_EXPIRED" }, "uncertain"]] as const) {
    const x = fakeX(published("1"));
    const f = fakeDb({ begin: rows({ reservation_id: RID, lease_token: LEASE, state: "claimed" }), preflight: rows({ verdict, credential_generation: null }), readback: rows({ reservation_id: RID, ...stored }) });
    assert.equal(((await run({ db: f.db, x })).body as { status: string }).status, expected, verdict);
    assert.deepEqual(x.sent, []);
    assert.ok(!f.calls.some((c) => c.fn === "record"), "nothing recorded by the handler");
  }
  const x = fakeX(published("1"));
  const f = fakeDb({ begin: rows({ reservation_id: RID, lease_token: LEASE, state: "claimed" }), preflight: () => Promise.reject(new Error("reset")), readback: rows({ reservation_id: RID, state: "pending" }) });
  assert.equal(((await run({ db: f.db, x })).body as { status: string }).status, "pending");
  assert.deepEqual(x.sent, []);
});

test("credential generation: missing token / thrown source -> X_CREDENTIALS_UNAVAILABLE; another generation (or none from the database) -> CREDENTIAL_GENERATION_CHANGED; never sent", async () => {
  const cases: [XGenerationCredential | null | (() => Promise<XGenerationCredential | null>), Record<string, unknown>, string][] = [
    [null, { verdict: "OK", credential_generation: GEN }, "X_CREDENTIALS_UNAVAILABLE"],
    [() => Promise.reject(new Error("vault down")), { verdict: "OK", credential_generation: GEN }, "X_CREDENTIALS_UNAVAILABLE"],
    [{ token: "short", generation: GEN }, { verdict: "OK", credential_generation: GEN }, "X_CREDENTIALS_UNAVAILABLE"],
    [{ token: X_TOKEN, generation: "d".repeat(64) }, { verdict: "OK", credential_generation: GEN }, "CREDENTIAL_GENERATION_CHANGED"],
    [{ token: X_TOKEN, generation: GEN }, { verdict: "OK", credential_generation: null }, "CREDENTIAL_GENERATION_CHANGED"],
    [{ token: X_TOKEN, generation: GEN.toUpperCase() }, { verdict: "OK", credential_generation: GEN.toUpperCase() }, "CREDENTIAL_GENERATION_CHANGED"],
  ];
  for (const [credential, preflight, code] of cases) {
    const x = fakeX(published(), credential);
    const recordArgs: unknown[][] = [];
    const f = fakeDb({ begin: rows({ reservation_id: RID, lease_token: LEASE, state: "claimed" }), preflight: rows(preflight),
      record: scalar("failed"), readback: rows({ reservation_id: RID, state: "failed", outcome_code: code, after_freeze: false, simulated: false }) });
    const call = f.db.call.bind(f.db);
    f.db.call = (fn, args, s) => { if (fn === "record") recordArgs.push([...args]); return call(fn, args, s); };
    const answer = await run({ db: f.db, x });
    assert.deepEqual([(answer.body as { status: string }).status, recordArgs[0]?.[2], recordArgs[0]?.[4]], ["failed", "failed_before_send", code], code);
    assert.deepEqual(x.sent, [], code);
    assert.ok(!JSON.stringify(answer).includes(X_TOKEN));
  }
});

test("X refused -> failed; X unknown / timeout / thrown / bad id -> uncertain; each sent exactly once", async () => {
  const cases: [PublishResult | (() => Promise<PublishResult>), string, Record<string, unknown>][] = [
    [{ kind: "rejected_before_send", code: "X_REJECTED_403" }, "failed_before_send", { state: "failed", outcome_code: "X_REJECTED_403" }],
    [{ kind: "unknown", code: "X_TIMEOUT" }, "uncertain", { state: "uncertain", outcome_code: "X_TIMEOUT" }],
    [() => Promise.reject(new Error("boom")), "uncertain", { state: "uncertain", outcome_code: "PUBLISHER_THREW" }],
    [{ kind: "published", providerPostId: "12a" }, "uncertain", { state: "uncertain", outcome_code: "PROVIDER_POST_ID_INVALID" }],
  ];
  for (const [result, outcome, stored] of cases) {
    const recordArgs: unknown[][] = [];
    const f = fakeDb({ begin: rows({ reservation_id: RID, lease_token: LEASE, state: "claimed" }), preflight: okPreflight,
      record: () => Promise.resolve({ ok: true, rows: [{ answer: outcome }] }), readback: rows({ reservation_id: RID, ...stored }) });
    const original = f.db.call.bind(f.db);
    f.db.call = (fn, args, s) => { if (fn === "record") recordArgs.push([...args]); return original(fn, args, s); };
    const x = fakeX(result);
    const answer = await run({ db: f.db, x });
    assert.equal((answer.body as { status: string }).status, stored.state, JSON.stringify(stored));
    assert.equal(recordArgs[0][2], outcome);
    assert.equal(x.sent.length, 1);
  }
});

test("X said published but the result was not recorded, or the read-back differs: uncertain, never sent", async () => {
  for (const record of [() => Promise.reject(new Error("COMMIT lost")), scalar("lease_lost"), () => Promise.resolve({ ok: false as const, code: "POSTONA_RESV_LEASE_LOST" })]) {
    const f = fakeDb({ begin: rows({ reservation_id: RID, lease_token: LEASE, state: "claimed" }), preflight: okPreflight, record });
    assert.deepEqual(await run({ db: f.db, x: fakeX(published()) }),
      { status: 200, body: { ok: true, status: "uncertain", reservationId: RID, code: "RESULT_NOT_RECORDED", simulated: false } });
  }
  for (const stored of [{ state: "sent", provider_post_id: "1790000000000000999" }, { state: "sent", provider_post_id: null }, { state: "weird" }]) {
    const { db } = happyDb();
    const read = fakeDb({ readback: rows({ reservation_id: RID, ...stored }) });
    const answer = await run({ db, readDb: read.db, x: fakeX(published()) });
    assert.equal((answer.body as { status: string }).status, "uncertain", JSON.stringify(stored));
  }
  const { db } = happyDb();
  const answer = await run({ db, readDb: fakeDb({ readback: () => Promise.reject(new Error("down")) }).db, x: fakeX(published()) });
  assert.deepEqual(answer.body, { ok: true, status: "uncertain", reservationId: RID, code: "READBACK_UNAVAILABLE", simulated: false });
});

test("M1-F3 / simulated marks: after_freeze is answered as stored (unknown = true); a simulated transport is recorded and answered simulated", async () => {
  const frozen = happyDb({ state: "sent", provider_post_id: "1790000000000000001", after_freeze: true, simulated: false });
  assert.deepEqual((await run({ db: frozen.db, x: fakeX(published()) })).body,
    { ok: true, status: "sent", reservationId: RID, xPostId: "1790000000000000001", simulated: false, afterFreeze: true }, "the in-flight post is shown as posted, flagged");
  const unknownMarks = happyDb({ state: "sent", provider_post_id: "1790000000000000001" });
  assert.deepEqual((await run({ db: unknownMarks.db, x: fakeX(published()) })).body,
    { ok: true, status: "sent", reservationId: RID, xPostId: "1790000000000000001", simulated: true, afterFreeze: true }, "missing marks never read as real / unfrozen");
  const sim = happyDb();
  const answer = await run({ db: sim.db, x: fakeX(published()), transport: "simulated" });
  assert.equal((answer.body as { simulated: boolean }).simulated, true, "a simulated transport is never answered as a real post");
  assert.equal(sim.calls.find((c) => c.fn === "record")?.args[5], "simulated");
  const odd = happyDb();
  await run({ db: odd.db, x: fakeX(published()), transport: "X" as never });
  assert.equal(odd.calls.find((c) => c.fn === "record")?.args[5], "simulated", "only exactly 'x' is the real transport");
});

test("source: no Vault, no service-role key, no console, no token or text in any answer", async () => {
  const source = await Deno.readTextFile(new URL("./single_post.ts", import.meta.url));
  for (const banned of ["vault", "SERVICE_ROLE", "console.", "Deno.env"]) assert.ok(!source.includes(banned), banned);
  const answer = await run({ db: happyDb().db, x: fakeX(published()) });
  assert.ok(!JSON.stringify(answer).includes(TOKEN) && !JSON.stringify(answer).includes(X_TOKEN) && !JSON.stringify(answer).includes("本文"));
});

test("G3-36: the session ends between begin and the check (the gate refuses the check) -> 401 AUTH_REQUIRED, no X call, no record, no read-back", async () => {
  const x = fakeX(published("1"));
  const f = fakeDb({
    begin: rows({ reservation_id: RID, lease_token: LEASE, state: "claimed" }),
    preflight: () => Promise.resolve({ ok: false as const, code: "POSTONA_RESV_AUTH_REQUIRED" }),
  });
  assert.deepEqual(await run({ db: f.db, x }), { status: 401, body: { ok: false, code: "AUTH_REQUIRED" } });
  assert.deepEqual(f.calls.map((c) => c.fn), ["begin", "preflight"]);
  assert.equal(x.sent.length, 0, "nothing was sent");
  // any other refusal of the check keeps the stored answer (read-back), as before
  const g = fakeDb({
    begin: rows({ reservation_id: RID, lease_token: LEASE, state: "claimed" }),
    preflight: () => Promise.resolve({ ok: false as const, code: "POSTONA_RESV_SERVICE_BUSY" }),
    readback: rows({ reservation_id: RID, state: "pending", after_freeze: false, simulated: false }),
  });
  assert.equal((await run({ db: g.db, x })).status, 200);
  assert.deepEqual(g.calls.map((c) => c.fn), ["begin", "preflight", "readback"]);
  assert.equal(x.sent.length, 0);
});

test("G3-37 readiness: { readiness: { socialAccountId } } -> the same person checks, then ONE read-only database call; ready or begin's codes; never a begin, a token read or an X call", async () => {
  const readiness = (socialAccountId: unknown) => JSON.stringify({ readiness: { socialAccountId } });
  const ready = fakeDb({ readiness: scalar("READY") });
  const x = fakeX(published("1"));
  assert.deepEqual(await run({ db: ready.db, x }, { body: readiness("sa_x") }), { status: 200, body: { ok: true, ready: true } });
  assert.deepEqual(ready.calls.map((c) => [c.fn, c.args]), [["readiness", ["sa_x"]]]);
  for (const [code, status] of [["POSTONA_RESV_PUBLISH_DISABLED", 403], ["POSTONA_RESV_ACCOUNT_NOT_FOUND", 404], ["POSTONA_RESV_AUTH_REQUIRED", 401], ["POSTONA_RESV_SERVICE_BUSY", 503]] as const) {
    const f = fakeDb({ readiness: () => Promise.resolve({ ok: false as const, code }) });
    assert.deepEqual(await run({ db: f.db, x }, { body: readiness("sa_x") }), { status, body: { ok: false, code } }, code);
  }
  const thrown = fakeDb({ readiness: () => Promise.reject(new Error("socket")) });
  assert.deepEqual(await run({ db: thrown.db, x }, { body: readiness("sa_x") }), { status: 503, body: { ok: false, code: "STORE_UNAVAILABLE" } });
  const odd = fakeDb({ readiness: scalar("MAYBE") });
  assert.deepEqual(await run({ db: odd.db, x }, { body: readiness("sa_x") }), { status: 500, body: { ok: false, code: "INTERNAL" } });
  // malformed questions and unverified callers never reach the database
  for (const body of [readiness("bad id!"), JSON.stringify({ readiness: { socialAccountId: "sa_x", extra: 1 } }), JSON.stringify({ readiness: "sa_x" }), JSON.stringify({ readiness: { socialAccountId: "sa_x" }, text: "x" })]) {
    const f = fakeDb({ readiness: scalar("READY") });
    assert.equal((await run({ db: f.db, x }, { body })).status, 400, body);
    assert.equal(f.calls.length, 0);
  }
  for (const authorization of [null, `Bearer ${token({ sub: USER, session_id: SESSION })}`, `Bearer ${token({ sub: USER, session_id: SESSION, is_anonymous: true })}`]) {
    const f = fakeDb({ readiness: scalar("READY") });
    assert.equal((await run({ db: f.db, x }, { body: readiness("sa_x"), authorization })).status, 401, String(authorization));
    assert.equal(f.calls.length, 0);
  }
  assert.equal(x.sent.length, 0, "readiness never sends");
});
