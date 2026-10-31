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

// ---- G3-02 #11 (H4-17 P1): the tick's one-use signed ticket instead of the reusable secret ----------------------------------------------
const REF = "abcdefghij0123456789";
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const sign = async (key: string, message: string) => {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message))));
};
const NONCE = "ab".repeat(32);
const ticket = async (o: { ref?: string; at?: number; nonce?: string; key?: string } = {}) => {
  const message = `v1.${o.ref ?? REF}.${o.at ?? Math.floor(Date.now() / 1000)}.${o.nonce ?? NONCE}`;
  return `${message}.${await sign(o.key ?? SECRET, message)}`;
};
const tickPost = (value: string, extra: Record<string, string> = {}) =>
  new Request("https://fn.example/postona-x-reservation-worker", { method: "POST", headers: { "x-postona-worker-tick": value, ...extra }, body: "{}" });
/** A fake database: consume_worker_tick answers `consume`; claim_due answers no rows. Records the statements. */
const scripted = (consume: "true" | "false") => {
  const statements: string[] = [];
  const connect: PgConnect = () => Promise.resolve({
    client: { queryArray: ({ text }: { text: string }) => {
      statements.push(text);
      if (text.includes("consume_worker_tick")) return Promise.resolve({ rows: [[consume]] });
      if (text.includes("claim_due")) return Promise.resolve({ rows: [["[]"]] });
      return Promise.resolve({ rows: [] });
    } },
    release: () => Promise.resolve(),
  });
  return { connect, statements, consumed: () => statements.filter((s) => s.includes("consume_worker_tick")).length, claimed: () => statements.filter((s) => s.includes("claim_due")).length };
};
const BOUND = { available: true, credentialFor: () => Promise.resolve({ token: "fake-token-0123456789abcdef", generation: "a".repeat(64) }) };
const PROD_ENV = { ...FULL, SUPABASE_URL: `https://${REF}.supabase.co` };

test("G3-02 #11: a valid ticket (this project's ref from SUPABASE_URL, fresh, signed with the secret) is consumed once, then the run", async () => {
  const db = scripted("true");
  const response = await createWorkerHandler(env(PROD_ENV), { enabled: true, connect: db.connect, credentials: BOUND })(tickPost(await ticket()));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).report.claimed, 0);
  assert.deepEqual([db.consumed(), db.claimed()], [1, 1]);
  assert.ok(db.statements.indexOf(db.statements.find((s) => s.includes("consume_worker_tick"))!) < db.statements.indexOf(db.statements.find((s) => s.includes("claim_due"))!), "consumed before the claim");
  assert.ok(db.statements.includes("SET LOCAL ROLE postona_resv_worker"));
});

test("G3-02 #11: a replayed / unknown / expired-in-the-database ticket (consume answers false) -> 401 WORKER_TICK_REJECTED, nothing claimed", async () => {
  const db = scripted("false");
  const response = await createWorkerHandler(env(PROD_ENV), { enabled: true, connect: db.connect, credentials: BOUND })(tickPost(await ticket()));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, code: "WORKER_TICK_REJECTED" });
  assert.deepEqual([db.consumed(), db.claimed()], [1, 0]);
});

test("G3-02 #11: a ticket that is forged, tampered, for another project, stale, from the future or malformed -> 401 before the database", async () => {
  const now = Math.floor(Date.now() / 1000);
  const good = await ticket();
  const cases: Array<[string, string, Record<string, string>]> = [
    ["another key", await ticket({ key: `${SECRET}x` }), PROD_ENV],
    ["tampered nonce", good.replace(`.${NONCE}.`, `.${"cd".repeat(32)}.`), PROD_ENV],
    ["tampered mac", good.slice(0, -1) + (good.endsWith("0") ? "1" : "0"), PROD_ENV],
    ["another project's ref", await ticket({ ref: "zzzzzzzzzz0123456789" }), PROD_ENV],
    ["stale (121 s)", await ticket({ at: now - 121 }), PROD_ENV],
    ["future (121 s)", await ticket({ at: now + 121 }), PROD_ENV],
    ["malformed", "v1.x.y.z.w", PROD_ENV],
    ["v2", good.replace(/^v1\./u, "v2."), PROD_ENV],
    ["no own ref (SUPABASE_URL not https://<ref>.supabase.co)", good, { ...FULL, SUPABASE_URL: "http://kong:8000" }],
    ["no own ref (SUPABASE_URL missing)", good, FULL],
  ];
  for (const [label, value, values] of cases) {
    const db = scripted("true");
    const response = await createWorkerHandler(env(values), { enabled: true, connect: db.connect, credentials: BOUND })(tickPost(value));
    assert.equal(response.status, 401, label);
    assert.deepEqual(await response.json(), { ok: false, code: "WORKER_AUTH_REQUIRED" }, label);
    assert.equal(db.statements.length, 0, `${label}: no database`);
  }
  // the ticket path is decided alone: a right secret header next to a bad ticket does not rescue it
  const db = scripted("true");
  assert.equal((await createWorkerHandler(env(PROD_ENV), { enabled: true, connect: db.connect, credentials: BOUND })(tickPost("v1.bad", { "x-postona-worker-secret": SECRET }))).status, 401);
  assert.equal(db.statements.length, 0);
});

test("G3-02 #11: with the gate OFF or no generation-bound source a ticket changes nothing (503 / notAvailable, no database)", async () => {
  const db = scripted("true");
  assert.equal((await createWorkerHandler(env(PROD_ENV), { connect: db.connect })(tickPost(await ticket()))).status, 503);
  const off = await createWorkerHandler(env(PROD_ENV), { enabled: true, connect: db.connect })(tickPost(await ticket()));
  assert.deepEqual([off.status, (await off.json()).report.notAvailable], [200, true]);
  assert.equal(db.statements.length, 0);
});

test("G3-02 #11: a database that cannot answer the consume is 503 STORE_UNAVAILABLE, nothing claimed", async () => {
  const db = counting();
  const response = await createWorkerHandler(env(PROD_ENV), { enabled: true, connect: db.connect, credentials: BOUND })(tickPost(await ticket()));
  assert.deepEqual([response.status, await response.json()], [503, { ok: false, code: "STORE_UNAVAILABLE" }]);
  assert.equal(db.count(), 1);
});
