// G3 TASK 30/50 (Issue #318): the X reservation worker module (worker.ts, copied by run.sh from PR #392's head, unchanged) driven by
// fake stores / publishers -- only the orders PR #392's worker_test.ts does not cover: a finish that was recorded but whose answer was
// lost, a stop request that arrives while a send is in flight, a send that outlives its lease (sweep first vs finish first), and what
// the provider adapter is given (no idempotency key). No network, no database, no provider.
import assert from "node:assert/strict";
import test from "node:test";
import {
  type ClaimedReservation,
  type FinishOutcome,
  type PrePublishVerdict,
  type PublishResult,
  type ReservationDeliveryStore,
  type ReservationPublisher,
  runReservationDelivery,
} from "./worker.ts";

type Row = { status: "planned" | "claimed" | "published" | "failed" | "uncertain"; lease: string | null; postId: string | null };

/** A small store with the SQL candidates' answers (claim_due / pre_publish_check / finish / release_unsent), plus fault hooks. */
function fakeStore(ids: string[], hooks: {
  afterFinishRecorded?: (id: string) => void; // throw here = the finish committed but its answer was lost
  finishMode?: "normal" | "lease_expired_finish_first" | "lease_expired_sweep_first";
} = {}) {
  const rows = new Map<string, Row>(ids.map((id) => [id, { status: "planned", lease: null, postId: null }]));
  const calls: string[] = [];
  let n = 0;
  const store: ReservationDeliveryStore = {
    claimDue(): Promise<ClaimedReservation[]> {
      const out: ClaimedReservation[] = [];
      for (const [id, row] of rows) {
        if (row.status !== "planned") continue;
        row.status = "claimed";
        row.lease = `lease-${++n}`;
        out.push({ reservationId: id, leaseToken: row.lease, socialAccountId: "acct-1", body: `body ${id}` });
      }
      calls.push(`claim:${out.length}`);
      return Promise.resolve(out);
    },
    prePublishCheck(id, lease): Promise<PrePublishVerdict> {
      calls.push(`check:${id}`);
      const row = rows.get(id)!;
      return Promise.resolve(row.status === "claimed" && row.lease === lease ? "OK" : "LEASE_LOST");
    },
    finish(id, lease, outcome: FinishOutcome, postId): Promise<string> {
      calls.push(`finish:${id}:${outcome}`);
      const row = rows.get(id)!;
      if (row.lease !== lease) return Promise.reject(new Error("POSTONA_RESV_LEASE_LOST"));
      if (row.status === "published" && outcome === "published" && row.postId === postId) return Promise.resolve("published");
      if (hooks.finishMode === "lease_expired_sweep_first" && row.status === "claimed") row.status = "uncertain"; // another run swept it
      if (row.status !== "claimed") return Promise.reject(new Error("POSTONA_RESV_LEASE_LOST"));
      if (hooks.finishMode === "lease_expired_finish_first") {
        row.status = "uncertain";
        return Promise.resolve("lease_lost");
      }
      row.status = outcome === "published" ? "published" : outcome === "failed_before_send" ? "failed" : "uncertain";
      row.postId = postId;
      hooks.afterFinishRecorded?.(id);
      return Promise.resolve(outcome);
    },
    releaseUnsent(id, lease): Promise<string> {
      calls.push(`release:${id}`);
      const row = rows.get(id)!;
      if (row.status !== "claimed" || row.lease !== lease) return Promise.resolve("lease_lost");
      row.status = "planned";
      row.lease = null;
      return Promise.resolve("released");
    },
  };
  return { store, rows, calls };
}

function fakePublisher(results: (() => Promise<PublishResult>)[]) {
  const sent: unknown[][] = [];
  const publisher: ReservationPublisher = {
    available: true,
    publish(...args: unknown[]): Promise<PublishResult> {
      sent.push(args);
      const next = results.shift();
      return next ? next() : Promise.resolve({ kind: "published", providerPostId: String(9000 + sent.length) });
    },
  };
  return { publisher, sent };
}

test("M1 a finish that was recorded but whose answer was lost: the run says uncertain, the row is published, a restart sends nothing", async () => {
  const { store, rows, calls } = fakeStore(["r1"], { afterFinishRecorded: () => { throw new Error("connection reset"); } });
  const { publisher, sent } = fakePublisher([() => Promise.resolve({ kind: "published", providerPostId: "1000000001" })]);
  const first = await runReservationDelivery({ store, publisher, worker: "m1" });
  assert.equal(first.published, 0); // CURRENT_OBSERVED: the report under-counts
  assert.equal(first.uncertain, 1);
  assert.equal(rows.get("r1")!.status, "published"); // the store has the truth
  assert.equal(rows.get("r1")!.postId, "1000000001");
  const restart = await runReservationDelivery({ store, publisher, worker: "m1" });
  assert.equal(restart.claimed, 0); // INVARIANT: no second send
  assert.equal(sent.length, 1);
  assert.ok(!calls.includes("release:r1")); // INVARIANT: a row that may have been sent is never handed back
});

test("M2 a stop request that arrives while a send is in flight: that send is finished (never handed back), the rest are handed back", async () => {
  const { store, rows, calls } = fakeStore(["r1", "r2", "r3"]);
  let stop = false;
  const { publisher, sent } = fakePublisher([() => {
    stop = true; // the request is aborted / the run budget ends during the provider call
    return Promise.resolve({ kind: "published", providerPostId: "1000000002" });
  }]);
  const report = await runReservationDelivery({ store, publisher, worker: "m2", shouldStop: () => stop });
  assert.equal(sent.length, 1);
  assert.equal(report.published, 1);
  assert.equal(report.released, 2);
  assert.equal(report.stopped, true);
  assert.equal(rows.get("r1")!.status, "published");
  assert.ok(!calls.includes("release:r1"));
  assert.deepEqual([rows.get("r2")!.status, rows.get("r3")!.status], ["planned", "planned"]);
});

test("M3 a send that outlives its lease: finish-first answers lease_lost, sweep-first raises; both are uncertain and the provider id is not in the report", async () => {
  for (const finishMode of ["lease_expired_finish_first", "lease_expired_sweep_first"] as const) {
    const { store, rows } = fakeStore(["r1"], { finishMode });
    const { publisher, sent } = fakePublisher([() => Promise.resolve({ kind: "published", providerPostId: "1000000003" })]);
    const report = await runReservationDelivery({ store, publisher, worker: "m3" });
    assert.equal(sent.length, 1, finishMode);
    assert.equal(report.published, 0, finishMode);
    assert.equal(report.uncertain, 1, finishMode);
    assert.equal(rows.get("r1")!.status, "uncertain", finishMode);
    assert.ok(!JSON.stringify(report).includes("1000000003"), finishMode); // CURRENT_OBSERVED: only the SQL audit (finish-first) keeps it
    const again = await runReservationDelivery({ store, publisher, worker: "m3" });
    assert.equal(again.claimed, 0, finishMode);
    assert.equal(sent.length, 1, finishMode);
  }
});

test("M4 the provider adapter is given only the account and the text: no reservation id / idempotency key reaches it", async () => {
  const { store } = fakeStore(["r1"]);
  const { publisher, sent } = fakePublisher([]);
  await runReservationDelivery({ store, publisher, worker: "m4" });
  assert.deepEqual(sent, [["acct-1", "body r1"]]); // CURRENT_OBSERVED (worker.ts:51 / :145); a key is PROPOSED
});
