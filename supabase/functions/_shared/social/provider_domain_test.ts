import assert from "node:assert/strict";
import test from "node:test";
import {
  checkTargetShape,
  type ConnectAdapter,
  type CredentialAdapter,
  type CredentialRef,
  type DisconnectAdapter,
  mayRetryTarget,
  parseProviderId,
  type PreparedPublish,
  PROVIDER_CAPABILITIES,
  PROVIDER_IDS,
  providerCapabilities,
  type PublicationTarget,
  type PublishAdapter,
  type PublishOutcome,
  publishStepsFor,
} from "./provider_domain.ts";

test("provider ids are exactly x, threads, instagram", () => {
  assert.deepEqual([...PROVIDER_IDS], ["x", "threads", "instagram"]);
  assert.deepEqual(Object.keys(PROVIDER_CAPABILITIES).sort(), ["instagram", "threads", "x"]);
  for (const id of PROVIDER_IDS) assert.equal(PROVIDER_CAPABILITIES[id].provider, id);
});

test("an unknown provider is refused (fail closed): no case folding, trimming or aliases", () => {
  for (const value of ["X", " x", "x ", "Threads", "twitter", "facebook", "ig", "", null, undefined, 0, {}, ["x"], "constructor", "__proto__", "toString"]) {
    assert.equal(parseProviderId(value), null, String(value));
    assert.equal(providerCapabilities(value), null, String(value));
  }
  assert.equal(parseProviderId("threads"), "threads");
});

test("structural capabilities match the accepted architecture (docs/postona/multi-social-phase1.md §3-4)", () => {
  assert.deepEqual(PROVIDER_CAPABILITIES.x, {
    provider: "x",
    textOnly: true,
    mediaRequired: false,
    optionalMedia: true,
    publishFlow: "single_call",
    credentialProfile: "oauth2_rotating_refresh",
    providerPostId: true,
    providerPermalink: false,
  });
  assert.deepEqual(PROVIDER_CAPABILITIES.threads, {
    provider: "threads",
    textOnly: true,
    mediaRequired: false,
    optionalMedia: true,
    publishFlow: "container_then_publish",
    credentialProfile: "long_lived_access",
    providerPostId: true,
    providerPermalink: true,
  });
  assert.deepEqual(PROVIDER_CAPABILITIES.instagram, {
    provider: "instagram",
    textOnly: false,
    mediaRequired: true,
    optionalMedia: false,
    publishFlow: "container_then_publish",
    credentialProfile: "long_lived_access",
    providerPostId: true,
    providerPermalink: true,
  });
});

test("capabilities carry no pricing or quota, and cannot be mutated at runtime", () => {
  for (const id of PROVIDER_IDS) {
    assert.deepEqual(Object.keys(PROVIDER_CAPABILITIES[id]).sort(), [
      "credentialProfile",
      "mediaRequired",
      "optionalMedia",
      "provider",
      "providerPermalink",
      "providerPostId",
      "publishFlow",
      "textOnly",
    ]);
    assert.ok(Object.isFrozen(PROVIDER_CAPABILITIES[id]));
  }
  assert.ok(Object.isFrozen(PROVIDER_CAPABILITIES));
  assert.throws(() => {
    (PROVIDER_CAPABILITIES.instagram as { textOnly: boolean }).textOnly = true;
  });
  assert.equal(PROVIDER_CAPABILITIES.instagram.textOnly, false);
});

test("target shape: Instagram needs media, X and Threads accept text alone or with media, unknown provider refused", () => {
  const image = [{ assetId: "asset_1", kind: "image" as const }];
  assert.equal(checkTargetShape({ provider: "x", renderedText: "こんにちは", media: [] }), null);
  assert.equal(checkTargetShape({ provider: "x", renderedText: "", media: image }), null);
  assert.equal(checkTargetShape({ provider: "threads", renderedText: "こんにちは", media: [] }), null);
  assert.equal(checkTargetShape({ provider: "threads", renderedText: "こんにちは", media: image }), null);
  assert.equal(checkTargetShape({ provider: "instagram", renderedText: "キャプション", media: [] }), "TEXT_ONLY_NOT_SUPPORTED");
  assert.equal(checkTargetShape({ provider: "instagram", renderedText: "キャプション", media: image }), null);
  assert.equal(checkTargetShape({ provider: "instagram", renderedText: "", media: image }), null);
  assert.equal(checkTargetShape({ provider: "x", renderedText: "   ", media: [] }), "EMPTY_TARGET");
  assert.equal(checkTargetShape({ provider: "facebook" as never, renderedText: "hi", media: [] }), "PROVIDER_UNSUPPORTED");
});

test("publish steps: single call publishes directly; a container is prepared, awaited, then published", () => {
  assert.deepEqual(publishStepsFor("single_call"), ["publish"]);
  assert.deepEqual(publishStepsFor("container_then_publish"), ["prepare", "await_ready", "publish"]);
  for (const id of PROVIDER_IDS) assert.equal(publishStepsFor(PROVIDER_CAPABILITIES[id].publishFlow).at(-1), "publish");
});

test("only a proven rejection may be retried as-is; uncertain needs reconciliation", () => {
  assert.equal(mayRetryTarget({ kind: "rejected", targetId: "t1", code: "HTTP_400" }), true);
  assert.equal(mayRetryTarget({ kind: "uncertain", targetId: "t1", code: "NETWORK_UNCERTAIN", containerId: "c1" }), false);
  assert.equal(mayRetryTarget({ kind: "published", targetId: "t1", providerPostId: "123", permalink: "https://example.invalid/p/1" }), false);
});

