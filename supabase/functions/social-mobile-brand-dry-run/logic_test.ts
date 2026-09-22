import assert from "node:assert/strict";
import test from "node:test";
import { handleSocialMobileBrandDryRun } from "./logic.ts";

const userId = "qa-user-id";
const brandId = "u_ae343f5caedb67d4af33fc7a";
const baseDeps = {
  supabaseUrl: "https://example.supabase.co",
  publishableKey: "publishable-fixture",
  openAiApiKey: "openai-fixture",
};

function request(
  body: unknown = { brand_id: brandId },
  authorization = "Bearer user-token",
) {
  return new Request("https://edge.example/social-mobile-brand-dry-run", {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function fixtureFetch({
  membershipRows = [{ brand_id: brandId, role: "owner" }],
  brandRows = [{
    id: brandId,
    display_name: "My Workspace",
    is_active: false,
    publish_mode: "disabled",
    code_profile_key: "social_mobile_user_v1",
  }],
  accountRows = [{
    id: "account-1",
    brand_id: brandId,
    platform: "x",
    handle: "qa_handle",
    connection_status: "identity_verified",
  }],
}: {
  membershipRows?: unknown[];
  brandRows?: unknown[];
  accountRows?: unknown[];
} = {}) {
  const calls: { url: string; method: string; authorization: string | null }[] =
    [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      url: url.toString(),
      method,
      authorization: new Headers(init?.headers).get("Authorization"),
    });
    if (url.pathname === "/auth/v1/user") return Response.json({ id: userId });
    if (url.pathname === "/rest/v1/brand_memberships") {
      return Response.json(membershipRows);
    }
    if (url.pathname === "/rest/v1/brands") return Response.json(brandRows);
    if (url.pathname === "/rest/v1/social_accounts") {
      return Response.json(accountRows);
    }
    return new Response("unexpected endpoint", { status: 404 });
  };
  return { fetchImpl, calls };
}

test("requires a real bearer Auth user before querying tenant data", async () => {
  const fixture = fixtureFetch();
  const response = await handleSocialMobileBrandDryRun(request({}, ""), {
    ...baseDeps,
    fetchImpl: fixture.fetchImpl,
  });
  assert.equal(response.status, 401);
  assert.equal(fixture.calls.length, 0);
});

test("uses verified user identity and owner membership before reading the selected workspace", async () => {
  const fixture = fixtureFetch({
    membershipRows: [{ brand_id: "other", role: "owner" }],
  });
  let generated = 0;
  const response = await handleSocialMobileBrandDryRun(request(), {
    ...baseDeps,
    fetchImpl: fixture.fetchImpl,
    generate: async () => {
      generated += 1;
      return { text: "preview", model: "fixture", characterCount: 7 };
    },
  });
  assert.equal(response.status, 404);
  assert.equal(generated, 0);
  assert.equal(
    fixture.calls.filter((call) =>
      new URL(call.url).pathname === "/rest/v1/brands"
    ).length,
    0,
  );
  const membershipUrl = new URL(fixture.calls[1].url);
  assert.equal(membershipUrl.searchParams.get("user_id"), `eq.${userId}`);
  assert.equal(membershipUrl.searchParams.get("role"), "eq.owner");
  assert.equal(fixture.calls[1].authorization, "Bearer user-token");
});

test("a non-owner member cannot request content generation", async () => {
  const fixture = fixtureFetch({ membershipRows: [{ brand_id: brandId, role: "member" }] });
  let generated = 0;
  const response = await handleSocialMobileBrandDryRun(request(), {
    ...baseDeps,
    fetchImpl: fixture.fetchImpl,
    generate: async () => { generated += 1; return { text: "no", model: "fixture", characterCount: 2 }; },
  });
  assert.equal(response.status, 404);
  assert.equal(generated, 0);
  assert.equal(fixture.calls.some((call) => new URL(call.url).pathname === "/rest/v1/brands"), false);
});

test("requires explicit selection when a user owns multiple workspaces", async () => {
  const fixture = fixtureFetch({
    membershipRows: [
      { brand_id: brandId, role: "owner" },
      { brand_id: "another-brand", role: "owner" },
    ],
  });
  const response = await handleSocialMobileBrandDryRun(request({}), {
    ...baseDeps,
    fetchImpl: fixture.fetchImpl,
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "WORKSPACE_SELECTION_REQUIRED");
  assert.equal(
    fixture.calls.some((call) =>
      new URL(call.url).pathname === "/rest/v1/brands"
    ),
    false,
  );
});

test("fails closed on an unregistered profile without running generation", async () => {
  const fixture = fixtureFetch({
    brandRows: [{
      id: brandId,
      display_name: "Workspace",
      is_active: true,
      publish_mode: "dry_run",
      code_profile_key: "unknown_v1",
    }],
  });
  let generated = 0;
  const response = await handleSocialMobileBrandDryRun(request(), {
    ...baseDeps,
    fetchImpl: fixture.fetchImpl,
    generate: async () => {
      generated += 1;
      return { text: "no", model: "fixture", characterCount: 2 };
    },
  });
  assert.equal(response.status, 409);
  assert.equal(generated, 0);
});

test("requires exactly one identity-verified X account for the owned workspace", async () => {
  const fixture = fixtureFetch({
    accountRows: [{
      id: "a",
      brand_id: brandId,
      platform: "x",
      handle: "pending",
      connection_status: "authorization_pending",
    }],
  });
  let generated = 0;
  const response = await handleSocialMobileBrandDryRun(request(), {
    ...baseDeps,
    fetchImpl: fixture.fetchImpl,
    generate: async () => {
      generated += 1;
      return { text: "no", model: "fixture", characterCount: 2 };
    },
  });
  assert.equal(response.status, 409);
  assert.equal(
    (await response.json()).error,
    "SOCIAL_MOBILE_X_ACCOUNT_NOT_CONFIGURED",
  );
  assert.equal(generated, 0);
});

test("generates a read-only preview for the disabled QA workspace and never enters publish/token/storage paths", async () => {
  const fixture = fixtureFetch();
  let generatedContext: unknown;
  let receivedSettings: unknown;
  let generated = 0;
  const response = await handleSocialMobileBrandDryRun(request(), {
    ...baseDeps,
    fetchImpl: fixture.fetchImpl,
    generate: async ({ context, settings }) => {
      generated += 1;
      generatedContext = context;
      receivedSettings = settings;
      return {
        text: "今日の小さな工夫をひとつ。",
        model: "gpt-5.6-luna",
        characterCount: 15,
      };
    },
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(generated, 1);
  assert.equal(body.status, "preview_ready");
  assert.equal(body.preview_only, true);
  assert.equal(body.workspace.display_name, "My Workspace");
  assert.equal(body.connected_account.handle, "@qa_handle");
  assert.equal(body.publish_attempted, false);
  assert.equal(body.x_api_called, false);
  assert.equal(body.scheduled_post_created, false);
  assert.equal(body.planning_defaults.live_publishing_enabled, false);
  assert.equal(
    (generatedContext as { codeProfile: { key: string } }).codeProfile.key,
    "social_mobile_user_v1",
  );
  assert.equal(
    (receivedSettings as { livePublishingEnabled: boolean })
      .livePublishingEnabled,
    false,
  );
  assert.ok(fixture.calls.every((call) => call.method === "GET"));
  assert.ok(
    fixture.calls.every((call) =>
      !/vault|scheduled_posts|x\.com|api\.twitter/iu.test(call.url)
    ),
  );
  assert.ok(
    fixture.calls.every((call) =>
      new URL(call.url).pathname !== "/rest/v1/brand_settings"
    ),
  );
});

test("uses owner-scoped persisted content settings when the candidate table is available", async () => {
  const fixture = fixtureFetch();
  const originalFetch = fixture.fetchImpl;
  fixture.fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/v1/social_mobile_content_settings") {
      assert.equal(url.searchParams.get("brand_id"), `eq.${brandId}`);
      return Response.json([{
        settings: {
          locale: "ja-JP",
          preferredTone: "短く、やわらかく",
          themes: ["生活の工夫"],
          objective: "気づきを届ける",
          frequencyTargetPerWeek: 2,
          approvalMode: "manual_review",
          generationWindow: {
            timezone: "Asia/Tokyo",
            startLocal: "09:00",
            endLocal: "24:00",
            defaultGenerationLocal: "18:00",
            generationDayOffset: -1,
          },
          optionalNgWords: ["断定"],
          notes: "やさしく",
        },
        persona_profile: {
          source: "conversation",
          confirmed: true,
          sentenceLength: "short",
        },
      }]);
    }
    return originalFetch(input, init);
  };
  let receivedSettings: unknown;
  const response = await handleSocialMobileBrandDryRun(request(), {
    ...baseDeps,
    fetchImpl: fixture.fetchImpl,
    generate: async ({ settings }) => {
      receivedSettings = settings;
      return { text: "preview", model: "fixture", characterCount: 7 };
    },
  });
  assert.equal(response.status, 200);
  assert.equal((receivedSettings as { preferredTone: string }).preferredTone, "短く、やわらかく");
  assert.equal((receivedSettings as { personaProfile?: { confirmed: boolean } }).personaProfile?.confirmed, true);
});

test("falls back to Phase 12 defaults when persisted settings are not yet deployed", async () => {
  const fixture = fixtureFetch();
  let receivedSettings: unknown;
  const response = await handleSocialMobileBrandDryRun(request(), {
    ...baseDeps,
    fetchImpl: fixture.fetchImpl,
    generate: async ({ settings }) => {
      receivedSettings = settings;
      return { text: "preview", model: "fixture", characterCount: 7 };
    },
  });
  assert.equal(response.status, 200);
  assert.equal((receivedSettings as { livePublishingEnabled: boolean }).livePublishingEnabled, false);
  assert.equal((receivedSettings as { preferredTone: string }).preferredTone, "自然で親しみやすく、押しつけない");
});

test("does not expose generator errors or credentials to the response", async () => {
  const fixture = fixtureFetch();
  const response = await handleSocialMobileBrandDryRun(request(), {
    ...baseDeps,
    fetchImpl: fixture.fetchImpl,
    generate: async () => {
      throw new Error("OPENAI_SECRET fixture failure");
    },
  });
  const serialized = JSON.stringify(await response.json());
  assert.equal(response.status, 502);
  assert.match(serialized, /PREVIEW_GENERATION_FAILED/u);
  assert.doesNotMatch(serialized, /OPENAI_SECRET|openai-fixture|user-token/u);
});
