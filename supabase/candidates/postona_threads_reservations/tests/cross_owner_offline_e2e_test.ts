// G3 TASK 9/50: ONE Threads reservation flow across the three owners, on a disposable LOCAL PostgreSQL (run by
// postona_threads_cross_owner_run.sh only). Network: 127.0.0.1 (PostgreSQL) only -- Threads is a FAKE Graph API
// (an in-process fetch); a request to any other origin is refused and counted.
//   G3  candidate 007 (create -> claim_due -> preflight -> record -> receipt), the HTTP fixture, PR #356's dispatcher
//       with its native beforePublish hook
//   G4  the REAL source of threads_send_port.ts / g5_owner_epoch_token.ts (an isolated, unedited copy of a pinned G4
//       head, THREADS_G4_SOCIAL_DIR): createGatedThreadsSendPort(true, 'simulated', fakeGraph) does the two-step send
//       and awaits the hook; parseThreadsCredentialRow reads the one-statement credential row; the gated credential
//       port is exercised as G4 ships it
//   G5  R1 / W1 test doubles (tests/g5_verdict_test_double.sql): the two numbers of g5oe:<epoch>:<lifecycle> stored
//       at create, handed unchanged to W1 at claim, preflight and beforePublish
// MOCK_ONLY: caller verdicts, the token (fake), Threads. Nothing here is evidence of a real post.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Client } from "jsr:@db/postgres@0.19.5";
import {
  runThreadsReservationDelivery, THREADS_DISPATCH_ENABLED, type ThreadsCredentialPort, type ThreadsDispatchStore, type ThreadsSendPort,
} from "../../../functions/_shared/postona_reservations/threads_dispatch.ts";
import { createPgPersonStore, createPgWorkerStore } from "../fixture/pg_fixture_ports.ts";
import { createThreadsReservationHttpFixture, type VerifiedCaller } from "../fixture/threads_reservation_http_fixture.ts";

const API_URL = Deno.env.get("THREADS_XO_API_URL")!;
const WORKER_URL = Deno.env.get("THREADS_XO_WORKER_URL")!;
const OWNER_URL = Deno.env.get("THREADS_XO_OWNER_URL")!;
const G4_DIR = Deno.env.get("THREADS_G4_SOCIAL_DIR")!;
assert.ok(API_URL && WORKER_URL && OWNER_URL && G4_DIR, "set by postona_threads_cross_owner_run.sh");

// ---- G4's real source (isolated copy, imported as is) --------------------------------------------------------------
type G4SendPortModule = {
  THREADS_POSTING_SERVICE_KEY: string | null;
  THREADS_SEND_PORT_ENABLED: boolean;
  THREADS_CREDENTIAL_PORT_ENABLED: boolean;
  acceptableServiceKey(key: string | null): boolean;
  parseThreadsCredentialRow(requested: string, answer: unknown): { socialAccountId: string; threadsUserId: string; accessToken: string; generation: string } | null;
  createGatedThreadsCredentialPort(enabled: boolean, key: string | null, statement: ((id: string, key: string) => Promise<unknown>) | null): ThreadsCredentialPort;
  createThreadsCredentialPort(statement?: ((id: string, key: string) => Promise<unknown>) | null): ThreadsCredentialPort;
  createGatedThreadsSendPort(enabled: boolean, transport: "threads" | "simulated", fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
    options?: { containerChecks?: number; containerCheckDelayMs?: number; sleep?: (ms: number) => Promise<void> }): ThreadsSendPort;
  createThreadsSendPort(fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>): ThreadsSendPort;
};
type G4TokenModule = { parseG5OwnerEpochToken(token: unknown): { ownerEpoch: string; lifecycleVersion: string } | null };
const fileUrl = (path: string) => new URL(`file://${encodeURI(path)}`).href;
const G4 = await import(fileUrl(`${G4_DIR}/threads_send_port.ts`)) as G4SendPortModule;
const G4T = await import(fileUrl(`${G4_DIR}/g5_owner_epoch_token.ts`)) as G4TokenModule;
// Which G4 contract this copy carries: PR #364 (key undecided, x_autopost refused) or G4-10 / PR #373 (x_autopost adopted).
const G4_KEY = G4.THREADS_POSTING_SERVICE_KEY;
console.log(`G4_COPY service key = ${G4_KEY === null ? "null (undecided)" : G4_KEY}`);

