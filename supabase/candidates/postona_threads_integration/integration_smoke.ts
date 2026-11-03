// G4 INTEGRATION SMOKE — runs ONLY inside the disposable combined checkout that
// supabase/tests/postona_threads_integration_run.sh builds from exact, read-only copies of PR #124 / #135 /
// #139 next to this branch. In this branch alone the H5 imports below do not exist; that is deliberate
// (nothing deployable imports unmerged H5 code), and the file name has no _test suffix so no default test
// run picks it up.
//
// What it proves, all with fakes (no network, no Meta, no Supabase):
//   H5's REAL verifier + runtime (start -> callback -> durable claim -> exchange -> complete) produce a
//   receipt that G4 accepts only as a receipt; the H5 bridge's completion lands what PR #124 complete +
//   G4 custody would store; G4's REAL Edge logic then refuses to post until the person explicitly allows
//   it, posts exactly once after that, and reads the post back. The H5 actor's user is the G4 caller.

import { createActorVerifier } from "../postona_threads_auth_runtime/verified_actor.ts";
import { createThreadsRuntime } from "../postona_threads_auth_runtime/runtime.ts";
import { handleThreadsPublish, type ThreadsPublishHandlerDeps } from "../../functions/social-mobile-threads-publish/logic.ts";
import { parseThreadsConnectReceipt } from "../../functions/_shared/social/threads_connect_publish_integration.ts";
import { FakeThreadsPublishStore } from "../../functions/_shared/social/threads_manual_publish_fake.ts";

function check(value: unknown, label: string) {
  if (!value) throw new Error(`INTEGRATION_SMOKE_FAILED: ${label}`);
}

