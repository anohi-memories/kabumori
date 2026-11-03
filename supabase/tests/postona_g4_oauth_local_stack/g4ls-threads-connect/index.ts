// TEST ONLY (G4-02 #6). Never deployed: run.sh copies it into a throw-away local Supabase project. The REAL Threads connect entry
// (createThreadsConnectEntry) and G4's REAL composition (H5's strict config, supabase-js Auth SDK with real GoTrue / JWKS, H5's verifier
// and runtime, G4's owner bridge, G4's HTTP handler) behind the real Kong on the real Edge runtime. Test-only differences, nothing else:
//   the static gate is passed as open; the database port is the local `db` container (no TLS; H5's connector pins TLS to a managed host);
//   the HTTP port sends the configured project origin to kong:8000 and Threads to the in-process fake (lib.ts). Anything else is refused.
// Routes: /g4ls-threads-connect          the personal product pin
//         /g4ls-threads-connect/unpinned no profile        /g4ls-threads-connect/full    the full profile
//         /g4ls-threads-connect/default  the entry's REAL default loader (no port): proves the dynamic import and the bare imports
//                                        resolve on the real Edge runtime with the function's deno.json; refuses before any network
import { createThreadsConnectEntry, THREADS_CONNECT_ENABLE_ENV } from "../_shared/social/threads_connect_entry.ts";
import { createG4ThreadsSourceServer, G4_AUTH_PROFILE_ENV, g4ProductAuthProfile } from "../../candidates/postona_g4_threads_personal_auth/composition.ts";
import { readConfig } from "../../candidates/postona_threads_auth_runtime/wiring/config.ts";
import { fakeConfig } from "../../candidates/postona_threads_auth_runtime/wiring/offline.fixture.ts";
import { localFetch, ownerConnect } from "../_shared_g4ls/lib.ts";

const config: Record<string, string | undefined> = {
  [THREADS_CONNECT_ENABLE_ENV]: "true",
  [G4_AUTH_PROFILE_ENV]: "personal",
  POSTONA_THREADS_PROJECT_URL: fakeConfig.projectUrl,
  POSTONA_THREADS_PROJECT_REF: fakeConfig.projectRef,
  POSTONA_THREADS_PUBLISHABLE_KEY: fakeConfig.publishableKey,
  POSTONA_THREADS_DB_HOST: fakeConfig.hostname,
  POSTONA_THREADS_DB_PORT: String(fakeConfig.port),
  POSTONA_THREADS_DB_NAME: fakeConfig.database,
  POSTONA_THREADS_DB_OWNER: fakeConfig.owner,
  POSTONA_THREADS_DB_PASSWORD: fakeConfig.password,
  POSTONA_THREADS_DB_CA_PEM: fakeConfig.caPem,
  POSTONA_THREADS_APP_ID: fakeConfig.appId,
  POSTONA_THREADS_APP_SECRET: fakeConfig.appSecret,
  POSTONA_THREADS_CALLBACK: fakeConfig.callback,
  POSTONA_THREADS_ATTESTATION_KEY: Deno.env.get("G4LS_ATTESTATION_KEY"),
};
const entry = (settings: Record<string, string | undefined>) =>
  createThreadsConnectEntry({
    gates: { wired: true },
    read: (name) => settings[name],
    loadComposition: () =>
      Promise.resolve({
        buildForApprovedSourceIntegration: (handlerFactory, read) =>
          createG4ThreadsSourceServer(readConfig(read), { handlerFactory, ownerConnect, fetch: localFetch }, g4ProductAuthProfile(read(G4_AUTH_PROFILE_ENV))),
      }),
  });
const product = entry(config);
const unpinned = entry({ ...config, [G4_AUTH_PROFILE_ENV]: undefined });
const full = entry({ ...config, [G4_AUTH_PROFILE_ENV]: "full" });
const realDefaultLoader = createThreadsConnectEntry({ gates: { wired: true }, read: (name) => config[name] });

Deno.serve((request) => {
  const path = new URL(request.url).pathname;
  if (path.endsWith("/unpinned")) return unpinned(request);
  if (path.endsWith("/full")) return full(request);
  if (path.endsWith("/default")) return realDefaultLoader(request);
  return product(request);
});
