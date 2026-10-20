// G2 independent QA (2026-10-20, Issue #317 generation 7): the BOUNDARY between G3's Threads reservation dispatcher
// (PR #356, threads_dispatch.ts — beforePublish hook owner) and G4's Threads send port (PR #359, threads_send_port.ts —
// container -> wait -> beforePublish -> publish -> read back). Both REAL sources are composed; only the reservation store
// and the Threads Graph API are scripted fakes. Offline: no network permission is granted (see run.sh).
// The two PRs live on different stacks, so run.sh materialises G3's file at its pinned commit and passes it in.
import assert from "node:assert/strict";
import test from "node:test";
import type { FetchLike } from "../../../../supabase/functions/_shared/social/threads_publish_contract.ts";
import { createGatedThreadsSendPort, createThreadsSendPort, createThreadsCredentialPort } from "../../../../supabase/functions/_shared/social/threads_send_port.ts";

const g3Path = Deno.env.get("G3_DISPATCH_PATH");
if (!g3Path) throw new Error("run through docs/postona/qa/g2-threads-prepublish/run.sh (G3_DISPATCH_PATH not set)");
const g3 = await import(new URL(`file://${g3Path}`).href);
const { runThreadsReservationDelivery } = g3;

const USER = "17841400000000001";
const TOKEN = "THfaketoken0123456789abcdef";
const ACCOUNT = "3f6c1b8e-5d2a-4c7f-9e1b-0a2b3c4d5e6f";
const RES = "11111111-2222-4333-8444-555555555555";
const LEASE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const GEN = "a".repeat(64);
const GEN2 = "b".repeat(64);
const PERMALINK = "https://www.threads.net/@postona_g2/post/G2qa_1";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Step = () => Response | Error | Promise<Response>;
/** Scripted Threads Graph API. Records method + path only (never the token). */
function threads(steps: Step[]) {
  const calls: string[] = [];
  const queue = [...steps];
  const fetch: FetchLike = (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${new URL(input).pathname}`);
    const next = queue.shift();
    if (!next) return Promise.reject(new Error("unexpected extra request"));
    const answer = next();
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  return { fetch, calls, publishes: () => calls.filter((c) => c.endsWith("/threads_publish")).length, containers: () => calls.filter((c) => /\/threads$/u.test(c)).length };
}
const CONTAINER_OK = () => json(200, { id: "111" });
const FINISHED = () => json(200, { id: "111", status: "FINISHED" });
const PUBLISH_OK = () => json(200, { id: "222" });
const READBACK_OK = () => json(200, { id: "222", permalink: PERMALINK, owner: { id: USER } });

type Preflight = { verdict: "OK" | "LEASE_LOST" | "NOT_PUBLISHABLE" | "RELEASED"; credentialGeneration: string | null };
/** Reservation store fake: the first preflight is G3's own, every later one is the beforePublish re-check. */
function store(preflights: Array<Preflight | Error | "never">, claimed: unknown[] = [{ reservationId: RES, leaseToken: LEASE, provider: "threads", socialAccountId: ACCOUNT, body: "G2境界テスト" }]) {
  const records: Array<{ outcome: string; providerPostId: string | null; code: string | null; transport: string }> = [];
  const queue = [...preflights];
  let preflightCalls = 0;
  return {
    records,
    preflightCalls: () => preflightCalls,
    impl: {
      claimDue: () => Promise.resolve(claimed),
      preflight: () => {
        preflightCalls += 1;
        const next = queue.shift() ?? { verdict: "LEASE_LOST", credentialGeneration: null };
        if (next === "never") return new Promise<Preflight>(() => {});
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      },
      record: (_r: string, _l: string, outcome: string, providerPostId: string | null, code: string | null, transport: string) => {
        records.push({ outcome, providerPostId, code, transport });
        return Promise.resolve(outcome);
      },
      releaseUnsent: () => Promise.resolve("released"),
    },
  };
}
const credentials = (generation = GEN) => ({ available: true, credentialFor: () => Promise.resolve({ socialAccountId: ACCOUNT, threadsUserId: USER, accessToken: TOKEN, generation }) });
const sender = (fetch: FetchLike) => createGatedThreadsSendPort(true, "simulated", fetch, { containerChecks: 1, containerCheckDelayMs: 0, sleep: () => Promise.resolve() });
const OK: Preflight = { verdict: "OK", credentialGeneration: GEN };
const run = (s: ReturnType<typeof store>, send: unknown, extra: Record<string, unknown> = {}) =>
  runThreadsReservationDelivery({ enabled: true, store: s.impl, credentials: credentials(), sender: send, worker: "g2-qa", prepublishTimeoutMs: 50, ...extra });

// ---------------------------------------------------------------- golden path through both sides

test("both sides real: container -> FINISHED -> beforePublish (G3 re-check) -> publish -> read back; one hook call, one publish, published recorded", async () => {
  const api = threads([CONTAINER_OK, FINISHED, PUBLISH_OK, READBACK_OK]);
  const s = store([OK, OK]);
  const report = await run(s, sender(api.fetch));
  assert.deepEqual(api.calls.map((c) => c.split(" ")[0]), ["POST", "GET", "POST", "GET"]);
  assert.equal(api.publishes(), 1);
  assert.equal(s.preflightCalls(), 2, "G3 preflight + exactly one beforePublish re-check");
  assert.equal(report.prepublishRechecks, 1);
  assert.deepEqual(s.records, [{ outcome: "published", providerPostId: "222", code: "PUBLISHED", transport: "simulated" }]);
});

// ---------------------------------------------------------------- the re-check refuses: the container exists, the publish never goes out

for (const [label, recheck, expected] of [
  ["permission / freeze / account no longer publishable (NOT_PUBLISHABLE)", { verdict: "NOT_PUBLISHABLE", credentialGeneration: GEN }, { record: null, skipped: 1, released: 0 }],
  ["the lease was lost to another worker (LEASE_LOST)", { verdict: "LEASE_LOST", credentialGeneration: null }, { record: null, skipped: 1, released: 0 }],
  ["the reservation was cancelled / handed back (RELEASED)", { verdict: "RELEASED", credentialGeneration: null }, { record: null, skipped: 0, released: 1 }],
  ["the service epoch / credential generation changed during the container wait", { verdict: "OK", credentialGeneration: GEN2 }, { record: "CREDENTIAL_GENERATION_CHANGED", skipped: 0, released: 0 }],
  ["the re-check could not be read (store threw)", new Error("store down"), { record: "THREADS_PREPUBLISH_UNVERIFIED", skipped: 0, released: 0 }],
  ["the re-check did not answer in time (timeout)", "never", { record: "THREADS_PREPUBLISH_UNVERIFIED", skipped: 0, released: 0 }],
] as const) {
  test(`re-check refuses — ${label}: a container was created, publish requests = 0, nothing reported as published`, async () => {
    const api = threads([CONTAINER_OK, FINISHED]); // any further request would fail the test
    const s = store([OK, recheck as Preflight | Error | "never"]);
    const report = await run(s, sender(api.fetch));
    assert.equal(api.containers(), 1, "the container step happened (a prepared container is NOT a post)");
    assert.equal(api.publishes(), 0);
    assert.equal(report.published, 0);
    assert.equal(report.prepublishRefused, 1);
    assert.equal(report.skipped, expected.skipped);
    assert.equal(report.released, expected.released);
    if (expected.record === null) assert.deepEqual(s.records, [], "the store already decided this row: nothing recorded twice");
    else assert.deepEqual(s.records, [{ outcome: "failed_before_send", providerPostId: null, code: expected.record, transport: "simulated" }]);
  });
}

// ---------------------------------------------------------------- unknown after the publish request: recorded uncertain, never re-sent

test("publish answer lost: recorded 'uncertain' (not published, not failed); the same row delivered twice in one run is sent once", async () => {
  const api = threads([CONTAINER_OK, FINISHED, () => new TypeError("connection reset")]);
  const item = { reservationId: RES, leaseToken: LEASE, provider: "threads", socialAccountId: ACCOUNT, body: "G2境界テスト" };
  const s = store([OK, OK, OK, OK], [item, item]); // the store would let the duplicate through: G3's own de-dup must stop it
  const report = await run(s, sender(api.fetch));
  assert.equal(api.publishes(), 1);
  assert.equal(api.containers(), 1, "no second container either");
  assert.equal(report.sends, 1);
  assert.deepEqual(s.records.map((r) => r.outcome), ["uncertain"]);
});

test("published but the read-back is unknown: 'uncertain', never 'published'", async () => {
  const api = threads([CONTAINER_OK, FINISHED, PUBLISH_OK, () => json(500, { error: { code: 2 } })]);
  const s = store([OK, OK]);
  await run(s, sender(api.fetch));
  assert.deepEqual(s.records.map((r) => [r.outcome, r.providerPostId]), [["uncertain", null]]);
});

test("two workers race for the same row: only the one whose lease still holds publishes (the other is refused at preflight)", async () => {
  const api = threads([CONTAINER_OK, FINISHED, PUBLISH_OK, READBACK_OK]);
  const a = store([OK, OK]);
  const b = store([{ verdict: "LEASE_LOST", credentialGeneration: null }]);
  const port = sender(api.fetch);
  const [ra, rb] = await Promise.all([run(a, port), run(b, port)]);
  assert.equal(api.publishes(), 1);
  assert.equal(ra.published + rb.published, 1);
  assert.equal(rb.sends, 0);
});

// ---------------------------------------------------------------- the deployable pieces stay closed

test("deployable G4 ports are closed: the G3 loop claims nothing and sends nothing", async () => {
  const api = threads([]);
  const s = store([OK, OK]);
  const report = await runThreadsReservationDelivery({ enabled: true, store: s.impl, credentials: createThreadsCredentialPort(), sender: createThreadsSendPort(api.fetch), worker: "g2-qa" });
  assert.equal(report.notAvailable, true);
  assert.equal(report.claimed, 0);
  assert.equal(api.calls.length, 0);
});

test("G3's own gate is closed in source", () => {
  assert.equal(g3.THREADS_DISPATCH_ENABLED, false);
});

// ---------------------------------------------------------------- boundary observation

test("OBSERVATION (P3, owners G3/G4): G3 cannot tell whether a port honours the hook — a port that ignores `hooks` publishes and is recorded as published with 0 re-checks", async () => {
  const api = threads([CONTAINER_OK, FINISHED, PUBLISH_OK, READBACK_OK]);
  const real = sender(api.fetch);
  const ignoring = { available: true, transport: "simulated", send: (cred: { threadsUserId: string; accessToken: string }, text: string) => real.send(cred, text, { beforePublish: () => Promise.resolve(true) }) };
  const s = store([OK, { verdict: "NOT_PUBLISHABLE", credentialGeneration: GEN }]); // G3's re-check WOULD refuse
  const report = await run(s, ignoring);
  assert.equal(report.prepublishRechecks, 0, "G3's hook was never called");
  assert.equal(api.publishes(), 1);
  assert.deepEqual(s.records.map((r) => r.outcome), ["published"]);
});
