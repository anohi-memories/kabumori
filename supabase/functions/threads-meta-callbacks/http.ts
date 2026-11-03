// HTTP entry for threads-meta-callbacks. SOURCE CANDIDATE (G4, Issue #319; see
// ../_shared/social/threads_meta_callback.ts). Routes, by the last path segment:
//   POST .../deauthorize     Meta's deauthorize callback
//   POST .../data-deletion   Meta's data deletion request callback
//   GET  .../deletion-status?code=   the status page the data deletion answer points to
// Closed while the static gate is false: every request answers 503 THREADS_META_CALLBACKS_DISABLED before the
// environment, the body or any store is touched. Even with the gate lifted there is no durable store yet
// (loadStore returns null), so the answer stays 503 STORE_UNAVAILABLE and nothing is acknowledged.
// Deploy-time dependencies, NOT done here: platform JWT verification must be OFF for this function only (Meta sends
// no Supabase JWT; the signed request is the authentication), THREADS_APP_SECRET and THREADS_META_DELETION_STATUS_URL
// set, both URLs registered in the Meta app, and a real Meta call checked on a non-production app.
import {
  acceptableAppSecret,
  createThreadsDeletionStatusHandler,
  createThreadsMetaCallbackHandler,
  failure,
  THREADS_META_CALLBACKS_ENABLED,
  type ThreadsDeletionStatusStore,
  type ThreadsMetaCallbackStore,
} from "../_shared/social/threads_meta_callback.ts";

export type Env = { get: (name: string) => string | undefined };
export type StoreLoader = () => (ThreadsMetaCallbackStore & ThreadsDeletionStatusStore) | null;

/** No durable store exists yet (a later, separately approved task). */
export const noDurableStore: StoreLoader = () => null;

export function createGatedHandler(enabled: boolean, env: Env, loadStore: StoreLoader) {
  return async (request: Request): Promise<Response> => {
    if (!enabled) return failure("THREADS_META_CALLBACKS_DISABLED");
    const route = new URL(request.url).pathname.replace(/\/+$/u, "").split("/").pop();
    if (route !== "deauthorize" && route !== "data-deletion" && route !== "deletion-status") {
      return Response.json({ ok: false, error: "NOT_FOUND" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    const store = loadStore();
    if (!store) return failure("STORE_UNAVAILABLE");
    if (route === "deletion-status") return await createThreadsDeletionStatusHandler({ store })(request);
    const appSecret = env.get("THREADS_APP_SECRET") ?? "";
    const statusBaseUrl = env.get("THREADS_META_DELETION_STATUS_URL") ?? "";
    if (!acceptableAppSecret(appSecret)) return failure("CONFIG_UNAVAILABLE");
    return await createThreadsMetaCallbackHandler({ appSecret, store, statusBaseUrl })(
      route === "deauthorize" ? "deauthorize" : "data_deletion",
      request,
    );
  };
}

/** The deployable entry: closed while THREADS_META_CALLBACKS_ENABLED is false, whatever the environment says. */
export function createHandler(env: Env, loadStore: StoreLoader = noDurableStore) {
  return createGatedHandler(THREADS_META_CALLBACKS_ENABLED, env, loadStore);
}
