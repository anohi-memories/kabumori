import { createClient } from "@supabase/supabase-js";
import {
  type AuthSdk,
  createActorVerifier,
  RuntimeRefusal,
} from "../verified_actor.ts";
import {
  createOwnerTransport,
  type OwnerSqlClient,
} from "../owner_transport.ts";
import { createThreadsRuntime } from "../runtime.ts";
import { createPostgresConnector } from "./postgres_connector.ts";
import { type RuntimeConfig, validateConfig } from "./config.ts";
export type HandlerFactory = (
  runtime: ReturnType<typeof createThreadsRuntime>,
  config: { registeredCallback: string },
) => (request: Request) => Promise<Response>;
export type ConstructionPorts = {
  /** Pinned G4 createThreadsConnectHandler, injected only after source integration. */
  handlerFactory: HandlerFactory;
  /** Offline tests substitute transport; actual default is the TLS driver above. */
  ownerConnect?: () => Promise<OwnerSqlClient>;
  fetch?: typeof fetch;
};
/** Builds the ACTUAL SDK+driver+runtime+G4 HTTP composition, but does not mount/serve it.
 * This file is not an Edge entry and has no import-time env/SDK/Auth/SQL/provider effects. */
export function createSourceServer(
  config: RuntimeConfig,
  ports: ConstructionPorts,
) {
  const c = validateConfig(config);
  if (typeof ports.handlerFactory !== "function") {
    throw new RuntimeRefusal("HTTP_INTEGRATION_UNAVAILABLE");
  }
  const http = ports.fetch ?? fetch;
  const authFetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url,
    );
    const expected = new URL(c.projectUrl);
    if (
      url.origin !== expected.origin || !url.pathname.startsWith("/auth/v1/") ||
      init?.redirect === "follow"
    ) {
      throw new RuntimeRefusal("AUTH_REQUIRED");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      return await http(input, {
        ...init,
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new RuntimeRefusal("AUTH_REQUIRED");
    } finally {
      clearTimeout(timer);
    }
  };
  const client = createClient(c.projectUrl, c.publishableKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch: authFetch },
  });
  const auth: AuthSdk = {
    async getClaims(jwt) {
      const r = await client.auth.getClaims(jwt);
      if (
        r.error || !r.data ||
        r.data.claims.iss !== new URL("auth/v1", c.projectUrl).href
      ) return { data: null, error: true };
      return { data: { claims: r.data.claims }, error: null };
    },
    getUser(jwt) {
      return client.auth.getUser(jwt);
    },
  };
  const runtime = createThreadsRuntime({
    verify: createActorVerifier(auth),
    bridge: createOwnerTransport(
      ports.ownerConnect ?? createPostgresConnector(c),
    ),
    settings: {
      appId: c.appId,
      appSecret: c.appSecret,
      redirectUri: c.callback,
    },
    attestationKey: c.attestationKey,
    fetch: (u, i) => http(u, i),
  });
  const handle = ports.handlerFactory(runtime, {
    registeredCallback: c.callback,
  });
  return Object.freeze({
    /** Offline/source callable, deliberately NOT exported from Edge index. */
    async sourceHandler(request: Request) {
      try {
        return await handle(request);
      } catch {
        return Response.json({
          ok: false,
          error: "THREADS_CONNECT_RUNTIME_UNAVAILABLE",
        }, { status: 503, headers: { "cache-control": "no-store" } });
      }
    },
  });
}
