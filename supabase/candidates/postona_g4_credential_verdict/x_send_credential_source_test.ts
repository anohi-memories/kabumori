// G4-02 #19, #20: the G4 X send credential source and its PostgREST read, without a database (the database half is proven by
// supabase/tests/postona_g4_x_send_credential_run.sh). node's assert, as the other G4 candidate tests (no inline jsr: import).
import assert from "node:assert/strict";
import { createG4XSendCredentialSource, createXSendCredentialRpcRead, X_SEND_CREDENTIAL_UNAVAILABLE } from "./x_send_credential_source.ts";

const ACCOUNT = "sa_0123456789abcdef01234567";
const TOKEN = "g4-test-only-x-access-token-0001";
const GEN = "g4x1:42";
const verified = [{ code: "VERIFIED", credential_generation: GEN, access_token: TOKEN, refresh_generation: 3 }];
const RESV = "0b0b0b0b-0000-4000-8000-000000000001";
const LEASE = "0c0c0c0c-0000-4000-8000-000000000002";
const SESSION = "0d0d0d0d-0000-4000-9000-000000000003";
const ATTEMPT = { reservationId: RESV, leaseToken: LEASE, sessionId: SESSION };
const sourceOf = (answer: unknown, seen: string[] = []) =>
  createG4XSendCredentialSource({
    read: (a, t) => (seen.push(`${a}|${t.reservationId}|${t.leaseToken}|${t.sessionId}`), answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)),
  });

Deno.test("a VERIFIED row -> { token, g4Generation } for exactly the asked account and attempt; one read per call, nothing cached", async () => {
  const seen: string[] = [];
  const source = sourceOf(verified, seen);
  assert.equal(source.available, true);
  assert.deepEqual(await source.credentialFor(ACCOUNT, ATTEMPT), { token: TOKEN, g4Generation: GEN });
  assert.deepEqual(await source.credentialFor(ACCOUNT, { reservationId: RESV, leaseToken: LEASE }), { token: TOKEN, g4Generation: GEN });
  assert.deepEqual(seen, [`${ACCOUNT}|${RESV}|${LEASE}|${SESSION}`, `${ACCOUNT}|${RESV}|${LEASE}|null`], "the worker's attempt has no session");
  assert.ok(Object.isFrozen(source));
});

Deno.test("H1 #50 P2-1: no send attempt -> null and no read (G3's one-argument port, a partial or malformed attempt)", async () => {
  const seen: string[] = [];
  const source = sourceOf(verified, seen);
  const bad: unknown[] = [
    undefined, null, {}, "attempt", { reservationId: RESV }, { leaseToken: LEASE }, { reservationId: RESV, leaseToken: "" },
    { reservationId: "not-a-uuid", leaseToken: LEASE }, { reservationId: RESV, leaseToken: LEASE.toUpperCase() },
    { reservationId: RESV, leaseToken: LEASE, sessionId: "x" }, { reservationId: RESV, leaseToken: LEASE, sessionId: 42 },
  ];
  for (const attempt of bad) assert.equal(await source.credentialFor(ACCOUNT, attempt as never), null, JSON.stringify(attempt) ?? "undefined");
  assert.equal(await (source.credentialFor as (a: string) => Promise<unknown>)(ACCOUNT), null, "G3's current port shape");
  assert.deepEqual(seen, [], "nothing reaches the database without an attempt");
});

Deno.test("fail-closed: every refusal, shape drift, throw and bad input is null (answered, never thrown)", async () => {
  const cases: [string, unknown][] = [
    ["refused", [{ code: "REFRESH_IN_PROGRESS", credential_generation: null, access_token: null }]],
    ["refused with a token (defence)", [{ code: "NOT_OWN_WORKSPACE", credential_generation: GEN, access_token: TOKEN }]],
    ["claim refused with a token (defence)", [{ code: "CLAIM_NOT_ACTIVE", credential_generation: GEN, access_token: TOKEN }]],
    ["shared Vault reference with a token (defence)", [{ code: "CREDENTIAL_REF_SHARED", credential_generation: GEN, access_token: TOKEN }]],
    ["no row", []],
    ["two rows", [verified[0], verified[0]]],
    ["not an array", verified[0]],
    ["null", null],
    ["null row", [null]],
    ["G3's derived value instead of G4's", [{ ...verified[0], credential_generation: "a".repeat(64) }]],
    ["generation without prefix", [{ ...verified[0], credential_generation: "42" }]],
    ["Threads generation", [{ ...verified[0], credential_generation: "g4t1:00000000-0000-4000-8000-000000000001" }]],
    ["short token", [{ ...verified[0], access_token: "short" }]],
    ["token with a space", [{ ...verified[0], access_token: "abc def ghi jkl mno" }]],
    ["token not a string", [{ ...verified[0], access_token: 1234567890123456 }]],
    ["code in lower case", [{ ...verified[0], code: "verified" }]],
    ["read threw", new Error(`leak ${TOKEN}`)],
  ];
  for (const [label, answer] of cases) assert.equal(await sourceOf(answer).credentialFor(ACCOUNT, ATTEMPT), null, label);
  const seen: string[] = [];
  const source = sourceOf(verified, seen);
  for (const bad of ["", "SA_UPPER", "sa-with-dash", "x", `sa_${"0".repeat(90)}`, null, undefined, 42] as unknown[]) {
    assert.equal(await source.credentialFor(bad as string, ATTEMPT), null, String(bad));
  }
  assert.deepEqual(seen, [], "a bad account id never reaches the database");
});

