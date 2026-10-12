// POSTONA X reservations — live boundary on a disposable LOCAL PostgreSQL with the REAL driver (jsr:@db/postgres
// 0.19.5). Run through live_boundary_run.sh only. Path under test:
//   app remote store -> HTTP Request -> postona-x-reservations http.ts -> Auth verifier -> real driver
//   -> login role -> SET LOCAL ROLE postona_resv_api -> SQL candidate (001 + 002).
// MOCK_ONLY: the Auth answers (fake GoTrue responses) and the G5 / G4 SQL predicates (test doubles in the
// disposable database). Real Supabase Auth, G5 and G4 are NOT proven here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createHttpHandler } from "../../../functions/postona-x-reservations/http.ts";
import { createDriverConnect } from "../../../functions/_shared/postona_reservations/postgres_driver.ts";
import type { PgConnect } from "../../../functions/_shared/postona_reservations/postgres_db.ts";
import { createRemoteReservationStore } from "../../../../apps/social-mobile/src/features/schedule/remote-reservation-store.ts";
import { buildSaveRequest, confirmPost } from "../../../../apps/social-mobile/src/domain/reservation-flow.ts";
import { jstDateOf, planBatch } from "../../../../apps/social-mobile/src/domain/schedule-planner.ts";
import { Client } from "jsr:@db/postgres@0.19.5";

const DB_URL = Deno.env.get("RESV_LIVE_DB_URL")!;
const OWNER_URL = Deno.env.get("RESV_LIVE_OWNER_URL")!;
assert.ok(DB_URL && OWNER_URL, "set by live_boundary_run.sh");

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
// MOCK_ONLY Auth: fake GoTrue answers keyed by token.
const USERS: Record<string, unknown> = {
  "token-a-0123456789abcdef": { id: A, aud: "authenticated", role: "authenticated" },
  "token-b-0123456789abcdef": { id: B, aud: "authenticated", role: "authenticated" },
  "token-banned-0123456789": { id: A, aud: "authenticated", role: "authenticated", banned_until: "2999-01-01T00:00:00Z" },
  "token-deleted-012345678": { id: A, aud: "authenticated", role: "authenticated", deleted_at: "2026-10-01T00:00:00Z" },
  "token-anon-0123456789ab": { id: A, aud: "authenticated", role: "authenticated", is_anonymous: true },
};
let authCalls = 0;
const fakeAuth = (_url: string, init?: RequestInit) => {
  authCalls += 1;
  const token = String((init?.headers as Record<string, string>).Authorization).replace(/^Bearer /u, "");
  const user = USERS[token];
  return Promise.resolve(user ? Response.json(user) : new Response(JSON.stringify({ message: "invalid JWT" }), { status: 401 }));
};
const ENV = new Map([["SUPABASE_URL", "https://project.example.invalid"], ["SUPABASE_ANON_KEY", "publishable"]]);
const realConnect = createDriverConnect({ databaseUrl: DB_URL, allowInsecureLoopback: true });
let connects = 0;
const countingConnect: PgConnect = () => { connects += 1; return realConnect(); };
const handlerWith = (connect: PgConnect) => createHttpHandler({ get: (n) => ENV.get(n) }, {
  enabled: true, fetch: fakeAuth, connect,
  // MOCK_ONLY: the TS permission port allows, so the DATABASE predicates (test doubles) are what decide.
  permissions: { xAutopostAllowed: () => Promise.resolve(true), xAccountVerified: () => Promise.resolve(true) },
});
const handler = handlerWith(countingConnect);
/** HTTP transport: a real Request / Response pair through the function handler. */
const transportFor = (h: (r: Request) => Promise<Response>) => async (call: unknown, token: string) => {
  const response = await h(new Request("http://localhost/functions/v1/postona-x-reservations", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(call),
  }));
  return { status: response.status, body: await response.json().catch(() => null) };
};
const store = (token: string, h = handler) => createRemoteReservationStore({ transport: transportFor(h), getAccessToken: () => Promise.resolve(token) });
const owner = async <T>(sql: string, args: unknown[] = []) => {
  const client = new Client(OWNER_URL);
  await client.connect();
  try {
    return (await client.queryArray<T[]>({ text: sql, args })).rows;
  } finally {
    await client.end();
  }
};
const sha256 = (text: string) => Promise.resolve(createHash("sha256").update(text, "utf8").digest("hex"));
const day = (n: number) => jstDateOf(Date.now() + n * 24 * 60 * 60 * 1000);
async function request(batchId: string, offset: number, owner = { accountId: "x_a", brandId: "brand_a", platform: "x" as const }) {
  const planned = planBatch({ mode: "manual_exact", posts: [{ text: "朝の告知", date: day(offset), time: "08:30" }, { text: "夜の告知", date: day(offset), time: "20:00" }] },
    { owner, now: new Date(), batchId });
  assert.equal(planned.ok, true);
  if (!planned.ok) throw new Error("plan");
  const confirmations: Record<string, Awaited<ReturnType<typeof confirmPost>>> = {};
  for (const draft of planned.drafts) confirmations[draft.id] = await confirmPost(draft, sha256);
  const built = await buildSaveRequest({ batch: planned.batch, drafts: planned.drafts, confirmations, aiOptIn: { source: "saved", approvalMode: "manual_review" }, sha256 });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error("build");
  return built.request;
}
const count = async () => Number((await owner<[bigint]>("select count(*) from postona_x_resv.reservations"))[0][0]);

