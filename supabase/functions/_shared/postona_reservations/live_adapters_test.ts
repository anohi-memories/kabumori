import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresReservationDb, type PgQueryClient, type PgSession } from "./postgres_db.ts";
import { createDriverConnect } from "./postgres_driver.ts";
import { createSupabaseAuthVerifier } from "./supabase_auth.ts";

const USER = "00000000-0000-4000-8000-00000000000a";
const NOW = Date.parse("2026-10-13T00:00:00Z");

// ---------------------------------------------------------------------------------------------------
// Supabase Auth verifier (fake Auth responses; MOCK_ONLY)
// ---------------------------------------------------------------------------------------------------
function authWith(answer: { status: number; body?: unknown } | Error) {
  const seen: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(new Response(answer.body === undefined ? "not json" : JSON.stringify(answer.body), { status: answer.status }));
  };
  const verifier = createSupabaseAuthVerifier({ supabaseUrl: "https://project.example.invalid/", anonKey: "publishable-key", fetch: fetchImpl, now: () => NOW });
  return { verifier, seen };
}
const user = (over: Record<string, unknown> = {}) => ({ id: USER, aud: "authenticated", role: "authenticated", ...over });

test("auth: a live user is accepted; the call carries the caller's token and the anon key only", async () => {
  const { verifier, seen } = authWith({ status: 200, body: user() });
  assert.deepEqual(await verifier.verify("caller-token"), { userId: USER });
  assert.equal(seen[0].url, "https://project.example.invalid/auth/v1/user");
  const headers = seen[0].init?.headers as Record<string, string>;
  assert.deepEqual(Object.keys(headers).sort(), ["Authorization", "apikey"]);
  assert.equal(headers.Authorization, "Bearer caller-token");
  assert.equal(headers.apikey, "publishable-key");
  assert.equal(seen[0].init?.redirect, "manual");
});

test("auth: banned, deleted, anonymous, wrong role/audience, signed-out or malformed users are refused (null)", async () => {
  for (const body of [
    user({ banned_until: "2026-12-01T00:00:00Z" }),
    user({ banned_until: "not a date" }),
    user({ deleted_at: "2026-10-01T00:00:00Z" }),
    user({ is_anonymous: true }),
    user({ role: "service_role" }),
    user({ aud: "other" }),
    user({ id: "admin" }),
    [user()],
  ]) {
    assert.equal(await authWith({ status: 200, body }).verifier.verify("t"), null, JSON.stringify(body));
  }
  assert.deepEqual(await authWith({ status: 200, body: user({ banned_until: "2026-10-01T00:00:00Z" }) }).verifier.verify("t"), { userId: USER }, "an expired ban");
  for (const status of [401, 403, 404, 302]) assert.equal(await authWith({ status, body: user() }).verifier.verify("t"), null, String(status));
  assert.equal(await authWith({ status: 200 }).verifier.verify("t"), null, "non-JSON");
});

test("auth: Auth unavailable (5xx / network) throws, so the API answers 503 and never guesses", async () => {
  await assert.rejects(authWith({ status: 503, body: {} }).verifier.verify("t"));
  await assert.rejects(authWith(new Error("dns")).verifier.verify("t"));
  assert.throws(() => createSupabaseAuthVerifier({ supabaseUrl: "http://project.example.invalid", anonKey: "k" }), /HTTPS/u);
});

// ---------------------------------------------------------------------------------------------------
// Postgres adapter (scripted client): the exact transaction, typed binds, error mapping
// ---------------------------------------------------------------------------------------------------
type Step = { text: string; args?: unknown[] };
function scriptedSession(onQuery: (step: Step, index: number) => { rows: unknown[][] } | Error) {
  const steps: Step[] = [];
  let released = 0;
  const client: PgQueryClient = {
    queryArray(query) {
      steps.push(query);
      const out = onQuery(query, steps.length - 1);
      return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
    },
  };
  const session: PgSession = { client, release: () => { released += 1; return Promise.resolve(); } };
  return { connect: () => Promise.resolve(session), steps, released: () => released };
}
const pgError = (code: string, message: string) => Object.assign(new Error(message), { fields: { code, message } });
const ROWS = JSON.stringify([{ reservation_id: "r", batch_id: "b", draft_id: "d", position: 0, origin: "user_authored", mode: "manual_exact", body: "x", scheduled_at: "2026-10-20T00:30:00+00:00", fixed: true, status: "planned", revision: 1, consent_state: "confirmed" }]);

