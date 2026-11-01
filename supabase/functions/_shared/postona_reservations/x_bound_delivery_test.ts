import assert from "node:assert/strict";
import test from "node:test";
import { type BoundPrePublish, type BoundReservationDeliveryStore, runBoundXReservationDelivery } from "./x_bound_delivery.ts";
import type { ClaimedReservation, FinishOutcome, PublishResult, ReservationPublisher } from "./worker.ts";
import { X_GENERATION_CREDENTIALS_NOT_CONNECTED, type XGenerationCredential, type XPostingGenerationCredentialSource } from "./x_credential_generation.ts";
import type { XPostingCredentialSource } from "./x_publisher.ts";

const GEN_A = "a".repeat(64);
const GEN_B = "b".repeat(64);
const TOKEN = "fake-x-token-0123456789";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** In-memory model of 004 + 014 + 015: the claim pins the generation, the bound check answers it with OK. */
function world(rows: { id: string; pin: string | null; verdict?: BoundPrePublish["verdict"] | "THROW" }[]) {
  const finished: { id: string; outcome: FinishOutcome; code: string | null; postId: string | null }[] = [];
  const released: string[] = [];
  const calls: string[] = [];
  const store: BoundReservationDeliveryStore = {
    claimDue() {
      calls.push("claim");
      return Promise.resolve(rows.map((r, i): ClaimedReservation => ({ reservationId: r.id, leaseToken: uuid(900 + i), socialAccountId: `acct-${r.id.slice(-2)}`, body: `body ${r.id}` })));
    },
    prePublishCheckBound(id) {
      calls.push(`check ${id}`);
      const r = rows.find((x) => x.id === id)!;
      if (r.verdict === "THROW") return Promise.reject(new Error("RESERVATION_WORKER_OUTCOME_UNKNOWN"));
      const verdict = r.verdict ?? "OK";
      return Promise.resolve({ verdict, credentialGeneration: verdict === "OK" ? r.pin : null });
    },
    finish(id, _lease, outcome, postId, code) {
      calls.push(`finish ${id} ${outcome}`);
      finished.push({ id, outcome, code, postId });
      return Promise.resolve(outcome);
    },
    releaseUnsent(id) {
      calls.push(`release ${id}`);
      released.push(id);
      return Promise.resolve("released");
    },
  };
  return { store, finished, released, calls };
}

function source(answer: (account: string) => XGenerationCredential | null | Error, calls: string[]): XPostingGenerationCredentialSource {
  return {
    available: true,
    credentialFor(account) {
      calls.push(`cred ${account}`);
      const a = answer(account);
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
    },
  };
}

function publisher(result: PublishResult | Error) {
  const sent: { account: string; text: string; token: string | null }[] = [];
  const publisherFor = (src: XPostingCredentialSource): ReservationPublisher => ({
    available: true,
    async publish(account, text) {
      const token = await src.accessTokenFor(account);
      const again = await src.accessTokenFor(account); // the one-shot source answers once
      assert.equal(again, null);
      sent.push({ account, text, token });
      if (result instanceof Error) throw result;
      return result;
    },
  });
  return { sent, publisherFor };
}

test("B1 the token's generation equals the pinned one: exactly one send with exactly that token, recorded published", async () => {
  const w = world([{ id: uuid(1), pin: GEN_A }]);
  const p = publisher({ kind: "published", providerPostId: "1849" });
  const report = await runBoundXReservationDelivery({ store: w.store, credentials: source(() => ({ token: TOKEN, generation: GEN_A }), w.calls), publisherFor: p.publisherFor, worker: "w" });
  assert.deepEqual(p.sent, [{ account: "acct-01", text: `body ${uuid(1)}`, token: TOKEN }]);
  assert.deepEqual(w.finished, [{ id: uuid(1), outcome: "published", code: null, postId: "1849" }]);
  assert.deepEqual(w.calls, ["claim", "cred acct-01", `check ${uuid(1)}`, `finish ${uuid(1)} published`]); // the token is read BEFORE the last check
  assert.equal(report.sends, 1);
  assert.equal(report.published, 1);
});

test("B2 another generation (reconnect / A->B->A / a stale source), no pin, or a malformed pin: never sent, CREDENTIAL_GENERATION_CHANGED", async () => {
  for (const pin of [GEN_B, null, "A".repeat(64), "a".repeat(63)]) {
    const w = world([{ id: uuid(2), pin }]);
    const p = publisher({ kind: "published", providerPostId: "1" });
    const report = await runBoundXReservationDelivery({ store: w.store, credentials: source(() => ({ token: TOKEN, generation: GEN_A }), w.calls), publisherFor: p.publisherFor, worker: "w" });
    assert.equal(p.sent.length, 0, String(pin));
    assert.deepEqual(w.finished, [{ id: uuid(2), outcome: "failed_before_send", code: "CREDENTIAL_GENERATION_CHANGED", postId: null }]);
    assert.equal(report.sends, 0);
    assert.equal(report.failedBeforeSend, 1);
  }
});