let saved: { reservationId: string; revision: number }[] = [];

Deno.test("real driver: save -> independent read-back -> saved; a fresh client lists the same rows", async () => {
  const outcome = await store("token-a-0123456789abcdef").save(await request("7a1c0f4e-3b0a-4f2b-9a51-0a0b0c0d0e01", 3));
  assert.equal(outcome.kind, "saved", JSON.stringify(outcome));
  if (outcome.kind !== "saved") return;
  saved = outcome.reservations;
  const listed = await store("token-a-0123456789abcdef").list("x_a");
  assert.ok(listed.ok);
  if (listed.ok) assert.deepEqual(listed.value.map((r) => r.reservationId).sort(), saved.map((r) => r.reservationId).sort());
});

Deno.test("real driver: two simultaneous submits of the same request store it once", async () => {
  const before = await count();
  const req = await request("7a1c0f4e-3b0a-4f2b-9a51-0a0b0c0d0e02", 6);
  const [first, second] = await Promise.all([store("token-a-0123456789abcdef").save(req), store("token-a-0123456789abcdef").save(req)]);
  assert.equal(first.kind, "saved");
  assert.equal(second.kind, "saved");
  assert.equal(await count(), before + 2);
});

Deno.test("real driver: reschedule (CAS) -> reconfirm -> cancel; stale revisions are refused", async () => {
  const s = store("token-a-0123456789abcdef");
  const row = saved[0];
  const listed = await s.get(row.reservationId);
  assert.ok(listed.ok);
  if (!listed.ok) return;
  const at = new Date(Date.parse(listed.value.scheduledAt) + 3 * 60 * 60 * 1000).toISOString();
  const moved = await s.reschedule(row.reservationId, 1, at);
  assert.ok(moved.ok && moved.value.consentState === "needs_reconfirm" && moved.value.revision === 2, JSON.stringify(moved));
  assert.deepEqual(await s.reschedule(row.reservationId, 1, at), { ok: false, code: "POSTONA_RESV_STALE_REVISION" });
  const reconfirmed = await s.reconfirm(row.reservationId, 2, await sha256("朝の告知"));
  assert.ok(reconfirmed.ok && reconfirmed.value.consentState === "confirmed");
  const cancelled = await s.cancel(row.reservationId, 2);
  assert.ok(cancelled.ok && cancelled.value.status === "cancelled");
  assert.deepEqual(await s.cancel(row.reservationId, 3), { ok: false, code: "POSTONA_RESV_ALREADY_FINAL" });
});

Deno.test("real driver: another user never reads or changes A's reservations", async () => {
  const s = store("token-b-0123456789abcdef");
  assert.deepEqual(await s.list("x_a"), { ok: false, code: "POSTONA_RESV_ACCOUNT_NOT_FOUND" });
  assert.deepEqual(await s.get(saved[1].reservationId), { ok: false, code: "POSTONA_RESV_NOT_FOUND" });
  assert.deepEqual(await s.cancel(saved[1].reservationId, 1), { ok: false, code: "POSTONA_RESV_NOT_FOUND" });
  const own = await s.list("x_b");
  assert.ok(own.ok && own.value.length === 0);
});

Deno.test("Auth: banned / deleted / anonymous / unknown tokens are refused and never open a database connection", async () => {
  const before = connects;
  for (const token of ["token-banned-0123456789", "token-deleted-012345678", "token-anon-0123456789ab", "token-unknown-012345678"]) {
    assert.deepEqual(await store(token).list("x_a"), { ok: false, code: "AUTH_REQUIRED" }, token);
  }
  assert.equal(connects, before);
});

