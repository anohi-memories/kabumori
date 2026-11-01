// F3 independent contract tests (2026-10-19, source-only, MOCK_ONLY, DENY-NET: run without --allow-net; global fetch is
// replaced by a counter that throws). They pin what the app (F1 / G1 PR #283 + #288), G4 (PR #282 credentialFor) and F5
// (pre-send authorization) may rely on from F3's single post (PR #272 + #278). Nothing here touches a database, Auth, X,
// Vault or the network; the real SQL path is proven by candidates/postona_x_reservations/single_post_live_fence_run.sh.
import assert from "node:assert/strict";
import test from "node:test";
import { createSinglePostHandler } from "./single_post.ts";
import { singlePostResultOf } from "./single_post_contract.ts";
import type { SinglePostDb, SinglePostFunction } from "./single_post_db.ts";
import type { PublishResult } from "./worker.ts";
import { generationSourceOf, X_GENERATION_CREDENTIALS_NOT_CONNECTED } from "./x_credential_generation.ts";
import type { XPostingCredentialSource } from "./x_publisher.ts";

// ---- deny-net ------------------------------------------------------------------------------------------------
let netCalls = 0;
globalThis.fetch = (() => { netCalls += 1; return Promise.reject(new Error("DENY_NET")); }) as typeof fetch;

