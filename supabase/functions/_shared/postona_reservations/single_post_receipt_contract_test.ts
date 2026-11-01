// PROPOSED receipt contract (no server exists): what the app may conclude from a text-free receipt. MOCK_ONLY, deny-net.
import assert from "node:assert/strict";
import test from "node:test";
import { RECEIPT_NOT_FOUND, receiptNextStep, singlePostReceiptOf, singlePostReceiptRequest } from "./single_post_receipt_contract.ts";

const RID = "33333333-3333-4333-8333-333333333333";
const REQ = "55555555-5555-4555-8555-555555555555";

test("the request carries only the account and the attempt id -- never text, hash or user id; malformed ids send nothing", () => {
  assert.deepEqual(singlePostReceiptRequest({ socialAccountId: "sa_x", clientRequestId: REQ }), { socialAccountId: "sa_x", clientRequestId: REQ });
  const extra = singlePostReceiptRequest({ socialAccountId: "sa_x", clientRequestId: REQ, text: "本文", contentSha256: "a".repeat(64), userId: "u" } as never);
  assert.deepEqual(Object.keys(extra ?? {}).sort(), ["clientRequestId", "socialAccountId"]);
  for (const bad of [{ socialAccountId: "sa x", clientRequestId: REQ }, { socialAccountId: "sa_x", clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".toUpperCase() }, { socialAccountId: "", clientRequestId: REQ }, { socialAccountId: "sa_x", clientRequestId: "x" }]) {
    assert.equal(singlePostReceiptRequest(bad), null, JSON.stringify(bad));
  }
});

test("answers: the send's shapes; only the exact 404 code is not_found; business refusals are not trustworthy receipts", () => {
  assert.deepEqual(singlePostReceiptOf(404, { ok: false, code: RECEIPT_NOT_FOUND }), { kind: "not_found" });
  assert.deepEqual(singlePostReceiptOf(404, { ok: false, code: "POSTONA_RESV_ACCOUNT_NOT_FOUND" }), { kind: "unavailable", code: null }, "another 404 is not 'never begun'");
  assert.deepEqual(singlePostReceiptOf(404, null), { kind: "unavailable", code: null });
  assert.deepEqual(singlePostReceiptOf(200, { ok: true, status: "sent", reservationId: RID, xPostId: "1790000000000000001", simulated: false, afterFreeze: true }),
    { kind: "sent", reservationId: RID, xPostId: "1790000000000000001", simulated: false, afterFreeze: true });
  assert.deepEqual(singlePostReceiptOf(401, { ok: false, code: "POSTONA_RESV_AUTH_REQUIRED" }), { kind: "refused", code: "POSTONA_RESV_AUTH_REQUIRED", retryable: true });
  assert.deepEqual(singlePostReceiptOf(403, { ok: false, code: "POSTONA_RESV_SERVICE_NOT_ACTIVE" }), { kind: "unavailable", code: null });
  assert.deepEqual(singlePostReceiptOf(503, { ok: false, code: "NOT_AVAILABLE" }), { kind: "unavailable", code: "NOT_AVAILABLE" });
});

test("next steps: only a real sent is 'posted'; simulated sent and uncertain stay unresolved; pending / not_found retry the SAME id; failed is not posted", () => {
  const sent = (simulated: boolean) => singlePostReceiptOf(200, { ok: true, status: "sent", reservationId: RID, xPostId: "1790000000000000001", simulated, afterFreeze: false });
  assert.equal(receiptNextStep(sent(false)), "show_posted");
  assert.equal(receiptNextStep(sent(true)), "keep_unresolved_check_x");
  assert.equal(receiptNextStep(singlePostReceiptOf(200, { ok: true, status: "sent", reservationId: RID, xPostId: "1790000000000000001" })), "keep_unresolved_check_x", "missing mark");
  assert.equal(receiptNextStep(singlePostReceiptOf(200, { ok: true, status: "uncertain", reservationId: RID, code: "X_TIMEOUT", simulated: false })), "keep_unresolved_check_x");
  assert.equal(receiptNextStep(singlePostReceiptOf(200, { ok: true, status: "pending", reservationId: RID, code: "IN_PROGRESS", simulated: false })), "retry_same_id");
  assert.equal(receiptNextStep({ kind: "not_found" }), "retry_same_id");
  assert.equal(receiptNextStep(singlePostReceiptOf(200, { ok: true, status: "failed", reservationId: RID, code: "CREDENTIAL_CHANGED", simulated: false })), "show_not_posted");
  assert.equal(receiptNextStep(singlePostReceiptOf(401, { ok: false, code: "AUTH_REQUIRED" })), "sign_in");
  assert.equal(receiptNextStep(singlePostReceiptOf(500, null)), "ask_again_later");
  const steps = ["show_posted", "retry_same_id", "keep_unresolved_check_x", "show_not_posted", "sign_in", "ask_again_later"];
  assert.ok(!steps.includes("send_new_attempt"), "no receipt ever allows a NEW attempt id");
});

test("source: the proposal has no network client, server, SQL or token handling", async () => {
  const source = await Deno.readTextFile(new URL("./single_post_receipt_contract.ts", import.meta.url));
  for (const banned of ["fetch(", "Deno.serve", "queryArray", "postona_x_resv.post_now", "vault", "console."]) assert.ok(!source.includes(banned), banned);
});
