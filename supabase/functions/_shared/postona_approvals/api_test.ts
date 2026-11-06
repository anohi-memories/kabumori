import assert from "node:assert/strict";
import test from "node:test";
import { type ApprovalDb, type ApprovalDbFunction, createApprovalApi, POSTONA_APPROVAL_API_ENABLED } from "./api.ts";
import type { AuthVerifier } from "../postona_reservations/api.ts";

const USER = "00000000-0000-4000-8000-00000000000a";
const SESSION = "00000000-0000-4000-8000-0000000000c1";
const CID = "11111111-2222-4333-8444-555555555555";
const NID = "21111111-2222-4333-8444-555555555555";
const SHA = "a".repeat(64);
const b64url = (s: string) => btoa(s).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
const tokenFor = (claims: Record<string, unknown>) => `eyJhbGciOiJIUzI1NiJ9.${b64url(JSON.stringify(claims))}.signature-0123456789`;
const TOKEN = tokenFor({ sub: USER, session_id: SESSION, is_anonymous: false });
const verifier: AuthVerifier = { verify: (token) => Promise.resolve(token === TOKEN ? { userId: USER } : null) };
const req = (body: unknown, token = TOKEN) => ({ method: "POST", authorization: `Bearer ${token}`, body: JSON.stringify(body) });
const candidate = (over: Record<string, unknown> = {}) => ({
  candidate_id: CID, social_account_id: "x_a", body: "本文", content_sha256: SHA, scheduled_at: "2026-11-20T00:30:00+00:00", state: "pending_approval",
  revision: 1, reservation_id: null, decided_at: null, created_at: "2026-11-05T00:00:00+00:00", ...over,
});
const note = (over: Record<string, unknown> = {}) => ({
  notification_id: NID, kind: "approval_requested", candidate_id: CID, reservation_id: null, subject_revision: 1, state: "pending_approval",
  scheduled_at: "2026-11-20T00:30:00+00:00", created_at: "2026-11-05T00:00:00+00:00", read_at: null, user_id: USER, brand_id: "u_x", ...over,
});
function recordingDb(rows: Record<string, unknown>[] | (() => never) = [candidate()], code?: string) {
  const calls: { fn: ApprovalDbFunction; args: readonly unknown[]; subject: unknown }[] = [];
  const db: ApprovalDb = {
    call: (fn, args, subject) => {
      calls.push({ fn, args, subject });
      if (typeof rows === "function") return rows();
      return Promise.resolve(code ? { ok: false as const, code } : { ok: true as const, rows });
    },
  };
  return { db, calls };
}

test("gate OFF (the source constant): 503 before Auth or the database", async () => {
  assert.equal(POSTONA_APPROVAL_API_ENABLED, false);
  let touched = 0;
  const { db, calls } = recordingDb();
  const api = createApprovalApi({ enabled: POSTONA_APPROVAL_API_ENABLED, auth: { verify: () => { touched += 1; return Promise.resolve({ userId: USER }); } }, db });
  assert.deepEqual(await api(req({ action: "list", payload: { socialAccountId: "x_a" } })), { status: 503, body: { ok: false, code: "NOT_AVAILABLE" } });
  assert.equal(touched + calls.length, 0);
});

