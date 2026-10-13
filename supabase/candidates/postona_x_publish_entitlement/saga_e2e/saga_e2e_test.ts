// The REAL X deletion saga (social-mobile-account-delete/delete_logic.ts) against the REAL SQL on a disposable LOCAL
// PostgreSQL (run through saga_run.sh only), over the real driver (jsr:@db/postgres 0.19.5), as service_role.
// MOCK_ONLY: the person's token check (getUser) and the X token revocation (revokeX) are fakes -- no X call is made.
import assert from "node:assert/strict";
import { Client } from "jsr:@db/postgres@0.19.5";
import { CONFIRMATION, handleAccountDeletion, type DeletionDeps, type RpcName, type RpcResult } from "../../../functions/social-mobile-account-delete/delete_logic.ts";
import { sha256Hex } from "../../../functions/social-mobile-account-delete/http.ts";
import { xServiceEndOutcomeOf, xServiceEndRequest } from "../../../functions/social-mobile-account-delete/x_service_end_contract.ts";

const OWNER_URL = Deno.env.get("SAGA_OWNER_URL")!;
const SUPER_URL = Deno.env.get("SAGA_SUPER_URL")!;
assert.ok(OWNER_URL && SUPER_URL, "set by saga_run.sh");

// Same map as http.ts (asserted against its source below).
const RPC_NAMES: Record<RpcName, string> = {
  preview: "social_mobile_account_deletion_preview",
  x_precheck: "social_mobile_account_deletion_x_precheck",
  acquire: "social_mobile_account_deletion_acquire",
  release: "social_mobile_account_deletion_release",
  stop_x: "social_mobile_account_deletion_stop_x",
  credentials: "social_mobile_account_deletion_credentials",
  mark_x_revoked: "social_mobile_account_deletion_mark_x_revoked",
  mark_apple_revoked: "social_mobile_account_deletion_mark_apple_revoked",
  purge: "social_mobile_account_deletion_purge",
  finalize: "social_mobile_account_deletion_finalize",
  record: "social_mobile_account_deletion_record",
};
const ARG = /^p_[a-z_]{1,40}$/u;
const VOID = new Set<RpcName>(["release", "record"]);

async function withOwner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client(OWNER_URL);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
/** PostgREST-like: one transaction as service_role, named arguments as bind parameters, fixed error codes. */
const rpc = async (name: RpcName, args: Record<string, unknown>): Promise<RpcResult> => {
  const keys = Object.keys(args);
  assert.ok(keys.every((key) => ARG.test(key)), "argument names");
  const call = `public.${RPC_NAMES[name]}(${keys.map((key, i) => `${key} => $${i + 1}`).join(", ")})`;
  const values = keys.map((key) => (typeof args[key] === "object" && args[key] !== null ? JSON.stringify(args[key]) : args[key] === null ? null : String(args[key])));
  return await withOwner(async (client) => {
    await client.queryArray("BEGIN");
    try {
      await client.queryArray("SET LOCAL ROLE service_role");
      const result = await client.queryArray<[string | null]>({
        text: VOID.has(name) ? `SELECT (SELECT count(*) FROM (SELECT ${call}) x)::text` : `SELECT (${call})::text`, args: values,
      });
      await client.queryArray("COMMIT");
      const text = result.rows[0]?.[0] ?? null;
      return { ok: true, data: VOID.has(name) || text === null ? null : JSON.parse(text) };
    } catch (error) {
      await client.queryArray("ROLLBACK").catch(() => undefined);
      const message = (error as { fields?: { message?: string } }).fields?.message ?? "";
      return { ok: false, code: /^[A-Z][A-Z0-9_]{2,99}$/u.test(message) ? message : null };
    }
  });
};
const owner = (sql: string, args: unknown[] = []) => withOwner((c) => c.queryArray({ text: sql, args }));
const scalar = async (sql: string, args: unknown[] = []) => (await owner(sql, args)).rows[0]?.[0];

