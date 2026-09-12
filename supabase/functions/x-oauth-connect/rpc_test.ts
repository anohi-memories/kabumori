import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BrandContextError } from "../_shared/brand/brand_context.ts";
import { rpc } from "./rpc.ts";
import { createOAuthStartResponse } from "./start_logic.ts";

const SUPABASE_URL = "https://example.invalid";

test("void RPC with HTTP 204 is a successful empty result", async () => {
  const result = await rpc(SUPABASE_URL, "", "void_rpc", {}, async () => new Response(null, { status: 204 }));
  assert.equal(result, null);
});

test("void RPC with an empty HTTP 200 body is a successful empty result", async () => {
  const result = await rpc(SUPABASE_URL, "", "void_rpc", {}, async () => new Response("", { status: 200 }));
  assert.equal(result, null);
});

test("JSON RPC success keeps returning its decoded response", async () => {
  const expected = [{ result: "kept", redirect_uri: "https://example.invalid/callback" }];
  const result = await rpc(SUPABASE_URL, "", "json_rpc", {}, async () => Response.json(expected));
  assert.deepEqual(result, expected);
});

test("non-2xx RPC response remains fail-closed without exposing its body", async () => {
  await assert.rejects(
    () => rpc(SUPABASE_URL, "", "failed_rpc", {}, async () => new Response("private error details", { status: 500 })),
    (error: unknown) => error instanceof BrandContextError && error.message === "OAUTH_CONNECTION_DB_WRITE_FAILED",
  );
});

test("OAuth start continues after a void RPC and returns the read-only authorization response", async () => {
  let requestCount = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    requestCount += 1;
    assert.equal(String(input), `${SUPABASE_URL}/rest/v1/rpc/begin_ai_salaryman_lab_oauth_connection`);
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.p_handle, "kaishain_ai_lab");
    assert.equal(typeof body.p_state_hash, "string");
    assert.equal(typeof body.p_code_verifier, "string");
    return new Response(null, { status: 204 });
  };

  const result = await createOAuthStartResponse({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: "",
    clientId: "test-client-id",
    handle: "kaishain_ai_lab",
    brandId: "ai_salaryman_lab",
    socialAccountId: "ai_salaryman_lab_x",
    scopes: "tweet.read users.read offline.access",
    fetchImpl,
  });

  const authorizationUrl = new URL(String(result.authorization_url));
  assert.equal(authorizationUrl.origin, "https://x.com");
  assert.equal(authorizationUrl.pathname, "/i/oauth2/authorize");
  assert.equal(authorizationUrl.searchParams.get("scope"), "tweet.read users.read offline.access");
  assert.doesNotMatch(authorizationUrl.searchParams.get("scope") ?? "", /tweet\.write|media\.write|like\.write|follows\.write/u);
  assert.equal(result.scopes, "tweet.read users.read offline.access");
  assert.equal(result.publish_mode, "dry_run");
  assert.equal(result.publish_enabled, false);
  assert.equal(requestCount, 1);

  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(source, /return json\(await createOAuthStartResponse\(/u);
});
