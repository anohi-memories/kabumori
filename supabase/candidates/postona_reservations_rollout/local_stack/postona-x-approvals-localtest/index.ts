// TEST ONLY (G3-02 #16). Never deployed. The real postona-x-approvals handler (createHttpHandler) behind the real local Kong / GoTrue on
// the real Edge runtime, with the same test-only differences as postona-x-reservations-localtest: the release gate is passed as enabled
// (the source constant stays false), and the local transport of ../_shared_g3ls/local_transport.ts (Auth via kong, the db container
// without TLS).
import { createHttpHandler } from "../postona-x-approvals/http.ts";
import { localDbConnect, localEnv, localFetch } from "../_shared_g3ls/local_transport.ts";

Deno.serve(createHttpHandler(localEnv, {
  enabled: true,
  fetch: localFetch,
  createConnect: (databaseUrl) => localDbConnect(databaseUrl, "postona-x-approvals"),
}));