const b64 = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
const tokenFor = (user: string) => `${b64({ alg: "HS256" })}.${b64({ sub: user, amr: [{ method: "password", timestamp: Math.floor(Date.now() / 1000) - 30 }] })}.sig`;
function depsFor(user: string, revokeOk: () => boolean = () => true) {
  const revoked: string[] = [];
  const deps: DeletionDeps = {
    getUser: (token) => Promise.resolve(token === tokenFor(user) ? { id: user, providers: ["email"], appleSubjects: [] } : null),
    rpc,
    revokeX: (token, hint) => { revoked.push(`${hint}:${token}`); return Promise.resolve(revokeOk()); },
    revokeApple: null,
    sha256Hex,
    nowSeconds: () => Math.floor(Date.now() / 1000),
  };
  return { deps, revoked };
}
const run = (user: string, deps: DeletionDeps) =>
  handleAccountDeletion({ authorization: `Bearer ${tokenFor(user)}`, body: { ...xServiceEndRequest(), confirmation: CONFIRMATION } }, deps);

/** TEST STAND-IN: a person with the X workspace (fixture), Kabumori data (scope social_only), an enabled authority row,
 *  two planned reservations and a reservation audit row. */
async function person(user: string, prefix: string): Promise<{ ws: string; account: string }> {
  await withOwner(async (c) => {
    await c.queryArray({ text: "select public.fixture_login($1::uuid)", args: [user] });
    await c.queryArray("BEGIN");
    await c.queryArray({ text: "select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', 'authenticated', true)", args: [user] });
    await c.queryArray("SET LOCAL ROLE authenticated");
    const started = await c.queryArray<[string]>("select public.start_kabumori_service() ->> 'status'");
    await c.queryArray("COMMIT");
    assert.equal(started.rows[0][0], "active", "setup: Kabumori service");
  });
  await owner("insert into public.profiles (id) values ($1::uuid) on conflict do nothing", [user]);
  const ws = String(await scalar("select public.fixture_user_with_workspace($1::uuid, $2)", [user, prefix]));
  const account = String(await scalar("select id from public.social_accounts where brand_id = $1", [ws]));
  await owner(`insert into public.x_account_publish_authority (social_account_id, state, starts_at, expires_at, reason_code)
               values ($1, 'enabled', now() - interval '1 minute', now() + interval '7 days', 'TEST_STAND_IN')`, [account]);
  const batch = String(await scalar(`insert into postona_x_resv.batches (user_id, brand_id, social_account_id, client_batch_id, revision, mode, origin, time_zone, band, payload_sha256)
               values ($1::uuid, $2, $3, gen_random_uuid(), 1, 'manual_exact', 'user_authored', 'Asia/Tokyo', null, repeat('a', 64)) returning id::text`, [user, ws, account]));
  await owner(`insert into postona_x_resv.reservations (batch_id, user_id, brand_id, social_account_id, draft_id, position, origin, mode, body, content_sha256,
               scheduled_at, fixed, status, consent_state, expires_at)
               select $1::uuid, $2::uuid, $3, $4, $5 || g, g, 'user_authored', 'manual_exact', 'b', repeat('c', 64), now() + (g + 1) * interval '1 day',
                      true, 'planned', 'confirmed', now() + interval '30 days' from generate_series(0, 1) g`, [batch, user, ws, account, prefix]);
  await owner("insert into postona_x_resv.audit (user_id, batch_id, action) values ($1::uuid, $2::uuid, 'create_batch')", [user, batch]);
  return { ws, account };
}
const authority = (account: string) => scalar("select state from public.x_account_publish_authority where social_account_id = $1", [account]);

const BYSTANDER = "00000000-0000-4000-8000-0000000000b9";
let bystander: { ws: string; account: string };

Deno.test("the RPC map here equals http.ts", async () => {
  const source = await Deno.readTextFile(new URL("../../../functions/social-mobile-account-delete/http.ts", import.meta.url));
  for (const [name, fn] of Object.entries(RPC_NAMES)) assert.match(source, new RegExp(`${name}: '${fn}'`, "u"), name);
});

