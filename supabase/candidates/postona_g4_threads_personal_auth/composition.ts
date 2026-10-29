// POSTONA Threads connect — G4's runtime composition (G4-02 #1, Issue #561). The composition the Edge entry
// (functions/_shared/social/threads_connect_entry.ts) loads past its gates: the same construction as H5's
// createSourceServer (candidates/postona_threads_auth_runtime/wiring/server_factory.ts) — H5's strict config, the
// pinned GoTrue SDK, H5's actor verifier, H5's runtime, H5's TLS-pinned Postgres connector, G4's HTTP handler — with
// ONE difference: the runtime's bridge is G4's owner bridge (owner_bridge.ts), so a connect records its generation at
// begin, completes through G4's binding entry (complete_and_attest_binding + the custody connect proof) and carries
// is_anonymous=false only for a sealed actor. H5's own transport cannot complete against that SQL (G4-50, control 4).
//
// H5's files are not changed. H5's factory has no bridge port, so the SDK/Auth construction below is a line-for-line
// copy of createSourceServer's (same origin + /auth/v1/ pin, redirect "error", 5 s timeout, issuer check). When H5
// adds `bridgeFactory` to ConstructionPorts (G4-50 IF), this module reduces to
//   createSourceServer(readConfig(read), { handlerFactory, bridgeFactory: (connect) => createG4ThreadsOwnerBridge(connect, Date.now, profile) }).
// G4-02 #2: the bridge's G5 profile is pinned by POSTONA_THREADS_G4_AUTH_PROFILE ("full" | "personal"; unset = not built).
// No import-time env/SDK/Auth/SQL/provider effects; not an Edge entry (no Deno.serve, no Deno.env).

import { createClient } from "@supabase/supabase-js";
import { type AuthSdk, createActorVerifier, RuntimeRefusal } from "../postona_threads_auth_runtime/verified_actor.ts";
import type { OwnerSqlClient } from "../postona_threads_auth_runtime/owner_transport.ts";
import { createThreadsRuntime } from "../postona_threads_auth_runtime/runtime.ts";
import { createPostgresConnector } from "../postona_threads_auth_runtime/wiring/postgres_connector.ts";
import { readConfig, type RuntimeConfig, validateConfig } from "../postona_threads_auth_runtime/wiring/config.ts";
import type { HandlerFactory } from "../postona_threads_auth_runtime/wiring/server_factory.ts";
import { createG4ThreadsOwnerBridge, G4_AUTH_PROFILES, type G4AuthProfile } from "./owner_bridge.ts";

/** G4-02 #2: which G5 profile the database runs ("full" | "personal"); required, never guessed (owner_bridge.ts). */
export const G4_AUTH_PROFILE_ENV = "POSTONA_THREADS_G4_AUTH_PROFILE";

export type G4ConstructionPorts = {
  /** G4's createThreadsConnectHandler (the entry passes it). */
  handlerFactory: HandlerFactory;
  /** Tests only: a local database instead of H5's TLS-pinned connector. */
  ownerConnect?: () => Promise<OwnerSqlClient>;
  /** Tests only: fake GoTrue / Threads instead of the network. */
  fetch?: typeof fetch;
};

/** The configured profile, or a refusal (unset or anything else: the composition is not built). */
export function g4AuthProfile(value: string | undefined): G4AuthProfile {
  if (!G4_AUTH_PROFILES.includes(value as G4AuthProfile)) throw new RuntimeRefusal("HTTP_INTEGRATION_UNAVAILABLE");
  return value as G4AuthProfile;
}

/** Builds the actual SDK + verifier + runtime + G4 bridge + G4 HTTP composition; does not mount or serve it. */
export function createG4ThreadsSourceServer(config: RuntimeConfig, ports: G4ConstructionPorts, profile: G4AuthProfile) {
  const c = validateConfig(config);
  const pinned = g4AuthProfile(profile);
  if (typeof ports.handlerFactory !== "function") throw new RuntimeRefusal("HTTP_INTEGRATION_UNAVAILABLE");
  const http = ports.fetch ?? fetch;
  // As H5's createSourceServer: the SDK may only reach this project's /auth/v1/, never follows a redirect, 5 s.
  const authFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const expected = new URL(c.projectUrl);
    if (url.origin !== expected.origin || !url.pathname.startsWith("/auth/v1/") || init?.redirect === "follow") {
      throw new RuntimeRefusal("AUTH_REQUIRED");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      return await http(input, { ...init, redirect: "error", signal: controller.signal });
    } catch {
      throw new RuntimeRefusal("AUTH_REQUIRED");
    } finally {
      clearTimeout(timer);
    }
  };
  const client = createClient(c.projectUrl, c.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: authFetch },
  });
  const auth: AuthSdk = {
    async getClaims(jwt) {
      const r = await client.auth.getClaims(jwt);
      if (r.error || !r.data || r.data.claims.iss !== new URL("auth/v1", c.projectUrl).href) return { data: null, error: true };
      return { data: { claims: r.data.claims }, error: null };
    },
    getUser(jwt) {
      return client.auth.getUser(jwt);
    },
  };
  const runtime = createThreadsRuntime({
    verify: createActorVerifier(auth),
    // The one difference from H5's factory: G4's bridge instead of createOwnerTransport.
    bridge: createG4ThreadsOwnerBridge(ports.ownerConnect ?? createPostgresConnector(c), Date.now, pinned),
    settings: { appId: c.appId, appSecret: c.appSecret, redirectUri: c.callback },
    attestationKey: c.attestationKey,
    fetch: (u, i) => http(u, i),
  });
  const handle = ports.handlerFactory(runtime, { registeredCallback: c.callback });
  return Object.freeze({
    async sourceHandler(request: Request) {
      try {
        return await handle(request);
      } catch {
        return Response.json({ ok: false, error: "THREADS_CONNECT_RUNTIME_UNAVAILABLE" }, {
          status: 503,
          headers: { "cache-control": "no-store" },
        });
      }
    },
  });
}

/** The entry's composition seam (same shape as H5's nondeployable.ts): H5's strict reader, the pinned profile, then the G4 server. */
export function buildForApprovedSourceIntegration(handlerFactory: HandlerFactory, read: (name: string) => string | undefined) {
  return createG4ThreadsSourceServer(readConfig(read), { handlerFactory }, g4AuthProfile(read(G4_AUTH_PROFILE_ENV)));
}
