// TEST ONLY (G3-02 #1). Never deployed. The real postona-x-reservations handler (createHttpHandler) behind the real local Kong / GoTrue on
// the real Edge runtime, with exactly three test-only differences: the release gate is passed as enabled (the source constant stays
// false), and the local transport of ../_shared_g3ls/local_transport.ts (Auth via kong, the db container without TLS). The permission port
// is NOT overridden: PERMISSIONS_NOT_CONNECTED (deny), as in production.
import { createHttpHandler } from "../postona-x-reservations/http.ts";
import { localDbConnect, localEnv, localFetch } from "../_shared_g3ls/local_transport.ts";

Deno.serve(createHttpHandler(localEnv, {
  enabled: true,
  fetch: localFetch,
  createConnect: (databaseUrl) => localDbConnect(databaseUrl, "postona-x-reservations"),
}));
