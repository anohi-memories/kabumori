// MOCK_ONLY: environment and connection factory are fakes; no database, Auth or network.
import assert from "node:assert/strict";
import test from "node:test";
import type { PgConnect } from "../_shared/postona_reservations/postgres_db.ts";
import { createSinglePostHttpHandler } from "./http.ts";

const FULL = { SUPABASE_URL: "https://project.example.invalid", SUPABASE_ANON_KEY: "publishable", POSTONA_RESV_DATABASE_URL: "postgres://api@db.example.invalid/postgres" };
const env = (values: Record<string, string>) => { const read: string[] = []; return { read, get: (n: string) => { read.push(n); return values[n]; } }; };
const counting = () => { let n = 0; const connect: PgConnect = () => { n += 1; return Promise.reject(new Error("no db")); }; return { connect, count: () => n }; };
const req = (body = "{}") => new Request("https://fn.example/postona-x-single-post", { method: "POST", headers: { authorization: "Bearer token-0123456789abcdef" }, body });

test("the shipped gate is OFF: 503 before the environment, the body, Auth, the database or X", async () => {
  const e = env(FULL);
  const db = counting();
  const response = await createSinglePostHttpHandler(e, { connect: db.connect })(req());
  assert.deepEqual([response.status, await response.json()], [503, { ok: false, code: "NOT_AVAILABLE" }]);
  assert.deepEqual(e.read, []);
  assert.equal(db.count(), 0);
});

test("behind the gate: configuration required; oversized bodies refused; no G4 source -> X_NOT_AVAILABLE before the database", async () => {
  assert.deepEqual(await (await createSinglePostHttpHandler(env({}), { enabled: true })(req())).json(), { ok: false, code: "NOT_CONFIGURED" });
  const db = counting();
  const big = await createSinglePostHttpHandler(env(FULL), { enabled: true, connect: db.connect })(req("x".repeat(20000)));
  assert.equal(big.status, 413);
  const body = JSON.stringify({ socialAccountId: "sa_x", clientRequestId: "55555555-5555-4555-8555-555555555555", text: "t", consent: { confirmed: true, contentSha256: "a".repeat(64) } });
  const b64 = (v: unknown) => btoa(JSON.stringify(v)).replace(/=+$/u, "");
  const tokenWithSession = `${b64({ alg: "HS256" })}.${b64({ sub: "11111111-1111-4111-8111-111111111111", session_id: "22222222-2222-4222-8222-222222222222" })}.sig`;
  const response = await createSinglePostHttpHandler(env(FULL), {
    enabled: true, connect: db.connect, auth: { verify: () => Promise.resolve({ userId: "11111111-1111-4111-8111-111111111111" }) },
  })(new Request("https://fn.example/x", { method: "POST", headers: { authorization: `Bearer ${tokenWithSession}` }, body }));
  assert.deepEqual([response.status, await response.json()], [503, { ok: false, code: "X_NOT_AVAILABLE" }]);
  assert.equal(db.count(), 0, "no database when nothing could be sent");
  // The older accessTokenFor-only source cannot say which generation its token belongs to: not connected.
  const accessorOnly = await createSinglePostHttpHandler(env(FULL), {
    enabled: true, connect: db.connect, auth: { verify: () => Promise.resolve({ userId: "11111111-1111-4111-8111-111111111111" }) },
    credentials: { available: true, accessTokenFor: () => Promise.resolve("fake-x-token-0123456789") } as never, xFetch: () => Promise.reject(new Error("never")),
  })(new Request("https://fn.example/x", { method: "POST", headers: { authorization: `Bearer ${tokenWithSession}` }, body }));
  assert.deepEqual([accessorOnly.status, await accessorOnly.json()], [503, { ok: false, code: "X_NOT_AVAILABLE" }]);
  assert.equal(db.count(), 0);
});

test("source: no service-role key, no Vault, no console in the entry", async () => {
  for (const file of ["./http.ts", "./index.ts"]) {
    const source = await Deno.readTextFile(new URL(file, import.meta.url));
    for (const banned of ["SERVICE_ROLE", "service_role_key", "vault", "console."]) assert.ok(!source.includes(banned), `${file}: ${banned}`);
  }
});
