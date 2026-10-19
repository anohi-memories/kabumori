// Unit tests of the TEST FIXTURE HTTP contract (MOCK_ONLY, DENY-NET: no --allow-net; fetch is a throwing counter).
import assert from "node:assert/strict";
import test from "node:test";
import { createThreadsReservationHttpFixture, type StoreAnswer, type VerifiedCaller } from "../fixture/threads_reservation_http_fixture.ts";

let net = 0;
globalThis.fetch = (() => { net += 1; return Promise.reject(new Error("DENY_NET")); }) as typeof fetch;

const USER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const RID = "33333333-3333-4333-8333-333333333333";
const REQ = "55555555-5555-4555-8555-555555555555";
const TOKEN = "person-token-0123456789abcdef";
const SHA = "a".repeat(64);
const verify = (t: string) => Promise.resolve(t === TOKEN ? { userId: USER, sessionId: SESSION } : null);

function fakeStore(answers: Partial<Record<"create" | "cancel" | "receipt", () => Promise<StoreAnswer>>>) {
  const calls: { fn: string; args: readonly unknown[]; caller: VerifiedCaller }[] = [];
  return { calls, store: { call: (fn: "create" | "cancel" | "receipt", args: readonly unknown[], caller: VerifiedCaller) => {
    calls.push({ fn, args, caller }); const a = answers[fn]; return a ? a() : Promise.reject(new Error(`unexpected ${fn}`));
  } } };
}
const rows = (...r: Record<string, unknown>[]) => () => Promise.resolve({ ok: true as const, rows: r });
const refuse = (code: string) => () => Promise.resolve({ ok: false as const, code });
const createBody = (over: Record<string, unknown> = {}) => ({ op: "create", socialAccountId: "th_61", clientRequestId: REQ, text: "本文",
  scheduledAt: "2026-10-20T09:00:00+09:00", consent: { confirmed: true, contentSha256: SHA }, ...over });