Deno.test("POSTONA end (social_only): stop -> revoke at X -> pre-purge cleanup -> purge -> finalize; nothing left, login kept", async () => {
  bystander = await person(BYSTANDER, "bystander");
  const user = "00000000-0000-4000-8000-0000000000b1";
  const { ws, account } = await person(user, "happy");
  const { deps, revoked } = depsFor(user);
  const answer = await run(user, deps);
  assert.deepEqual(answer, { status: 200, body: { ok: true, login_deleted: false } });
  assert.deepEqual(xServiceEndOutcomeOf(answer.status, answer.body), { status: "done", unconfirmedPosts: 0 });
  assert.deepEqual(revoked, ["refresh_token:fake_happy_REFRESH", "access_token:fake_happy_ACCESS"], "X revoked exactly once each");
  assert.equal(await scalar("select count(*)::int from public.social_accounts where brand_id = $1", [ws]), 0);
  assert.equal(await authority(account), undefined, "authority row removed with the workspace");
  assert.equal(await scalar("select count(*)::int from postona_x_resv.reservations where brand_id = $1", [ws]), 0);
  assert.equal(await scalar("select count(*)::int from postona_x_resv.audit where user_id = $1::uuid", [user]), 0, "no raw user id left");
  assert.equal(await scalar("select count(*)::int from public.social_mobile_account_deletions where user_id = $1::uuid", [user]), 0);
  assert.equal(await authority(bystander.account), "enabled", "another person untouched");
});

Deno.test("a reservation in flight blocks with a TYPED reason before any X call; publishing is already stopped; a stale lease is fenced and reported", async () => {
  const user = "00000000-0000-4000-8000-0000000000b2";
  const { ws, account } = await person(user, "flight");
  await owner(`update postona_x_resv.reservations set status = 'claimed', lease_token = gen_random_uuid(), lease_expires_at = now() + interval '2 minutes'
               where brand_id = $1 and draft_id = 'flight0'`, [ws]);
  const { deps, revoked } = depsFor(user);
  const blocked = await run(user, deps);
  assert.deepEqual(blocked, { status: 409, body: { ok: false, error: "DELETION_BLOCKED_POSTING_IN_PROGRESS" } });
  assert.deepEqual(xServiceEndOutcomeOf(blocked.status, blocked.body), { status: "blocked", reason: "POSTING_IN_PROGRESS", retryable: true });
  assert.deepEqual(revoked, [], "nothing revoked at X while a post is in flight");
  assert.equal(await authority(account), "revoked", "publishing stopped anyway");
  assert.equal(await scalar("select status from postona_x_resv.reservations where brand_id = $1 and draft_id = 'flight1'", [ws]), "cancelled");
  assert.equal(await scalar("select state from public.social_mobile_account_deletions where user_id = $1::uuid", [user]), "started", "no operator hand-off");
  // The worker's lease runs out without a result: the next attempt fences it to 'uncertain' and reports it.
  await owner("update postona_x_resv.reservations set lease_expires_at = now() - interval '1 second' where brand_id = $1 and status = 'claimed'", [ws]);
  const done = await run(user, deps);
  assert.deepEqual(done, { status: 200, body: { ok: true, login_deleted: false, x_posts_unconfirmed: 1 } });
  assert.deepEqual(xServiceEndOutcomeOf(done.status, done.body), { status: "done", unconfirmedPosts: 1 });
});

Deno.test("X does not confirm the revoke: reconciliation_required, never done; publishing already stopped; a retry ends it", async () => {
  const user = "00000000-0000-4000-8000-0000000000b3";
  const { ws, account } = await person(user, "revokefail");
  let fail = true;
  const { deps, revoked } = depsFor(user, () => !fail);
  const first = await run(user, deps);
  assert.deepEqual(first, { status: 502, body: { ok: false, error: "X_REVOKE_FAILED" } });
  assert.deepEqual(xServiceEndOutcomeOf(first.status, first.body), { status: "reconciliation_required", reason: "X_REVOKE_FAILED" });
  assert.equal(await authority(account), "revoked");
  assert.equal(await scalar("select count(*)::int from public.social_accounts where brand_id = $1", [ws]), 1, "nothing removed");
  fail = false;
  const second = await run(user, deps);
  assert.equal(second.status, 200);
  assert.ok(revoked.length >= 3);
});

