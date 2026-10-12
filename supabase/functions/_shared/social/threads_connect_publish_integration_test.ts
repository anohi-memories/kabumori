import assert from "node:assert/strict";
import test from "node:test";
import { handleThreadsPublish, type ThreadsPublishHandlerDeps } from "../../social-mobile-threads-publish/logic.ts";
import {
  firstUnavailableStage,
  parseThreadsConnectReceipt,
  THREADS_COMPLETE_TRANSACTION_SQL,
  THREADS_INTEGRATION_STAGES,
  type ThreadsIntegrationProbe,
} from "./threads_connect_publish_integration.ts";
import { FakeThreadsPublishStore } from "./threads_manual_publish_fake.ts";
import type { FetchLike } from "./threads_publish_contract.ts";

// Fake values only.
const USER = "11111111-1111-4111-8111-111111111111";
const JWT = "owner-jwt-fixture";
const ACCOUNT = "sa_0123456789abcdef01234567";
const THREADS_USER = "17841405793187218";
const TOKEN = "THQVJfakeLongLivedPublishToken0123456789";
const NOW = new Date("2026-10-11T03:00:00Z");
const RECEIPT = { ok: true, status: "connected", provider: "threads", socialAccountId: ACCOUNT, publishEnabled: false, tokenExpiresAt: "2026-12-10T03:00:00.000Z" };

test("the connect receipt is accepted exactly, and only as a receipt", () => {
  assert.deepEqual(parseThreadsConnectReceipt(RECEIPT, NOW), { socialAccountId: ACCOUNT, tokenExpiresAt: "2026-12-10T03:00:00.000Z" });
  for (const bad of [
    { ...RECEIPT, publishEnabled: true },
    { ...RECEIPT, provider: "x" },
    { ...RECEIPT, status: "pending" },
    { ...RECEIPT, ok: false },
    { ...RECEIPT, socialAccountId: "sa_x" },
    { ...RECEIPT, tokenExpiresAt: "2026-10-11T02:59:59Z" },
    { ...RECEIPT, tokenExpiresAt: "2027-01-01T00:00:00Z" },
    { ...RECEIPT, tokenExpiresAt: "soon" },
    { ...RECEIPT, accessToken: TOKEN },
    { ...RECEIPT, userId: USER },
    null, [], "connected",
  ]) {
    assert.equal(parseThreadsConnectReceipt(bad, NOW), null, JSON.stringify(bad));
  }
});

test("readiness today: the very first missing stage is the connection, and it says exactly what is missing", () => {
  // Today the connect gate is false in source (PR #118's static gate, which this module deliberately does
  // not import: that contract stays unimported) and nothing else is provisioned.
  const today: ThreadsIntegrationProbe = { CONNECT_GATE: false };
  const first = firstUnavailableStage(today);
  assert.equal(first?.stage, "actor");
  assert.deepEqual(first?.missing, ["AUTH_GET_CLAIMS"]);
  // With the verifier wired but the owner transport unprovisioned, the chain stops at the OAuth state.
  const noOwner = firstUnavailableStage({ AUTH_GET_CLAIMS: true, CONNECT_GATE: true, T13_LIVE: true, PHASE_2A2_APPLIED: true, CONNECT_SQL_APPLIED: true });
  assert.deepEqual(noOwner, { stage: "oauth_state", missing: ["OWNER_TRANSPORT"] });
  // The custody wiring (the one H5 change) is named at the completion stage.
  const all = Object.fromEntries(THREADS_INTEGRATION_STAGES.flatMap((s) => s.needs).map((n) => [n, true])) as ThreadsIntegrationProbe;
  assert.deepEqual(firstUnavailableStage({ ...all, CUSTODY_WIRED: false }), { stage: "complete", missing: ["CUSTODY_WIRED"] });
  assert.deepEqual(firstUnavailableStage({ ...all, PUBLISH_GATE: false }), { stage: "release_write", missing: ["PUBLISH_GATE"] });
  // Everything technical in place still needs the review and the explicit pilot approval.
  assert.deepEqual(firstUnavailableStage(all), { stage: "pilot", missing: ["INTEGRATED_REVIEW", "PILOT_APPROVED"] });
  assert.equal(firstUnavailableStage({ ...all, INTEGRATED_REVIEW: true, PILOT_APPROVED: true }), null);
});