test("B3 no credential (G4 not verified / refresh / disconnected), a bad token or a throwing source: never sent, X_CREDENTIALS_UNAVAILABLE", async () => {
  for (const answer of [null, { token: "short", generation: GEN_A }, { token: "has space 0123456789", generation: GEN_A }, new Error(TOKEN)]) {
    const w = world([{ id: uuid(3), pin: GEN_A }]);
    const p = publisher({ kind: "published", providerPostId: "1" });
    await runBoundXReservationDelivery({ store: w.store, credentials: source(() => answer as XGenerationCredential | null | Error, w.calls), publisherFor: p.publisherFor, worker: "w" });
    assert.equal(p.sent.length, 0);
    assert.deepEqual(w.finished, [{ id: uuid(3), outcome: "failed_before_send", code: "X_CREDENTIALS_UNAVAILABLE", postId: null }]);
    assert.ok(!JSON.stringify(w.finished).includes(TOKEN));
  }
});

test("B4 the store's own answers: NOT_PUBLISHABLE / LEASE_LOST skipped, RELEASED counted, unreadable handed back; none is sent or finished", async () => {
  const w = world([{ id: uuid(41), pin: GEN_A, verdict: "NOT_PUBLISHABLE" }, { id: uuid(42), pin: GEN_A, verdict: "LEASE_LOST" },
    { id: uuid(43), pin: GEN_A, verdict: "RELEASED" }, { id: uuid(44), pin: GEN_A, verdict: "THROW" }]);
  const p = publisher({ kind: "published", providerPostId: "1" });
  const report = await runBoundXReservationDelivery({ store: w.store, credentials: source(() => ({ token: TOKEN, generation: GEN_A }), w.calls), publisherFor: p.publisherFor, worker: "w" });
  assert.equal(p.sent.length, 0);
  assert.deepEqual(w.finished, []);
  assert.deepEqual(w.released, [uuid(44)]);
  assert.deepEqual({ sends: report.sends, skipped: report.skipped, released: report.released }, { sends: 0, skipped: 2, released: 2 });
});

test("B5 an unknown X outcome (or a throw, or an invalid post id) is uncertain and never re-sent", async () => {
  for (const result of [{ kind: "unknown", code: "X_TIMEOUT" } as PublishResult, new Error("boom"), { kind: "published", providerPostId: "not-a-number" } as PublishResult]) {
    const w = world([{ id: uuid(5), pin: GEN_A }]);
    const p = publisher(result);
    const report = await runBoundXReservationDelivery({ store: w.store, credentials: source(() => ({ token: TOKEN, generation: GEN_A }), w.calls), publisherFor: p.publisherFor, worker: "w" });
    assert.equal(p.sent.length, 1);
    assert.equal(w.finished.length, 1);
    assert.equal(w.finished[0].outcome, "uncertain");
    assert.equal(report.uncertain, 1);
  }
});

test("B6 a rejected-before-send X answer is recorded failed_before_send with its fixed code", async () => {
  const w = world([{ id: uuid(6), pin: GEN_A }]);
  const p = publisher({ kind: "rejected_before_send", code: "X_REJECTED_401" });
  await runBoundXReservationDelivery({ store: w.store, credentials: source(() => ({ token: TOKEN, generation: GEN_A }), w.calls), publisherFor: p.publisherFor, worker: "w" });
  assert.deepEqual(w.finished, [{ id: uuid(6), outcome: "failed_before_send", code: "X_REJECTED_401", postId: null }]);
});

test("B7 no generation-bound source (the production default) or no publisher: nothing is claimed", async () => {
  for (const credentials of [X_GENERATION_CREDENTIALS_NOT_CONNECTED, { available: true } as unknown as XPostingGenerationCredentialSource]) {
    const w = world([{ id: uuid(7), pin: GEN_A }]);
    const report = await runBoundXReservationDelivery({ store: w.store, credentials, publisherFor: publisher({ kind: "published", providerPostId: "1" }).publisherFor, worker: "w" });
    assert.equal(report.notAvailable, true);
    assert.deepEqual(w.calls, []);
  }
  const w = world([{ id: uuid(7), pin: GEN_A }]);
  const report = await runBoundXReservationDelivery({ store: w.store, credentials: source(() => null, w.calls), publisherFor: undefined as never, worker: "w" });
  assert.equal(report.notAvailable, true);
  assert.deepEqual(w.calls, []);
});

test("B8 asked to stop: the rest is handed back unsent", async () => {
  const w = world([{ id: uuid(81), pin: GEN_A }, { id: uuid(82), pin: GEN_A }]);
  const p = publisher({ kind: "published", providerPostId: "2" });
  let n = 0;
  const report = await runBoundXReservationDelivery({ store: w.store, credentials: source(() => ({ token: TOKEN, generation: GEN_A }), w.calls), publisherFor: p.publisherFor, worker: "w", shouldStop: () => n++ > 0 });
  assert.equal(p.sent.length, 1);
  assert.deepEqual(w.released, [uuid(82)]);
  assert.equal(report.stopped, true);
});
