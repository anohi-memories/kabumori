// The live social-mobile-publish-setting Edge (unchanged) against every answer the guard wrapper can give: each one is
// already part of the live contract, so the Edge maps it to its existing typed error -- never a success, never a 503
// "unknown answer". MOCK_ONLY: the RPC answers stand in for PostgREST.
import assert from "node:assert/strict";
import { parseDecision } from "../../functions/social-mobile-publish-setting/http.ts";
import { BLOCKED_REASONS } from "../../functions/social-mobile-publish-setting/logic.ts";

const WRAPPER_ANSWERS = [
  { status: "busy" },                                        // deletion in progress / lifecycle lock wait
  { status: "forbidden" },                                   // service not active / not registered / locked / not owner
  { status: "auth_required" },                               // signed out
  { status: "blocked", reason: "CONNECTION_NOT_VERIFIED" },   // G4 has not verified the X identity
];

Deno.test("every answer the guard adds is already accepted by the live Edge parser", () => {
  for (const answer of WRAPPER_ANSWERS) {
    const decision = parseDecision(answer);
    assert.equal(decision.status, answer.status, JSON.stringify(answer));
  }
  assert.ok(BLOCKED_REASONS.has("CONNECTION_NOT_VERIFIED"));
});

Deno.test("an unknown guard code would never pass the Edge (fail closed)", () => {
  for (const answer of [{ status: "blocked", reason: "SERVICE_NOT_ACTIVE" }, { status: "service_not_active" }, { status: "forbidden", reason: "x" }]) {
    assert.throws(() => parseDecision(answer), JSON.stringify(answer));
  }
});
