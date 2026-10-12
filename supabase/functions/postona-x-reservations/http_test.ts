import assert from "node:assert/strict";
import test from "node:test";
import { createHttpHandler } from "./http.ts";
import type { PgConnect } from "../_shared/postona_reservations/postgres_db.ts";

const ENV = new Map([["SUPABASE_URL", "https://project.example.invalid"], ["SUPABASE_ANON_KEY", "publishable"], ["POSTONA_RESV_DATABASE_URL", "postgres://login@db.example.invalid/postgres"]]);
const env = (map: Map<string, string>) => ({ get: (name: string) => map.get(name) });
const post = (body: string, headers: Record<string, string> = {}) =>
  new Request("http://localhost/postona-x-reservations", { method: "POST", headers: { authorization: "Bearer token-0123456789abcdef", ...headers }, body });
const LIST = JSON.stringify({ action: "list", payload: { socialAccountId: "x_a" } });

function spies() {
  const calls = { fetch: 0, connect: 0, envReads: 0 };
  const fetchImpl = () => { calls.fetch += 1; return Promise.resolve(new Response("{}", { status: 401 })); };
  const connect: PgConnect = () => { calls.connect += 1; return Promise.reject(new Error("no db")); };
  const countingEnv = { get: (name: string) => { calls.envReads += 1; return ENV.get(name); } };
  return { calls, fetchImpl, connect, countingEnv };
}

test("gate OFF (the default): 503 NOT_AVAILABLE before the environment, the body, Auth or the database", async () => {
  const s = spies();
  const handler = createHttpHandler(s.countingEnv, { fetch: s.fetchImpl, connect: s.connect });
  const response = await handler(post(LIST));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, code: "NOT_AVAILABLE" });
  assert.deepEqual(s.calls, { fetch: 0, connect: 0, envReads: 0 });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("gate ON but not configured: 503 NOT_CONFIGURED without naming the missing value", async () => {
  for (const missing of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "POSTONA_RESV_DATABASE_URL"]) {
    const map = new Map(ENV);
    map.delete(missing);
    const response = await createHttpHandler(env(map), { enabled: true, createConnect: () => () => Promise.reject(new Error("x")) })(post(LIST));
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.deepEqual(body, { ok: false, code: "NOT_CONFIGURED" });
  }
  // A database URL with an unsupported scheme is "not configured" too.
  const bad = await createHttpHandler(env(ENV), { enabled: true, createConnect: () => { throw new Error("RESERVATION_DB_URL_INVALID"); } })(post(LIST));
  assert.equal(bad.status, 503);
});

test("gate ON: oversize bodies are refused before Auth (declared or streamed); a refused token never opens a connection", async () => {
  const s = spies();
  const handler = createHttpHandler(env(ENV), { enabled: true, fetch: s.fetchImpl, connect: s.connect });
  assert.equal((await handler(post("{}", { "content-length": String(70 * 1024) }))).status, 413);
  const stream = new ReadableStream({ start(controller) { for (let i = 0; i < 70; i += 1) controller.enqueue(new Uint8Array(1024)); controller.close(); } });
  const streamed = new Request("http://localhost/", { method: "POST", headers: { authorization: "Bearer token-0123456789abcdef" }, body: stream });
  assert.equal((await handler(streamed)).status, 413);
  // A huge streamed body is not read to the end: reading stops just past the limit.
  let pulled = 0;
  const endless = new ReadableStream({ pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(1024)); if (pulled > 10_000) controller.close(); } });
  const huge = new Request("http://localhost/", { method: "POST", headers: { authorization: "Bearer token-0123456789abcdef" }, body: endless });
  assert.equal((await handler(huge)).status, 413);
  assert.ok(pulled <= 70, `read ${pulled} KiB of an endless body`);
  assert.equal(s.calls.fetch, 0);
  const refused = await handler(post(LIST));
  assert.equal(refused.status, 401, "Auth answered 401 for the token");
  assert.equal(s.calls.fetch, 1);
  assert.equal(s.calls.connect, 0, "no database connection for an unverified caller");
});

test("source: the entry point builds the real driver only through the factory and holds no key, log or X call", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const file of ["index.ts", "http.ts"]) {
    const code = (await readFile(new URL(`./${file}`, import.meta.url), "utf8")).replace(/\/\/.*$/gmu, "");
    assert.doesNotMatch(code, /SERVICE_ROLE|service_role|console\.|api\.x\.com|twitter|openai/iu, file);
  }
  const http = await readFile(new URL("./http.ts", import.meta.url), "utf8");
  assert.match(http, /const enabled = overrides\.enabled \?\? POSTONA_RESERVATION_API_ENABLED;/u);
  assert.match(http, /permissions: overrides\.permissions \?\? PERMISSIONS_NOT_CONNECTED,/u);
  const index = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(index, /enabled:|permissions:/u, "production passes no gate or permission override");
});