Deno.test("H5 connect (real runtime, fake Meta/DB) -> G4 receipt -> explicit permission -> one Threads post -> read-back", async () => {
  const ms = Date.parse("2026-10-11T03:00:00Z");
  const userId = "00000000-0000-4000-8000-000000000001";
  const sessionId = "00000000-0000-4000-8000-000000000002";
  const jwt = "offline_dummy_session_jwt";
  const auth = `Bearer ${jwt}`;
  const sdk = {
    getClaims: () => Promise.resolve({ data: { claims: { sub: userId, session_id: sessionId, role: "authenticated", aud: "authenticated", is_anonymous: false, exp: ms / 1000 + 3600 } }, error: null }),
    getUser: () => Promise.resolve({ data: { user: { id: userId, is_anonymous: false } }, error: null }),
  };
  const verify = createActorVerifier(sdk, () => ms);

  // The G4 database, as the fake reference model. The H5 bridge below writes into it what PR #124 complete,
  // G4 custody and H5 outcome would write in ONE owner transaction.
  const store = new FakeThreadsPublishStore();
  store.clock = ms;
  store.tokens.set(jwt, userId);
  store.services.set(userId, "active");
  const brandId = "u_" + "a".repeat(24);
  const socialAccountId = "sa_" + "b".repeat(24);
  store.memberships.set(`${brandId}|${userId}`, "owner");
  let stateHash = "";
  let completes = 0;
  const bridge = {
    begin: (_a: unknown, h: string) => {
      stateHash = h;
      return Promise.resolve({ brand_id: brandId, social_account_id: socialAccountId });
    },
    claim: (_a: unknown, h: string) => {
      check(h === stateHash, "claim of the begun state");
      return Promise.resolve({ oauth_state_id: "00000000-0000-4000-8000-000000000003", brand_id: brandId, social_account_id: socialAccountId, expires_at: new Date(ms + 600000).toISOString(), redirect_uri: "https://postona.example/callback" });
    },
    complete: (actor: { userId: string }, _h: string, p: { p_access_token: string; p_platform_user_id: string }, expiry: Date) => {
      check(actor.userId === userId, "the verified actor completes");
      completes += 1;
      // complete_social_mobile_threads_oauth_connection + record_threads_credential_custody (same expiry).
      store.accounts.set(socialAccountId, { brandId, platform: "threads", connection: "identity_verified", threadsUserId: p.p_platform_user_id, token: p.p_access_token, expiresAt: expiry.getTime() });
      return Promise.resolve();
    },
    uncertain: () => Promise.resolve(),
  };
  let metaConnect = 0;
  const connectFetch = (_url: string, init?: RequestInit) => {
    check(init?.redirect === "error", "no redirects");
    metaConnect += 1;
    return Promise.resolve(new Response(
      metaConnect === 1 ? '{"access_token":"offline_dummy_SHORT_TOKEN_123456","token_type":"bearer","user_id":17841405793187218}'
        : metaConnect === 2 ? '{"access_token":"offline_dummy_LONG_TOKEN_123456","token_type":"bearer","expires_in":5184000}'
        : '{"id":"17841405793187218","username":"offline_dummy"}',
      { status: 200 },
    ));
  };
  const runtime = createThreadsRuntime({
    verify, bridge: bridge as never, fetch: connectFetch, now: () => ms,
    settings: { appId: "123456", appSecret: "offline_dummy_app_secret_1234567890", redirectUri: "https://postona.example/callback" },
    attestationKey: "offline_dummy_attestation_" + "k".repeat(40),
  });
  const started = await runtime.start(auth);
  check(started.ok, "H5 start");
  const state = new URL(started.authorizationUrl!).searchParams.get("state");
  const receiptRaw = await runtime.callback(auth, `https://postona.example/callback?code=offline_dummy_code&state=${state}`);
  check(receiptRaw.ok && completes === 1 && metaConnect === 3, "H5 callback completed once");
  check(!JSON.stringify(receiptRaw).includes("TOKEN"), "no credential in the receipt");

  // G4 accepts the receipt as a receipt only.
  const receipt = parseThreadsConnectReceipt(receiptRaw, new Date(ms));
  check(receipt?.socialAccountId === socialAccountId, "receipt accepted");
  check(store.accounts.get(socialAccountId)?.expiresAt === Date.parse(receipt!.tokenExpiresAt), "custody expiry = receipt expiry");
  // The same verified person is the G4 caller (the Edge re-verifies the bearer token itself).
  const actor = await verify(auth);
  check(actor.userId === userId, "actor is the caller");

  // G4 publish, through the real Edge logic.
  const queue = [{ id: "17890000000000001" }, { id: "17890000000000001", status: "FINISHED" }, { id: "17890000000000003" },
    { id: "17890000000000003", permalink: "https://www.threads.net/@offline_dummy/post/AbC", owner: { id: "17841405793187218" } }];
  let metaWrites = 0;
  const deps: ThreadsPublishHandlerDeps = {
    getUser: (token) => Promise.resolve(token === jwt ? { id: userId } : null),
    store,
    fetch: (_url, init) => {
      if (init?.method === "POST") metaWrites += 1;
      const next = queue.shift();
      return next ? Promise.resolve(new Response(JSON.stringify(next), { status: 200 })) : Promise.reject(new Error("unscripted"));
    },
    sleep: () => Promise.resolve(),
    now: () => new Date(ms),
  };
  const req = (body: unknown) => new Request("https://edge.example", { method: "POST", headers: { "Content-Type": "application/json", Authorization: auth }, body: JSON.stringify(body) });
  const publish = { action: "publish", social_account_id: socialAccountId, idempotency_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", text: "POSTONAから最初のThreads投稿" };
  const refused = await (await handleThreadsPublish(req(publish), deps)).json();
  check(refused.error === "MANUAL_PUBLISH_NOT_PERMITTED" && metaWrites === 0, "connected is not permitted");
  await handleThreadsPublish(req({ action: "set_permission", social_account_id: socialAccountId, desired_enabled: true, expected_current_enabled: false }), deps);
  const done = await (await handleThreadsPublish(req(publish), deps)).json();
  check(done.attempt?.status === "published" && done.attempt.permalink === "https://www.threads.net/@offline_dummy/post/AbC", "published and read back");
  check(metaWrites === 2, "exactly two Meta writes");
  console.log("G4_INTEGRATION_SMOKE_TS_PASS");
});