// ---- database helpers -------------------------------------------------------------------------------------------------
const owner = async <T extends unknown[]>(text: string, args: unknown[] = []) => {
  const c = new Client(OWNER_URL);
  await c.connect();
  try {
    return (await c.queryArray<T>({ text, args })).rows;
  } finally {
    await c.end();
  }
};
const people = new Map((await owner<[number, string, string, string]>("select n, user_id::text, threads_account, brand from t_ids.people")).map(([n, u, t, b]) => [Number(n), { user: u, threads: t, brand: b }]));
const P = (n: number) => people.get(n)!;
async function reserve(n: number, text: string): Promise<string> {
  return String((await owner<[string]>(
    `insert into postona_threads_resv.reservations (user_id, brand_id, social_account_id, client_request_id, body, content_sha256, scheduled_at,
       bound_owner_epoch, bound_lifecycle_version)
     select p.user_id, p.brand, p.threads_account, gen_random_uuid(), $2, encode(sha256(convert_to($2, 'UTF8')), 'hex'), now() - interval '1 second',
       (select e.v from t_g5.owner_epoch e where e.brand_id = p.brand), (select l.v from t_g5.lifecycle l where l.user_id = p.user_id)
     from t_ids.people p where p.n = $1 returning id::text`, [n, text]))[0][0]);
}
const row = async (id: string) => (await owner<[string, string | null, boolean | null, string | null, string | null]>(
  "select status, outcome_code, after_freeze, transport, provider_post_id from postona_threads_resv.reservations where id = $1::uuid", [id]))[0];
const bound = async (id: string) => (await owner<[string, string]>(
  "select bound_owner_epoch::text, bound_lifecycle_version::text from postona_threads_resv.reservations where id = $1::uuid", [id]))[0];
const dueLeft = async () => Number((await owner<[bigint]>("select count(*) from postona_threads_resv.reservations where status = 'planned' and scheduled_at <= now()"))[0][0]);
async function restartService(n: number) {
  await owner("update public.service_entitlements set status = 'ended', ended_at = now() where user_id = $1::uuid and service_key = 'x_autopost'", [P(n).user]);
  await owner("update public.service_entitlements set status = 'active', ended_at = null where user_id = $1::uuid and service_key = 'x_autopost'", [P(n).user]);
}

