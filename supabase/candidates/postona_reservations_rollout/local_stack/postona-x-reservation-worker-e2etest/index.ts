// TEST ONLY (G3-02 #9). Never deployed: run.sh copies it into a throw-away local Supabase project only. The real
// postona-x-reservation-worker handler (createWorkerHandler: claim -> 014's generation pin -> ONE credentialFor -> 015's bound pre-send
// check -> one X create -> finish) on the real Edge runtime, with the localtest twin's two differences (the release gate passed as
// enabled; the db container without TLS) and, at the TEST BOUNDARY only, these overrides the handler already takes for tests:
//   credentials  TEST_ONLY injected credentialFor({ token, generation }): answers the FAKE snapshot the test wrote into
//                g3ls_test.x_token_snapshot. It is NOT G4's source and proves nothing about G4's token read: G4 has not delivered a
//                generation-bound source (the production worker keeps X_GENERATION_CREDENTIALS_NOT_CONNECTED: claim 0, send 0).
//   fetch        a fake X: only POST https://api.x.com/2/tweets is answered (anything else is refused, nothing leaves the machine);
//                each call is recorded in g3ls_test.x_calls (the bearer's SHA-256, never the token) and answered as g3ls_test.x_mode
//                says (see ../_shared_g3ls/fake_x.ts): ok -> 201 + a numeric id, reject_400/401/403/429 -> that status, http_500 -> 500, unknown -> a broken connection.
//   projectRef   G3-02 #11: this stack's TEST ref (g3lslocalref00000000), the ref a tick's ticket must name; a deploy reads it from
//                SUPABASE_URL (https://<ref>.supabase.co), which a local stack does not have.
// Both read / write only the g3ls_test schema through a throw-away login (G3LS_TEST_DB_URL) that reaches nothing else.
import { createWorkerHandler } from "../postona-x-reservation-worker/http.ts";
import { localDbConnect } from "../_shared_g3ls/local_transport.ts";
import { fakeXFor } from "../_shared_g3ls/fake_x.ts";

// G3-02 #26: the fake X and the fake credential snapshot moved to ../_shared_g3ls/fake_x.ts (shared with the single-post twin), unchanged
// but for more refusal modes.
const { credentials: TEST_ONLY_CREDENTIALS, fakeX } = fakeXFor("g3ls-x-worker-e2e-test-double");

Deno.serve(createWorkerHandler(Deno.env, {
  enabled: true,
  createConnect: (databaseUrl) => localDbConnect(databaseUrl, "postona-x-reservation-worker"),
  credentials: TEST_ONLY_CREDENTIALS,
  fetch: fakeX,
  projectRef: "g3lslocalref00000000",
}));
