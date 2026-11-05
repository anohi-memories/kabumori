import assert from "node:assert/strict";
import test from "node:test";
import { createHttpHandler } from "./http.ts";
import type { PgConnect } from "../_shared/postona_reservations/postgres_db.ts";

const ENV = new Map([["SUPABASE_URL", "https://project.example.invalid"], ["SUPABASE_ANON_KEY", "publishable"], ["POSTONA_RESV_DATABASE_URL", "postgres://login@db.example.invalid/x"]]);
const post = (body: string) => new Request("http://localhost/postona-x-approvals", { method: "POST", headers: { authorization: "Bearer token-0123456789abcdef" }, body });
const LIST = JSON.stringify({ action: "notifications", payload: {} });

test("gate OFF (the default): 503 NOT_AVAILABLE before the environment, the body, Auth or the database", async () => {
  const calls = { fetch: 0, connect: 0, env: 0 };
  const handler = createHttpHandler({ get: (n) => { calls.env += 1; return ENV.get(n); } }, {
    fetch: () => { calls.fetch += 1; return Promise.resolve(new Response("{}", { status: 401 })); },
    connect: (() => { calls.connect += 1; return Promise.reject(new Error("no db")); }) as PgConnect,
  });
  const response = await handler(post(LIST));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, code: "NOT_AVAILABLE" });
  assert.deepEqual(calls, { fetch: 0, connect: 0, env: 0 });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("gate ON, not configured: 503 NOT_CONFIGURED; a rejected token: 401 with no database connection", async () => {
  for (const missing of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "POSTONA_RESV_DATABASE_URL"]) {
    const map = new Map(ENV);
    map.delete(missing);
    const response = await createHttpHandler({ get: (n) => map.get(n) }, { enabled: true, createConnect: () => () => Promise.reject(new Error("x")) })(post(LIST));
    assert.deepEqual([response.status, await response.json()], [503, { ok: false, code: "NOT_CONFIGURED" }]);
  }
  let connected = 0;
  const response = await createHttpHandler({ get: (n) => ENV.get(n) }, {
    enabled: true,
    fetch: () => Promise.resolve(new Response("{}", { status: 401 })),
    connect: (() => { connected += 1; return Promise.reject(new Error("no db")); }) as PgConnect,
  })(post(LIST));
  assert.deepEqual([response.status, await response.json(), connected], [401, { ok: false, code: "AUTH_REQUIRED" }, 0]);
});