// ---- the FAKE Graph API (the only "Threads" in this file) -------------------------------------------------------------
type GraphEvent = "container" | "status" | "hook" | "publish" | "readback" | "refused-origin";
type GraphOptions = {
  duringWait?: () => Promise<unknown>;
  duringPublish?: () => Promise<unknown>;
  container?: "ok" | "unknown";
  publish?: "ok" | "unknown";
  readBack?: "ok" | "unknown" | "mismatch";
};
function fakeGraph(opts: GraphOptions = {}) {
  const events: GraphEvent[] = [];
  const tokens = new Set<string>();
  const containers = new Map<string, string>();
  const media = new Map<string, string>();
  let next = 18100000000000000n;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (url.origin !== "https://graph.threads.net") {
      events.push("refused-origin");
      throw new TypeError("fake graph: origin refused");
    }
    const parts = url.pathname.split("/").filter(Boolean);
    const form = typeof init?.body === "string" ? new URLSearchParams(init.body) : null;
    const token = form?.get("access_token") ?? url.searchParams.get("access_token");
    if (token) tokens.add(token);
    if (init?.method === "POST" && parts.length === 3 && parts[2] === "threads") {
      events.push("container");
      if (opts.container === "unknown") return new Response("", { status: 502 });
      const id = String(++next);
      containers.set(id, parts[1]);
      return json({ id });
    }
    if (init?.method === "POST" && parts.length === 3 && parts[2] === "threads_publish") {
      events.push("publish");
      if (opts.duringPublish) await opts.duringPublish();
      if (opts.publish === "unknown") return new Response("", { status: 503 });
      const id = String(++next);
      media.set(id, parts[1]);
      return json({ id });
    }
    if (init?.method === "GET" && parts.length === 2 && containers.has(parts[1])) {
      events.push("status");
      if (opts.duringWait) await opts.duringWait();
      return json({ id: parts[1], status: "FINISHED" });
    }
    if (init?.method === "GET" && parts.length === 2 && media.has(parts[1])) {
      events.push("readback");
      if (opts.readBack === "unknown") return new Response("", { status: 500 });
      const ownerId = opts.readBack === "mismatch" ? "17841499999999999" : media.get(parts[1])!;
      return json({ id: parts[1], owner: { id: ownerId }, permalink: `https://www.threads.net/@g3/post/${parts[1]}` });
    }
    return json({ error: { code: 100 } }, 400);
  };
  const count = (e: GraphEvent) => events.filter((x) => x === e).length;
  return { fetchImpl, events, tokens, count };
}
// G4's REAL send port over the fake Graph ('simulated': never the deployable 'threads' transport).
const g4Sender = (g: ReturnType<typeof fakeGraph>) => G4.createGatedThreadsSendPort(true, "simulated", g.fetchImpl, { containerChecks: 1, containerCheckDelayMs: 0 });

// ---- G3's one-statement credential row, read with G4's parser ---------------------------------------------------------
// The decision, the (FAKE) token and 007's generation come from ONE statement, in the column set G4 requires.
let generationOverride: string | null = null;
const oneStatement = async (account: string) => (await owner<[string, string, string, string]>(
  `select sa.id, sa.platform_user_id, 'fake-threads-token-' || sa.id, postona_threads_resv.threads_credential_generation(sa.id)
     from public.social_accounts sa where sa.id = $1 and sa.platform = 'threads' and sa.connection_status = 'identity_verified'`, [account]))
  .map(([social_account_id, threads_user_id, access_token, generation]) => ({ social_account_id, threads_user_id, access_token, generation: generationOverride ?? generation }));
const credentials: ThreadsCredentialPort = {
  available: true,
  credentialFor: async (account) => G4.parseThreadsCredentialRow(account, await oneStatement(account)),
};

const workerStore = createPgWorkerStore(WORKER_URL);
function traced(store: ThreadsDispatchStore, g: ReturnType<typeof fakeGraph>): ThreadsDispatchStore {
  // Marks each preflight that happens after the container step: that one is the beforePublish re-check.
  return { ...store, preflight: async (id, lease) => { if (g.events.includes("container")) g.events.push("hook"); return await store.preflight(id, lease); } };
}
const deliver = (sender: ThreadsSendPort, extra: { store?: ThreadsDispatchStore; worker?: string; creds?: ThreadsCredentialPort; enabled?: boolean; prepublishTimeoutMs?: number } = {}) =>
  runThreadsReservationDelivery({ enabled: extra.enabled ?? true, store: extra.store ?? workerStore, credentials: extra.creds ?? credentials, sender,
    worker: extra.worker ?? "cross-owner-w1", leaseSeconds: 60, limit: 50, prepublishTimeoutMs: extra.prepublishTimeoutMs });

// ---- tests -----------------------------------------------------------------------------------------------------------
Deno.test("X0 deny-net: no permission for any Threads / Meta host; only 127.0.0.1 is reachable", async () => {
  for (const host of ["graph.threads.net", "graph.facebook.com", "threads.net", "api.x.com"]) {
    assert.notEqual((await Deno.permissions.query({ name: "net", host })).state, "granted", host);
  }
  assert.equal(THREADS_DISPATCH_ENABLED, false);
});

