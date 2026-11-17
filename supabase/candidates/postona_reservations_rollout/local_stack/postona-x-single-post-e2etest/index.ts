// TEST ONLY (G3-02 #26). Never deployed: run.sh copies it into a throw-away local Supabase project only. The real postona-x-single-post
// handler (createSinglePostHttpHandler: Auth -> post_now_begin -> ONE credentialFor -> post_now_preflight -> one X create ->
// post_now_record -> post_now_readback on a separate connection) on the real Edge runtime behind the real local Kong / GoTrue, with the
// localtest twins' differences (the release gate passed as enabled; Auth via kong; the db container without TLS) and, at the TEST BOUNDARY
// only, the overrides the handler already takes for tests: `credentials` = the FAKE snapshot (not G4's source) and `xFetch` = the fake X of
// ../_shared_g3ls/fake_x.ts (so every result is recorded as simulated). Nothing reaches the real X.
import { createSinglePostHttpHandler } from "../postona-x-single-post/http.ts";
import { localDbConnect, localEnv, localFetch } from "../_shared_g3ls/local_transport.ts";
import { fakeXFor } from "../_shared_g3ls/fake_x.ts";

const { credentials, fakeX } = fakeXFor("g3ls-x-single-post-e2e-test-double");

Deno.serve(createSinglePostHttpHandler(localEnv, {
  enabled: true,
  authFetch: localFetch,
  createConnect: (databaseUrl) => localDbConnect(databaseUrl, "postona-x-single-post"),
  credentials,
  xFetch: fakeX,
}));