Deno.test("two accounts: each answer is only its own read (no token crosses accounts)", async () => {
  const other = "sa_fedcba9876543210fedcba98";
  const source = createG4XSendCredentialSource({
    read: (a, _t) => Promise.resolve(a === ACCOUNT ? verified : [{ code: "VERIFIED", credential_generation: "g4x1:7", access_token: "g4-test-only-x-access-token-0002" }]),
  });
  const [x, y] = [await source.credentialFor(ACCOUNT, ATTEMPT), await source.credentialFor(other, ATTEMPT)];
  assert.notEqual(x?.token, y?.token);
  assert.deepEqual([x?.g4Generation, y?.g4Generation], [GEN, "g4x1:7"]);
});

Deno.test("the RPC read: service-role headers, exact URL and body, no redirect; refusals throw one fixed code without the body", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const key = "service-role-test-key-not-real";
  const ok = (body: unknown, status = 200) => (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  const read = createXSendCredentialRpcRead({ supabaseUrl: "https://example.invalid/", serviceRoleKey: key, fetchImpl: ok(verified) as typeof fetch });
  assert.deepEqual(await read(ACCOUNT, { reservationId: RESV, leaseToken: LEASE, sessionId: SESSION }), verified);
  assert.equal(calls[0].url, "https://example.invalid/rest/v1/rpc/postona_x_send_credential_for_claim_v1");
  const h = new Headers(calls[0].init.headers);
  assert.deepEqual([calls[0].init.method, calls[0].init.redirect, h.get("apikey"), h.get("authorization")], ["POST", "error", key, `Bearer ${key}`]);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { p_reservation_id: RESV, p_lease_token: LEASE, p_social_account_id: ACCOUNT, p_session_id: SESSION });
  await read(ACCOUNT, { reservationId: RESV, leaseToken: LEASE, sessionId: null });
  assert.equal(JSON.parse(String(calls[1].init.body)).p_session_id, null, "the worker sends an explicit null session");
  for (const [label, impl] of [
    ["403", ok({ message: TOKEN }, 403)],
    ["500", ok({ message: TOKEN }, 500)],
    ["network", () => Promise.reject(new TypeError(TOKEN))],
    ["not json", () => Promise.resolve(new Response("<html>", { status: 200 }))],
  ] as const) {
    const r = createXSendCredentialRpcRead({ supabaseUrl: "https://example.invalid", serviceRoleKey: key, fetchImpl: impl as typeof fetch });
    await assert.rejects(r(ACCOUNT, { reservationId: RESV, leaseToken: LEASE, sessionId: null }), (e: unknown) => e instanceof Error && e.message === X_SEND_CREDENTIAL_UNAVAILABLE && !e.message.includes(TOKEN), label);
    assert.equal(await createG4XSendCredentialSource({ read: r }).credentialFor(ACCOUNT, ATTEMPT), null, `${label} -> null`);
  }
});

Deno.test("the RPC read refuses a non-https remote URL, credentials in the URL and a missing key", () => {
  for (const url of ["http://example.invalid", "ftp://example.invalid", "https://u:p@example.invalid", "https://example.invalid/?a=1", "not a url"]) {
    assert.throws(() => createXSendCredentialRpcRead({ supabaseUrl: url, serviceRoleKey: "service-role-test-key-not-real" }), /G4_X_SEND_CREDENTIAL_URL_INVALID/u, url);
  }
  assert.throws(() => createXSendCredentialRpcRead({ supabaseUrl: "https://example.invalid", serviceRoleKey: "" }), /G4_X_SEND_CREDENTIAL_KEY_REQUIRED/u);
  for (const url of ["http://localhost:8000", "http://127.0.0.1:54321"]) {
    createXSendCredentialRpcRead({ supabaseUrl: url, serviceRoleKey: "service-role-test-key-not-real" });
  }
  assert.throws(() => createG4XSendCredentialSource({ read: null as unknown as () => Promise<unknown> }), /G4_X_SEND_CREDENTIAL_READ_REQUIRED/u);
});