test("db: one transaction -- constant role, local claims of the verified subject, one fixed function with bind parameters", async () => {
  const s = scriptedSession((step) => (step.text.startsWith("SELECT coalesce") ? { rows: [[ROWS]] } : { rows: [] }));
  const db = createPostgresReservationDb(s.connect);
  const items = [{ draft_id: "d", scheduled_at: "2026-10-20T00:30:00Z", body: "x'); drop table x; --", consent: { confirmed: true, content_sha256: "a".repeat(64) } }];
  const result = await db.call("create_batch", ["x_a", "0f9d2a52-8c1b-4b6a-9d55-1a2b3c4d5e6f", 1, "manual_exact", null, items], USER);
  assert.equal(result.ok, true);
  const order = ["BEGIN ISOLATION LEVEL READ COMMITTED", "SET LOCAL ROLE ", "SET LOCAL statement_timeout", "SELECT set_config('request.jwt.claims'", "SELECT coalesce(json_agg(r)", "COMMIT"];
  assert.equal(s.steps.length, order.length);
  order.forEach((prefix, i) => assert.ok(s.steps[i].text.startsWith(prefix), `${i}: ${s.steps[i].text}`));
  assert.equal(s.steps[1].text, "SET LOCAL ROLE postona_resv_api");
  assert.deepEqual(s.steps[3].args, [JSON.stringify({ sub: USER, role: "authenticated" }), USER]);
  // Every claim is transaction-local (is_local = true): a reused connection never carries a subject over.
  assert.equal((s.steps[3].text.match(/set_config\('[a-z_.]+', [^)]+\)/gu) ?? []).filter((call) => !call.endsWith(", true)")).length, 0);
  assert.equal((s.steps[3].text.match(/set_config\(/gu) ?? []).length, 3);
  assert.match(s.steps[4].text, /postona_x_resv\.create_batch\(\$1::text, \$2::uuid, \$3::integer, \$4::text, \$5::jsonb, \$6::jsonb\)/u);
  assert.deepEqual(s.steps[4].args, ["x_a", "0f9d2a52-8c1b-4b6a-9d55-1a2b3c4d5e6f", "1", "manual_exact", null, JSON.stringify(items)]);
  assert.ok(!s.steps.some((step) => step.text.includes("drop table")), "values never reach the SQL text");
  assert.equal(s.released(), 1);
});

test("db: refuses an unknown function, a wrong arity or a non-UUID subject before connecting", async () => {
  let connected = 0;
  const db = createPostgresReservationDb(() => { connected += 1; return Promise.reject(new Error("x")); });
  assert.deepEqual(await db.call("claim_due" as never, [], USER), { ok: false, code: "DB_REQUEST_INVALID" });
  assert.deepEqual(await db.call("cancel", ["r"], USER), { ok: false, code: "DB_REQUEST_INVALID" });
  assert.deepEqual(await db.call("list_reservations", ["x_a"], "00000000-0000-4000-8000-00000000000a' or '1'='1"), { ok: false, code: "DB_REQUEST_INVALID" });
  assert.equal(connected, 0);
});

test("db: a POSTONA_RESV refusal rolls back and returns its code; a lock timeout is BUSY; other server errors are DB_ERROR", async () => {
  for (const [error, code] of [
    [pgError("P0001", "POSTONA_RESV_SLOT_CONFLICT"), "POSTONA_RESV_SLOT_CONFLICT"],
    [pgError("55P03", "canceling statement due to lock timeout"), "POSTONA_RESV_SERVICE_BUSY"],
    [pgError("42501", "permission denied for function claim_due"), "DB_ERROR"],
  ] as const) {
    const s = scriptedSession((step) => (step.text.startsWith("SELECT coalesce") ? error : { rows: [] }));
    assert.deepEqual(await createPostgresReservationDb(s.connect).call("list_reservations", ["x_a"], USER), { ok: false, code });
    assert.equal(s.steps[s.steps.length - 1].text, "ROLLBACK");
    assert.ok(!s.steps.some((step) => step.text === "COMMIT"));
    assert.equal(s.released(), 1);
  }
});

test("db: a broken connection or a failed COMMIT is an UNKNOWN outcome (throws), never a definite answer", async () => {
  const broken = scriptedSession((step) => (step.text.startsWith("SELECT coalesce") ? new Error("connection reset") : { rows: [] }));
  await assert.rejects(createPostgresReservationDb(broken.connect).call("list_reservations", ["x_a"], USER), /OUTCOME_UNKNOWN/u);
  const commit = scriptedSession((step) => (step.text === "COMMIT" ? pgError("08006", "connection failure") : step.text.startsWith("SELECT coalesce") ? { rows: [[ROWS]] } : { rows: [] }));
  await assert.rejects(createPostgresReservationDb(commit.connect).call("list_reservations", ["x_a"], USER), /OUTCOME_UNKNOWN/u);
  assert.equal(commit.released(), 1);
  await assert.rejects(createPostgresReservationDb(() => Promise.reject(new Error("refused"))).call("list_reservations", ["x_a"], USER));
});

test("driver config: TLS is enforced for any non-loopback host; plain TCP only on loopback with the explicit test flag", () => {
  assert.throws(() => createDriverConnect({ databaseUrl: "mysql://u@h/db" }), /INVALID/u);
  assert.throws(() => createDriverConnect({ databaseUrl: "postgres://@db.example.invalid/db" }), /INVALID/u);
  // Construction is lazy (no connection is opened here); the options are checked by the source test below.
  assert.equal(typeof createDriverConnect({ databaseUrl: "postgres://login@db.example.invalid:6543/postgres" }), "function");
});

test("source: adapters log nothing and hold no service-role key; the driver is pinned exactly; TLS defaults on", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const file of ["postgres_db.ts", "postgres_driver.ts", "supabase_auth.ts"]) {
    const code = (await readFile(new URL(`./${file}`, import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, "");
    assert.doesNotMatch(code, /console\.|service_role|SERVICE_ROLE|Deno\.env/u, file);
  }
  const driver = await readFile(new URL("./postgres_driver.ts", import.meta.url), "utf8");
  assert.match(driver, /from "jsr:@db\/postgres@0\.19\.5";/u);
  assert.match(driver, /tls: insecure \? \{ enabled: false \} : \{ enabled: true, enforce: true \}/u);
  assert.match(driver, /const insecure = loopback && config\.allowInsecureLoopback === true;/u);
});
