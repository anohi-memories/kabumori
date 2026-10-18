import assert from "node:assert/strict";
import test from "node:test";
import { singlePostRequest, singlePostResultOf } from "./single_post_contract.ts";

const RID = "33333333-3333-4333-8333-333333333333";

test("the request is exactly the server's shape (no user id; consent bound to the text's hash)", () => {
  assert.deepEqual(singlePostRequest({ socialAccountId: "sa_x", clientRequestId: RID, text: "t", contentSha256: "a".repeat(64) }),
    { socialAccountId: "sa_x", clientRequestId: RID, text: "t", consent: { confirmed: true, contentSha256: "a".repeat(64) } });
});

test("results: sent only with a stored X id; pending / failed / uncertain typed; refusals and anything else", () => {
  assert.deepEqual(singlePostResultOf(200, { ok: true, status: "sent", reservationId: RID, xPostId: "1790000000000000001", simulated: false, afterFreeze: false }),
    { kind: "sent", reservationId: RID, xPostId: "1790000000000000001", simulated: false, afterFreeze: false });
  assert.deepEqual(singlePostResultOf(200, { ok: true, status: "sent", reservationId: RID }), { kind: "unavailable", code: null }, "sent without an id is never sent");
  for (const status of ["pending", "failed", "uncertain"] as const) {
    assert.deepEqual(singlePostResultOf(200, { ok: true, status, reservationId: RID, code: "X_TIMEOUT", simulated: false }), { kind: status, reservationId: RID, code: "X_TIMEOUT", simulated: false, afterFreeze: false });
  }
  assert.deepEqual(singlePostResultOf(403, { ok: false, code: "POSTONA_RESV_SERVICE_NOT_ACTIVE" }), { kind: "refused", code: "POSTONA_RESV_SERVICE_NOT_ACTIVE", retryable: false });
  assert.deepEqual(singlePostResultOf(401, { ok: false, code: "AUTH_REQUIRED" }), { kind: "refused", code: "AUTH_REQUIRED", retryable: true });
  for (const [s, b] of [[503, { ok: false, code: "X_NOT_AVAILABLE" }], [200, { ok: true, status: "posted", reservationId: RID }], [200, { ok: true, status: "sent", reservationId: "x", xPostId: "1" }], [500, null], [200, "ok"]] as const) {
    assert.equal(singlePostResultOf(s, b).kind, "unavailable", JSON.stringify(b));
  }
});

test("M1-F1 marks: a missing / non-false simulated mark is simulated; afterFreeze only when exactly true", () => {
  assert.deepEqual(singlePostResultOf(200, { ok: true, status: "sent", reservationId: RID, xPostId: "1790000000000000001" }),
    { kind: "sent", reservationId: RID, xPostId: "1790000000000000001", simulated: true, afterFreeze: false }, "no mark -> simulated");
  for (const simulated of [true, "false", 0, null]) {
    const result = singlePostResultOf(200, { ok: true, status: "sent", reservationId: RID, xPostId: "1790000000000000001", simulated });
    assert.equal(result.kind === "sent" && result.simulated, true, String(simulated));
  }
  const frozen = singlePostResultOf(200, { ok: true, status: "sent", reservationId: RID, xPostId: "1790000000000000001", simulated: false, afterFreeze: true });
  assert.deepEqual(frozen, { kind: "sent", reservationId: RID, xPostId: "1790000000000000001", simulated: false, afterFreeze: true });
  const notTrue = singlePostResultOf(200, { ok: true, status: "uncertain", reservationId: RID, simulated: false, afterFreeze: "yes" });
  assert.equal(notTrue.kind === "uncertain" && notTrue.afterFreeze, false);
});
