import assert from "node:assert/strict";
import test from "node:test";
import {
  type ClaimedReservation,
  type FinishOutcome,
  PRODUCTION_PUBLISHER_NOT_AVAILABLE,
  type PublishResult,
  type ReservationDeliveryStore,
  type ReservationPublisher,
  runReservationDelivery,
} from "./worker.ts";

/** In-memory model of the SQL candidate's claim / pre-publish / finish contract (single process). */
function fakeStore(rows: { id: string; body: string; publishable?: boolean }[]) {
  const state = new Map(rows.map((row) => [row.id, { ...row, status: "planned", lease: null as string | null }]));
  const calls: string[] = [];
  let leaseSeq = 0;
  const store: ReservationDeliveryStore = {
    claimDue(_worker, _lease, limit) {
      const out: ClaimedReservation[] = [];
      for (const row of state.values()) {
        if (out.length >= limit) break;
        if (row.status !== "planned" || row.publishable === false) continue;
        row.status = "claimed";
        row.lease = `lease-${++leaseSeq}`;
        out.push({ reservationId: row.id, leaseToken: row.lease, socialAccountId: "x_a", body: row.body });
      }
      calls.push(`claim:${out.length}`);
      return Promise.resolve(out);
    },
    prePublishCheck(id, lease) {
      const row = state.get(id)!;
      calls.push(`check:${id}`);
      if (row.status !== "claimed" || row.lease !== lease) return Promise.resolve("LEASE_LOST");
      return Promise.resolve("OK");
    },
    finish(id, lease, outcome: FinishOutcome, postId) {
      const row = state.get(id)!;
      if (row.lease !== lease || row.status !== "claimed") return Promise.reject(new Error("POSTONA_RESV_LEASE_LOST"));
      row.status = outcome === "published" ? "published" : outcome === "failed_before_send" ? "failed" : "uncertain";
      calls.push(`finish:${id}:${outcome}:${postId ?? "-"}`);
      return Promise.resolve(outcome);
    },
    releaseUnsent(id, lease) {
      const row = state.get(id)!;
      calls.push(`release:${id}`);
      if (row.status !== "claimed" || row.lease !== lease) return Promise.resolve("lease_lost");
      row.status = "planned";
      row.lease = null;
      return Promise.resolve("released");
    },
  };
  return { store, state, calls };
}

function publisher(results: PublishResult[] | (() => Promise<PublishResult>)): ReservationPublisher & { sent: string[] } {
  const sent: string[] = [];
  return {
    available: true,
    sent,
    publish(_account, text) {
      sent.push(text);
      if (typeof results === "function") return results();
      return Promise.resolve(results.shift() ?? { kind: "unknown", code: "NO_SCRIPT" });
    },
  };
}

test("the production publisher is NOT_AVAILABLE: nothing is claimed, nothing is sent", async () => {
  const { store, calls, state } = fakeStore([{ id: "r1", body: "本文" }]);
  const report = await runReservationDelivery({ store, publisher: PRODUCTION_PUBLISHER_NOT_AVAILABLE, worker: "w" });
  assert.equal(report.notAvailable, true);
  assert.equal(report.claimed, 0);
  assert.deepEqual(calls, [], "no claim call at all");
  assert.equal(state.get("r1")!.status, "planned");
  assert.equal(PRODUCTION_PUBLISHER_NOT_AVAILABLE.available, false);
});

test("published / rejected / unknown outcomes map to published / failed / uncertain; manual text is sent as stored", async () => {
  const { store, state } = fakeStore([{ id: "a", body: "そのまま送る本文" }, { id: "b", body: "b" }, { id: "c", body: "c" }]);
  const pub = publisher([
    { kind: "published", providerPostId: "1234567890" },
    { kind: "rejected_before_send", code: "PROVIDER_REJECTED" },
    { kind: "unknown", code: "PROVIDER_TIMEOUT" },
  ]);
  const report = await runReservationDelivery({ store, publisher: pub, worker: "w" });
  assert.deepEqual(report, { claimed: 3, published: 1, failedBeforeSend: 1, uncertain: 1, skipped: 0, released: 0, notAvailable: false, stopped: false });
  assert.deepEqual(pub.sent, ["そのまま送る本文", "b", "c"]);
  assert.deepEqual([...state.values()].map((r) => r.status), ["published", "failed", "uncertain"]);
});

