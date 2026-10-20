// G3 TASK 13/50: the HTTP contract of the TEST FIXTURE entry (threads_reservation_http_fixture.ts) as one matrix, for G1's screens
// and the future G4 / G5 wiring. MOCK_ONLY + DENY-NET: the verified caller is a mock verdict (no JWT is forged or checked here), the
// store is a fake, and fetch is a throwing counter. Adds what http_fixture_test.ts (TASK 3) did not pin: byte-identical refusals,
// the full 007 code table, columns a store might over-return, every lost answer, and no retry inside the entry.
import assert from "node:assert/strict";
import { createThreadsReservationHttpFixture, type StoreAnswer, type VerifiedCaller } from "../fixture/threads_reservation_http_fixture.ts";

let net = 0;
globalThis.fetch = (() => { net += 1; return Promise.reject(new Error("DENY_NET")); }) as typeof fetch;

const USER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const RID = "33333333-3333-4333-8333-333333333333";
const REQ = "55555555-5555-4555-8555-555555555555";
const TOKEN = "person-token-0123456789abcdef";
const OTHER_TOKEN = "other-person-token-0123456789";
const SECRET_TEXT = "本文-SECRET-TEXT";
const FAKE_ACCESS_TOKEN = "fakeTHREADSaccess0123456789abcdef";
const verify = (t: string) => Promise.resolve(t === TOKEN ? { userId: USER, sessionId: SESSION } : null);

type Fn = "create" | "cancel" | "receipt";
function fakeStore(answers: Partial<Record<Fn, () => Promise<StoreAnswer>>>) {
  const calls: { fn: Fn; args: readonly unknown[]; caller: VerifiedCaller }[] = [];
  return { calls, store: { call: (fn: Fn, args: readonly unknown[], caller: VerifiedCaller) => {
    calls.push({ fn, args, caller });
    const a = answers[fn];
    return a ? a() : Promise.reject(new Error(`unexpected ${fn}`));
  } } };
}
const rows = (...r: Record<string, unknown>[]) => () => Promise.resolve({ ok: true as const, rows: r });
const refuse = (code: string) => () => Promise.resolve({ ok: false as const, code });
const lost = () => Promise.reject(new Error("connection reset after COMMIT"));
const createBody = (over: Record<string, unknown> = {}) => ({ op: "create", socialAccountId: "sa_0123456789abcdef01234567", clientRequestId: REQ,
  text: SECRET_TEXT, scheduledAt: "2026-10-21T09:00:00+09:00", consent: { confirmed: true, contentSha256: "a".repeat(64) }, ...over });
const receiptBody = (account = "sa_0123456789abcdef01234567", id = REQ) => ({ op: "receipt", socialAccountId: account, clientRequestId: id });
type Raw = { status: number; text: string; headers: Record<string, string> };
async function call(h: (r: Request) => Promise<Response>, body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }): Promise<Raw> {
  const res = await h(new Request("http://fixture.local/threads-reservations", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }));
  return { status: res.status, text: await res.text(), headers: { "content-type": res.headers.get("content-type") ?? "", "cache-control": res.headers.get("cache-control") ?? "" } };
}
const entry = (answers: Partial<Record<Fn, () => Promise<StoreAnswer>>>, v = verify) => {
  const f = fakeStore(answers);
  return { f, h: createThreadsReservationHttpFixture({ enabled: true, verify: v, store: f.store }) };
};

Deno.test("C1 every refusal 007 can raise on the person path has a fixed status; nothing person-reachable falls into 503 STORE_UNAVAILABLE", async () => {
  // the codes 007 raises (person path: create / cancel / receipt and the helpers they call), read from the candidate itself
  const source = await Deno.readTextFile(new URL("../007_postona_threads_reservations.sql", import.meta.url));
  const raised = [...new Set([...source.matchAll(/raise exception '(POSTONA_THREADS_RESV_[A-Z0-9_]+)'/gu)].map((m) => m[1]))]
    .filter((c) => !/PRECONDITION|ALREADY_APPLIED|LEASE_LOST/u.test(c)); // install-time and worker-only codes
  const expected: Record<string, [number, string]> = {
    POSTONA_RESV_AUTH_REQUIRED: [401, "AUTH_REQUIRED"],
    POSTONA_THREADS_RESV_ACCOUNT_NOT_FOUND: [404, "NOT_FOUND"], POSTONA_THREADS_RESV_NOT_FOUND: [404, "NOT_FOUND"],
    POSTONA_THREADS_RESV_ACCOUNT_NOT_VERIFIED: [403, "ACCOUNT_NOT_VERIFIED"], POSTONA_THREADS_RESV_PUBLISH_DISABLED: [403, "PUBLISH_DISABLED"],
    POSTONA_THREADS_RESV_SERVICE_NOT_ACTIVE: [403, "SERVICE_NOT_ACTIVE"],
    POSTONA_THREADS_RESV_IDEMPOTENCY_CONFLICT: [409, "IDEMPOTENCY_CONFLICT"], POSTONA_THREADS_RESV_NOT_CANCELLABLE: [409, "NOT_CANCELLABLE"],
    POSTONA_THREADS_RESV_REQUEST_INVALID: [422, "REQUEST_INVALID"], POSTONA_THREADS_RESV_TEXT_INVALID: [422, "TEXT_INVALID"],
    POSTONA_THREADS_RESV_CONSENT_REQUIRED: [422, "CONSENT_REQUIRED"], POSTONA_THREADS_RESV_SCHEDULE_INVALID: [422, "SCHEDULE_INVALID"],
  };
  for (const code of raised) assert.ok(code in expected, `007 raises ${code}: the table must name it`);
  for (const [code, [status, out]] of Object.entries(expected)) {
    for (const op of ["create", "cancel"] as const) {
      const { h } = entry({ [op]: refuse(code) });
      const r = await call(h, op === "create" ? createBody() : { op: "cancel", reservationId: RID });
      assert.deepEqual([r.status, JSON.parse(r.text)], [status, { ok: false, code: out }], `${op} ${code}`);
    }
  }
  // an unexpected code is not guessed into a definite answer
  const { h } = entry({ create: refuse("POSTONA_THREADS_RESV_SOMETHING_NEW") });
  assert.deepEqual([(await call(h, createBody())).status, JSON.parse((await call(h, createBody())).text).code], [503, "STORE_UNAVAILABLE"]);
});

