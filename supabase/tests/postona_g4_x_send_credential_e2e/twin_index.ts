// TEST ONLY (G4-02 #19). Never deployed: postona_g4_x_send_credential_e2e_run.sh copies it into G3's throw-away local Supabase project
// (G3 PR #699's local_stack, read only) as functions/postona-x-single-post-g4cred-e2etest/index.ts. It is G3's own manual-send twin
// (postona-x-single-post-e2etest) with ONE difference: `credentials` is G4's REAL source -- G3's adapter xGenerationSourceFromG4Raw over
// G4's createG4XSendCredentialSource, reading public.postona_x_send_credential_v1 (003) through PostgREST with this stack's service-role
// key -- instead of G3's fake snapshot. The X API is still G3's test-only fake (every result is simulated); nothing reaches the real X.
import { createSinglePostHttpHandler } from "../postona-x-single-post/http.ts";
import { localDbConnect, localEnv, localFetch } from "../_shared_g3ls/local_transport.ts";
import { fakeXFor } from "../_shared_g3ls/fake_x.ts";
import { xGenerationSourceFromG4Raw } from "../_shared/postona_reservations/credential_generation_derivation.ts";
import { createG4XSendCredentialSource, createXSendCredentialRpcRead } from "../_shared_g4/x_send_credential_source.ts";

const { fakeX } = fakeXFor("g4xs-x-single-post-g4cred-e2e-test");

// The local stack's PostgREST behind kong, reached as http://localhost:8000 (localFetch sends exactly that origin to kong:8000).
const credentials = xGenerationSourceFromG4Raw(createG4XSendCredentialSource({
  read: createXSendCredentialRpcRead({
    supabaseUrl: "http://localhost:8000",
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    fetchImpl: localFetch as typeof fetch,
  }),
}));

Deno.serve(createSinglePostHttpHandler(localEnv, {
  enabled: true,
  authFetch: localFetch,
  createConnect: (databaseUrl) => localDbConnect(databaseUrl, "postona-x-single-post"),
  credentials,
  xFetch: fakeX,
}));
