import assert from "node:assert/strict";
import test from "node:test";
import {
  type ApiRequest,
  type AuthVerifier,
  createReservationApi,
  type PermissionSources,
  POSTONA_RESERVATION_API_ENABLED,
  type ReservationDb,
  type ReservationRow,
} from "./api.ts";

const USER = "00000000-0000-4000-8000-00000000000a";
const OTHER = "00000000-0000-4000-8000-00000000000b";
const TOKEN = "token-of-user-a-0123456789";
const BATCH = "0f9d2a52-8c1b-4b6a-9d55-1a2b3c4d5e6f";
const RID = "11111111-2222-4333-8444-555555555555";
const SHA = "a".repeat(64);

const row = (over: Partial<ReservationRow> = {}): ReservationRow => ({
  reservation_id: RID, batch_id: BATCH, draft_id: `${BATCH}:0`, position: 0, origin: "user_authored", mode: "manual_exact",
  body: "本文", scheduled_at: "2026-10-20 00:30:00+00", fixed: true, status: "planned", revision: 1, consent_state: "confirmed", ...over,
});

// MOCK_ONLY: a verifier that knows one token, permissions that allow, and a recording database double.
const verifier: AuthVerifier = { verify: (token) => Promise.resolve(token === TOKEN ? { userId: USER } : null) };
const allow: PermissionSources = { xAutopostAllowed: () => Promise.resolve(true), xAccountVerified: () => Promise.resolve(true) };
function recordingDb(answer: Awaited<ReturnType<ReservationDb["call"]>> | (() => never) = { ok: true, rows: [row()] }) {
  const calls: { fn: string; args: readonly unknown[]; subject: string }[] = [];
  const db: ReservationDb = {
    call(fn, args, subject) {
      calls.push({ fn, args, subject });
      if (typeof answer === "function") return Promise.reject(new Error("socket closed"));
      return Promise.resolve(answer);
    },
  };
  return { db, calls };
}
const codeOf = (res: Awaited<ReturnType<ReturnType<typeof createReservationApi>>>) => (res.body.ok ? null : res.body.code);
const req = (payload: unknown, over: Partial<ApiRequest> = {}): ApiRequest => ({
  method: "POST", authorization: `Bearer ${TOKEN}`, body: JSON.stringify(payload), ...over,
});
const createPayload = (over: Record<string, unknown> = {}) => ({
  action: "create",
  payload: {
    socialAccountId: "x_a", clientBatchId: BATCH, revision: 1, mode: "manual_exact", band: null,
    items: [{ draft_id: `${BATCH}:0`, scheduled_at: "2026-10-20T00:30:00.000Z", body: "本文", consent: { confirmed: true, content_sha256: SHA } }],
    ...over,
  },
});

test("the release gate is a literal OFF and an OFF api touches nothing (no Auth, permission or database call)", async () => {
  assert.equal(POSTONA_RESERVATION_API_ENABLED, false);
  let touched = 0;
  const { db, calls } = recordingDb();
  const api = createReservationApi({
    enabled: POSTONA_RESERVATION_API_ENABLED,
    auth: { verify: () => { touched += 1; return Promise.resolve({ userId: USER }); } },
    permissions: { xAutopostAllowed: () => { touched += 1; return Promise.resolve(true); }, xAccountVerified: () => Promise.resolve(true) },
    db,
  });
  assert.deepEqual(await api(req(createPayload())), { status: 503, body: { ok: false, code: "NOT_AVAILABLE" } });
  assert.equal(touched, 0);
  assert.equal(calls.length, 0);
});

test("defaults are fail-closed: no verifier -> 503, no G5/G4 permission source -> 403, no database -> 503", async () => {
  assert.equal(codeOf(await createReservationApi({ enabled: true })(req(createPayload()))), "AUTH_UNAVAILABLE");
  const { db, calls } = recordingDb();
  const noPermissions = createReservationApi({ enabled: true, auth: verifier, db });
  const denied = await noPermissions(req(createPayload()));
  assert.deepEqual(denied, { status: 403, body: { ok: false, code: "POSTONA_RESV_SERVICE_NOT_ACTIVE" } });
  assert.equal(calls.length, 0, "a denied request never reaches the database");
  const noDb = await createReservationApi({ enabled: true, auth: verifier, permissions: allow })(req(createPayload()));
  assert.deepEqual(noDb, { status: 503, body: { ok: false, code: "STORE_UNAVAILABLE" } });
});

