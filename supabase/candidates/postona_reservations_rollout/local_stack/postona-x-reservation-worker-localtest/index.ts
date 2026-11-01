// TEST ONLY (G3-02 #1). Never deployed. The real postona-x-reservation-worker handler (createWorkerHandler) on the real Edge runtime,
// with exactly two test-only differences: the release gate is passed as enabled (the source constant stays false), and the db container
// without TLS (../_shared_g3ls/local_transport.ts). The X credential source is NOT overridden: X_GENERATION_CREDENTIALS_NOT_CONNECTED
// (deny), as in production, so nothing is claimed and X is never called.
import { createWorkerHandler } from "../postona-x-reservation-worker/http.ts";
import { localDbConnect } from "../_shared_g3ls/local_transport.ts";

Deno.serve(createWorkerHandler(Deno.env, {
  enabled: true,
  createConnect: (databaseUrl) => localDbConnect(databaseUrl, "postona-x-reservation-worker"),
}));