async function call(h: (r: Request) => Promise<Response>, body: unknown, token: string | null = TOKEN) {
  const res = await h(new Request("http://fixture.local/threads-reservations", { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json(), raw: res };
}

test("gate, method, size, strict body: nothing reaches the store", async () => {
  const f = fakeStore({});
  assert.equal((await call(createThreadsReservationHttpFixture({ enabled: false, verify, store: f.store }), createBody())).status, 503);
  const h = createThreadsReservationHttpFixture({ enabled: true, verify, store: f.store });
  const get = await h(new Request("http://fixture.local/x", { method: "GET" }));
  assert.equal(get.status, 405);
  const big = await h(new Request("http://fixture.local/x", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "x".repeat(20000) }));
  assert.equal(big.status, 413);
  for (const bad of [createBody({ extra: 1 }), createBody({ consent: { confirmed: false, contentSha256: SHA } }), createBody({ clientRequestId: "x" }), createBody({ socialAccountId: "TH 61" }),
    createBody({ scheduledAt: "tomorrow" }), createBody({ scheduledAt: "2026-10-20T09:00:00" }), createBody({ text: "" }), { op: "update" }, { op: "cancel", reservationId: RID, x: 1 },
    { op: "receipt", socialAccountId: "th_61" }, [], "x"]) {
    assert.equal((await call(h, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(f.calls.length, 0);
});

test("authentication: no / unverified token -> 401 for every op (receipt too); verifier down -> 503; nothing reaches the store", async () => {
  const f = fakeStore({});
  const h = createThreadsReservationHttpFixture({ enabled: true, verify, store: f.store });
  for (const body of [createBody(), { op: "cancel", reservationId: RID }, { op: "receipt", socialAccountId: "th_61", clientRequestId: REQ }]) {
    assert.deepEqual([(await call(h, body, null)).status, (await call(h, body, "someone-elses-token-000000")).status], [401, 401]);
  }
  const down = createThreadsReservationHttpFixture({ enabled: true, verify: () => Promise.reject(new Error("auth down")), store: f.store });
  assert.equal((await call(down, createBody())).status, 503);
  const odd = createThreadsReservationHttpFixture({ enabled: true, verify: () => Promise.resolve({ userId: "not-a-uuid", sessionId: SESSION }), store: f.store });
  assert.equal((await call(odd, createBody())).status, 401);
  assert.equal(f.calls.length, 0);
});

test("create: the verified caller and exactly the request travel; refusals keep fixed codes; an unknown outcome is 503 OUTCOME_UNKNOWN", async () => {
  const ok = fakeStore({ create: rows({ reservation_id: RID, status: "planned", created: true }) });
  const h = createThreadsReservationHttpFixture({ enabled: true, verify, store: ok.store });
  assert.deepEqual((await call(h, createBody())).body, { ok: true, reservationId: RID, status: "planned", created: true });
  assert.deepEqual(ok.calls[0], { fn: "create", args: ["th_61", REQ, "本文", SHA, "2026-10-20T09:00:00+09:00"], caller: { userId: USER, sessionId: SESSION } });
  for (const [code, status, mapped] of [["POSTONA_RESV_AUTH_REQUIRED", 401, "AUTH_REQUIRED"], ["POSTONA_THREADS_RESV_ACCOUNT_NOT_FOUND", 404, "NOT_FOUND"],
    ["POSTONA_THREADS_RESV_ACCOUNT_NOT_VERIFIED", 403, "ACCOUNT_NOT_VERIFIED"], ["POSTONA_THREADS_RESV_PUBLISH_DISABLED", 403, "PUBLISH_DISABLED"],
    ["POSTONA_THREADS_RESV_SERVICE_NOT_ACTIVE", 403, "SERVICE_NOT_ACTIVE"], ["POSTONA_THREADS_RESV_IDEMPOTENCY_CONFLICT", 409, "IDEMPOTENCY_CONFLICT"],
    ["POSTONA_THREADS_RESV_TEXT_INVALID", 422, "TEXT_INVALID"], ["POSTONA_THREADS_RESV_CONSENT_REQUIRED", 422, "CONSENT_REQUIRED"],
    ["POSTONA_THREADS_RESV_SCHEDULE_INVALID", 422, "SCHEDULE_INVALID"], ["DB_ERROR", 503, "STORE_UNAVAILABLE"]] as const) {
    const r = await call(createThreadsReservationHttpFixture({ enabled: true, verify, store: fakeStore({ create: refuse(code) }).store }), createBody());
    assert.deepEqual([r.status, r.body], [status, { ok: false, code: mapped }], code);
  }
  const lost = await call(createThreadsReservationHttpFixture({ enabled: true, verify, store: fakeStore({ create: () => Promise.reject(new Error("COMMIT lost")) }).store }), createBody());
  assert.deepEqual([lost.status, lost.body], [503, { ok: false, code: "OUTCOME_UNKNOWN" }]);
  const malformed = await call(createThreadsReservationHttpFixture({ enabled: true, verify, store: fakeStore({ create: rows({ reservation_id: "x", status: "planned", created: true }) }).store }), createBody());
  assert.equal(malformed.status, 503);
});

test("receipt: text-free; one constant 404 for another person / another account / unknown id; simulated unless exactly false; never the text", async () => {
  const sent = await call(createThreadsReservationHttpFixture({ enabled: true, verify, store: fakeStore({ receipt: rows({ reservation_id: RID, state: "sent", provider_post_id: "18000000000000001", outcome_code: "PUBLISHED", after_freeze: true, simulated: false, body: "本文" }) }).store }),
    { op: "receipt", socialAccountId: "th_61", clientRequestId: REQ });
  assert.deepEqual(sent.body, { ok: true, reservationId: RID, state: "sent", xPostId: "18000000000000001", code: "PUBLISHED", simulated: false, afterFreeze: true });
  assert.ok(!JSON.stringify(sent.body).includes("本文"), "a stray body column is never passed on");
  const answers: string[] = [];
  for (const store of [fakeStore({ receipt: refuse("POSTONA_THREADS_RESV_NOT_FOUND") }).store, fakeStore({ receipt: rows() }).store]) {
    const r = await call(createThreadsReservationHttpFixture({ enabled: true, verify, store }), { op: "receipt", socialAccountId: "th_61", clientRequestId: REQ });
    answers.push(`${r.status} ${JSON.stringify(r.body)} ${r.raw.headers.get("content-type")}`);
  }
  assert.equal(new Set(answers).size, 1, "identical not-found answers");
  assert.ok(answers[0].startsWith("404 "));
  for (const mark of [undefined, null, "false", 0, true]) {
    const r = await call(createThreadsReservationHttpFixture({ enabled: true, verify, store: fakeStore({ receipt: rows({ reservation_id: RID, state: "pending", ...(mark === undefined ? {} : { simulated: mark }) }) }).store }),
      { op: "receipt", socialAccountId: "th_61", clientRequestId: REQ });
    assert.equal(r.body.simulated, true, String(mark));
  }
  const noId = await call(createThreadsReservationHttpFixture({ enabled: true, verify, store: fakeStore({ receipt: rows({ reservation_id: RID, state: "sent", simulated: false }) }).store }),
    { op: "receipt", socialAccountId: "th_61", clientRequestId: REQ });
  assert.equal(noId.body.state, "uncertain", "sent without an id is never sent");
  const down = await call(createThreadsReservationHttpFixture({ enabled: true, verify, store: fakeStore({ receipt: () => Promise.reject(new Error("down")) }).store }),
    { op: "receipt", socialAccountId: "th_61", clientRequestId: REQ });
  assert.deepEqual([down.status, down.body.code], [503, "RECEIPT_UNAVAILABLE"]);
});

test("cancel: cancelled / not cancellable / not found; the source has no network, env, console or token use", async () => {
  const ok = await call(createThreadsReservationHttpFixture({ enabled: true, verify, store: fakeStore({ cancel: rows({ answer: "cancelled" }) }).store }), { op: "cancel", reservationId: RID });
  assert.deepEqual(ok.body, { ok: true, status: "cancelled" });
  for (const [code, status] of [["POSTONA_THREADS_RESV_NOT_CANCELLABLE", 409], ["POSTONA_THREADS_RESV_NOT_FOUND", 404]] as const) {
    assert.equal((await call(createThreadsReservationHttpFixture({ enabled: true, verify, store: fakeStore({ cancel: refuse(code) }).store }), { op: "cancel", reservationId: RID })).status, status);
  }
  const source = await Deno.readTextFile(new URL("../fixture/threads_reservation_http_fixture.ts", import.meta.url));
  for (const banned of ["fetch(", "Deno.env", "console.", "Deno.serve", "service_role"]) assert.ok(!source.includes(banned), banned);
  assert.equal(net, 0);
});