Deno.test("a non-X social account still in the workspace blocks with a TYPED reason (no operator hand-off); after it is removed, the end completes", async () => {
  const user = "00000000-0000-4000-8000-0000000000b4";
  const { ws } = await person(user, "nonx");
  await owner("alter table public.social_accounts drop constraint if exists social_accounts_platform_check");
  await owner("insert into public.social_accounts (id, brand_id, platform) values ($1, $2, 'threads')", [`th_${ws}`, ws]);
  const { deps, revoked } = depsFor(user);
  const blocked = await run(user, deps);
  assert.deepEqual(blocked, { status: 409, body: { ok: false, error: "DELETION_BLOCKED_NON_X_ACCOUNT_PRESENT" } });
  assert.deepEqual(xServiceEndOutcomeOf(blocked.status, blocked.body), { status: "blocked", reason: "NON_X_ACCOUNT_PRESENT", retryable: true });
  assert.deepEqual(revoked, []);
  assert.equal(await scalar("select count(*)::int from public.social_mobile_account_deletions where user_id = $1::uuid", [user]), 0, "nothing recorded: no tombstone, no bound credential set");
  // F4's Threads cleanup would remove its account here (TEST STAND-IN, with the deletion guard bypassed as the owner).
  const admin = new Client(SUPER_URL);
  await admin.connect();
  try {
    await admin.queryArray("BEGIN");
    await admin.queryArray("SET LOCAL session_replication_role = replica");
    await admin.queryArray({ text: "delete from public.social_accounts where id = $1", args: [`th_${ws}`] });
    await admin.queryArray("COMMIT");
  } finally {
    await admin.end();
  }
  const done = await run(user, deps);
  assert.equal(done.status, 200);
});

