import assert from "node:assert/strict";
import test from "node:test";
import { createLiveHistoryDependencies, historyLiveEnabled } from "./live_dependencies.ts";
import { disabledHistoryLearningDependencies, handleHistoryLearningRequest } from "./logic.ts";

const request = (body: Record<string, unknown>) => new Request("https://edge.example/history", {
  method: "POST", headers: { Authorization: "Bearer user-jwt", "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

test("gate is exact server-only true; OFF never reaches any adapter", async () => {
  for (const value of [undefined, "", "TRUE", "1", " true", "false", "yes"]) assert.equal(historyLiveEnabled(value), false);
  assert.equal(historyLiveEnabled("true"), true);
  const response = await handleHistoryLearningRequest(request({ explicit_consent: true, SOCIAL_MOBILE_HISTORY_LIVE_ENABLED: "true" }), disabledHistoryLearningDependencies());
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "AUTH_REQUIRED");
});

test("ON factory fails closed when any server credential is missing", () => {
  for (const config of [
    { supabaseUrl: "https://project.example", publishableKey: "public" },
    { supabaseUrl: "https://project.example", serviceRoleKey: "service" },
    { publishableKey: "public", serviceRoleKey: "service" },
  ]) assert.throws(() => createLiveHistoryDependencies(config), /HISTORY_CONFIGURATION_UNAVAILABLE/);
});

test("live factory uses user JWT for RLS, service role only for narrow RPC, then X", async () => {
  const calls: string[] = [];
  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("Authorization");
    if (url.pathname === "/auth/v1/user") { calls.push("auth"); assert.equal(auth, "Bearer user-jwt"); return Response.json({ id: "user-a" }); }
    if (url.pathname.endsWith("/brand_memberships")) { calls.push("owner"); assert.equal(auth, "Bearer user-jwt"); return Response.json([{ brand_id: "brand-a", role: "owner" }]); }
    if (url.pathname.endsWith("/brands")) { calls.push("workspace"); assert.equal(auth, "Bearer user-jwt"); return Response.json([{ id: "brand-a" }]); }
    if (url.pathname.endsWith("/social_accounts")) { calls.push("account"); assert.equal(auth, "Bearer user-jwt"); return Response.json([{ id: "account-a", brand_id: "brand-a", platform: "x", connection_status: "identity_verified", platform_user_id: "x-user-a", handle: "qa" }]); }
    if (url.pathname.endsWith("/read_social_mobile_history_access_token")) {
      calls.push("rpc"); assert.equal(auth, "Bearer service");
      assert.deepEqual(JSON.parse(String(init?.body)), { p_user_id: "user-a", p_social_account_id: "account-a" });
      return Response.json("x-token");
    }
    if (url.host === "api.x.com") { calls.push("x"); assert.equal(auth, "Bearer x-token"); return Response.json({ data: [{ id: "post-1", text: "Good morning" }] }); }
    throw new Error("unexpected URL");
  };
  const deps = createLiveHistoryDependencies({ supabaseUrl: "https://project.example", publishableKey: "public", serviceRoleKey: "service", fetchImpl: mockFetch as typeof fetch });
  const response = await handleHistoryLearningRequest(request({ explicit_consent: true, workspace_id: "brand-a", user_id: "attacker", account_id: "attacker", access_token: "attacker", refresh_token: "attacker" }), deps);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.persona.confirmed, false);
  assert.equal(body.analyzedPostCount, 1);
  assert.equal(JSON.stringify(body).includes("x-token"), false);
  assert.equal(JSON.stringify(body).includes("Good morning"), false);
  assert.deepEqual(calls, ["auth", "owner", "workspace", "account", "rpc", "x"]);
});

test("no consent stops before Auth and malformed membership stops before RPC/X", async () => {
  const calls: string[] = [];
  const fetchImpl = async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path === "/auth/v1/user") return Response.json({ id: "user-a" });
    if (path.endsWith("/brand_memberships")) return Response.json([]);
    throw new Error("must not reach this dependency");
  };
  const deps = createLiveHistoryDependencies({ supabaseUrl: "https://project.example", publishableKey: "public", serviceRoleKey: "service", fetchImpl: fetchImpl as typeof fetch });
  assert.equal((await handleHistoryLearningRequest(request({ explicit_consent: false }), deps)).status, 400);
  assert.deepEqual(calls, []);
  assert.equal((await handleHistoryLearningRequest(request({ explicit_consent: true }), deps)).status, 403);
  assert.deepEqual(calls, ["/auth/v1/user", "/rest/v1/brand_memberships"]);
});
