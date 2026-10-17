// POSTONA Threads connect — the Edge ENTRY adapter (F4). It joins the three parts that already exist:
//   H5's hard-disabled handler (candidates/postona_threads_auth_runtime/disabled_entry.ts),
//   H5's runtime composition seam (candidates/.../wiring/nondeployable.ts: buildForApprovedSourceIntegration),
//   G4's HTTP contract (./threads_connect_edge.ts: createThreadsConnectHandler).
//
// While the static gate THREADS_CONNECT_EDGE_WIRED (G4, false in source) is closed the entry IS H5's disabled handler:
// no environment is read, nothing is constructed, and the runtime composition is never even loaded (it is imported
// dynamically, only past the gate). With the gate open, a request is still refused (503) unless THREADS_CONNECT_ENABLED
// is exactly "true", the environment is consistent, and H5's own strict config validation accepts it; any failure
// answers a fixed code and never echoes a value. (The PR #118 contract module and its own static gate stay untouched
// and unimported, as its isolation test requires; H5's disabled handler and source-isolation smoke still read it.)
//
// Environment names: the runtime's canonical names are POSTONA_THREADS_<NAME> (H5 wiring/config.ts). The PR #118
// contract names THREADS_APP_ID / THREADS_APP_SECRET / THREADS_REDIRECT_URI are accepted as aliases of APP_ID /
// APP_SECRET / CALLBACK only: when both a canonical and its alias are set they must be identical, otherwise refused.

import { handler as disabledHandler } from "../../../candidates/postona_threads_auth_runtime/disabled_entry.ts";
import { createThreadsConnectHandler, THREADS_CONNECT_EDGE_WIRED } from "./threads_connect_edge.ts";

export const THREADS_CONNECT_ENABLE_ENV = "THREADS_CONNECT_ENABLED";
export const CANONICAL_PREFIX = "POSTONA_THREADS_";
/** Canonical runtime name (without the prefix) -> the PR #118 contract alias. */
export const THREADS_ENV_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  APP_ID: "THREADS_APP_ID",
  APP_SECRET: "THREADS_APP_SECRET",
  CALLBACK: "THREADS_REDIRECT_URI",
});

export type EnvRead = (name: string) => string | undefined;
type SourceServer = { sourceHandler(request: Request): Promise<Response> };
type Composition = {
  buildForApprovedSourceIntegration(handlerFactory: typeof createThreadsConnectHandler, read: EnvRead): SourceServer;
};
export type ThreadsConnectEntryDeps = {
  read?: EnvRead;
  /** Tests only; production uses the static source gate. */
  gates?: { wired: boolean };
  loadComposition?: () => Promise<Composition>;
};

const present = (value: string | undefined): value is string => value !== undefined && value !== "";

/**
 * One reader for the runtime: POSTONA_THREADS_<NAME> first, else its alias. Refused (ok:false) when a canonical
 * name and its alias are both set and differ. Any other name reads as unset (the runtime asks for nothing else).
 */
export function harmonizedThreadsEnv(read: EnvRead): { ok: true; read: EnvRead } | { ok: false } {
  for (const [name, alias] of Object.entries(THREADS_ENV_ALIASES)) {
    const canonical = read(CANONICAL_PREFIX + name);
    const legacy = read(alias);
    if (present(canonical) && present(legacy) && canonical !== legacy) return { ok: false };
  }
  return {
    ok: true,
    read(name: string) {
      if (!name.startsWith(CANONICAL_PREFIX)) return undefined;
      const canonical = read(name);
      if (present(canonical)) return canonical;
      const alias = THREADS_ENV_ALIASES[name.slice(CANONICAL_PREFIX.length)];
      return alias ? read(alias) : undefined;
    },
  };
}

const unavailable = () =>
  Response.json({ ok: false, error: "THREADS_CONNECT_RUNTIME_UNAVAILABLE" }, {
    status: 503,
    headers: { "cache-control": "no-store" },
  });

export function createThreadsConnectEntry(deps: ThreadsConnectEntryDeps = {}): (request: Request) => Response | Promise<Response> {
  const gates = deps.gates ?? { wired: THREADS_CONNECT_EDGE_WIRED };
  // Closed in source: exactly H5's disabled handler. Nothing below is reached, read or loaded.
  if (gates.wired !== true) return disabledHandler;
  const read: EnvRead = deps.read ?? ((name) => Deno.env.get(name));
  const load = deps.loadComposition ??
    (() => import("../../../candidates/postona_threads_auth_runtime/wiring/nondeployable.ts") as Promise<Composition>);
  let server: Promise<SourceServer> | null = null;
  return async (request: Request) => {
    if (read(THREADS_CONNECT_ENABLE_ENV) !== "true") return disabledHandler(request);
    const env = harmonizedThreadsEnv(read);
    if (!env.ok) return unavailable();
    try {
      server ??= load().then((composition) => composition.buildForApprovedSourceIntegration(createThreadsConnectHandler, env.read));
      return await (await server).sourceHandler(request);
    } catch {
      server = null; // a refused or failed construction is retried (and refused again) on the next request
      return unavailable();
    }
  };
}
