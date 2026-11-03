// HTTP entry for social-mobile-threads-disconnect. SOURCE CANDIDATE (hard-disabled; see
// ../_shared/social/threads_disconnect.ts and docs/postona/threads-disconnect-and-lease-safe-cleanup-v1.md).
//
// Outgoing calls, and with which credential:
//  - Auth: GET  /auth/v1/user                         caller's token (is it valid now)
//  - RPC:  disconnect_threads_account(id, handle)     CALLER'S token: auth.uid() and the session are the caller's
// No service-role key, no Threads call, no table read or written directly, nothing logged.

import { createGetUser } from "../social-mobile-threads-publish/http.ts";
import {
  createThreadsDisconnectRpc,
  type FetchLike,
  gatedThreadsDisconnectHandler,
  handleThreadsDisconnect,
  THREADS_DISCONNECT_SERVER_ENABLED,
} from "../_shared/social/threads_disconnect.ts";

/** The deployable entry. Closed while the static gate is false, whatever the environment says. */
export function createHandler(env: { get: (name: string) => string | undefined }, fetchImpl: FetchLike = fetch) {
  return gatedThreadsDisconnectHandler(THREADS_DISCONNECT_SERVER_ENABLED, (request) => {
    const supabaseUrl = (env.get("SUPABASE_URL") ?? "").replace(/\/$/u, "");
    const anonKey = env.get("SUPABASE_ANON_KEY") ?? "";
    if (!supabaseUrl || !anonKey) {
      return Promise.resolve(Response.json({ ok: false, error: "STORE_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } }));
    }
    return handleThreadsDisconnect(request, {
      getUser: createGetUser({ supabaseUrl, anonKey }, fetchImpl),
      disconnect: createThreadsDisconnectRpc({ supabaseUrl, anonKey }, fetchImpl),
    });
  });
}
