// App/server parity for the POSTONA provider domain. The app (Expo/Metro) cannot import from
// supabase/functions without bundler changes, so the domain is kept as two import-free modules. This
// test fails if they drift: same exported names, same constant values, same function results on a
// shared input matrix, and (checked by `deno test` type checking) identical exported types.
import assert from "node:assert/strict";
import test from "node:test";
import * as app from "../../../../apps/social-mobile/src/domain/provider-domain.ts";
import * as server from "./provider_domain.ts";

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function sameType<_T extends true>(): void {}

// Compile-time: every exported type is identical on both sides.
sameType<Equals<app.ProviderId, server.ProviderId>>();
sameType<Equals<app.CredentialProfile, server.CredentialProfile>>();
sameType<Equals<app.PublishFlow, server.PublishFlow>>();
sameType<Equals<app.ProviderCapabilities, server.ProviderCapabilities>>();
sameType<Equals<app.ConnectedAccountIdentity, server.ConnectedAccountIdentity>>();
sameType<Equals<app.CredentialRef, server.CredentialRef>>();
sameType<Equals<app.MediaKind, server.MediaKind>>();
sameType<Equals<app.MediaRef, server.MediaRef>>();
sameType<Equals<app.PublicationTarget, server.PublicationTarget>>();
sameType<Equals<app.TargetShapeRefusal, server.TargetShapeRefusal>>();
sameType<Equals<app.PublishStep, server.PublishStep>>();
sameType<Equals<app.PreparedPublish, server.PreparedPublish>>();
sameType<Equals<app.ContainerState, server.ContainerState>>();
sameType<Equals<app.PublishOutcomeKind, server.PublishOutcomeKind>>();
sameType<Equals<app.PublishOutcome, server.PublishOutcome>>();
sameType<Equals<app.CredentialCheck, server.CredentialCheck>>();
sameType<Equals<app.RevokeResult, server.RevokeResult>>();
sameType<Equals<app.ConnectAdapter, server.ConnectAdapter>>();
sameType<Equals<app.CredentialAdapter, server.CredentialAdapter>>();
sameType<Equals<app.PublishAdapter, server.PublishAdapter>>();
sameType<Equals<app.DisconnectAdapter, server.DisconnectAdapter>>();

test("parity: both modules export exactly the same runtime names", () => {
  assert.deepEqual(Object.keys(app).sort(), Object.keys(server).sort());
});

test("parity: every exported constant is deeply equal (ids, capabilities, profiles, flows, states, codes)", () => {
  for (const name of Object.keys(server) as (keyof typeof server)[]) {
    const value = server[name];
    if (typeof value === "function") continue;
    assert.deepEqual((app as Record<string, unknown>)[name], value, name);
  }
});

test("parity: every exported function gives the same answer on a shared input matrix", () => {
  const providers: unknown[] = ["x", "threads", "instagram", "X", "twitter", "", null, undefined, 0, "__proto__"];
  for (const value of providers) {
    assert.deepEqual(app.parseProviderId(value), server.parseProviderId(value), String(value));
    assert.deepEqual(app.providerCapabilities(value), server.providerCapabilities(value), String(value));
  }
  const media = [[], [{ assetId: "a", kind: "image" as const }]];
  for (const provider of ["x", "threads", "instagram", "facebook"]) {
    for (const renderedText of ["", "  ", "本文"]) {
      for (const m of media) {
        const input = { provider: provider as server.ProviderId, renderedText, media: m };
        assert.equal(app.checkTargetShape(input), server.checkTargetShape(input), JSON.stringify(input));
      }
    }
  }
  for (const flow of server.PUBLISH_FLOWS) assert.deepEqual(app.publishStepsFor(flow), server.publishStepsFor(flow));
  const outcomes: server.PublishOutcome[] = [
    { kind: "published", targetId: "t", providerPostId: "1" },
    { kind: "rejected", targetId: "t", code: "C" },
    { kind: "uncertain", targetId: "t", code: "C" },
  ];
  for (const outcome of outcomes) assert.equal(app.mayRetryTarget(outcome), server.mayRetryTarget(outcome));
});
