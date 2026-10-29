// MOCK_ONLY unit tests for the Threads reservation API (G3-46): Auth, the person session, the permission port and the database are
// test doubles. They prove the request handling and the fail-closed order, not the real Auth / G5 / G4 boundary.
import assert from "node:assert/strict";
import test from "node:test";
import {
  createThreadsReservationApi,
  POSTONA_THREADS_RESERVATION_API_ENABLED,
  THREADS_PERMISSIONS_NOT_CONNECTED,
  type ThreadsDbFunction,
  type ThreadsDbResult,
  type ThreadsPermissionSources,
  type ThreadsReservationDb,
} from "./threads_api.ts";
import type { ApiRequest, AuthVerifier, ReservationSubject } from "./api.ts";

const USER = "00000000-0000-4000-8000-00000000000a";
const OTHER = "00000000-0000-4000-8000-00000000000b";
const SESSION = "00000000-0000-4000-8000-0000000000c1";
const RID = "00000000-0000-4000-8000-0000000000d1";
const CRID = "00000000-0000-4000-8000-0000000000e1";
const SHA = "a".repeat(64);
const b64url = (s: string) => btoa(s).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
const tokenFor = (claims: Record<string, unknown>) => `eyJhbGciOiJIUzI1NiJ9.${b64url(JSON.stringify(claims))}.signature-0123456789`;
const TOKEN = tokenFor({ sub: USER, session_id: SESSION, is_anonymous: false });
const verifier: AuthVerifier = { verify: () => Promise.resolve({ userId: USER }) };
const allow: ThreadsPermissionSources = { threadsPublishAllowed: () => Promise.resolve(true) };

function recordingDb(answer: ThreadsDbResult | "throw" = { ok: true, rows: [] }) {
  const calls: { fn: ThreadsDbFunction; args: readonly unknown[]; subject: ReservationSubject }[] = [];
  const db: ThreadsReservationDb = {
    call(fn, args, subject) {
      calls.push({ fn, args, subject });
      return answer === "throw" ? Promise.reject(new Error("socket closed")) : Promise.resolve(answer);
    },
  };
  return { db, calls };
}
const req = (payload: unknown, over: Partial<ApiRequest> = {}): ApiRequest => ({ method: "POST", authorization: `Bearer ${TOKEN}`, body: JSON.stringify(payload), ...over });
const createP = (over: Record<string, unknown> = {}) => ({
  action: "create",
  payload: { socialAccountId: "th_a", clientRequestId: CRID, text: "本文", contentSha256: SHA, scheduledAt: "2026-11-01T00:30:00.000Z", ...over },
});
const cancelP = { action: "cancel", payload: { reservationId: RID } };
const receiptP = { action: "receipt", payload: { socialAccountId: "th_a", clientRequestId: CRID } };
const RECEIPT_ROW = { reservation_id: RID, state: "pending", provider_post_id: null, outcome_code: null, after_freeze: false, simulated: true };

test("the release gate is a literal OFF and an OFF api touches nothing", async () => {
  assert.equal(POSTONA_THREADS_RESERVATION_API_ENABLED, false);
  let touched = 0;
  const { db, calls } = recordingDb();
  const api = createThreadsReservationApi({
    enabled: POSTONA_THREADS_RESERVATION_API_ENABLED, db,
    auth: { verify: () => { touched += 1; return Promise.resolve({ userId: USER }); } },
    permissions: { threadsPublishAllowed: () => { touched += 1; return Promise.resolve(true); } },
  });
  assert.deepEqual(await api(req(cancelP)), { status: 503, body: { ok: false, code: "NOT_AVAILABLE" } });
  assert.equal(touched, 0);
  assert.equal(calls.length, 0);
});

test("strict request shape: wrong method, size, JSON, action, extra or missing keys, bad values -> 4xx before Auth", async () => {
  let asked = 0;
  const { db, calls } = recordingDb();
  const api = createThreadsReservationApi({ enabled: true, db, permissions: allow, auth: { verify: () => { asked += 1; return Promise.resolve({ userId: USER }); } } });
  assert.equal((await api(req(cancelP, { method: "GET" }))).status, 405);
  assert.equal((await api({ method: "POST", authorization: `Bearer ${TOKEN}`, body: "x".repeat(70 * 1024) })).status, 413);
  for (const bad of [
    "not json", { action: "list", payload: {} }, { action: "cancel", payload: { reservationId: RID, extra: 1 } }, { action: "cancel", payload: {} },
    { action: "cancel", payload: { reservationId: "not-a-uuid" } }, { action: "cancel", payload: { reservationId: RID }, userId: USER },
    { action: "receipt", payload: { socialAccountId: "th a", clientRequestId: CRID } }, { action: "receipt", payload: { socialAccountId: "th_a" } },
    createP({ text: "" }), createP({ text: "x".repeat(4001) }), createP({ contentSha256: "A".repeat(64) }), createP({ scheduledAt: "tomorrow" }),
    createP({ clientRequestId: 7 }), { action: "create", payload: { ...createP().payload, brandId: "b" } },
  ]) {
    const body = typeof bad === "string" ? bad : JSON.stringify(bad);
    assert.deepEqual(await api({ method: "POST", authorization: `Bearer ${TOKEN}`, body }), { status: 400, body: { ok: false, code: "REQUEST_INVALID" } }, body);
  }
  assert.equal(asked, 0);
  assert.equal(calls.length, 0);
});