test("an invalid provider post id or a thrown publisher is uncertain, never success, never retried", async () => {
  const { store, state } = fakeStore([{ id: "a", body: "a" }, { id: "b", body: "b" }]);
  let n = 0;
  const pub = publisher(() => (++n === 1 ? Promise.resolve({ kind: "published", providerPostId: "not-a-number" } as PublishResult) : Promise.reject(new Error("socket"))));
  const report = await runReservationDelivery({ store, publisher: pub, worker: "w" });
  assert.equal(report.published, 0);
  assert.equal(report.uncertain, 2);
  assert.deepEqual([...state.values()].map((r) => r.status), ["uncertain", "uncertain"]);
  assert.equal(pub.sent.length, 2, "one attempt each");
  // A second run claims nothing: uncertain rows are never re-claimed.
  const again = await runReservationDelivery({ store, publisher: pub, worker: "w" });
  assert.equal(again.claimed, 0);
  assert.equal(pub.sent.length, 2);
});

test("a lost lease or a row no longer publishable is never sent", async () => {
  const { store, state } = fakeStore([{ id: "a", body: "a" }, { id: "b", body: "b" }]);
  const original = store.prePublishCheck;
  store.prePublishCheck = (id, lease) => (id === "a" ? Promise.resolve("NOT_PUBLISHABLE") : original(id, lease));
  const pub = publisher([{ kind: "published", providerPostId: "42" }]);
  const report = await runReservationDelivery({ store, publisher: pub, worker: "w" });
  assert.equal(report.skipped, 1);
  assert.deepEqual(pub.sent, ["b"]);
  assert.equal(state.get("b")!.status, "published");
  // A failing pre-publish check (store error): not sent; handed back when the store confirms it is still ours.
  const second = fakeStore([{ id: "c", body: "c" }]);
  second.store.prePublishCheck = () => Promise.reject(new Error("db down"));
  const pub2 = publisher([{ kind: "published", providerPostId: "1" }]);
  const r2 = await runReservationDelivery({ store: second.store, publisher: pub2, worker: "w" });
  assert.equal(r2.released, 1);
  assert.equal(second.state.get("c")!.status, "planned");
  assert.deepEqual(pub2.sent, []);
  // ... and when the hand-back cannot be confirmed either, it is only skipped (never sent, never re-sent).
  const third = fakeStore([{ id: "d", body: "d" }]);
  third.store.prePublishCheck = () => Promise.reject(new Error("db down"));
  third.store.releaseUnsent = () => Promise.reject(new Error("db down"));
  const pub3 = publisher([{ kind: "published", providerPostId: "1" }]);
  const r3 = await runReservationDelivery({ store: third.store, publisher: pub3, worker: "w" });
  assert.equal(r3.skipped, 1);
  assert.equal(r3.released, 0);
  assert.deepEqual(pub3.sent, []);
});

test("if the outcome cannot be recorded, the run reports uncertain and does not re-send", async () => {
  const { store } = fakeStore([{ id: "a", body: "a" }]);
  store.finish = () => Promise.reject(new Error("db down after send"));
  const pub = publisher([{ kind: "published", providerPostId: "7" }]);
  const report = await runReservationDelivery({ store, publisher: pub, worker: "w" });
  assert.equal(report.uncertain, 1);
  assert.equal(report.published, 0);
  assert.deepEqual(pub.sent, ["a"]);
});

test("a finish after the lease deadline ('lease_lost') is counted uncertain, never published or failed, and not re-sent", async () => {
  const { store, state } = fakeStore([{ id: "a", body: "a" }, { id: "b", body: "b" }]);
  // Model of the SQL fence: the lease ran out before finish, so the store records uncertain and answers lease_lost.
  store.finish = (id) => {
    state.get(id)!.status = "uncertain";
    return Promise.resolve("lease_lost");
  };
  const pub = publisher([{ kind: "published", providerPostId: "99" }, { kind: "rejected_before_send", code: "PROVIDER_REJECTED" }]);
  const report = await runReservationDelivery({ store, publisher: pub, worker: "w" });
  assert.deepEqual(report, { claimed: 2, published: 0, failedBeforeSend: 0, uncertain: 2, skipped: 0, released: 0, notAvailable: false, stopped: false });
  const again = await runReservationDelivery({ store, publisher: pub, worker: "w" });
  assert.equal(again.claimed, 0);
  assert.deepEqual(pub.sent, ["a", "b"], "one attempt each");
});

