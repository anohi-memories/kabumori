// TEST ONLY (G3-02 #27). Never deployed: run.sh copies it into a throw-away local Supabase project only. G3's Threads reservation worker
// handler (createThreadsWorkerHandler: 007 claim -> ONE credentialFor -> 007 preflight -> G4's two-step send with the pre-publish re-check
// -> 007 record) on the real Edge runtime, with these differences at the TEST BOUNDARY only:
//   enabled      the release gate passed as enabled (THREADS_RESERVATION_WORKER_ENABLED stays false in source).
//   db           the db container without TLS (../_shared_g3ls/local_transport.ts).
//   sender       G4's REAL two-step send port (G4 PR #701 HEAD threads_send_port.ts + threads_publish_contract.ts, blob-pinned, copied
//                read-only into ../_shared_g4pin/ by run.sh) built with createGatedThreadsSendPort(true, "simulated", fakeThreads): G4's
//                shipped createThreadsSendPort stays closed (THREADS_SEND_PORT_ENABLED = false) and is not used.
//   fetch        a fake Threads Graph API (../_shared_g3ls/fake_threads.ts): nothing leaves the machine.
//   credentials  TEST_ONLY credentialFor answering the FAKE snapshot the test wrote (g3ls_test.threads_token_snapshot). It is NOT G4's
//                source: G4's Threads credential statement does not exist (threads_send_port.ts THREADS_POSTING_SERVICE_KEY = null).
import { localDbConnect } from "../_shared_g3ls/local_transport.ts";
import { fakeThreadsFor } from "../_shared_g3ls/fake_threads.ts";
import { createGatedThreadsSendPort } from "../_shared_g4pin/threads_send_port.ts";
import { createThreadsWorkerHandler } from "../_shared/postona_reservations/threads_worker_http.ts";

const { credentials: TEST_ONLY_CREDENTIALS, fakeThreads } = fakeThreadsFor("g3ls-threads-worker-e2e-test-double");

Deno.serve(createThreadsWorkerHandler(Deno.env, {
  enabled: true,
  createConnect: (databaseUrl) => localDbConnect(databaseUrl, "postona-threads-reservation-worker"),
  credentials: TEST_ONLY_CREDENTIALS,
  sender: createGatedThreadsSendPort(true, "simulated", fakeThreads, { containerChecks: 1, containerCheckDelayMs: 0 }),
  leaseSeconds: 60,
  limit: 1, // one row per run, so parallel runs contend for the due rows (L51)
}));
