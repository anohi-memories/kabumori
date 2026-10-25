// POSTONA X reservations — the whole F3 chain on a disposable LOCAL PostgreSQL (run through dispatch_run.sh only):
//   app remote store -> postona-x-reservations http.ts -> Auth (fake GoTrue) -> real driver -> postona_resv_api -> SQL
//   postona-x-reservation-worker http.ts -> real driver -> postona_resv_worker -> SQL (004) -> x_publisher -> fake X
// with the REAL G5 decision (003 on G5's candidate SQL). MOCK_ONLY: Auth answers, the G4 verified-account predicate
// (allow list), the X credential source and X itself. Real Supabase Auth, G4, X tokens and X are NOT proven here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Client } from "jsr:@db/postgres@0.19.5";
import { createHttpHandler } from "../../../functions/postona-x-reservations/http.ts";
import { createWorkerHandler } from "../../../functions/postona-x-reservation-worker/http.ts";
import { createDriverConnect } from "../../../functions/_shared/postona_reservations/postgres_driver.ts";
import { createRemoteReservationStore } from "../../../../apps/social-mobile/src/features/schedule/remote-reservation-store.ts";
import { buildSaveRequest, confirmPost } from "../../../../apps/social-mobile/src/domain/reservation-flow.ts";
import { jstDateOf, planBatch } from "../../../../apps/social-mobile/src/domain/schedule-planner.ts";