test("two workers on one store: every row is sent at most once", async () => {
  const { store, state } = fakeStore(Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, body: `b${i}` })));
  const sent: string[] = [];
  const mk = (): ReservationPublisher => ({
    available: true,
    publish(_a, text) {
      sent.push(text);
      return Promise.resolve({ kind: "published", providerPostId: String(sent.length) });
    },
  });
  const [r1, r2] = await Promise.all([
    runReservationDelivery({ store, publisher: mk(), worker: "w1", limit: 3 }),
    runReservationDelivery({ store, publisher: mk(), worker: "w2", limit: 3 }),
  ]);
  assert.equal(r1.claimed + r2.claimed, 5);
  assert.equal(new Set(sent).size, 5);
  assert.equal(sent.length, 5);
  assert.ok([...state.values()].every((row) => row.status === "published"));
});

test("source: no provider, OpenAI, Vault or live queue access in the delivery module", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./worker.ts", import.meta.url), "utf8");
  // Code only: the header comment names the paths it must never touch.
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, "");
  assert.doesNotMatch(code, /^import /mu, "no imports");
  assert.doesNotMatch(code, /fetch\(|api\.x\.com|twitter|openai|vault|claim_due_post|brand_post|Deno\.env/iu);
});

// ---------------------------------------------------------------------------------------------------
// F3 dispatch (2026-10-16): a claimed row that was NOT sent is handed back, never left to become 'uncertain'.
// ---------------------------------------------------------------------------------------------------
test("graceful shutdown: rows claimed but not yet sent are handed back to planned; the next run sends each once", async () => {
  const { store, state, calls } = fakeStore([{ id: "r1", body: "one" }, { id: "r2", body: "two" }, { id: "r3", body: "three" }]);
  const pub = publisher([{ kind: "published", providerPostId: "101" }, { kind: "published", providerPostId: "102" }, { kind: "published", providerPostId: "103" }]);
  let sends = 0;
  const first = await runReservationDelivery({ store, publisher: { available: true, publish: (a, t) => { sends += 1; return pub.publish(a, t); } }, worker: "w1", shouldStop: () => sends >= 1 });
  assert.equal(first.published, 1);
  assert.equal(first.released, 2);
  assert.equal(first.stopped, true);
  assert.deepEqual([...state.values()].map((row) => row.status), ["published", "planned", "planned"]);
  assert.ok(calls.includes("release:r2") && calls.includes("release:r3"));
  const second = await runReservationDelivery({ store, publisher: pub, worker: "w2" });
  assert.equal(second.published, 2);
  assert.deepEqual(pub.sent, ["one", "two", "three"], "each text exactly once");
});

test("RELEASED from the store (busy fence / lease out before send) and an unreadable check are never sent", async () => {
  const { store, state } = fakeStore([{ id: "r1", body: "one" }, { id: "r2", body: "two" }]);
  let checks = 0;
  const check = store.prePublishCheck.bind(store);
  store.prePublishCheck = (id, lease) => {
    checks += 1;
    if (checks === 1) {
      const row = state.get(id)!;
      row.status = "planned";
      row.lease = null;
      return Promise.resolve("RELEASED");
    }
    if (checks === 2) return Promise.reject(new Error("connection reset"));
    return check(id, lease);
  };
  const pub = publisher([]);
  const report = await runReservationDelivery({ store, publisher: pub, worker: "w1" });
  assert.deepEqual(pub.sent, [], "nothing sent");
  assert.equal(report.released, 2);
  assert.deepEqual([...state.values()].map((row) => row.status), ["planned", "planned"]);
});

test("a shouldStop that throws stops the run (fail closed): everything claimed is handed back unsent", async () => {
  const { store, state } = fakeStore([{ id: "r1", body: "one" }]);
  const pub = publisher([]);
  const report = await runReservationDelivery({ store, publisher: pub, worker: "w1", shouldStop: () => { throw new Error("signal"); } });
  assert.equal(report.stopped, true);
  assert.equal(report.released, 1);
  assert.deepEqual(pub.sent, []);
  assert.equal(state.get("r1")!.status, "planned");
});
