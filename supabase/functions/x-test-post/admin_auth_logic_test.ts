import assert from "node:assert/strict";
import test from "node:test";
import { resolveAdminAuthorization } from "./admin_auth_logic.ts";

const SUPABASE_URL = "https://example.supabase.co";
const ANON_KEY = "anon-key";
const SERVICE_ROLE_KEY = "service-role-key";

const ADMIN_USER_ID = "11111111-1111-1111-1111-111111111111";
const NON_ADMIN_USER_ID = "22222222-2222-2222-2222-222222222222";

function fetcher(args: { tokenToUserId: Record<string, string>; adminUserIds: string[] }) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname === "/auth/v1/user") {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("apikey"), ANON_KEY, "must use the anon key, never the service role key, to verify the caller's own token");
      const authHeader = headers.get("Authorization") ?? "";
      const token = authHeader.replace(/^Bearer\s+/iu, "");
      const userId = args.tokenToUserId[token];
      if (!userId) return new Response("invalid token", { status: 401 });
      return Response.json({ id: userId });
    }
    if (url.pathname === "/rest/v1/admin_users") {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("apikey"), SERVICE_ROLE_KEY, "the admin_users lookup must use the service role key internally");
      const userId = url.searchParams.get("user_id")?.replace(/^eq\./u, "");
      const found = userId && args.adminUserIds.includes(userId);
      return Response.json(found ? [{ user_id: userId }] : []);
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  };
}

const standardFetcher = fetcher({
  tokenToUserId: { "valid-admin-token": ADMIN_USER_ID, "valid-non-admin-token": NON_ADMIN_USER_ID },
  adminUserIds: [ADMIN_USER_ID],
});

async function authorize(authorizationHeader: string | null, fetcherOverride = standardFetcher) {
  return await resolveAdminAuthorization({
    authorizationHeader,
    supabaseUrl: SUPABASE_URL,
    anonKey: ANON_KEY,
    serviceRoleKey: SERVICE_ROLE_KEY,
    fetcher: fetcherOverride,
  });
}

test("1: a valid admin JWT is authorized", async () => {
  const result = await authorize("Bearer valid-admin-token");
  assert.equal(result.authorized, true);
  assert.equal(result.userId, ADMIN_USER_ID);
});

test("2: a valid non-admin JWT is rejected", async () => {
  const result = await authorize("Bearer valid-non-admin-token");
  assert.equal(result.authorized, false);
  assert.equal(result.userId, NON_ADMIN_USER_ID);
});

test("3: no Authorization header is rejected without calling the network", async () => {
  const calls: string[] = [];
  const trackingFetcher: typeof fetch = async (input) => {
    calls.push(String(input));
    throw new Error("should not be called");
  };
  const result = await authorize(null, trackingFetcher);
  assert.equal(result.authorized, false);
  assert.equal(result.userId, null);
  assert.deepEqual(calls, []);
});

test("4: an invalid/expired JWT is rejected", async () => {
  const result = await authorize("Bearer not-a-real-token");
  assert.equal(result.authorized, false);
  assert.equal(result.userId, null);
});

test("a malformed Authorization header (no Bearer prefix) is rejected without calling the network", async () => {
  const calls: string[] = [];
  const trackingFetcher: typeof fetch = async (input) => {
    calls.push(String(input));
    throw new Error("should not be called");
  };
  const result = await authorize("valid-admin-token", trackingFetcher);
  assert.equal(result.authorized, false);
  assert.deepEqual(calls, []);
});

test("a network failure while verifying the token fails closed", async () => {
  const failingFetcher: typeof fetch = async () => { throw new TypeError("network down"); };
  const result = await authorize("Bearer valid-admin-token", failingFetcher);
  assert.equal(result.authorized, false);
});

test("a network failure while checking admin_users fails closed even for a valid user", async () => {
  const partiallyFailingFetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/auth/v1/user") return Response.json({ id: ADMIN_USER_ID });
    throw new TypeError("network down");
  };
  const result = await authorize("Bearer valid-admin-token", partiallyFailingFetcher);
  assert.equal(result.authorized, false);
  assert.equal(result.userId, ADMIN_USER_ID);
});

test("5: the service role key is never sent to the auth verification call (only used for admin_users)", async () => {
  let authCallApikey: string | null | undefined;
  const inspectingFetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (url.pathname === "/auth/v1/user") {
      authCallApikey = headers.get("apikey");
      return Response.json({ id: ADMIN_USER_ID });
    }
    return Response.json([{ user_id: ADMIN_USER_ID }]);
  };
  await authorize("Bearer valid-admin-token", inspectingFetcher);
  assert.equal(authCallApikey, ANON_KEY);
  assert.notEqual(authCallApikey, SERVICE_ROLE_KEY);
});

test("6: presenting the service role key itself as the caller's Bearer token is rejected, not treated as admin", async () => {
  // No code path compares the incoming Authorization header to SUPABASE_SERVICE_ROLE_KEY directly — the
  // key is only ever used server-side for the admin_users lookup. A caller who sends the service role key
  // as their own bearer token is verified via /auth/v1/user exactly like any other token: since it is not
  // a real end-user session token, Supabase Auth does not resolve it to a user, so it fails closed here.
  const result = await authorize(`Bearer ${SERVICE_ROLE_KEY}`);
  assert.equal(result.authorized, false);
  assert.equal(result.userId, null);
});