Deno.test("C2 401 is byte-identical for no header, a malformed header, an unknown token and a malformed verdict; the store is never called", async () => {
  const malformedVerdict = () => Promise.resolve({ userId: "not-a-uuid", sessionId: SESSION });
  const variants: [string, Record<string, string>, ((t: string) => Promise<VerifiedCaller | null>) | undefined][] = [
    ["no header", {}, undefined],
    ["Basic", { authorization: "Basic dXNlcjpwYXNz" }, undefined],
    ["short bearer", { authorization: "Bearer abc" }, undefined],
    ["unknown token", { authorization: `Bearer ${OTHER_TOKEN}` }, undefined],
    ["malformed verdict", { authorization: `Bearer ${TOKEN}` }, malformedVerdict],
  ];
  const seen = new Set<string>();
  for (const [label, headers, v] of variants) {
    for (const body of [createBody(), { op: "cancel", reservationId: RID }, receiptBody()]) {
      const { f, h } = entry({}, v ?? verify);
      const r = await call(h, body, headers);
      assert.equal(r.status, 401, label);
      seen.add(JSON.stringify([r.text, r.headers]));
      assert.equal(f.calls.length, 0, label);
    }
  }
  assert.equal(seen.size, 1, "one byte-identical 401");
});

Deno.test("C3 the receipt 404 is byte-identical for another person's id, another account, an unknown id and NOT_FOUND; it carries no id, no account, no state", async () => {
  const answers: [string, () => Promise<StoreAnswer>][] = [
    ["zero rows (another person / another account / unknown id: 007 filters by the caller)", rows()],
    ["NOT_FOUND", refuse("POSTONA_THREADS_RESV_NOT_FOUND")],
    ["a row without a valid id", rows({ reservation_id: "x", state: "sent" })],
  ];
  const seen = new Set<string>();
  for (const [label, a] of answers) {
    for (const body of [receiptBody(), receiptBody("sa_ffffffffffffffffffffffff"), receiptBody(undefined, "66666666-6666-4666-8666-666666666666")]) {
      const { h } = entry({ receipt: a });
      const r = await call(h, body);
      assert.equal(r.status, 404, label);
      seen.add(JSON.stringify([r.text, r.headers]));
    }
  }
  assert.equal(seen.size, 1);
  assert.equal([...seen][0].includes("sa_"), false);
});

Deno.test("C4 columns a store might over-return never reach the caller: text, token, user, brand, lease, generation are dropped from create / receipt", async () => {
  const leak = { body: SECRET_TEXT, access_token: FAKE_ACCESS_TOKEN, user_id: USER, brand_id: "brand_x", lease_token: RID, bound_generation: "f".repeat(64),
    bound_owner_epoch: "7", bound_lifecycle_version: "9", claimed_by: "w1", content_sha256: "a".repeat(64) };
  const c = entry({ create: rows({ reservation_id: RID, status: "planned", created: true, ...leak }) });
  const created = await call(c.h, createBody());
  assert.deepEqual(JSON.parse(created.text), { ok: true, reservationId: RID, status: "planned", created: true });
  for (const state of ["pending", "sent", "failed", "uncertain", "cancelled"]) {
    const r = entry({ receipt: rows({ reservation_id: RID, state, provider_post_id: state === "sent" ? "18000000000000001" : null, outcome_code: "PUBLISHED",
      after_freeze: true, simulated: true, ...leak }) });
    const res = await call(r.h, receiptBody());
    const body = JSON.parse(res.text);
    assert.deepEqual(Object.keys(body).sort(), ["action", "afterFreeze", "code", "ok", "reservationId", "simulated", "state", ...(state === "sent" ? ["xPostId"] : [])].sort(), state);
    for (const secret of [SECRET_TEXT, FAKE_ACCESS_TOKEN, USER, "brand_x", "f".repeat(64), "w1"]) assert.equal(res.text.includes(secret), false, `${state}: ${secret}`);
  }
});

