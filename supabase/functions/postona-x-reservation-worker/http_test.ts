// MOCK_ONLY: environment, connection factory, credential source and X are fakes; no database or network.
import assert from "node:assert/strict";
import test from "node:test";
import type { PgConnect } from "../_shared/postona_reservations/postgres_db.ts";
import { createWorkerHandler, POSTONA_RESERVATION_WORKER_ENABLED } from "./http.ts";

const SECRET = "worker-secret-0123456789abcdef-0123456789";
const env = (values: Record<string, string>) => {
  const read: string[] = [];
  return { read, get: (name: string) => { read.push(name); return values[name]; } };
};
const FULL = { POSTONA_RESV_WORKER_SECRET: SECRET, POSTONA_RESV_WORKER_DATABASE_URL: "postgres://worker@db.example.invalid/postgres" };
const post = (secret?: string) => new Request("https://fn.example/postona-x-reservation-worker", {
  method: "POST", headers: secret === undefined ? {} : { "x-postona-worker-secret": secret }, body: "{}",
});
const counting = () => {
  let connects = 0;
  const connect: PgConnect = () => { connects += 1; return Promise.reject(new Error("no database in this test")); };
  return { connect, count: () => connects };
};

test("the shipped gate is OFF: 503 before the environment, the database or X is touched", async () => {
  assert.equal(POSTONA_RESERVATION_WORKER_ENABLED, false);
  const e = env(FULL);
  const db = counting();
  const response = await createWorkerHandler(e, { connect: db.connect })(post(SECRET));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, code: "NOT_AVAILABLE" });
  assert.deepEqual(e.read, []);
  assert.equal(db.count(), 0);
});

test("behind the gate: POST only, configuration required, the scheduler secret is checked before anything else", async () => {
  const db = counting();
  const handler = (values: Record<string, string>) => createWorkerHandler(env(values), { enabled: true, connect: db.connect });
  assert.equal((await handler(FULL)(new Request("https://fn.example/x"))).status, 405);
  assert.deepEqual(await (await handler({ ...FULL, POSTONA_RESV_WORKER_SECRET: "too-short" })(post("too-short"))).json(), { ok: false, code: "NOT_CONFIGURED" });
  assert.deepEqual(await (await createWorkerHandler(env({ POSTONA_RESV_WORKER_SECRET: SECRET }), { enabled: true })(post(SECRET))).json(), { ok: false, code: "NOT_CONFIGURED" });
  for (const wrong of [undefined, "", SECRET.slice(0, -1), `${SECRET}x`, SECRET.toUpperCase()]) {
    const response = await handler(FULL)(post(wrong));
    assert.equal(response.status, 401, String(wrong));
    assert.deepEqual(await response.json(), { ok: false, code: "WORKER_AUTH_REQUIRED" });
  }
  // A wrong secret whose SHA-256 shares its first byte with the right one's is refused too (the whole digest counts).
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const target = (await digest(SECRET))[0];
  let nearMiss = "";
  for (let i = 0; !nearMiss; i++) if ((await digest(`near-miss-${i}`))[0] === target) nearMiss = `near-miss-${i}`;
  assert.equal((await handler(FULL)(post(nearMiss))).status, 401);
  assert.equal(db.count(), 0, "no database before the secret is proven");
});

test("with the right secret but no G4 credential source (production default) the run claims nothing", async () => {
  const db = counting();
  const response = await createWorkerHandler(env(FULL), { enabled: true, connect: db.connect })(post(SECRET));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.report.notAvailable, true);
  assert.equal(body.report.claimed, 0);
  assert.equal(body.report.sends, 0);
  assert.equal(db.count(), 0, "not even a connection");
});

test("G3-50: a token-only source (accessTokenFor) or anything not exactly generation-bound is not accepted: no claim, no connection, no X", async () => {
  for (const credentials of [
    { available: true, accessTokenFor: () => Promise.resolve("fake-token-0123456789abcdef") },
    { available: false, credentialFor: () => Promise.resolve({ token: "fake-token-0123456789abcdef", generation: "a".repeat(64) }) },
    { available: "true", credentialFor: () => Promise.resolve(null) },
    { available: true },
  ]) {
    const db = counting();
    let xCalls = 0;
    const response = await createWorkerHandler(env(FULL), {
      enabled: true, connect: db.connect, credentials: credentials as never, fetch: () => { xCalls += 1; return Promise.resolve(new Response(null, { status: 201 })); },
    })(post(SECRET));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual([body.report.notAvailable, body.report.claimed, body.report.sends], [true, 0, 0], JSON.stringify(credentials));
    assert.equal(db.count(), 0);
    assert.equal(xCalls, 0);
  }
});

test("a store that cannot answer the claim is 503 STORE_UNAVAILABLE (nothing sent), with no detail", async () => {
  const db = counting();
  const credentials = { available: true, credentialFor: () => Promise.resolve({ token: "fake-token-0123456789abcdef", generation: "a".repeat(64) }) };
  let xCalls = 0;
  const response = await createWorkerHandler(env(FULL), {
    enabled: true, connect: db.connect, credentials, fetch: () => { xCalls += 1; return Promise.resolve(new Response(null, { status: 500 })); },
  })(post(SECRET));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, code: "STORE_UNAVAILABLE" });
  assert.equal(db.count(), 1);
  assert.equal(xCalls, 0);
});

test("source: no service-role key, no Vault, no log, no user token in the worker entry", async () => {
  for (const file of ["./http.ts", "./index.ts"]) {
    const source = await Deno.readTextFile(new URL(file, import.meta.url));
    for (const banned of ["SERVICE_ROLE", "service_role_key", "vault", "console.", "authorization", "accessTokenFor", "runReservationDelivery", "X_CREDENTIALS_NOT_CONNECTED"]) {
      assert.ok(!source.includes(banned), `${file}: ${banned}`);
    }
  }
});