// ---- fixtures ------------------------------------------------------------------------------------------------
const USER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const RID = "33333333-3333-4333-8333-333333333333";
const LEASE = "44444444-4444-4444-8444-444444444444";
const REQ = "55555555-5555-4555-8555-555555555555";
const GEN = "a1".repeat(32);
const X_TOKEN = "fake-x-token-sa_x-0001";
const b64 = (v: unknown) => btoa(JSON.stringify(v)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
const TOKEN = `${b64({ alg: "HS256" })}.${b64({ sub: USER, session_id: SESSION, is_anonymous: false })}.sig`;
const auth = { verify: (t: string) => Promise.resolve(t === TOKEN ? { userId: USER } : null) };
const sha = "b".repeat(64);
const body = (text = "本文", id = REQ) => JSON.stringify({ socialAccountId: "sa_x", clientRequestId: id, text, consent: { confirmed: true, contentSha256: sha } });

type Answer = { ok: true; rows: Record<string, unknown>[] } | { ok: false; code: string };
type Script = Partial<Record<SinglePostFunction, () => Promise<Answer>>>;
const rows = (...r: Record<string, unknown>[]) => () => Promise.resolve({ ok: true as const, rows: r });
function fakeDb(script: Script) {
  const calls: { fn: SinglePostFunction; args: readonly unknown[] }[] = [];
  const db: SinglePostDb = { call: (fn, args) => { calls.push({ fn, args }); const a = script[fn]; return a ? a() : Promise.reject(new Error(`unexpected ${fn}`)); } };
  return { db, calls };
}
const claimed = rows({ reservation_id: RID, lease_token: LEASE, state: "claimed" });
const okPreflight = rows({ verdict: "OK", credential_generation: GEN });
const stored = (s: Record<string, unknown>) => rows({ reservation_id: RID, after_freeze: false, simulated: false, ...s });

/** MOCK_ONLY G4 port in PR #282's shape: credentialFor (atomic) AND accessTokenFor (the worker's), both counted. */
function g4Port(answer: { token: string; generation: string } | null | (() => Promise<{ token: string; generation: string } | null>) = { token: X_TOKEN, generation: GEN }) {
  const counts = { credentialFor: 0, accessTokenFor: 0 };
  const port = {
    available: true,
    credentialFor: (_a: string) => { counts.credentialFor += 1; return typeof answer === "function" ? answer() : Promise.resolve(answer); },
    accessTokenFor: (_a: string) => { counts.accessTokenFor += 1; return Promise.resolve(X_TOKEN); },
  };
  return { port, counts };
}
function fakeX(result: PublishResult = { kind: "published", providerPostId: "1790000000000000001" }) {
  const sent: string[] = [];
  return { sent, publisherFor: (source: XPostingCredentialSource) => ({ available: true, publish: async (account: string, text: string) => { sent.push(`${await source.accessTokenFor(account)}|${text}`); return result; } }) };
}
function handler(db: SinglePostDb, opts: { port?: unknown; x?: ReturnType<typeof fakeX>; transport?: "x" | "simulated"; readDb?: SinglePostDb } = {}) {
  const x = opts.x ?? fakeX();
  return createSinglePostHandler({
    enabled: true, auth, db, readDb: opts.readDb, credentials: generationSourceOf(opts.port ?? g4Port().port), publisherFor: x.publisherFor, transport: opts.transport ?? "x",
  });
}
const call = (h: ReturnType<typeof handler>, text?: string, id?: string) => h({ method: "POST", authorization: `Bearer ${TOKEN}`, body: body(text, id) });

// ---- 1. the answer contract shared with the app --------------------------------------------------------------
test("C1 every F3 answer vector parses to exactly the expected result (the table F1 / G1 runs against its copy)", async () => {
  const vectors = JSON.parse(await Deno.readTextFile(new URL("./contract_vectors/single_post_result_vectors.json", import.meta.url))) as {
    cases: { name: string; status: number; body: unknown; expect: unknown }[];
  };
  assert.ok(vectors.cases.length >= 30);
  for (const c of vectors.cases) assert.deepEqual(singlePostResultOf(c.status, c.body), c.expect, c.name);
  const kinds = new Set(vectors.cases.map((c) => (c.expect as { kind: string }).kind));
  assert.deepEqual([...kinds].sort(), ["failed", "pending", "refused", "sent", "unavailable", "uncertain"], "all six kinds are covered");
});

test("C2 every answer the handler can produce is one of the six kinds; 200 answers always carry a boolean simulated mark", async () => {
  const scripts: [string, Script, ReturnType<typeof fakeX>?][] = [
    ["sent", { begin: claimed, preflight: okPreflight, record: rows({ answer: "published" }), readback: stored({ state: "sent", provider_post_id: "1790000000000000001" }) }],
    ["in progress", { begin: rows({ reservation_id: RID, state: "in_progress" }) }],
    ["released", { begin: claimed, preflight: rows({ verdict: "RELEASED", credential_generation: null }), readback: stored({ state: "pending" }) }],
    ["refused", { begin: () => Promise.resolve({ ok: false, code: "POSTONA_RESV_PUBLISH_DISABLED" }) }],
    ["busy", { begin: () => Promise.resolve({ ok: false, code: "POSTONA_RESV_SERVICE_BUSY" }) }],
    ["store down", { begin: () => Promise.reject(new Error("reset")) }],
    ["unknown X", { begin: claimed, preflight: okPreflight, record: rows({ answer: "uncertain" }), readback: stored({ state: "uncertain", outcome_code: "X_TIMEOUT" }) }, fakeX({ kind: "unknown", code: "X_TIMEOUT" })],
  ];
  for (const [name, script, x] of scripts) {
    const answer = await call(handler(fakeDb(script).db, { x }));
    const parsed = singlePostResultOf(answer.status, answer.body);
    assert.ok(["sent", "pending", "failed", "uncertain", "refused", "unavailable"].includes(parsed.kind), name);
    if (answer.status === 200) assert.equal(typeof (answer.body as { simulated?: unknown }).simulated, "boolean", name);
  }
});

// ---- 2. simulated is never a real X post ---------------------------------------------------------------------
test("S1 with a simulated transport no path answers simulated:false -- even when the store claims a real post", async () => {
  const cases: Script[] = [
    { begin: claimed, preflight: okPreflight, record: rows({ answer: "published" }), readback: stored({ state: "sent", provider_post_id: "1790000000000000001", simulated: false }) },
    { begin: rows({ reservation_id: RID, state: "sent" }), readback: stored({ state: "sent", provider_post_id: "1790000000000000001", simulated: false }) },
    { begin: rows({ reservation_id: RID, state: "in_progress" }) },
    { begin: claimed, preflight: okPreflight, record: () => Promise.reject(new Error("lost")) },
  ];
  for (const script of cases) {
    const f = fakeDb(script);
    const answer = await call(handler(f.db, { transport: "simulated" }));
    assert.equal((answer.body as { simulated?: boolean }).simulated, true, JSON.stringify(answer.body));
    const recorded = f.calls.find((c) => c.fn === "record");
    if (recorded) assert.equal(recorded.args[5], "simulated", "recorded as simulated");
  }
});

test("S2 a real transport answers simulated:false only when the store says so; a missing / odd stored mark stays simulated", async () => {
  for (const [mark, expected] of [[false, false], [true, true], [undefined, true], [null, true], ["false", true], [0, true]] as const) {
    const answer = await call(handler(fakeDb({ begin: claimed, preflight: okPreflight, record: rows({ answer: "published" }),
      readback: rows({ reservation_id: RID, state: "sent", provider_post_id: "1790000000000000001", after_freeze: false, ...(mark === undefined ? {} : { simulated: mark }) }) }).db));
    assert.equal((answer.body as { simulated: boolean }).simulated, expected, String(mark));
  }
});

// ---- 3. uncertain is never resent; a restart never sends twice -----------------------------------------------
test("U1 a stored uncertain / sent / failed attempt repeated by a NEW process (restart) is read back, never sent; no token is read", async () => {
  for (const state of ["uncertain", "sent", "failed"]) {
    const g4 = g4Port();
    const x = fakeX();
    const f = fakeDb({ begin: rows({ reservation_id: RID, state }), readback: stored({ state, provider_post_id: state === "sent" ? "1790000000000000001" : null, outcome_code: state === "uncertain" ? "X_TIMEOUT" : null }) });
    const answer = await call(handler(f.db, { port: g4.port, x })); // a fresh handler = the app after a restart
    assert.equal((answer.body as { status: string }).status, state);
    assert.deepEqual(x.sent, [], `${state}: never sent`);
    assert.deepEqual(g4.counts, { credentialFor: 0, accessTokenFor: 0 }, `${state}: no token read`);
    assert.deepEqual(f.calls.map((c) => c.fn), ["begin", "readback"]);
  }
});

test("U2 the same id with ANOTHER text is a conflict (409, nothing written or sent); a live attempt is pending IN_PROGRESS", async () => {
  const x = fakeX();
  const conflict = await call(handler(fakeDb({ begin: () => Promise.resolve({ ok: false, code: "POSTONA_RESV_IDEMPOTENCY_CONFLICT" }) }).db, { x }), "別の本文");
  assert.deepEqual(singlePostResultOf(conflict.status, conflict.body), { kind: "refused", code: "POSTONA_RESV_IDEMPOTENCY_CONFLICT", retryable: false });
  const live = await call(handler(fakeDb({ begin: rows({ reservation_id: RID, state: "in_progress" }) }).db, { x }));
  assert.deepEqual(singlePostResultOf(live.status, live.body), { kind: "pending", reservationId: RID, code: "IN_PROGRESS", simulated: false, afterFreeze: false });
  assert.deepEqual(x.sent, []);
});

test("U3 unknown after the X call (timeout, thrown, unrecorded, unreadable) is uncertain and the handler sends exactly once", async () => {
  const variants: [string, ReturnType<typeof fakeX>, Script][] = [
    ["timeout", fakeX({ kind: "unknown", code: "X_TIMEOUT" }), { record: rows({ answer: "uncertain" }), readback: stored({ state: "uncertain", outcome_code: "X_TIMEOUT" }) }],
    ["unrecorded", fakeX(), { record: () => Promise.reject(new Error("COMMIT lost")) }],
    ["unreadable", fakeX(), { record: rows({ answer: "published" }), readback: () => Promise.reject(new Error("down")) }],
  ];
  for (const [name, x, tail] of variants) {
    const answer = await call(handler(fakeDb({ begin: claimed, preflight: okPreflight, ...tail }).db, { x }));
    assert.equal((answer.body as { status: string }).status, "uncertain", name);
    assert.equal(x.sent.length, 1, `${name}: one X call`);
  }
});

// ---- 4. G4 PR #282 atomic credential --------------------------------------------------------------------------
test("G1 the single post uses ONLY credentialFor (one atomic call), never accessTokenFor, and sends the token it got", async () => {
  const g4 = g4Port();
  const x = fakeX();
  const f = fakeDb({ begin: claimed, preflight: okPreflight, record: rows({ answer: "published" }), readback: stored({ state: "sent", provider_post_id: "1790000000000000001" }) });
  await call(handler(f.db, { port: g4.port, x }));
  assert.deepEqual(g4.counts, { credentialFor: 1, accessTokenFor: 0 });
  assert.deepEqual(x.sent, [`${X_TOKEN}|本文`]);
});

test("G2 a generation that is not 64 lowercase hex (the retired 32-hex one, uppercase, other) or differs from the preflight's never sends", async () => {
  for (const generation of ["a1".repeat(16), GEN.toUpperCase(), `${GEN}0`, "", "z".repeat(64), "b2".repeat(32)]) {
    const x = fakeX();
    const recordArgs: unknown[][] = [];
    const f = fakeDb({ begin: claimed, preflight: okPreflight, record: rows({ answer: "failed_before_send" }),
      readback: stored({ state: "failed", outcome_code: "CREDENTIAL_GENERATION_CHANGED" }) });
    const original = f.db.call.bind(f.db);
    f.db.call = (fn, args, s) => { if (fn === "record") recordArgs.push([...args]); return original(fn, args, s); };
    await call(handler(f.db, { port: g4Port({ token: X_TOKEN, generation }).port, x }));
    assert.deepEqual(x.sent, [], generation);
    assert.deepEqual([recordArgs[0]?.[2], recordArgs[0]?.[4]], ["failed_before_send", "CREDENTIAL_GENERATION_CHANGED"], generation);
  }
  // Even when both sides agree on a malformed generation (a retired 32-hex or uppercase one), it is never accepted.
  for (const generation of ["a1".repeat(16), GEN.toUpperCase()]) {
    const x = fakeX();
    const f = fakeDb({ begin: claimed, preflight: rows({ verdict: "OK", credential_generation: generation }), record: rows({ answer: "failed_before_send" }),
      readback: stored({ state: "failed", outcome_code: "CREDENTIAL_GENERATION_CHANGED" }) });
    await call(handler(f.db, { port: g4Port({ token: X_TOKEN, generation }).port, x }));
    assert.deepEqual(x.sent, [], `agreed ${generation}`);
  }
});

test("G3 separate getters are refused: a token-only port, or a token getter plus a separate generation getter, is not connected (503, nothing written)", async () => {
  const tokenOnly = { available: true, accessTokenFor: () => Promise.resolve(X_TOKEN) };
  const separate = { available: true, accessTokenFor: () => Promise.resolve(X_TOKEN), generationFor: () => Promise.resolve(GEN) };
  for (const port of [tokenOnly, separate, { available: false, credentialFor: () => Promise.resolve({ token: X_TOKEN, generation: GEN }) }, X_GENERATION_CREDENTIALS_NOT_CONNECTED]) {
    const f = fakeDb({});
    const answer = await call(handler(f.db, { port }));
    assert.deepEqual(answer, { status: 503, body: { ok: false, code: "X_NOT_AVAILABLE" } });
    assert.equal(f.calls.length, 0);
  }
});

test("G4 PR #282's fixed failure (XCredentialSourceUnavailable thrown) and its null (unverified / outside its id pattern) never send", async () => {
  class XCredentialSourceUnavailable extends Error {}
  for (const answer of [() => Promise.reject(new XCredentialSourceUnavailable("X_CREDENTIAL_SOURCE_UNAVAILABLE")), null]) {
    const x = fakeX();
    const recordArgs: unknown[][] = [];
    const f = fakeDb({ begin: claimed, preflight: okPreflight, record: rows({ answer: "failed_before_send" }), readback: stored({ state: "failed", outcome_code: "X_CREDENTIALS_UNAVAILABLE" }) });
    const original = f.db.call.bind(f.db);
    f.db.call = (fn, args, s) => { if (fn === "record") recordArgs.push([...args]); return original(fn, args, s); };
    const out = await call(handler(f.db, { port: g4Port(answer).port, x }));
    assert.deepEqual(x.sent, []);
    assert.equal(recordArgs[0]?.[4], "X_CREDENTIALS_UNAVAILABLE");
    assert.ok(!JSON.stringify(out).includes("X_CREDENTIAL_SOURCE_UNAVAILABLE"), "the source's error text is not passed on");
  }
});

// ---- 5. F5 pre-send authorization and the credential generation ---------------------------------------------
test("F1 begin refusals (T13 / F5 brand state / owner / switch / G4 / degraded) map to fixed statuses and app kinds; nothing is sent", async () => {
  const table: [string, number, string][] = [
    ["POSTONA_RESV_AUTH_REQUIRED", 401, "refused"], ["POSTONA_RESV_SERVICE_NOT_ACTIVE", 403, "refused"], ["POSTONA_RESV_ACCOUNT_NOT_FOUND", 404, "refused"],
    ["POSTONA_RESV_PUBLISH_DISABLED", 403, "refused"], ["POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED", 403, "refused"], ["POSTONA_RESV_CREDENTIAL_DEGRADED", 403, "refused"],
    ["POSTONA_RESV_PUBLISH_AUTHORITY_REVOKED", 403, "refused"], ["POSTONA_RESV_BRAND_NOT_ELIGIBLE", 403, "refused"], ["POSTONA_RESV_SERVICE_BUSY", 503, "unavailable"],
    ["POSTONA_RESV_SOMETHING_NEW", 500, "unavailable"],
  ];
  for (const [code, status, kind] of table) {
    const g4 = g4Port();
    const x = fakeX();
    const answer = await call(handler(fakeDb({ begin: () => Promise.resolve({ ok: false, code }) }).db, { port: g4.port, x }));
    assert.equal(answer.status, status, code);
    assert.equal(singlePostResultOf(answer.status, answer.body).kind, kind, code);
    assert.deepEqual([x.sent.length, g4.counts.credentialFor], [0, 0], code);
  }
});

test("F2 refused right before the send (preflight): NOT_PUBLISHABLE (F5 state / owner / switch changed) and CREDENTIAL_CHANGED are failed, RELEASED pending -- never sent", async () => {
  for (const [verdict, storedRow, kind] of [
    ["NOT_PUBLISHABLE", { state: "failed", outcome_code: "NOT_PUBLISHABLE_AT_SEND" }, "failed"],
    ["NOT_PUBLISHABLE", { state: "failed", outcome_code: "CREDENTIAL_CHANGED" }, "failed"],
    ["RELEASED", { state: "pending" }, "pending"],
    ["LEASE_LOST", { state: "uncertain", outcome_code: "LEASE_EXPIRED" }, "uncertain"],
  ] as const) {
    const x = fakeX();
    const f = fakeDb({ begin: claimed, preflight: rows({ verdict, credential_generation: null }), readback: stored(storedRow) });
    const answer = await call(handler(f.db, { x }));
    assert.equal(singlePostResultOf(answer.status, answer.body).kind, kind, `${verdict} ${storedRow.state}`);
    assert.deepEqual(x.sent, []);
    assert.ok(!f.calls.some((c) => c.fn === "record"), "the handler records nothing when the preflight refused");
  }
});

test("F3 the generation changes between the token read and the preflight: the preflight's newer generation wins, nothing is sent", async () => {
  const x = fakeX();
  const recordArgs: unknown[][] = [];
  const f = fakeDb({ begin: claimed, preflight: rows({ verdict: "OK", credential_generation: "c3".repeat(32) }), record: rows({ answer: "failed_before_send" }),
    readback: stored({ state: "failed", outcome_code: "CREDENTIAL_GENERATION_CHANGED" }) });
  const original = f.db.call.bind(f.db);
  f.db.call = (fn, args, s) => { if (fn === "record") recordArgs.push([...args]); return original(fn, args, s); };
  const answer = await call(handler(f.db, { port: g4Port({ token: X_TOKEN, generation: GEN }).port, x }));
  assert.deepEqual(singlePostResultOf(answer.status, answer.body), { kind: "failed", reservationId: RID, code: "CREDENTIAL_GENERATION_CHANGED", simulated: false, afterFreeze: false });
  assert.deepEqual(x.sent, []);
  assert.equal(recordArgs[0]?.[4], "CREDENTIAL_GENERATION_CHANGED");
});

test("N1 deny-net held: no test above reached the network", () => {
  assert.equal(netCalls, 0);
});