test("each action calls exactly one SQL 018 function as the verified subject, with typed arguments", async () => {
  const cases: [unknown, ApprovalDbFunction, unknown[]][] = [
    [{ action: "submit", payload: { socialAccountId: "x_a", clientRequestId: CID, body: "本文", scheduledAt: "2026-11-20T00:30:00Z" } }, "submit_approval", ["x_a", CID, "本文", "2026-11-20T00:30:00Z"]],
    [{ action: "revise", payload: { candidateId: CID, expectedRevision: 1, body: "新", scheduledAt: "2026-11-21T00:30:00Z" } }, "revise_approval", [CID, 1, "新", "2026-11-21T00:30:00Z"]],
    [{ action: "approve", payload: { candidateId: CID, expectedRevision: 2, contentSha256: SHA } }, "approve_candidate", [CID, 2, SHA]],
    [{ action: "reject", payload: { candidateId: CID, expectedRevision: 2 } }, "reject_candidate", [CID, 2]],
    [{ action: "list", payload: { socialAccountId: "x_a" } }, "list_approvals", ["x_a"]],
    [{ action: "get", payload: { candidateId: CID } }, "get_approval", [CID]],
  ];
  for (const [body, fn, args] of cases) {
    const { db, calls } = recordingDb();
    const res = await createApprovalApi({ enabled: true, auth: verifier, db })(req(body));
    assert.equal(res.status, 200, fn);
    assert.deepEqual(calls, [{ fn, args, subject: { userId: USER, sessionId: SESSION, isAnonymous: false } }]);
  }
  for (const [body, fn, args] of [[{ action: "notifications", payload: {} }, "list_notifications", [50]], [{ action: "notifications", payload: { limit: 7 } }, "list_notifications", [7]],
                                  [{ action: "markRead", payload: { notificationId: NID } }, "mark_notification_read", [NID]]] as const) {
    const { db, calls } = recordingDb([note()]);
    const res = await createApprovalApi({ enabled: true, auth: verifier, db })(req(body));
    assert.equal(res.status, 200, fn);
    assert.deepEqual(calls.map((c) => [c.fn, c.args]), [[fn, args]]);
  }
});

test("only the listed fields leave: candidate and notification DTOs; a malformed row is INTERNAL", async () => {
  const { db } = recordingDb([candidate({ state: "approved", revision: 3, reservation_id: NID, decided_at: "2026-11-05T01:00:00+00:00", user_id: USER, brand_id: "u_x", request_sha256: SHA })]);
  const res = await createApprovalApi({ enabled: true, auth: verifier, db })(req({ action: "get", payload: { candidateId: CID } }));
  assert.deepEqual(res.body, { ok: true, candidates: [{
    candidateId: CID, socialAccountId: "x_a", body: "本文", contentSha256: SHA, scheduledAt: "2026-11-20T00:30:00.000Z", state: "approved", revision: 3,
    reservationId: NID, decidedAt: "2026-11-05T01:00:00.000Z", createdAt: "2026-11-05T00:00:00.000Z",
  }] });
  const n = await createApprovalApi({ enabled: true, auth: verifier, db: recordingDb([note()]).db })(req({ action: "notifications", payload: {} }));
  assert.deepEqual(n.body, { ok: true, notifications: [{
    notificationId: NID, kind: "approval_requested", candidateId: CID, reservationId: null, subjectRevision: 1, state: "pending_approval",
    scheduledAt: "2026-11-20T00:30:00.000Z", createdAt: "2026-11-05T00:00:00.000Z", readAt: null,
  }] });
  for (const bad of [candidate({ state: "draft" }), candidate({ candidate_id: "x" })]) {
    assert.deepEqual((await createApprovalApi({ enabled: true, auth: verifier, db: recordingDb([bad]).db })(req({ action: "get", payload: { candidateId: CID } }))).body, { ok: false, code: "INTERNAL" });
  }
  assert.deepEqual((await createApprovalApi({ enabled: true, auth: verifier, db: recordingDb([note({ kind: "push_sent" })]).db })(req({ action: "notifications", payload: {} }))).body, { ok: false, code: "INTERNAL" });
});

test("strict shapes: unknown actions, extra keys, bad ids / revisions / hashes / limits never reach the database", async () => {
  const bad: unknown[] = [
    { action: "approveAll", payload: {} },
    { action: "list", payload: { socialAccountId: "x_a", userId: USER } },
    { action: "list", payload: { socialAccountId: "x_a" }, userId: USER },
    { action: "get", payload: { candidateId: "not-a-uuid" } },
    { action: "approve", payload: { candidateId: CID, expectedRevision: 0, contentSha256: SHA } },
    { action: "approve", payload: { candidateId: CID, expectedRevision: 1, contentSha256: "A".repeat(64) } },
    { action: "submit", payload: { socialAccountId: "x_a", clientRequestId: CID, body: "", scheduledAt: "2026-11-20T00:30:00Z" } },
    { action: "submit", payload: { socialAccountId: "x_a", clientRequestId: CID, body: "x", scheduledAt: "tomorrow" } },
    { action: "notifications", payload: { limit: 101 } },
    { action: "markRead", payload: { notificationId: NID, all: true } },
  ];
  for (const body of bad) {
    const { db, calls } = recordingDb();
    assert.deepEqual((await createApprovalApi({ enabled: true, auth: verifier, db })(req(body))).body, { ok: false, code: "REQUEST_INVALID" }, JSON.stringify(body));
    assert.equal(calls.length, 0);
  }
});

