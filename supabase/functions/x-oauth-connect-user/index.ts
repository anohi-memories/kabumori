// Phase 9 candidate. Not deployed to production by this task -- see oauth_logic.ts for the full
// architecture note on why every DB call here forwards the connecting user's own JWT rather than using
// the service role key, and why this is a separate function from the existing, unrelated
// x-oauth-connect (which stays exactly as-is: a hardcoded 2-account, service_role-only, admin-initiated
// flow this file never imports from or writes to).
import {
  OAuthConnectUserError,
  completeConnection,
  resolveConnectingUser,
  startConnection,
  type CallbackRequest,
  type StartRequest,
} from "./oauth_logic.ts";

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const clientId = Deno.env.get("X_CLIENT_ID");
  const clientSecret = Deno.env.get("X_CLIENT_SECRET");
  if (!supabaseUrl || !anonKey || !clientId || !clientSecret) {
    return json({ error: "REQUIRED_SERVER_SECRET_MISSING" }, 500);
  }

  const authorizationHeader = req.headers.get("Authorization");
  const bearerMatch = authorizationHeader ? /^Bearer\s+(.+)$/iu.exec(authorizationHeader.trim()) : null;
  const userAccessToken = bearerMatch?.[1]?.trim();
  if (!userAccessToken) return json({ error: "SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED" }, 401);

  try {
    // Fails closed with a clear 401 before any RPC call is attempted if the token is missing, malformed,
    // or does not belong to a real signed-in user -- no admin_users check, any real user may proceed.
    await resolveConnectingUser({ authorizationHeader, supabaseUrl, anonKey });

    const path = new URL(req.url).pathname;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "REQUEST_BODY_INVALID" }, 400);
    }
    const bodyRecord = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};

    if (path.endsWith("/callback")) {
      const request: CallbackRequest = {
        code: typeof bodyRecord.code === "string" ? bodyRecord.code : "",
        state: typeof bodyRecord.state === "string" ? bodyRecord.state : "",
        codeVerifier: typeof bodyRecord.code_verifier === "string" ? bodyRecord.code_verifier : "",
        redirectUri: typeof bodyRecord.redirect_uri === "string" ? bodyRecord.redirect_uri : "",
      };
      const result = await completeConnection({
        request, userAccessToken, supabaseUrl, anonKey, clientId, clientSecret,
      });
      return json({
        success: true,
        brand_id: result.brandId,
        social_account_id: result.socialAccountId,
        handle: result.handle,
        connection_status: result.connectionStatus,
      });
    }

    const request: StartRequest = {
      stateHash: typeof bodyRecord.state_hash === "string" ? bodyRecord.state_hash : "",
      codeChallenge: typeof bodyRecord.code_challenge === "string" ? bodyRecord.code_challenge : "",
      redirectUri: typeof bodyRecord.redirect_uri === "string" ? bodyRecord.redirect_uri : "",
    };
    const result = await startConnection({ request, userAccessToken, supabaseUrl, anonKey, clientId });
    return json({
      authorization_url: result.authorizationUrl,
      brand_id: result.brandId,
      social_account_id: result.socialAccountId,
    });
  } catch (error) {
    if (error instanceof OAuthConnectUserError) return json({ error: error.message }, error.status);
    return json({ error: "SOCIAL_MOBILE_OAUTH_CONNECTION_FAILED" }, 500);
  }
});

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Start (mobile app calls this first, generating its own state/verifier/code_challenge locally):

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/x-oauth-connect-user' \
    --header 'Authorization: Bearer <user JWT>' \
    --header 'Content-Type: application/json' \
    --data '{"state_hash":"<sha256 hex of a locally-generated random state>","code_challenge":"<S256 PKCE challenge>","redirect_uri":"kabumori-social-mobile://oauth-callback"}'

  3. Callback (mobile app calls this after the X browser round-trip returns via deep link):

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/x-oauth-connect-user/callback' \
    --header 'Authorization: Bearer <user JWT>' \
    --header 'Content-Type: application/json' \
    --data '{"code":"<from deep link>","state":"<the raw state value the client generated>","code_verifier":"<the locally-held verifier>","redirect_uri":"kabumori-social-mobile://oauth-callback"}'

*/