Deno.test("unknown outcome: a lost COMMIT answer is resolved by read-back; a COMMIT never sent stores nothing", async () => {
  // (a) COMMIT reached the server, the answer was lost: the API says 503, the client's read-back finds the rows.
  const lostAck: PgConnect = async () => {
    const session = await realConnect();
    const client = { queryArray: async (q: { text: string; args?: unknown[] }) => {
      const out = await session.client.queryArray(q);
      if (q.text === "COMMIT") throw new Error("connection reset after COMMIT");
      return out;
    } };
    return { client, release: session.release };
  };
  const before = await count();
  const req = await request("7a1c0f4e-3b0a-4f2b-9a51-0a0b0c0d0e03", 9);
  const lost = transportFor(handlerWith(lostAck));
  const normal = transportFor(handler);
  const lostCreate = createRemoteReservationStore({
    // Only the create loses its COMMIT answer; the read-back runs over a normal connection.
    transport: (call: { action: string }, token: string) => (call.action === "create" ? lost(call, token) : normal(call, token)),
    getAccessToken: () => Promise.resolve("token-a-0123456789abcdef"),
  });
  const outcome = await lostCreate.save(req);
  assert.equal(outcome.kind, "saved", "read-back over a normal connection proves the stored rows");
  assert.equal(await count(), before + 2);
  // (b) The COMMIT never left: nothing is stored, the client says uncertain, a retry with the same key saves once.
  const neverSent: PgConnect = async () => {
    const session = await realConnect();
    const client = { queryArray: (q: { text: string; args?: unknown[] }) =>
      q.text === "COMMIT" ? Promise.reject(new Error("socket closed")) : session.client.queryArray(q) };
    return { client, release: session.release };
  };
  const req2 = await request("7a1c0f4e-3b0a-4f2b-9a51-0a0b0c0d0e04", 12);
  // Every call (the create AND its read-back) loses its COMMIT: the outcome cannot be confirmed.
  assert.deepEqual(await store("token-a-0123456789abcdef", handlerWith(neverSent)).save(req2), { kind: "uncertain", code: "UNCERTAIN" });
  assert.equal(await count(), before + 2, "nothing stored");
  assert.equal((await store("token-a-0123456789abcdef").save(req2)).kind, "saved");
  assert.equal(await count(), before + 4);
});

Deno.test("role boundary through the real driver: the login role and postona_resv_api reach no table, worker function or other role", async () => {
  const client = new Client(DB_URL);
  await client.connect();
  const refused = async (sql: string) => {
    await client.queryArray("BEGIN");
    try {
      await client.queryArray("SET LOCAL ROLE postona_resv_api");
      await client.queryArray(sql);
      return false;
    } catch (error) {
      return /permission denied/u.test(String((error as Error).message));
    } finally {
      await client.queryArray("ROLLBACK").catch(() => undefined);
    }
  };
  try {
    for (const sql of ["select count(*) from postona_x_resv.reservations", "select * from postona_x_resv.claim_due('w', 60, 1)",
      "select postona_x_resv.g5_x_autopost_allowed('" + A + "')", "update postona_x_resv.reservations set status = 'published'",
      "set local role service_role", "set local role kb_postona_resv_live_owner", "set local role authenticated", "set local role anon"]) {
      assert.ok(await refused(sql), sql);
    }
    await assert.rejects(client.queryArray("select count(*) from postona_x_resv.reservations"), /permission denied/u, "the login role itself");
  } finally {
    await client.end();
  }
});

Deno.test("nothing is logged: no token, subject or row reaches the console during API calls", async () => {
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  let writes = 0;
  for (const key of Object.keys(original) as (keyof typeof original)[]) console[key] = () => { writes += 1; };
  try {
    await store("token-a-0123456789abcdef").list("x_a");
    await store("token-banned-0123456789").list("x_a");
    await store("token-b-0123456789abcdef").get(saved[1].reservationId);
  } finally {
    Object.assign(console, original);
  }
  assert.equal(writes, 0);
  assert.ok(authCalls > 0);
});

Deno.test("pooled connection: a reused session carries no subject or role into the next caller", async () => {
  const client = new Client(DB_URL);
  await client.connect();
  try {
    const pooled: PgConnect = () => Promise.resolve({ client, release: () => Promise.resolve() });
    const first = await store("token-a-0123456789abcdef", handlerWith(pooled)).list("x_a");
    assert.ok(first.ok);
    const after = await client.queryArray<[string, string, string]>(
      "select coalesce(current_setting('request.jwt.claim.sub', true), ''), coalesce(current_setting('request.jwt.claims', true), ''), current_user");
    assert.deepEqual(after.rows[0], ["", "", "kb_postona_resv_live_login"]);
    // The next caller on the same session is B and sees only B's own account.
    assert.deepEqual(await store("token-b-0123456789abcdef", handlerWith(pooled)).list("x_a"), { ok: false, code: "POSTONA_RESV_ACCOUNT_NOT_FOUND" });
  } finally {
    await client.end();
  }
});