Deno.test("X1 one flow: 007 row -> claim (W1) -> G4 real send port: container -> status -> beforePublish (W1 again) -> publish -> read-back -> published; the two G5 numbers are never rewritten", async () => {
  const id = await reserve(61, "X1 横断 送信");
  const before = await bound(id);
  const g = fakeGraph();
  const r = await deliver(g4Sender(g), { store: traced(workerStore, g) });
  assert.deepEqual(g.events, ["container", "status", "hook", "publish", "readback"]);
  assert.deepEqual([r.claimed, r.sends, r.prepublishRechecks, r.published, r.uncertain], [1, 1, 1, 1, 0]);
  const [status, code, freeze, transport, postId] = await row(id);
  assert.deepEqual([status, code, freeze, transport], ["published", "PUBLISHED", false, "simulated"]);
  assert.match(postId!, /^[1-9][0-9]+$/u);
  assert.deepEqual(await bound(id), before, "stored owner_epoch / lifecycle_version unchanged");
  assert.deepEqual([...g.tokens], [`fake-threads-token-${P(61).threads}`], "only the fake token of this account reached the fake Graph");
});

Deno.test("X2 G5 changes (and a credential rotation) during G4's container wait -> beforePublish false -> 0 publish requests; W1's code on the row; never uncertain", async () => {
  const cases: [number, string, () => Promise<unknown>, string][] = [
    [62, "service end + restart (ABA, same instant)", () => restartService(62), "SERVICE_GENERATION_CHANGED"],
    [63, "owner A -> B -> A", async () => {
      await owner("insert into public.brand_memberships (brand_id, user_id, role) values ($1, $2::uuid, 'owner')", [P(63).brand, P(99).user]);
      await owner("delete from public.brand_memberships where brand_id = $1 and user_id = $2::uuid", [P(63).brand, P(99).user]);
    }, "OWNER_EPOCH_CHANGED"],
    [64, "account deletion starts", () => owner("update public.common_accounts set status = 'deleting' where user_id = $1::uuid", [P(64).user]), "ACCOUNT_DELETION_IN_PROGRESS"],
    [65, "entitlement ended", () => owner("update public.service_entitlements set status = 'ended', ended_at = now() where user_id = $1::uuid and service_key = 'x_autopost'", [P(65).user]), "SERVICE_NOT_ACTIVE"],
    // G4's credential rotated while the container waited: 007 compares the generation bound at claim and refuses first
    [89, "credential rotated", () => owner("update public.threads_account_credential_custody set vault_secret_id = gen_random_uuid(), recorded_at = now() where social_account_id = $1", [P(89).threads]), "CREDENTIAL_CHANGED"],
  ];
  for (const [n, label, change, code] of cases) {
    const id = await reserve(n, `X2 ${label}`);
    const before = await bound(id);
    const g = fakeGraph({ duringWait: change });
    const r = await deliver(g4Sender(g), { store: traced(workerStore, g) });
    assert.deepEqual(g.events, ["container", "status", "hook"], label);
    assert.equal(g.count("publish"), 0, label);
    assert.deepEqual([r.prepublishRechecks, r.prepublishRefused, r.uncertain, r.published], [1, 1, 0, 0], label);
    assert.deepEqual((await row(id)).slice(0, 2), ["failed", code], label);
    assert.deepEqual(await bound(id), before, label);
  }
});