Deno.test("C5 every lost answer is 503 and the entry never retries: create / cancel OUTCOME_UNKNOWN, receipt RECEIPT_UNAVAILABLE; malformed successes too", async () => {
  const cases: [Fn, unknown, () => Promise<StoreAnswer>, string][] = [
    ["create", createBody(), lost, "OUTCOME_UNKNOWN"],
    ["cancel", { op: "cancel", reservationId: RID }, lost, "OUTCOME_UNKNOWN"],
    ["receipt", receiptBody(), lost, "RECEIPT_UNAVAILABLE"],
    ["create", createBody(), rows(), "OUTCOME_UNKNOWN"],
    ["create", createBody(), rows({ reservation_id: RID, status: "planned", created: "yes" }), "OUTCOME_UNKNOWN"],
    ["cancel", { op: "cancel", reservationId: RID }, rows({ answer: "maybe" }), "OUTCOME_UNKNOWN"],
    ["receipt", receiptBody(), refuse("POSTONA_THREADS_RESV_SOMETHING_NEW"), "RECEIPT_UNAVAILABLE"],
  ];
  for (const [fn, body, a, code] of cases) {
    const { f, h } = entry({ [fn]: a });
    const r = await call(h, body);
    assert.deepEqual([r.status, JSON.parse(r.text).code, f.calls.length], [503, code, 1], `${fn} ${code}`);
  }
});

Deno.test("C6 every answer (success and refusal, 4xx and 5xx) is JSON, no-store, and never echoes the request text", async () => {
  const hs: [string, (r: Request) => Promise<Response>, unknown, Record<string, string>?][] = [
    ["503 gate OFF", createThreadsReservationHttpFixture({ enabled: false, verify, store: fakeStore({}).store }), createBody()],
    ["400 invalid", entry({}).h, "{not json " + SECRET_TEXT],
    ["401", entry({}).h, createBody(), {}],
    ["403", entry({ create: refuse("POSTONA_THREADS_RESV_PUBLISH_DISABLED") }).h, createBody()],
    ["409", entry({ create: refuse("POSTONA_THREADS_RESV_IDEMPOTENCY_CONFLICT") }).h, createBody()],
    ["422", entry({ create: refuse("POSTONA_THREADS_RESV_TEXT_INVALID") }).h, createBody()],
    ["503 verifier down", createThreadsReservationHttpFixture({ enabled: true, verify: () => Promise.reject(new Error("down")), store: fakeStore({}).store }), createBody()],
    ["200", entry({ create: rows({ reservation_id: RID, status: "planned", created: true }) }).h, createBody()],
  ];
  for (const [label, h, body, headers] of hs) {
    const r = await call(h, body, headers ?? { authorization: `Bearer ${TOKEN}` });
    assert.equal(r.headers["content-type"], "application/json; charset=utf-8", label);
    assert.equal(r.headers["cache-control"], "no-store", label);
    assert.equal(r.text.includes(SECRET_TEXT), false, label);
    assert.doesNotThrow(() => JSON.parse(r.text), label);
  }
  assert.equal(net, 0, "deny-net: no fetch at all");
});

Deno.test("C7 receipt actions: only a stop by G5's service generation asks to reconfirm; uncertain / failed for anything else / cancelled / sent -> none", async () => {
  const cases: [string, string | null, string][] = [
    ["failed", "SERVICE_GENERATION_CHANGED", "reconfirm_and_create_new"], ["failed", "OWNER_EPOCH_CHANGED", "reconfirm_and_create_new"],
    ["failed", "EXPECTED_OWNER_EPOCH_REQUIRED", "reconfirm_and_create_new"], ["failed", "EXPECTED_LIFECYCLE_VERSION_REQUIRED", "reconfirm_and_create_new"],
    ["failed", "SERVICE_GENERATION_UNAVAILABLE", "none"], ["failed", "NOT_PUBLISHABLE_AT_SEND", "none"], ["failed", "THREADS_CREDENTIALS_UNAVAILABLE", "none"],
    ["uncertain", "SERVICE_GENERATION_CHANGED", "none"], ["uncertain", "LEASE_EXPIRED", "none"], ["cancelled", null, "none"], ["pending", null, "none"],
  ];
  for (const [state, code, action] of cases) {
    const { h } = entry({ receipt: rows({ reservation_id: RID, state, provider_post_id: null, outcome_code: code, after_freeze: false, simulated: true }) });
    assert.equal(JSON.parse((await call(h, receiptBody())).text).action, action, `${state} ${code}`);
  }
});