Deno.test("two attempts at once: exactly one runs, the other is in_progress; X is revoked once", async () => {
  const user = "00000000-0000-4000-8000-0000000000b5";
  await person(user, "twice");
  const { deps, revoked } = depsFor(user);
  const [a, b] = await Promise.all([run(user, deps), run(user, deps)]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const loser = a.status === 409 ? a : b;
  assert.deepEqual(xServiceEndOutcomeOf(loser.status, loser.body), { status: "in_progress" });
  assert.equal(revoked.length, 2);
  assert.equal(await authority(bystander.account), "enabled");
});

// ---------------------------------------------------------------------------------------------------
// R1 (J3 V3): an X post whose result is unknown survives a committed purge + failed finalize, a crash with a lease
// takeover and even a whole later run, until it is acknowledged. X is never revoked twice.
// ---------------------------------------------------------------------------------------------------
const durableRows = (user: string) =>
  scalar("select count(*)::int from public.social_mobile_account_deletion_x_unconfirmed where subject_sha256 = public.social_mobile_account_deletion_subject($1::uuid)", [user]);

async function inFlightExpired(user: string, prefix: string) {
  const p = await person(user, prefix);
  await owner(`update postona_x_resv.reservations set status = 'claimed', lease_token = gen_random_uuid(), lease_expires_at = now() - interval '1 second'
               where brand_id = $1 and draft_id = $2`, [p.ws, `${prefix}0`]);
  return p;
}
/** finalize fails once (transport); with crash = true the process also dies before releasing its lease. */
function finalizeFailsOnce(user: string, crash: boolean) {
  const base = depsFor(user);
  let failed = false;
  const wrapped: DeletionDeps["rpc"] = (name, args) => {
    if (name === "finalize" && !failed) { failed = true; return Promise.resolve({ ok: false, code: null }); }
    if (name === "release" && crash) return Promise.resolve({ ok: true, data: null });
    return rpc(name, args);
  };
  return { deps: { ...base.deps, rpc: wrapped }, plain: base.deps, revoked: base.revoked };
}

Deno.test("R1: expired in-flight -> uncertain -> purge COMMIT -> finalize fails -> retry still reports the unknown X post", async () => {
  const user = "00000000-0000-4000-8000-0000000000b6";
  const { ws } = await inFlightExpired(user, "ckpt");
  const { deps, plain, revoked } = finalizeFailsOnce(user, false);
  const first = await run(user, deps);
  assert.deepEqual(first, { status: 500, body: { ok: false, error: "FINALIZE_FAILED" } });
  assert.equal(await scalar("select state from public.social_mobile_account_deletions where user_id = $1::uuid", [user]), "purged", "the purge committed");
  assert.equal(await scalar("select count(*)::int from postona_x_resv.reservations where brand_id = $1", [ws]), 0, "the reservation rows are gone");
  assert.equal(revoked.length, 2);
  // Second line: the stop step itself (state purged -> not_applicable) still answers the durable count.
  const lease = await rpc("acquire", { p_expected_scope: "social_only", p_apple_required: false, p_user_id: user });
  assert.ok(lease.ok);
  const leaseArgs = { p_lease: (lease.data as { lease: string }).lease, p_user_id: user };
  assert.deepEqual(await rpc("stop_x", leaseArgs), { ok: true, data: { status: "not_applicable", state: "purged", x_posts_unconfirmed: 1, reconciliation_required: true } });
  assert.ok((await rpc("release", leaseArgs)).ok);
  const retry = await run(user, plain);
  assert.deepEqual(retry, { status: 200, body: { ok: true, login_deleted: false, x_posts_unconfirmed: 1 } });
  assert.deepEqual(xServiceEndOutcomeOf(retry.status, retry.body), { status: "done", unconfirmedPosts: 1 });
  assert.equal(revoked.length, 2, "X is never revoked twice");
  assert.equal(await durableRows(user), 1, "the unknown post is checkpointed durably (until acknowledged)");
});

Deno.test("R1: a crash after the purge (lease kept) -> in_progress -> lease takeover -> later runs still report it until acknowledged", async () => {
  const user = "00000000-0000-4000-8000-0000000000b7";
  await inFlightExpired(user, "crash");
  const { deps, plain, revoked } = finalizeFailsOnce(user, true);
  assert.equal((await run(user, deps)).status, 500);
  assert.deepEqual(await run(user, plain), { status: 409, body: { ok: false, error: "DELETION_IN_PROGRESS" } }, "the dead attempt still holds its lease");
  await owner("update public.social_mobile_account_deletions set lease_expires_at = now() - interval '1 second' where user_id = $1::uuid", [user]);
  const takeover = await run(user, plain);
  assert.deepEqual(takeover, { status: 200, body: { ok: true, login_deleted: false, x_posts_unconfirmed: 1 } });
  assert.equal(revoked.length, 2, "X is never revoked twice");
  // A whole new run after the finished deletion (the tombstone is gone) still reports it.
  assert.deepEqual(await run(user, plain), { status: 200, body: { ok: true, login_deleted: false, x_posts_unconfirmed: 1 } });
  // The record holds no raw user id: only the subject hash and the random reservation id.
  assert.equal(await scalar("select count(*)::int from public.social_mobile_account_deletion_x_unconfirmed where subject_sha256 = $1", [await sha256Hex(user)]), 1);
  // Acknowledgement: service_role only, compare-and-clear.
  const ack = async (expected: number, role = "service_role") => await withOwner(async (c) => {
    await c.queryArray("BEGIN");
    try {
      await c.queryArray(`SET LOCAL ROLE ${role}`);
      const r = await c.queryArray<[string]>({ text: "select public.social_mobile_account_deletion_x_unconfirmed_ack($1::uuid, $2)::text", args: [user, expected] });
      await c.queryArray("COMMIT");
      return JSON.parse(r.rows[0][0]);
    } catch (error) {
      await c.queryArray("ROLLBACK");
      return { error: (error as { fields?: { message?: string } }).fields?.message ?? "" };
    }
  });
  assert.match((await ack(1, "authenticated")).error, /permission denied/u);
  assert.deepEqual(await ack(2), { status: "count_changed", x_posts_unconfirmed: 1 });
  assert.deepEqual(await ack(1), { status: "acknowledged", cleared: 1 });
  assert.equal(await durableRows(user), 0);
  assert.deepEqual(await run(user, plain), { status: 200, body: { ok: true, login_deleted: false } });
  assert.equal(await durableRows(BYSTANDER), 0, "another person has no record");
});