test("401 before the database: no token, an unverified token, an anonymous or session-less token", async () => {
  for (const token of ["", "not-a-real-token-at-all", tokenFor({ sub: USER, session_id: SESSION, is_anonymous: true }), tokenFor({ sub: USER, is_anonymous: false })]) {
    const { db, calls } = recordingDb();
    const auth: AuthVerifier = { verify: () => Promise.resolve({ userId: USER }) };
    const res = await createApprovalApi({ enabled: true, auth: token === "not-a-real-token-at-all" ? verifier : auth, db })(
      token ? req({ action: "notifications", payload: {} }, token) : { method: "POST", authorization: null, body: JSON.stringify({ action: "notifications", payload: {} }) });
    assert.equal(res.status, 401, token);
    assert.equal(calls.length, 0);
  }
  const down = await createApprovalApi({ enabled: true, auth: { verify: () => Promise.reject(new Error("x")) }, db: recordingDb().db })(req({ action: "notifications", payload: {} }));
  assert.deepEqual(down, { status: 503, body: { ok: false, code: "AUTH_UNAVAILABLE" } });
});

test("database codes map to fixed statuses; an unknown code or a thrown call never leaks detail", async () => {
  const expectations: [string, number][] = [
    ["POSTONA_RESV_NOT_FOUND", 404], ["POSTONA_RESV_AUTH_REQUIRED", 401], ["POSTONA_RESV_SERVICE_NOT_ACTIVE", 403], ["POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED", 403],
    ["POSTONA_RESV_STALE_REVISION", 409], ["POSTONA_RESV_APPROVAL_NOT_PENDING", 409], ["POSTONA_RESV_APPROVAL_GENERATION_CHANGED", 409],
    ["POSTONA_RESV_IDEMPOTENCY_CONFLICT", 409], ["POSTONA_RESV_CONSENT_REQUIRED", 422], ["POSTONA_RESV_SERVICE_BUSY", 503],
  ];
  for (const [code, status] of expectations) {
    const res = await createApprovalApi({ enabled: true, auth: verifier, db: recordingDb([], code).db })(req({ action: "get", payload: { candidateId: CID } }));
    assert.deepEqual(res, { status, body: { ok: false, code } });
  }
  assert.deepEqual((await createApprovalApi({ enabled: true, auth: verifier, db: recordingDb([], "DB_ERROR").db })(req({ action: "get", payload: { candidateId: CID } }))).body, { ok: false, code: "INTERNAL" });
  assert.deepEqual(await createApprovalApi({ enabled: true, auth: verifier, db: recordingDb(() => { throw new Error("secret detail"); }).db })(req({ action: "get", payload: { candidateId: CID } })),
    { status: 503, body: { ok: false, code: "STORE_UNAVAILABLE" } });
});

test("source: no Deno.env, no service-role key, no fetch, no provider or push service", async () => {
  for (const file of ["./api.ts", "./postgres_db.ts", "../../postona-x-approvals/http.ts"]) {
    const text = await Deno.readTextFile(new URL(file, import.meta.url));
    assert.ok(!/service_role|SERVICE_ROLE|api\.x\.com|api\.twitter|graph\.threads|exp\.host|fcm|apns/u.test(text), file);
    if (file !== "../../postona-x-approvals/http.ts") assert.ok(!/Deno\.env|fetch\(/u.test(text), file);
  }
});