test("authentication: missing / malformed / unknown token -> 401, a failing verifier -> 503; nothing reaches the database", async () => {
  const { db, calls } = recordingDb();
  const api = createReservationApi({ enabled: true, auth: verifier, permissions: allow, db });
  for (const authorization of [null, "", "Basic abc", "Bearer short", `Bearer ${TOKEN} extra`, "Bearer wrong-token-0123456789"]) {
    const res = await api(req(createPayload(), { authorization }));
    assert.deepEqual(res, { status: 401, body: { ok: false, code: "AUTH_REQUIRED" } }, String(authorization));
  }
  const throwing = createReservationApi({ enabled: true, auth: { verify: () => Promise.reject(new Error("auth down")) }, permissions: allow, db });
  assert.equal((await throwing(req(createPayload()))).status, 503);
  const notUuid = createReservationApi({ enabled: true, auth: { verify: () => Promise.resolve({ userId: "admin" }) }, permissions: allow, db });
  assert.equal((await notUuid(req(createPayload()))).status, 401);
  assert.equal(calls.length, 0);
});

test("G5 and G4 decisions are separate and both required; a failing source is 503, never allow", async () => {
  const { db, calls } = recordingDb();
  const g5off = createReservationApi({ enabled: true, auth: verifier, permissions: { ...allow, xAutopostAllowed: () => Promise.resolve(false) }, db });
  assert.equal(codeOf(await g5off(req(createPayload()))), "POSTONA_RESV_SERVICE_NOT_ACTIVE");
  let askedFor: string[] = [];
  const g4off = createReservationApi({
    enabled: true, auth: verifier, db,
    permissions: { xAutopostAllowed: () => Promise.resolve(true), xAccountVerified: (user, account) => { askedFor = [user, account]; return Promise.resolve(false); } },
  });
  assert.equal(codeOf(await g4off(req(createPayload()))), "POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED");
  assert.deepEqual(askedFor, [USER, "x_a"], "G4 is asked for the verified subject and the requested account");
  const throwing = createReservationApi({ enabled: true, auth: verifier, db, permissions: { ...allow, xAutopostAllowed: () => Promise.reject(new Error("x")) } });
  assert.deepEqual(await throwing(req(createPayload())), { status: 503, body: { ok: false, code: "PERMISSION_UNAVAILABLE" } });
  const truthy = createReservationApi({ enabled: true, auth: verifier, db, permissions: { ...allow, xAutopostAllowed: () => Promise.resolve("yes" as unknown as boolean) } });
  assert.equal((await truthy(req(createPayload()))).status, 403, "only a literal true allows");
  const truthyG4 = createReservationApi({ enabled: true, auth: verifier, db, permissions: { ...allow, xAccountVerified: () => Promise.resolve(1 as unknown as boolean) } });
  assert.equal(codeOf(await truthyG4(req(createPayload()))), "POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED", "G4 also needs a literal true");
  assert.equal(calls.length, 0);
});

test("strict request shape: unknown action, extra keys, a client user id, bad ids, AI text, oversize -> refused before Auth", async () => {
  let verified = 0;
  const { db, calls } = recordingDb();
  const api = createReservationApi({ enabled: true, auth: { verify: (t) => { verified += 1; return verifier.verify(t); } }, permissions: allow, db });
  const bad = [
    "not json",
    JSON.stringify({ action: "drop", payload: {} }),
    JSON.stringify(createPayload({ userId: OTHER })),
    JSON.stringify(createPayload({ brandId: "brand_b" })),
    JSON.stringify(createPayload({ clientBatchId: "local-abc" })),
    JSON.stringify(createPayload({ socialAccountId: "x a; drop" })),
    JSON.stringify(createPayload({ revision: 0 })),
    JSON.stringify(createPayload({ mode: "manual_anything" })),
    JSON.stringify(createPayload({ items: [] })),
    JSON.stringify(createPayload({ items: [{ draft_id: "d", scheduled_at: "tomorrow", body: "x", consent: { confirmed: true, content_sha256: SHA } }] })),
    JSON.stringify(createPayload({ items: [{ draft_id: "d", scheduled_at: "2026-10-20T00:30:00Z", body: "x", consent: { confirmed: "yes", content_sha256: SHA } }] })),
    JSON.stringify(createPayload({ mode: "ai_flexible", band: {}, items: [{ draft_id: "d", scheduled_at: "2026-10-20T00:30:00Z", body: "AI text" }] })),
    JSON.stringify({ action: "get", payload: { reservationId: "1" } }),
    JSON.stringify({ action: "cancel", payload: { reservationId: RID, expectedRevision: 1, force: true } }),
    JSON.stringify({ action: "reconfirm", payload: { reservationId: RID, expectedRevision: 1, contentSha256: "abc" } }),
  ];
  for (const body of bad) assert.equal((await api({ method: "POST", authorization: `Bearer ${TOKEN}`, body })).status, 400, body.slice(0, 60));
  assert.equal((await api({ method: "GET", authorization: `Bearer ${TOKEN}`, body: "{}" })).status, 405);
  assert.equal((await api({ method: "POST", authorization: `Bearer ${TOKEN}`, body: "x".repeat(70 * 1024) })).status, 413);
  assert.equal(verified, 0, "nothing invalid reaches Auth");
  assert.equal(calls.length, 0);
});