const API_URL = Deno.env.get("RESV_DSP_API_URL")!;
const WORKER_URL = Deno.env.get("RESV_DSP_WORKER_URL")!;
const OWNER_URL = Deno.env.get("RESV_DSP_OWNER_URL")!;
assert.ok(API_URL && WORKER_URL && OWNER_URL, "set by dispatch_run.sh");

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const accountOf = (user: string) => `x${user.replaceAll("-", "")}`;
const A = uid(61), B = uid(62), C = uid(63);
const TOKENS: Record<string, string> = { "token-a-0123456789abcdef": A, "token-b-0123456789abcdef": B, "token-c-0123456789abcdef": C };
// G3-34: Auth-shaped tokens carrying a live session of each person -- the Edge reads session_id only after Auth accepted the
// token, and G5's person-session gate S2-2 (asked first by caller()) checks that session row. The aliases above stay the names.
const b64url = (s: string) => btoa(s).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
async function sessionOf(user: string): Promise<string> {
  const c = new Client(OWNER_URL);
  await c.connect();
  try {
    return (await c.queryArray<[string]>("insert into auth.sessions (user_id) values ($1::uuid) returning id::text", [user])).rows[0][0];
  } finally {
    await c.end();
  }
}
// Made on first use (the people are created by the tests); an unknown alias stays an unknown (401) token.
const JWT: Record<string, Promise<string>> = {};
const USER_OF_JWT: Record<string, string> = {};
const jwtOf = (alias: string): Promise<string> => {
  const user = TOKENS[alias];
  if (!user) return Promise.resolve(alias);
  return JWT[alias] ??= sessionOf(user).then((session) => {
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${b64url(JSON.stringify({ sub: user, session_id: session, is_anonymous: false }))}.signature-0123456789`;
    USER_OF_JWT[jwt] = user;
    return jwt;
  });
};

// MOCK_ONLY Auth (fake GoTrue): unknown or expired tokens are 401.
const fakeAuth = (_url: string, init?: RequestInit) => {
  const token = String(new Headers(init?.headers).get("Authorization")).replace(/^Bearer /u, "");
  const id = USER_OF_JWT[token];
  return Promise.resolve(id ? Response.json({ id, aud: "authenticated", role: "authenticated" }) : new Response(JSON.stringify({ msg: "invalid JWT" }), { status: 401 }));
};
const apiConnect = createDriverConnect({ databaseUrl: API_URL, allowInsecureLoopback: true });
const workerConnect = createDriverConnect({ databaseUrl: WORKER_URL, allowInsecureLoopback: true });
const apiHandler = () => createHttpHandler({ get: (n) => ({ SUPABASE_URL: "https://project.example.invalid", SUPABASE_ANON_KEY: "publishable" } as Record<string, string>)[n] }, {
  enabled: true, fetch: fakeAuth, connect: apiConnect,
  // MOCK_ONLY: the TS permission port allows, so the DATABASE (real G5, mocked G4) is what decides.
  permissions: { xAutopostAllowed: () => Promise.resolve(true), xAccountVerified: () => Promise.resolve(true) },
});
const store = (token: string, handler = apiHandler()) => createRemoteReservationStore({
  transport: async (call, accessToken) => {
    const response = await handler(new Request("http://localhost/functions/v1/postona-x-reservations", {
      method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify(call),
    }));
    return { status: response.status, body: await response.json().catch(() => null) };
  },
  getAccessToken: () => jwtOf(token),
});

// MOCK_ONLY X + credential source: every create is recorded; the answer is scripted per call.
type XCall = { account: string; token: string; text: string };
const xCalls: XCall[] = [];
let xScript: ((call: XCall) => Response | Promise<Response>) | null = null;
let nextPostId = 1790000000000000100n;
const fakeX = async (_url: string, init?: RequestInit) => {
  const token = String(new Headers(init?.headers).get("authorization")).replace(/^Bearer /u, "");
  const account = Object.entries(X_TOKENS).find(([, t]) => t === token)?.[0] ?? "?";
  const call = { account, token, text: JSON.parse(String(init?.body)).text as string };
  xCalls.push(call);
  if (xScript) return await xScript(call);
  nextPostId += 1n;
  return Response.json({ data: { id: String(nextPostId), text: call.text } }, { status: 201 });
};
const X_TOKENS: Record<string, string> = { [accountOf(A)]: "fake-x-token-of-a-0123456789", [accountOf(B)]: "fake-x-token-of-b-0123456789" };
const credentials = { available: true, accessTokenFor: (account: string) => Promise.resolve(X_TOKENS[account] ?? null) };
const SECRET = "worker-secret-0123456789abcdef-0123456789";
const workerHandler = (overrides: { runBudgetMs?: number } = {}) => createWorkerHandler(
  { get: (n) => ({ POSTONA_RESV_WORKER_SECRET: SECRET, POSTONA_RESV_WORKER_DATABASE_URL: WORKER_URL } as Record<string, string>)[n] },
  { enabled: true, connect: workerConnect, credentials, fetch: fakeX, ...overrides },
);
const runWorker = async (overrides: { runBudgetMs?: number } = {}) => {
  const response = await workerHandler(overrides)(new Request("http://localhost/functions/v1/postona-x-reservation-worker", {
    method: "POST", headers: { "x-postona-worker-secret": SECRET },
  }));
  assert.equal(response.status, 200);
  return (await response.json()).report as Record<string, number | boolean>;
};

const owner = async <T extends unknown[]>(sql: string, args: unknown[] = []) => {
  const client = new Client(OWNER_URL);
  await client.connect();
  try {
    return (await client.queryArray<T>({ text: sql, args })).rows;
  } finally {
    await client.end();
  }
};
/** TEST STAND-IN: a person with POSTONA x_autopost started (real G5 path), a workspace, an X account and G4 allowed. */
async function person(user: string, verified = true) {
  const client = new Client(OWNER_URL);
  await client.connect();
  try {
    await client.queryArray({ text: "select public.fixture_login($1::uuid)", args: [user] });
    await client.queryArray("BEGIN");
    await client.queryArray({ text: "select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', 'authenticated', true)", args: [user] });
    await client.queryArray("SET LOCAL ROLE authenticated");
    const started = await client.queryArray<[string]>("select public.start_x_autopost_service() ->> 'status'");
    await client.queryArray("COMMIT");
    assert.equal(started.rows[0][0], "active");
    const brand = (await client.queryArray<[string]>({ text: "select public.social_mobile_account_deletion_workspace($1::uuid)", args: [user] })).rows[0][0];
    await client.queryArray({ text: "insert into public.brands (id, code_profile_key) values ($1, 'social_mobile_user_v1') on conflict do nothing", args: [brand] });
    await client.queryArray({ text: "insert into public.brand_memberships (brand_id, user_id, role) values ($1, $2::uuid, 'owner') on conflict do nothing", args: [brand, user] });
    await client.queryArray({ text: "insert into public.social_accounts (id, brand_id) values ($1, $2) on conflict do nothing", args: [accountOf(user), brand] });
    if (verified) await client.queryArray({ text: "insert into t_mock.verified values ($1::uuid, $2) on conflict do nothing", args: [user, accountOf(user)] });
    return { brand, account: accountOf(user) };
  } finally {
    await client.end();
  }
}
const sha256 = (text: string) => Promise.resolve(createHash("sha256").update(text, "utf8").digest("hex"));
const day = (n: number) => jstDateOf(Date.now() + n * 24 * 60 * 60 * 1000);
async function saveRequest(user: string, brand: string, text: string, offset: number) {
  const planned = planBatch({ mode: "manual_exact", posts: [{ text, date: day(offset), time: "09:15" }] },
    { owner: { accountId: accountOf(user), brandId: brand, platform: "x" }, now: new Date(), batchId: crypto.randomUUID() });
  if (!planned.ok) throw new Error("plan");
  const confirmations: Record<string, Awaited<ReturnType<typeof confirmPost>>> = {};
  for (const draft of planned.drafts) confirmations[draft.id] = await confirmPost(draft, sha256);
  const built = await buildSaveRequest({ batch: planned.batch, drafts: planned.drafts, confirmations, aiOptIn: { source: "saved", approvalMode: "manual_review" }, sha256 });
  if (!built.ok) throw new Error("build");
  return built.request;
}
/** TEST STAND-IN (the clock): the row is due now; a CONFIRMED consent moves with it (as if confirmed for that time).
 *  Each due row gets its own past time, 61 minutes apart, so the rows keep the 60-minute spacing they were saved with. */
let dueSeq = 0;
const makeDue = (id: string) => owner(`update postona_x_resv.reservations set scheduled_at = now() - make_interval(mins => $2::integer),
  consent_scheduled_at = case when consent_state = 'confirmed' then now() - make_interval(mins => $2::integer) else consent_scheduled_at end,
  expires_at = now() + interval '6 hours' where id = $1::uuid`, [id, String(1 + 61 * dueSeq++)]);
const statusOf = async (id: string) => String((await owner<[string]>("select status from postona_x_resv.reservations where id = $1::uuid", [id]))[0][0]);
async function saved(token: string, user: string, brand: string, text: string, offset: number) {
  const outcome = await store(token).save(await saveRequest(user, brand, text, offset));
  assert.equal(outcome.kind, "saved", JSON.stringify(outcome));
  if (outcome.kind !== "saved") throw new Error("save");
  return outcome.reservations[0];
}

let a: { brand: string; account: string };
let b: { brand: string; account: string };

Deno.test("save -> independent read-back; a restarted server and a new client list the same row; others and bad tokens see nothing", async () => {
  a = await person(A);
  b = await person(B);
  const row = await saved("token-a-0123456789abcdef", A, a.brand, "再起動後も残る予約", 3);
  // "Restart": a new handler and a new client instance, nothing shared with the save.
  const listed = await store("token-a-0123456789abcdef", apiHandler()).list(a.account);
  assert.ok(listed.ok);
  if (listed.ok) assert.deepEqual(listed.value.map((r) => [r.reservationId, r.status, r.consentState]), [[row.reservationId, "planned", "confirmed"]]);
  assert.deepEqual(await store("token-b-0123456789abcdef").list(a.account), { ok: false, code: "POSTONA_RESV_ACCOUNT_NOT_FOUND" });
  assert.deepEqual(await store("token-b-0123456789abcdef").get(row.reservationId), { ok: false, code: "POSTONA_RESV_NOT_FOUND" });
  assert.deepEqual(await store("token-b-0123456789abcdef").cancel(row.reservationId, 1), { ok: false, code: "POSTONA_RESV_NOT_FOUND" });
  assert.deepEqual(await store("token-expired-0123456789").list(a.account), { ok: false, code: "AUTH_REQUIRED" });
  await owner("update postona_x_resv.reservations set status = 'cancelled' where id = $1::uuid", [row.reservationId]);
});

Deno.test("due -> the worker sends the stored text once, with that account's own token; the app reads it back as published", async () => {
  const row = await saved("token-a-0123456789abcdef", A, a.brand, "予約投稿 本文 🍣", 3);
  await makeDue(row.reservationId);
  const before = xCalls.length;
  const report = await runWorker();
  assert.equal(report.published, 1, JSON.stringify(report));
  assert.deepEqual(xCalls.slice(before), [{ account: a.account, token: X_TOKENS[a.account], text: "予約投稿 本文 🍣" }]);
  const readBack = await store("token-a-0123456789abcdef").get(row.reservationId);
  assert.ok(readBack.ok && readBack.value.status === "published", JSON.stringify(readBack));
  const again = await runWorker();
  assert.equal(again.claimed, 0);
  assert.equal(xCalls.length, before + 1, "never sent twice");
});

Deno.test("reschedule invalidates the consent: nothing is sent until reconfirmed; then it is sent once", async () => {
  const row = await saved("token-a-0123456789abcdef", A, a.brand, "時間を変えた投稿", 4);
  const s = store("token-a-0123456789abcdef");
  const at = new Date(Date.parse(row.scheduledAt) + 2 * 60 * 60 * 1000).toISOString();
  const moved = await s.reschedule(row.reservationId, 1, at);
  assert.ok(moved.ok && moved.value.consentState === "needs_reconfirm");
  await makeDue(row.reservationId);
  const before = xCalls.length;
  assert.equal((await runWorker()).claimed, 0);
  assert.equal(xCalls.length, before);
  await owner("update postona_x_resv.reservations set scheduled_at = $2::timestamptz, expires_at = $2::timestamptz + interval '6 hours' where id = $1::uuid", [row.reservationId, at]);
  const reconfirmed = await s.reconfirm(row.reservationId, 2, await sha256("時間を変えた投稿"));
  assert.ok(reconfirmed.ok && reconfirmed.value.consentState === "confirmed");
  await makeDue(row.reservationId);
  assert.equal((await runWorker()).published, 1);
  assert.equal(xCalls.length, before + 1);
  assert.equal(await statusOf(row.reservationId), "published");
});

Deno.test("cancel before the claim is never sent; a claimed row can no longer be cancelled (too late), and is then sent", async () => {
  const s = store("token-a-0123456789abcdef");
  const early = await saved("token-a-0123456789abcdef", A, a.brand, "取り消す投稿", 5);
  assert.ok((await s.cancel(early.reservationId, 1)).ok);
  await makeDue(early.reservationId);
  const late = await saved("token-a-0123456789abcdef", A, a.brand, "直前に取り消そうとした投稿", 6);
  await makeDue(late.reservationId);
  const before = xCalls.length;
  xScript = async (call) => {
    // While this send is in flight, the owner tries to cancel: refused, the row is in delivery.
    assert.deepEqual(await s.cancel(late.reservationId, 1), { ok: false, code: "POSTONA_RESV_CANCEL_TOO_LATE" });
    return Response.json({ data: { id: "1790000000000000999", text: call.text } }, { status: 201 });
  };
  try {
    assert.equal((await runWorker()).published, 1);
  } finally {
    xScript = null;
  }
  assert.deepEqual(xCalls.slice(before).map((c) => c.text), ["直前に取り消そうとした投稿"]);
  assert.equal(await statusOf(early.reservationId), "cancelled");
});

Deno.test("X answers unknown (503) -> uncertain, never re-sent; X refuses (403) -> failed; the app shows both as such", async () => {
  const unknown = await saved("token-a-0123456789abcdef", A, a.brand, "結果が分からない投稿", 7);
  await makeDue(unknown.reservationId);
  xScript = () => new Response(null, { status: 503 });
  try {
    const report = await runWorker();
    assert.equal(report.uncertain, 1);
  } finally {
    xScript = null;
  }
  const refused = await saved("token-a-0123456789abcdef", A, a.brand, "Xに断られる投稿", 8);
  await makeDue(refused.reservationId);
  xScript = () => Response.json({ title: "Forbidden" }, { status: 403 });
  try {
    assert.equal((await runWorker()).failedBeforeSend, 1);
  } finally {
    xScript = null;
  }
  const before = xCalls.length;
  assert.equal((await runWorker()).claimed, 0, "neither is claimed again");
  assert.equal(xCalls.length, before);
  const s = store("token-a-0123456789abcdef");
  const u = await s.get(unknown.reservationId);
  const f = await s.get(refused.reservationId);
  assert.ok(u.ok && u.value.status === "uncertain" && f.ok && f.value.status === "failed");
});

Deno.test("the lease runs out while X is answering: the success is recorded as uncertain (lease_lost), never re-sent", async () => {
  const row = await saved("token-a-0123456789abcdef", A, a.brand, "遅い応答の投稿", 9);
  await makeDue(row.reservationId);
  xScript = async (call) => {
    await owner("update postona_x_resv.reservations set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1::uuid", [row.reservationId]);
    return Response.json({ data: { id: "1790000000000000777", text: call.text } }, { status: 201 });
  };
  try {
    const report = await runWorker();
    assert.equal(report.uncertain, 1);
    assert.equal(report.published, 0);
  } finally {
    xScript = null;
  }
  assert.equal(await statusOf(row.reservationId), "uncertain");
  const before = xCalls.length;
  assert.equal((await runWorker()).claimed, 0);
  assert.equal(xCalls.length, before);
});

Deno.test("service ended / X account not verified: the API refuses and the worker never sends; another person is unaffected", async () => {
  const c = await person(C, true);
  const row = await saved("token-c-0123456789abcdef", C, c.brand, "終了する人の投稿", 3);
  await makeDue(row.reservationId);
  await owner("update public.service_entitlements set status = 'ended', ended_at = now() where user_id = $1::uuid and service_key = 'x_autopost'", [C]);
  assert.deepEqual(await store("token-c-0123456789abcdef").list(c.account), { ok: false, code: "POSTONA_RESV_SERVICE_NOT_ACTIVE" });
  const bRow = await saved("token-b-0123456789abcdef", B, b.brand, "Bの投稿", 3);
  await makeDue(bRow.reservationId);
  await owner("delete from t_mock.verified where user_id = $1::uuid", [B]);
  const before = xCalls.length;
  const report = await runWorker();
  assert.equal(report.claimed, 0, JSON.stringify(report));
  assert.equal(xCalls.length, before);
  assert.equal(await statusOf(row.reservationId), "planned");
  assert.equal(await statusOf(bRow.reservationId), "planned");
  assert.deepEqual(await store("token-b-0123456789abcdef").list(b.account), { ok: false, code: "POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED" });
  await owner("insert into t_mock.verified values ($1::uuid, $2)", [B, b.account]);
  assert.equal((await runWorker()).published, 1);
  await owner("update postona_x_resv.reservations set status = 'cancelled' where id = $1::uuid", [row.reservationId]);
});

Deno.test("two workers at once: every due row is sent exactly once", async () => {
  const rows = [];
  for (let i = 0; i < 4; i++) rows.push(await saved("token-a-0123456789abcdef", A, a.brand, `並行 ${i}`, 10 + i));
  for (const row of rows) await makeDue(row.reservationId);
  const before = xCalls.length;
  const [r1, r2] = await Promise.all([runWorker(), runWorker()]);
  assert.equal(Number(r1.published) + Number(r2.published), 4, JSON.stringify([r1, r2]));
  assert.deepEqual(xCalls.slice(before).map((c) => c.text).sort(), ["並行 0", "並行 1", "並行 2", "並行 3"]);
});

Deno.test("graceful shutdown: a run out of time hands its claims back unsent (planned); the next run sends each once", async () => {
  const rows = [];
  for (let i = 0; i < 2; i++) rows.push(await saved("token-a-0123456789abcdef", A, a.brand, `停止 ${i}`, 20 + i));
  for (const row of rows) await makeDue(row.reservationId);
  const before = xCalls.length;
  const stopped = await runWorker({ runBudgetMs: 0 });
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.released, 2);
  assert.equal(xCalls.length, before);
  for (const row of rows) assert.equal(await statusOf(row.reservationId), "planned");
  assert.equal((await runWorker()).published, 2);
  assert.equal(xCalls.length, before + 2);
});

Deno.test("the worker answer holds counts only; nothing is logged; the old Stage 3B / Kabumori queue is not used", async () => {
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  let writes = 0;
  for (const key of Object.keys(original) as (keyof typeof original)[]) console[key] = () => { writes += 1; };
  let body = "";
  try {
    const response = await workerHandler()(new Request("http://localhost/x", { method: "POST", headers: { "x-postona-worker-secret": SECRET } }));
    body = await response.text();
  } finally {
    Object.assign(console, original);
  }
  assert.equal(writes, 0);
  assert.deepEqual(Object.keys(JSON.parse(body).report).sort(), ["claimed", "failedBeforeSend", "notAvailable", "published", "released", "skipped", "stopped", "uncertain"]);
  // (worker.ts names the old queue only in its header comment, to say it is never fed into it.)
  for (const file of ["../../../functions/postona-x-reservation-worker/http.ts", "../../../functions/_shared/postona_reservations/postgres_delivery_store.ts",
                      "../../../functions/_shared/postona_reservations/x_publisher.ts"]) {
    const source = await Deno.readTextFile(new URL(file, import.meta.url));
    for (const banned of ["scheduled_posts", "claim_due_post", "brand_posts", "x-test-post"]) assert.ok(!source.includes(banned), `${file}: ${banned}`);
  }
});
