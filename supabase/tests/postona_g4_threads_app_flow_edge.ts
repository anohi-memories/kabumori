// G4-02 #1 (Issue #561): the Threads connect Edge for the app product-flow e2e
// (apps/social-mobile/tests/threads-connect-product-flow.e2e.mjs), started by that test, which postona_g4_threads_person_session_run.sh
// (G4T_APP_FLOW=1) runs. It serves, on 127.0.0.1 only:
//   POST /open/...   the REAL entry (createThreadsConnectEntry) past its gates -> G4's composition (createG4ThreadsSourceServer:
//                    the real supabase-js Auth SDK, H5's config check, actor verifier and runtime, G4's owner bridge, G4's handler)
//                    -> the real SQL in the runner's local PostgreSQL 17
//   POST /closed/... the REAL entry exactly as in source (static gate closed: H5's disabled handler)
//   GET  /stats      how many Threads calls were made (so a test can prove none was) and the last SQL refusal
// Only the two ports a test may set are faked: ownerConnect (the local socket instead of H5's TLS connector) and fetch
// (GoTrue: JWKS + /auth/v1/user; Threads: code / long-lived / profile). Dummy configuration (H5's offline fixture). No network.
import { Client } from "@db/postgres";
import { createThreadsConnectEntry, THREADS_CONNECT_ENABLE_ENV } from "../functions/_shared/social/threads_connect_entry.ts";
import { createG4ThreadsSourceServer } from "../candidates/postona_g4_threads_personal_auth/composition.ts";
import { readConfig } from "../candidates/postona_threads_auth_runtime/wiring/config.ts";
import { fakeConfig } from "../candidates/postona_threads_auth_runtime/wiring/offline.fixture.ts";
import type { OwnerSqlClient } from "../candidates/postona_threads_auth_runtime/owner_transport.ts";

const env = (k: string) => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`${k} missing`);
  return v;
};
const host = env("FLOW_PGHOST"), port = Number(env("FLOW_PGPORT")), user = env("FLOW_PGUSER"), database = env("FLOW_DB");
if (!/^\/(private\/)?tmp\//.test(host) || !/^kb_tb_owner_\d+$/.test(user) || !/^kabumori_tb_\d+_app$/.test(database)) {
  throw new Error("LOCAL_FIXTURE_REQUIRED");
}
const jwk = JSON.parse(env("FLOW_JWK")) as JsonWebKey & { kid: string };

const config: Record<string, string> = {
  [THREADS_CONNECT_ENABLE_ENV]: "true",
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
  // the dummy key the test world seeds in vault (postona_threads_oauth_test_fixture.sql), not H5's offline one
  POSTONA_THREADS_ATTESTATION_KEY: "fake_attestation_key_0123456789abcdef0123456789abcdef",
};

let lastSqlError: string | null = null;

// ---- ownerConnect: the runner's owner role over the local socket ----------------------------------------------------
async function ownerConnect(): Promise<OwnerSqlClient> {
  const c = new Client({ hostname: host, host_type: "socket", port, user, database, applicationName: "g4_app_flow", connection: { attempts: 1 } });
  await c.connect();
  // A failing statement's message goes to stderr (the runner prints it when a test fails); nothing else is logged.
  return new Proxy(c, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        try {
          return await value.apply(target, args);
        } catch (e) {
          lastSqlError = (e as Error).message;
          console.error(`[edge sql] ${String(key)}: ${lastSqlError}`);
          throw e;
        }
      };
    },
  }) as unknown as OwnerSqlClient;
}

// ---- fetch: fake GoTrue (signature checked by the real SDK against this JWKS) and fake Threads -------------------------
let threadsCalls = 0;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const raw = (body: string) => Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
const fakeFetch: typeof fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin === new URL(fakeConfig.projectUrl).origin) {
    if (url.pathname === "/auth/v1/.well-known/jwks.json") return json({ keys: [jwk] });
    if (url.pathname === "/auth/v1/user") {
      const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
      try {
        const claims = JSON.parse(atob(token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/"))) as Record<string, unknown>;
        return json({ id: claims.sub, aud: "authenticated", role: "authenticated", is_anonymous: claims.is_anonymous });
      } catch {
        return json({ msg: "invalid JWT" }, 401);
      }
    }
    return json({ msg: "unexpected Auth endpoint" }, 404);
  }
  threadsCalls++;
  // The code names the Threads user it was issued to (code<puid>x<n>); puid 0 = Threads refuses the code.
  if (url.href.startsWith("https://graph.threads.com/oauth/access_token")) {
    const code = new URLSearchParams(String(init?.body)).get("code") ?? "";
    const puid = /^code([0-9]+)x[0-9]+$/.exec(code)?.[1] ?? "";
    if (puid === "0") return json({ error: { message: "Invalid verification code format.", type: "OAuthException", code: 100 } }, 400);
    // raw JSON: a Threads user id is past Number.MAX_SAFE_INTEGER (as the real API sends it)
    return raw(`{"access_token":"short${puid}abcdefghijkl","token_type":"bearer","user_id":${puid}}`);
  }
  if (url.href.startsWith("https://graph.threads.net/access_token")) {
    const puid = (url.searchParams.get("access_token") ?? "").replace(/^short|abcdefghijkl$/g, "");
    return json({ access_token: `long${puid}abcdefghijklmnop`, token_type: "bearer", expires_in: 5184000 });
  }
  if (url.href.startsWith("https://graph.threads.net/v1.0/me")) {
    const puid = (url.searchParams.get("access_token") ?? "").replace(/^long|abcdefghijklmnop$/g, "");
    return json({ id: puid, username: `flow_${puid.slice(-4)}` });
  }
  return json({}, 404);
};

// ---- the two entries ------------------------------------------------------------------------------------------------
const open = createThreadsConnectEntry({
  gates: { wired: true },
  read: (name) => config[name],
  // The entry's own composition call, with only the two test ports set (as H5's createSourceServer ports).
  loadComposition: () =>
    Promise.resolve({
      buildForApprovedSourceIntegration: (handlerFactory, read) =>
        createG4ThreadsSourceServer(readConfig(read), { handlerFactory, ownerConnect, fetch: fakeFetch }),
    }),
});
const closed = createThreadsConnectEntry();

// Never outlive the test process: it holds this child's stdin, which closes (EOF) when it exits for any reason.
(async () => {
  for await (const _ of Deno.stdin.readable);
  Deno.exit(0);
})();

Deno.serve({
  hostname: "127.0.0.1",
  port: 0,
  onListen: ({ port }) => console.log(`FLOW_EDGE ${JSON.stringify({ port, projectUrl: fakeConfig.projectUrl, callback: fakeConfig.callback })}`),
}, (request) => {
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path === "/stats") return Response.json({ threads: threadsCalls, lastSqlError });
  if (path.startsWith("/open/")) return open(request);
  if (path.startsWith("/closed/")) return closed(request);
  return new Response("not found", { status: 404 });
});