test("the H5 completion transaction carries the custody writer between complete and outcome, with the same expiry", () => {
  assert.equal(THREADS_COMPLETE_TRANSACTION_SQL.length, 3);
  assert.match(THREADS_COMPLETE_TRANSACTION_SQL[0], /complete_social_mobile_threads_oauth_connection/);
  assert.match(THREADS_COMPLETE_TRANSACTION_SQL[1], /record_threads_credential_custody\(\$6,\$7::timestamptz\)/);
  assert.match(THREADS_COMPLETE_TRANSACTION_SQL[2], /outcome\(.*'complete',\$7::timestamptz\)/);
});

// --- Golden path: receipt -> explicit permission -> one post -> read-back (fake DB and fake Meta) ----------

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
function meta(): { fetch: FetchLike; writes: () => number } {
  const queue = [ok({ id: "17890000000000001" }), ok({ id: "17890000000000001", status: "FINISHED" }), ok({ id: "17890000000000003" }),
    ok({ id: "17890000000000003", permalink: "https://www.threads.net/@tester/post/AbC", owner: { id: THREADS_USER } })];
  let writes = 0;
  return {
    writes: () => writes,
    fetch: (_url, init) => {
      if (init?.method === "POST") writes += 1;
      const next = queue.shift();
      return next ? Promise.resolve(next) : Promise.reject(new Error("unscripted"));
    },
  };
}
const post = (body: unknown) =>
  new Request("https://edge.example/functions/v1/social-mobile-threads-publish", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${JWT}` },
    body: JSON.stringify(body),
  });

test("golden path: a connect receipt alone posts nothing; after explicit permission ONE post goes out and is read back", async () => {
  const receipt = parseThreadsConnectReceipt(RECEIPT, NOW);
  assert.ok(receipt);
  // What the connect completion leaves in the database (PR #124 complete + custody), modelled by the fake.
  const store = new FakeThreadsPublishStore();
  store.clock = NOW.getTime();
  store.tokens.set(JWT, USER);
  store.services.set(USER, "active");
  store.memberships.set(`u_owner|${USER}`, "owner");
  store.accounts.set(receipt.socialAccountId, {
    brandId: "u_owner", platform: "threads", connection: "identity_verified", threadsUserId: THREADS_USER, token: TOKEN,
    expiresAt: Date.parse(receipt.tokenExpiresAt),
  });
  const provider = meta();
  const deps: ThreadsPublishHandlerDeps = {
    getUser: (token) => Promise.resolve(store.tokens.has(token) ? { id: store.tokens.get(token)! } : null),
    store, fetch: provider.fetch, sleep: () => Promise.resolve(), now: () => new Date(store.clock),
  };
  const publish = { action: "publish", social_account_id: receipt.socialAccountId, idempotency_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", text: "POSTONAから最初の1件" };
  // 1. Connected, but not permitted: refused, Meta untouched.
  let response = await handleThreadsPublish(post(publish), deps);
  assert.deepEqual(await response.json(), { success: false, error: "MANUAL_PUBLISH_NOT_PERMITTED" });
  assert.equal(provider.writes(), 0);
  // 2. The explicit per-account permission.
  response = await handleThreadsPublish(post({ action: "set_permission", social_account_id: receipt.socialAccountId, desired_enabled: true, expected_current_enabled: false }), deps);
  assert.equal((await response.json()).account.manual_publish_permitted, true);
  // 3. One tap: container, ready, publish, read-back.
  response = await handleThreadsPublish(post(publish), deps);
  const body = await response.json();
  assert.equal(body.attempt.status, "published");
  assert.equal(body.attempt.provider_post_id, "17890000000000003");
  assert.equal(body.attempt.permalink, "https://www.threads.net/@tester/post/AbC");
  assert.equal(provider.writes(), 2, "exactly two Meta writes: container and publish");
  assert.deepEqual(store.log.filter((l) => l.startsWith("release")), ["release:create_container", "release:check_container", "release:publish", "release:confirm"]);
  // 4. The same tap again: the same attempt, no Meta write.
  response = await handleThreadsPublish(post(publish), deps);
  assert.equal((await response.json()).attempt.replayed, true);
  assert.equal(provider.writes(), 2);
});
