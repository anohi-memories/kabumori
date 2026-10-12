// G4 CONNECT + CLEANUP SMOKE — runs ONLY inside the disposable combined checkout built by
// supabase/tests/postona_threads_connect_smoke_run.sh (exact read-only copies of PR #124 / #135 / #139 and
// PR #152's provider_cleanup.ts next to this branch). In this branch alone the H5 / G5 imports do not exist
// on purpose; the file has no _test suffix so no default run picks it up.
//
// 1. G4's connect HTTP contract (threads_connect_edge.ts) composed with H5's REAL runtime
//    (createThreadsRuntime + verifier) and fake Meta / owner bridge: start -> the exact official URL ->
//    callback -> the verified receipt, publish_enabled false; a foreign callback never reaches H5.
// 2. G4's Threads cleanup adapter through G5's REAL port (runProviderCleanups from PR #152): removed ->
//    proceed with 'threads' remote-unverified; in flight / lost answer -> reconciliation_required.

import { createActorVerifier } from "../postona_threads_auth_runtime/verified_actor.ts";
import { createThreadsRuntime } from "../postona_threads_auth_runtime/runtime.ts";
import { createThreadsConnectHandler } from "../../functions/_shared/social/threads_connect_edge.ts";
import { createThreadsProviderCleanupAdapter } from "../../functions/_shared/social/threads_provider_cleanup.ts";
import { type ProviderCleanupAdapter, runProviderCleanups } from "../../functions/account-delete/provider_cleanup.ts";

function check(value: unknown, label: string) {
  if (!value) throw new Error(`CONNECT_CLEANUP_SMOKE_FAILED: ${label}`);
}

const CALLBACK = "https://postona.example/threads/callback";

Deno.test("G4 connect contract composes with H5's real runtime: start -> official URL -> callback -> verified receipt", async () => {
  const ms = Date.now();
  const userId = "00000000-0000-4000-8000-000000000001";
  const auth = "Bearer offline_dummy_session";
  const verify = createActorVerifier({
    getClaims: () => Promise.resolve({ data: { claims: { sub: userId, session_id: "00000000-0000-4000-8000-000000000002", role: "authenticated", aud: "authenticated", is_anonymous: false, exp: ms / 1000 + 3600 } }, error: null }),
    getUser: () => Promise.resolve({ data: { user: { id: userId, is_anonymous: false } }, error: null }),
  }, () => ms);
  let stateHash = "";
  let completes = 0;
  const bridge = {
    begin: (_a: unknown, h: string) => { stateHash = h; return Promise.resolve({ brand_id: "u_" + "a".repeat(24), social_account_id: "sa_" + "b".repeat(24) }); },
    claim: (_a: unknown, h: string) => {
      check(h === stateHash, "claim of the begun state");
      return Promise.resolve({ oauth_state_id: "00000000-0000-4000-8000-000000000003", brand_id: "u_" + "a".repeat(24), social_account_id: "sa_" + "b".repeat(24), expires_at: new Date(ms + 600000).toISOString(), redirect_uri: CALLBACK });
    },
    complete: () => { completes += 1; return Promise.resolve(); },
    uncertain: () => Promise.resolve(),
  };
  let meta = 0;
  const runtime = createThreadsRuntime({
    verify, bridge: bridge as never, now: () => ms,
    settings: { appId: "123456", appSecret: "offline_dummy_app_secret_1234567890", redirectUri: CALLBACK },
    attestationKey: "offline_dummy_attestation_" + "k".repeat(40),
    fetch: () => {
      meta += 1;
      return Promise.resolve(new Response(
        meta === 1 ? '{"access_token":"offline_dummy_SHORT_TOKEN_123456","token_type":"bearer","user_id":17841405793187218}'
          : meta === 2 ? '{"access_token":"offline_dummy_LONG_TOKEN_123456","token_type":"bearer","expires_in":5184000}'
          : '{"id":"17841405793187218","username":"offline_dummy"}', { status: 200 }));
    },
  });
  const handler = createThreadsConnectHandler(runtime, { registeredCallback: CALLBACK });
  const post = (body: unknown) => new Request("https://edge.example", { method: "POST", headers: { "Content-Type": "application/json", Authorization: auth }, body: JSON.stringify(body) });

  const started = await handler(post({ action: "start" }));
  const start = await started.json();
  check(started.status === 200 && start.provider === "threads", `start: ${started.status}`);
  const state = new URL(start.authorization_url).searchParams.get("state");
  check(new URL(start.authorization_url).searchParams.get("redirect_uri") === CALLBACK, "redirect is the registered callback");

  const foreign = await handler(post({ action: "callback", callback_url: `https://evil.example/threads/callback?code=x&state=${state}` }));
  check(foreign.status === 400 && meta === 0, "a foreign callback never reaches H5 or Meta");

  const done = await handler(post({ action: "callback", callback_url: `${CALLBACK}?code=offline_dummy_code&state=${state}#_` }));
  const receipt = await done.json();
  check(done.status === 200 && receipt.status === "connected" && receipt.publish_enabled === false && receipt.social_account_id === "sa_" + "b".repeat(24), `callback: ${done.status}`);
  check(completes === 1 && meta === 3, "H5 completed once after exactly three Meta calls");
  check(!JSON.stringify(receipt).includes("TOKEN") && !JSON.stringify(start).includes("secret"), "no credential in the answers");
  console.log("G4_CONNECT_SMOKE_PASS");
});

Deno.test("G4 Threads cleanup adapter through G5's real provider cleanup port", async () => {
  const user = "00000000-0000-4000-8000-0000000000a1";
  const adapter = (cleanup: unknown, state: unknown = "connected", throws = false): ProviderCleanupAdapter =>
    createThreadsProviderCleanupAdapter({
      connectionState: () => Promise.resolve(state),
      cleanup: () => (throws ? Promise.reject(new Error("lost")) : Promise.resolve(cleanup)),
    });
  const removed = await runProviderCleanups([adapter({ outcome: "local_removed_remote_unverified", code: "LOCAL_REMOVED" })], user);
  check(removed.decision === "proceed" && removed.remoteUnverified.join() === "threads", JSON.stringify(removed));
  const inFlight = await runProviderCleanups([adapter({ outcome: "reconciliation_required", code: "PUBLISH_IN_FLIGHT" })], user);
  check(inFlight.decision === "reconciliation_required", JSON.stringify(inFlight));
  const lost = await runProviderCleanups([adapter(null, "connected", true)], user);
  check(lost.decision === "reconciliation_required", JSON.stringify(lost));
  const notConnected = await runProviderCleanups([adapter(null, "not_connected")], user);
  check(notConnected.decision === "proceed" && notConnected.providers[0].result === "not_connected", JSON.stringify(notConnected));
  const unreadable = await runProviderCleanups([adapter(null, null)], user);
  check(unreadable.decision === "reconciliation_required", JSON.stringify(unreadable));
  console.log("G4_CLEANUP_PORT_SMOKE_PASS");
});