test("each action calls exactly one owner function as the VERIFIED subject with typed arguments", async () => {
  const { db, calls } = recordingDb();
  const api = createReservationApi({ enabled: true, auth: verifier, permissions: allow, db });
  const cases: [unknown, string, unknown[]][] = [
    [createPayload(), "create_batch", ["x_a", BATCH, 1, "manual_exact", null, createPayload().payload.items]],
    [{ action: "list", payload: { socialAccountId: "x_a" } }, "list_reservations", ["x_a"]],
    [{ action: "get", payload: { reservationId: RID } }, "get_reservation", [RID]],
    [{ action: "reschedule", payload: { reservationId: RID, expectedRevision: 2, scheduledAt: "2026-10-21T01:00:00.000Z" } }, "reschedule", [RID, 2, "2026-10-21T01:00:00.000Z"]],
    [{ action: "reconfirm", payload: { reservationId: RID, expectedRevision: 3, contentSha256: SHA } }, "reconfirm", [RID, 3, SHA]],
    [{ action: "cancel", payload: { reservationId: RID, expectedRevision: 3 } }, "cancel", [RID, 3]],
  ];
  for (const [payload, fn, args] of cases) {
    const res = await api(req(payload));
    assert.equal(res.status, 200, fn);
    const last = calls[calls.length - 1];
    assert.equal(last.fn, fn);
    assert.deepEqual(last.args, args);
    assert.equal(last.subject, USER);
  }
  const ok = await api(req({ action: "get", payload: { reservationId: RID } }));
  assert.deepEqual(ok.body, {
    ok: true,
    reservations: [{
      reservationId: RID, batchId: BATCH, draftId: `${BATCH}:0`, position: 0, origin: "user_authored", mode: "manual_exact", body: "本文",
      scheduledAt: "2026-10-20T00:30:00.000Z", fixed: true, status: "planned", revision: 1, consentState: "confirmed",
    }],
  });
});

test("database codes map to fixed statuses; unknown codes and exceptions never leak detail", async () => {
  const expectations: [string, number, string][] = [
    ["POSTONA_RESV_ACCOUNT_NOT_FOUND", 404, "POSTONA_RESV_ACCOUNT_NOT_FOUND"],
    ["POSTONA_RESV_SERVICE_NOT_ACTIVE", 403, "POSTONA_RESV_SERVICE_NOT_ACTIVE"],
    ["POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED", 403, "POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED"],
    ["POSTONA_RESV_STALE_REVISION", 409, "POSTONA_RESV_STALE_REVISION"],
    ["POSTONA_RESV_CANCEL_TOO_LATE", 409, "POSTONA_RESV_CANCEL_TOO_LATE"],
    ["POSTONA_RESV_INTERVAL_MISMATCH", 422, "POSTONA_RESV_INTERVAL_MISMATCH"],
    ["DB_UNAVAILABLE", 503, "STORE_UNAVAILABLE"],
    ["permission denied for table reservations", 500, "INTERNAL"],
  ];
  for (const [code, status, shown] of expectations) {
    const api = createReservationApi({ enabled: true, auth: verifier, permissions: allow, db: recordingDb({ ok: false, code }).db });
    assert.deepEqual(await api(req(createPayload())), { status, body: { ok: false, code: shown } }, code);
  }
  const throwing = createReservationApi({ enabled: true, auth: verifier, permissions: allow, db: recordingDb(() => { throw new Error("x"); }).db });
  assert.deepEqual(await throwing(req(createPayload())), { status: 503, body: { ok: false, code: "STORE_UNAVAILABLE" } });
});

test("source: the API module has no imports, no Deno.env, no service-role key, no direct provider or table access", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./api.ts", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, "");
  assert.doesNotMatch(code, /^import /mu);
  assert.doesNotMatch(code, /Deno\.env|SERVICE_ROLE|service_role|fetch\(|api\.x\.com|twitter|openai|\.from\(|claim_due|finish\(/iu);
  assert.match(code, /export const POSTONA_RESERVATION_API_ENABLED = false as const;/u);
});