test("Auth: no / malformed bearer, rejected token, a token without the same subject's session or a JSON-false is_anonymous -> 401; a failing verifier -> 503", async () => {
  const { db, calls } = recordingDb();
  const api = createThreadsReservationApi({ enabled: true, db, permissions: allow, auth: verifier });
  assert.equal((await api(req(cancelP, { authorization: null }))).status, 401);
  assert.equal((await api(req(cancelP, { authorization: "Basic abc" }))).status, 401);
  const rejected = createThreadsReservationApi({ enabled: true, db, permissions: allow, auth: { verify: () => Promise.resolve(null) } });
  assert.deepEqual(await rejected(req(cancelP)), { status: 401, body: { ok: false, code: "AUTH_REQUIRED" } });
  for (const claims of [
    { sub: USER, session_id: SESSION, is_anonymous: true }, { sub: USER, session_id: SESSION }, { sub: USER, session_id: SESSION, is_anonymous: "false" },
    { sub: USER, session_id: SESSION, is_anonymous: null }, { sub: USER, is_anonymous: false }, { sub: USER, session_id: "nope", is_anonymous: false },
    { sub: OTHER, session_id: SESSION, is_anonymous: false },
  ]) {
    for (const p of [cancelP, receiptP, createP()]) {
      assert.deepEqual(await api(req(p, { authorization: `Bearer ${tokenFor(claims)}` })), { status: 401, body: { ok: false, code: "AUTH_REQUIRED" } }, JSON.stringify(claims));
    }
  }
  const down = createThreadsReservationApi({ enabled: true, db, permissions: allow, auth: { verify: () => Promise.reject(new Error("x")) } });
  assert.deepEqual(await down(req(cancelP)), { status: 503, body: { ok: false, code: "AUTH_UNAVAILABLE" } });
  assert.equal(calls.length, 0);
});

test("create: the production default permission port denies (403) before the database; a failing or non-literal-true source never allows", async () => {
  const { db, calls } = recordingDb({ ok: true, rows: [{ reservation_id: RID, status: "planned", created: true }] });
  const prod = createThreadsReservationApi({ enabled: true, db, auth: verifier });
  assert.deepEqual(await prod(req(createP())), { status: 403, body: { ok: false, code: "POSTONA_THREADS_RESV_SERVICE_NOT_ACTIVE" } });
  assert.equal(await THREADS_PERMISSIONS_NOT_CONNECTED.threadsPublishAllowed(USER, "th_a"), false, "the default port denies");
  const throwing = createThreadsReservationApi({ enabled: true, db, auth: verifier, permissions: { threadsPublishAllowed: () => Promise.reject(new Error("x")) } });
  assert.deepEqual(await throwing(req(createP())), { status: 503, body: { ok: false, code: "PERMISSION_UNAVAILABLE" } });
  const truthy = createThreadsReservationApi({ enabled: true, db, auth: verifier, permissions: { threadsPublishAllowed: () => Promise.resolve(1 as unknown as boolean) } });
  assert.equal((await truthy(req(createP()))).status, 403);
  assert.equal(calls.length, 0);
  let askedFor: string[] = [];
  const allowed = createThreadsReservationApi({ enabled: true, db, auth: verifier, permissions: { threadsPublishAllowed: (u, a) => { askedFor = [u, a]; return Promise.resolve(true); } } });
  assert.deepEqual(await allowed(req(createP())), { status: 200, body: { ok: true, reservation: { reservationId: RID, status: "planned", created: true } } });
  assert.deepEqual(askedFor, [USER, "th_a"]);
  assert.deepEqual(calls.map((c) => [c.fn, c.args, c.subject]), [["create_reservation", ["th_a", CRID, "本文", SHA, "2026-11-01T00:30:00.000Z"], { userId: USER, sessionId: SESSION, isAnonymous: false }]]);
});