Deno.test("X3 the re-check throws or is late -> G4 sends no publish request; 007 records THREADS_PREPUBLISH_UNVERIFIED", async () => {
  for (const [n, kind] of [[66, "throws"], [67, "late"]] as const) {
    const id = await reserve(n, `X3 ${kind}`);
    const g = fakeGraph();
    let calls = 0;
    const odd: ThreadsDispatchStore = {
      ...workerStore,
      preflight: async (rid, lease) => {
        calls += 1;
        if (calls === 2 && kind === "throws") throw new Error("connection reset");
        if (calls === 2) await new Promise((resolve) => setTimeout(resolve, 200));
        return workerStore.preflight(rid, lease);
      },
    };
    const r = await deliver(g4Sender(g), { store: odd, prepublishTimeoutMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(g.count("publish"), 0, kind);
    assert.deepEqual([r.failedBeforeSend, r.prepublishRefused], [1, 1], kind);
    assert.deepEqual((await row(id)).slice(0, 2), ["failed", "THREADS_PREPUBLISH_UNVERIFIED"], kind);
  }
});

Deno.test("X4 G5 changes AFTER the hook said yes (during the publish request) -> published once, after_freeze = true", async () => {
  const id = await reserve(68, "X4 late freeze");
  const g = fakeGraph({ duringPublish: () => restartService(68) });
  const r = await deliver(g4Sender(g));
  assert.deepEqual([g.count("publish"), r.published], [1, 1]);
  assert.deepEqual((await row(id)).slice(0, 3), ["published", "PUBLISHED", true]);
});

Deno.test("X5 unknown outcomes are never re-sent: publish unknown / read-back unknown / read-back mismatch -> uncertain; a second worker run sends nothing", async () => {
  const cases: [number, GraphOptions, string][] = [
    [69, { publish: "unknown" }, "THREADS_UNAVAILABLE"],
    [70, { readBack: "unknown" }, "THREADS_READBACK_UNKNOWN"],
    [71, { readBack: "mismatch" }, "THREADS_READBACK_MISMATCH"],
  ];
  for (const [n, opts, code] of cases) {
    const id = await reserve(n, `X5 ${code}`);
    const g = fakeGraph(opts);
    const r = await deliver(g4Sender(g));
    assert.deepEqual([g.count("publish"), r.uncertain, r.published], [1, 1, 0], code);
    assert.deepEqual((await row(id)).slice(0, 2), ["uncertain", code], code);
    const [[clientId]] = await owner<[string]>("select client_request_id::text from postona_threads_resv.reservations where id = $1::uuid", [id]);
    const rc = await req(tokenOf(n), { op: "receipt", socialAccountId: P(n).threads, clientRequestId: clientId });
    assert.deepEqual([rc.status, rc.body.state, rc.body.action, "xPostId" in rc.body], [200, "uncertain", "none", false], `${code}: receipt says unconfirmed, no automatic resend`);
    const g2 = fakeGraph();
    const again = await deliver(g4Sender(g2));
    assert.deepEqual([again.claimed, g2.events.length], [0, 0], `${code}: no second attempt`);
  }
});

Deno.test("X6 container unknown -> no container id is held -> failed THREADS_CONTAINER_UNKNOWN_NOT_POSTED, 0 publish requests", async () => {
  const id = await reserve(72, "X6 container unknown");
  const g = fakeGraph({ container: "unknown" });
  const r = await deliver(g4Sender(g));
  assert.deepEqual([g.events, r.failedBeforeSend], [["container"], 1]);
  assert.deepEqual((await row(id)).slice(0, 2), ["failed", "THREADS_CONTAINER_UNKNOWN_NOT_POSTED"]);
});

Deno.test("X7 the lease is lost during the container wait -> beforePublish false, 0 publish requests, the row is not ours to record", async () => {
  const id = await reserve(73, "X7 lease lost");
  const g = fakeGraph({ duringWait: () => owner("update postona_threads_resv.reservations set lease_token = gen_random_uuid() where id = $1::uuid", [id]) });
  const r = await deliver(g4Sender(g));
  assert.deepEqual([g.count("publish"), r.prepublishRefused, r.skipped, r.published, r.uncertain], [0, 1, 1, 0, 0]);
  assert.equal((await row(id))[0], "claimed");
  // the stolen lease expires -> fenced to uncertain by the next claim, never sent
  await owner("update postona_threads_resv.reservations set lease_expires_at = now() - interval '1 second' where id = $1::uuid", [id]);
  const g2 = fakeGraph();
  const again = await deliver(g4Sender(g2));
  assert.deepEqual([again.claimed, g2.events.length], [0, 0]);
  assert.deepEqual((await row(id)).slice(0, 2), ["uncertain", "LEASE_EXPIRED"]);
});

Deno.test("X8 G4 credential generation (64 hex) disagreements -> no Graph request at all", async () => {
  const cases: [number, string, string][] = [
    [74, "0".repeat(64), "CREDENTIAL_GENERATION_CHANGED"], // well-formed but not 007's
    [75, "A".repeat(64), "THREADS_CREDENTIALS_UNAVAILABLE"], // not lowercase hex: G4's parser refuses the row
    [76, "abc", "THREADS_CREDENTIALS_UNAVAILABLE"],
  ];
  try {
    for (const [n, generation, code] of cases) {
      const id = await reserve(n, `X8 ${code}`);
      generationOverride = generation;
      const g = fakeGraph();
      const r = await deliver(g4Sender(g));
      assert.deepEqual([g.events.length, r.sends, r.failedBeforeSend], [0, 0, 1], code);
      assert.deepEqual((await row(id)).slice(0, 2), ["failed", code], code);
    }
  } finally {
    generationOverride = null;
  }
});

Deno.test("X9 two workers at once over six due rows -> each row claimed by one worker and published exactly once", async () => {
  const ids = await Promise.all([77, 78, 79, 80, 81, 82].map((n) => reserve(n, `X9 ${n}`)));
  const ga = fakeGraph(), gb = fakeGraph();
  const [ra, rb] = await Promise.all([deliver(g4Sender(ga), { worker: "cron-a" }), deliver(g4Sender(gb), { worker: "cron-b" })]);
  assert.equal(ra.claimed + rb.claimed, 6);
  assert.equal(ga.count("publish") + gb.count("publish"), 6);
  assert.equal(ra.published + rb.published, 6);
  for (const id of ids) assert.equal((await row(id))[0], "published");
});

Deno.test("X10 the record answer is lost after the publish -> the report says uncertain; the lease expires into uncertain; never sent again", async () => {
  const id = await reserve(83, "X10 record lost");
  const g = fakeGraph();
  const lossy: ThreadsDispatchStore = { ...workerStore, record: () => Promise.reject(new Error("connection reset before the answer")) };
  const r = await deliver(g4Sender(g), { store: lossy });
  assert.deepEqual([g.count("publish"), r.uncertain, r.published], [1, 1, 0]);
  assert.equal((await row(id))[0], "claimed");
  await owner("update postona_threads_resv.reservations set lease_expires_at = now() - interval '1 second' where id = $1::uuid", [id]);
  const g2 = fakeGraph();
  const again = await deliver(g4Sender(g2));
  assert.deepEqual([again.claimed, g2.events.length], [0, 0]);
  assert.deepEqual((await row(id)).slice(0, 2), ["uncertain", "LEASE_EXPIRED"]);
});

// ---- HTTP: actor / tenant / idempotency / receipt -----------------------------------------------------------------------
const verdicts = new Map<string, VerifiedCaller>();
const tokenOf = (n: number) => {
  const token = `tok-${n}-0123456789abcdef`;
  verdicts.set(token, { userId: P(n).user, sessionId: crypto.randomUUID() });
  return token;
};
const http = createThreadsReservationHttpFixture({ enabled: true, verify: (t: string) => Promise.resolve(verdicts.get(t) ?? null), store: createPgPersonStore(API_URL) });
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
async function req(token: string, body: unknown) {
  const res = await http(new Request("http://fixture.local/threads-reservations", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
const createBody = (account: string, id: string, text: string, at: string) =>
  ({ op: "create", socialAccountId: account, clientRequestId: id, text, scheduledAt: at, consent: { confirmed: true, contentSha256: sha(text) } });

Deno.test("X11 HTTP: same id twice = one row and one publish; another person's account (another workspace) refused; the receipt is the owner's only and carries no text", async () => {
  const t84 = tokenOf(84), t85 = tokenOf(85);
  const id = crypto.randomUUID(), text = "X11 同じ ID", at = new Date(Date.now() + 10 * 60_000).toISOString();
  const first = await req(t84, createBody(P(84).threads, id, text, at));
  const again = await req(t84, createBody(P(84).threads, id, text, at));
  assert.deepEqual([first.status, first.body.created, again.status, again.body.created, again.body.reservationId], [200, true, 200, false, first.body.reservationId]);
  const cross = await req(t85, createBody(P(84).threads, crypto.randomUUID(), "X11 他人の口座", at));
  assert.notEqual(cross.status, 200, "a person cannot reserve on another workspace's Threads account");
  assert.equal(Number((await owner<[bigint]>("select count(*) from postona_threads_resv.reservations where social_account_id = $1", [P(84).threads]))[0][0]), 1);

  await owner("update postona_threads_resv.reservations set scheduled_at = now() - interval '1 second' where id = $1::uuid", [first.body.reservationId]);
  const g = fakeGraph();
  await deliver(g4Sender(g));
  assert.equal(g.count("publish"), 1);
  const mine = await req(t84, { op: "receipt", socialAccountId: P(84).threads, clientRequestId: id });
  assert.deepEqual([mine.status, mine.body.state, mine.body.simulated, mine.body.action], [200, "sent", true, "none"]);
  assert.match(String(mine.body.xPostId), /^[1-9][0-9]+$/u);
  const all = JSON.stringify(mine.body);
  assert.ok(!all.includes(text) && !("text" in mine.body) && !("body" in mine.body) && !all.includes("fake-threads-token"), "text-free, token-free");
  const theirs = await req(t85, { op: "receipt", socialAccountId: P(84).threads, clientRequestId: id });
  assert.equal(theirs.status, 404, "another person gets the constant not-found");
  assert.ok(!JSON.stringify(theirs.body).includes(String(mine.body.xPostId)), "no post id for another person");
});

Deno.test("X12 the cron worker role cannot create, and the API role cannot claim (roles stay separate)", async () => {
  const asRole = async (url: string, role: string, sql: string) => {
    const c = new Client(url);
    await c.connect();
    try {
      await c.queryArray("BEGIN");
      await c.queryArray(`SET LOCAL ROLE ${role}`);
      await c.queryArray(sql);
      return "ran";
    } catch (e) {
      return (e as { fields?: { code?: string } }).fields?.code ?? "error";
    } finally {
      await c.queryArray("ROLLBACK").catch(() => undefined);
      await c.end().catch(() => undefined);
    }
  };
  assert.equal(await asRole(WORKER_URL, "postona_resv_worker", `select * from postona_threads_resv.create_reservation('${P(86).threads}', gen_random_uuid(), 'x', repeat('0', 64), now())`), "42501");
  assert.equal(await asRole(API_URL, "postona_resv_api", "select * from postona_threads_resv.claim_due('api', 60, 1)"), "42501");
});

// ---- service key, OFF and G4's credential port as shipped --------------------------------------------------------------
Deno.test("X13 OFF / unavailable -> claim 0: dispatcher off, G4 send port closed, G4's deployable ports", async () => {
  const id = await reserve(87, "X13 OFF");
  const g = fakeGraph();
  const off = [
    await deliver(g4Sender(g), { enabled: false }),
    await deliver(G4.createGatedThreadsSendPort(false, "simulated", g.fetchImpl)),
    await deliver(G4.createThreadsSendPort(g.fetchImpl)), // the deployable send port (THREADS_SEND_PORT_ENABLED = false)
    await deliver(g4Sender(g), { creds: G4.createThreadsCredentialPort(oneStatementForG4) }), // the deployable credential port
  ];
  for (const r of off) assert.deepEqual([r.notAvailable, r.claimed], [true, 0]);
  assert.deepEqual([g.events.length, (await row(id))[0]], [0, "planned"]);
  await owner("update postona_threads_resv.reservations set status = 'cancelled' where id = $1::uuid", [id]);
});

// G4's credential statement shape: (socialAccountId, serviceKey) -> the row. The key is only passed through here.
async function oneStatementForG4(account: string, _serviceKey: string) {
  return await oneStatement(account);
}

Deno.test("X14 G4's gated credential port on the real account-id shape: service key gate, then the id gate", async () => {
  const id = await reserve(88, "X14 key + id");
  // a) G5's common key x_autopost
  const common = G4.createGatedThreadsCredentialPort(true, "x_autopost", oneStatementForG4);
  if (G4_KEY === null) {
    // PR #364: x_autopost is refused -> the port is unavailable -> the dispatcher claims nothing (UNCONNECTED point 1)
    assert.equal(common.available, false);
    const g = fakeGraph();
    const r = await deliver(g4Sender(g), { creds: common });
    assert.deepEqual([r.notAvailable, r.claimed, g.events.length], [true, 0, 0]);
  } else {
    assert.equal(G4_KEY, "x_autopost");
    assert.equal(common.available, true);
  }
  // the app key and malformed keys never open it
  for (const key of ["kabumori", "", "X_AUTOPOST", null]) assert.equal(G4.createGatedThreadsCredentialPort(true, key, oneStatementForG4).available, false, String(key));
  // a provisional key that is not G5's: PR #364 accepts any other well-formed key (only its deployable port, whose key is
  // null, stays closed); G4-10 accepts G5's common key only
  assert.equal(G4.createGatedThreadsCredentialPort(true, "threads_autopost", oneStatementForG4).available, G4_KEY === null);
  // b) an open port (x_autopost on G4-10, a synthetic key on PR #364) still refuses every non-UUID account id. Real
  //    public.social_accounts ids are text slugs (CHECK ^[a-z][a-z0-9_]{1,80}$; G4 PR #124 makes 'sa_<24 hex>'), so no
  //    credential is handed out for a real row (UNCONNECTED point 2): the reservation fails before any Graph request.
  const open = G4.createGatedThreadsCredentialPort(true, G4_KEY ?? "g3_synthetic_test_key", oneStatementForG4);
  assert.equal(open.available, true);
  assert.equal(await open.credentialFor(P(88).threads), null);
  assert.equal(await open.credentialFor("sa_" + "0123456789abcdef01234567"), null);
  const g = fakeGraph();
  const r = await deliver(g4Sender(g), { creds: open });
  assert.deepEqual([r.claimed, r.sends, g.events.length, r.failedBeforeSend], [1, 0, 0, 1]);
  assert.deepEqual((await row(id)).slice(0, 2), ["failed", "THREADS_CREDENTIALS_UNAVAILABLE"]);
});

Deno.test("X15 G4's g5oe parser and 007's parser agree on every vector (the two numbers stay exact, bigint range)", async () => {
  const vectors = ["g5oe:1:1", "g5oe:12:34", "g5oe:9223372036854775807:1", "g5oe:1:9223372036854775807", "g5oe:9223372036854775808:1", "g5oe:0:1",
    "g5oe:01:1", "g5oe:1:0", "g5oe:-1:1", "g5oe:1", "g5oe:1:1:1", "G5OE:1:1", " g5oe:1:1", "g5oe:1:1 ", "g5oe:1.0:1", "g5oe::1", "", "g5oe:18446744073709551616:2"];
  for (const v of vectors) {
    const g4 = G4T.parseG5OwnerEpochToken(v);
    const [[e, l]] = await owner<[string | null, string | null]>(
      "select t.owner_epoch::text, t.lifecycle_version::text from postona_threads_resv.parse_owner_epoch_token($1) t", [v]);
    assert.deepEqual(g4 ? [g4.ownerEpoch, g4.lifecycleVersion] : [null, null], [e, l], JSON.stringify(v));
  }
});

Deno.test("X16 nothing left behind: no due planned row, no request to any non-Graph origin in this file", async () => {
  assert.equal(await dueLeft(), 0);
});