// The contracts can express both flows end to end. These fakes exist only in this test: no adapter is
// implemented or wired anywhere, and nothing here touches the network.
async function drive(adapter: PublishAdapter, target: PublicationTarget, credential: CredentialRef): Promise<PublishOutcome> {
  const prepared = await adapter.prepare(target, credential);
  if ("kind" in prepared) return prepared;
  if (prepared.flow === "container_then_publish") {
    const state = await adapter.awaitReady!(prepared, credential);
    if (state !== "finished") {
      return state === "error" || state === "expired"
        ? { kind: "rejected", targetId: target.targetId, code: `CONTAINER_${state.toUpperCase()}` }
        : { kind: "uncertain", targetId: target.targetId, code: `CONTAINER_${state.toUpperCase()}`, containerId: prepared.containerId };
    }
  }
  return await adapter.publish(prepared, credential);
}

const xCredential: CredentialRef = { profile: "oauth2_rotating_refresh", accessRef: "vault_a", refreshRef: "vault_r" };
const metaCredential: CredentialRef = { profile: "long_lived_access", accessRef: "vault_l", refreshRef: null };
const target = (provider: PublicationTarget["provider"], media: PublicationTarget["media"] = []): PublicationTarget => ({
  targetId: `target_${provider}`,
  provider,
  connectedAccountId: `sa_${provider}`,
  renderedText: "本文",
  media,
  scheduledAt: "2026-10-07T09:00:00.000Z",
});

test("contracts: a single-call adapter and a container adapter both reach a target-level outcome", async () => {
  const calls: string[] = [];
  const singleCall: PublishAdapter = {
    provider: "x",
    flow: "single_call",
    prepare: (t) => Promise.resolve<PreparedPublish>({ flow: "single_call", targetId: t.targetId }),
    publish: (p) => {
      calls.push(`x:publish:${p.targetId}`);
      return Promise.resolve({ kind: "published", targetId: p.targetId, providerPostId: "1900000000000000001" });
    },
  };
  const container: PublishAdapter = {
    provider: "threads",
    flow: "container_then_publish",
    prepare: (t) => {
      calls.push(`threads:container:${t.targetId}`);
      return Promise.resolve<PreparedPublish>({ flow: "container_then_publish", targetId: t.targetId, containerId: "c_1" });
    },
    awaitReady: (p) => {
      calls.push(`threads:status:${p.targetId}`);
      return Promise.resolve("finished");
    },
    publish: (p) => {
      calls.push(`threads:publish:${p.targetId}`);
      return Promise.resolve({ kind: "published", targetId: p.targetId, providerPostId: "18000000000000001", permalink: "https://example.invalid/t/1" });
    },
  };
  assert.equal((await drive(singleCall, target("x"), xCredential)).kind, "published");
  assert.equal((await drive(container, target("threads"), metaCredential)).kind, "published");
  assert.deepEqual(calls, ["x:publish:target_x", "threads:container:target_threads", "threads:status:target_threads", "threads:publish:target_threads"]);

  const expired: PublishAdapter = { ...container, awaitReady: () => Promise.resolve("expired") };
  const pending: PublishAdapter = { ...container, awaitReady: () => Promise.resolve("in_progress") };
  const instagramTarget = target("instagram", [{ assetId: "asset_1", kind: "image" }]);
  assert.deepEqual(await drive(expired, instagramTarget, metaCredential), { kind: "rejected", targetId: "target_instagram", code: "CONTAINER_EXPIRED" });
  assert.deepEqual(await drive(pending, instagramTarget, metaCredential), {
    kind: "uncertain",
    targetId: "target_instagram",
    code: "CONTAINER_IN_PROGRESS",
    containerId: "c_1",
  });
});

test("contracts: connect, credential and disconnect adapters exchange references, never credential material", async () => {
  const connect: ConnectAdapter = {
    provider: "threads",
    authorizationUrl: ({ state }) => `https://example.invalid/authorize?state=${state}`,
    complete: () =>
      Promise.resolve({
        identity: { provider: "threads", providerAccountId: "1234", handle: "postona_user" },
        credential: metaCredential,
      }),
  };
  const credentials: CredentialAdapter = { provider: "threads", profile: "long_lived_access", ensureUsable: () => Promise.resolve("usable") };
  const disconnect: DisconnectAdapter = { provider: "threads", revoke: () => Promise.resolve("not_supported") };
  const connected = await connect.complete({ code: "c", codeVerifier: "v", redirectUri: "https://example.invalid/cb" });
  assert.deepEqual(Object.keys(connected.identity).sort(), ["handle", "provider", "providerAccountId"]);
  assert.deepEqual(Object.keys(connected.credential).sort(), ["accessRef", "profile", "refreshRef"]);
  assert.equal(await credentials.ensureUsable(connected.credential, new Date(0)), "usable");
  assert.equal(await disconnect.revoke(connected.credential), "not_supported");
});

test("the module is pure: no imports, no fetch, no Deno or environment access", async () => {
  const source = await Deno.readTextFile(new URL("./provider_domain.ts", import.meta.url));
  const code = source.split("\n").filter((line) => !/^\s*(\/\/|\/?\*)/u.test(line)).join("\n");
  assert.equal(/^\s*import\b/mu.test(code), false);
  for (const forbidden of ["fetch(", "Deno.", "process.", "createClient", "supabase", "vault.", "http://", "https://"]) {
    assert.equal(code.includes(forbidden), false, forbidden);
  }
});