test("cancel and receipt: no permission pre-gate (the SQL decides with the person session and row ownership); the verified subject is passed", async () => {
  let asked = 0;
  const deny: ThreadsPermissionSources = { threadsPublishAllowed: () => { asked += 1; return Promise.resolve(false); } };
  const c = recordingDb({ ok: true, rows: [{ state: "cancelled" }] });
  assert.deepEqual(await createThreadsReservationApi({ enabled: true, db: c.db, auth: verifier, permissions: deny })(req(cancelP)),
    { status: 200, body: { ok: true, reservation: { reservationId: RID, status: "cancelled" } } });
  assert.deepEqual(c.calls.map((x) => [x.fn, x.args, x.subject.userId, x.subject.sessionId]), [["cancel_reservation", [RID], USER, SESSION]]);
  const r = recordingDb({ ok: true, rows: [RECEIPT_ROW] });
  assert.deepEqual(await createThreadsReservationApi({ enabled: true, db: r.db, auth: verifier, permissions: deny })(req(receiptP)), {
    status: 200, body: { ok: true, receipt: { reservationId: RID, state: "pending", providerPostId: null, outcomeCode: null, afterFreeze: false, simulated: true } },
  });
  assert.deepEqual(r.calls.map((x) => [x.fn, x.args]), [["receipt", ["th_a", CRID]]]);
  assert.equal(asked, 0);
});

test("database answers: fixed codes map to fixed statuses; an unknown code is 500; a thrown call or a malformed answer is 503 (outcome unknown)", async () => {
  const cases: [string, number, string][] = [
    ["POSTONA_RESV_AUTH_REQUIRED", 401, "POSTONA_RESV_AUTH_REQUIRED"], ["POSTONA_THREADS_RESV_NOT_FOUND", 404, "POSTONA_THREADS_RESV_NOT_FOUND"],
    ["POSTONA_THREADS_RESV_NOT_CANCELLABLE", 409, "POSTONA_THREADS_RESV_NOT_CANCELLABLE"], ["POSTONA_THREADS_RESV_ACCOUNT_NOT_VERIFIED", 403, "POSTONA_THREADS_RESV_ACCOUNT_NOT_VERIFIED"],
    ["POSTONA_THREADS_RESV_IDEMPOTENCY_CONFLICT", 409, "POSTONA_THREADS_RESV_IDEMPOTENCY_CONFLICT"], ["POSTONA_THREADS_RESV_SCHEDULE_INVALID", 422, "POSTONA_THREADS_RESV_SCHEDULE_INVALID"],
    ["POSTONA_RESV_SERVICE_BUSY", 503, "POSTONA_RESV_SERVICE_BUSY"], ["DB_UNAVAILABLE", 503, "STORE_UNAVAILABLE"], ["DB_ERROR", 500, "INTERNAL"],
    ["DB_REQUEST_INVALID", 500, "INTERNAL"], ["SOMETHING_ELSE", 500, "INTERNAL"],
  ];
  for (const [code, status, out] of cases) {
    const api = createThreadsReservationApi({ enabled: true, db: recordingDb({ ok: false, code }).db, auth: verifier, permissions: allow });
    assert.deepEqual(await api(req(cancelP)), { status, body: { ok: false, code: out } }, code);
  }
  const thrown = createThreadsReservationApi({ enabled: true, db: recordingDb("throw").db, auth: verifier, permissions: allow });
  assert.deepEqual(await thrown(req(cancelP)), { status: 503, body: { ok: false, code: "STORE_UNAVAILABLE" } });
  for (const [p, rows] of [
    [cancelP, []], [cancelP, [{ state: "planned" }]], [cancelP, [{ state: "cancelled" }, { state: "cancelled" }]],
    [receiptP, [{ ...RECEIPT_ROW, state: "sending" }]], [receiptP, [{ ...RECEIPT_ROW, provider_post_id: "<script>" }]], [receiptP, [{ ...RECEIPT_ROW, simulated: "no" }]],
    [createP(), [{ reservation_id: RID, status: "claimed", created: true }]], [createP(), [{ reservation_id: "x", status: "planned", created: true }]],
  ] as [unknown, Record<string, unknown>[]][]) {
    const api = createThreadsReservationApi({ enabled: true, db: recordingDb({ ok: true, rows }).db, auth: verifier, permissions: allow });
    assert.deepEqual(await api(req(p)), { status: 503, body: { ok: false, code: "STORE_UNAVAILABLE" } }, JSON.stringify(rows));
  }
});

test("source: the Threads API has no Deno.env, no service-role key, no provider or table access, and a literal OFF gate", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./threads_api.ts", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, "");
  assert.doesNotMatch(code, /Deno\.env|SERVICE_ROLE|service_role|fetch\(|graph\.threads|threads\.net|\.from\(|claim_due|record\(/iu);
  assert.match(code, /export const POSTONA_THREADS_RESERVATION_API_ENABLED = false as const;/u);
  assert.deepEqual([...code.matchAll(/^import .* from "(.*)";$/gmu)].map((m) => m[1]), ["./api.ts"]);
});
