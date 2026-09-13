// Phase 3F: a small, dedicated Edge Function rather than a new branch inside x-test-post/index.ts's
// ~4500-line monolith (per this phase's own allowance, Section B). This function's only job is to run
// _shared/brand/brand_post_dry_run.ts's existing, structurally X-write-free pipeline against a real
// OpenAI call and return the result to an authenticated admin -- it never imports token_loader.ts,
// x_oauth2_post.ts, or x-test-post/index.ts, so it has no code path to the X API or the legacy Kabumori
// token store.
import { resolveAdminAuthorization } from "../x-test-post/admin_auth_logic.ts";
import { loadBrandContext } from "../_shared/brand/brand_context.ts";
import { runBrandPostDryRun } from "../_shared/brand/brand_post_dry_run.ts";
import { fetchRecentKabumoriFingerprints } from "../_shared/brand/kabumori_recent_fingerprints.ts";
import { resolveVaultTokenRoutingMetadata } from "../_shared/brand/vault_token_routing.ts";
import { handleBrandPostDryRunRequest } from "./dry_run_handler.ts";

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const openAiApiKey = Deno.env.get("OPENAI_API_KEY");
  if (!supabaseUrl || !serviceRoleKey || !anonKey || !openAiApiKey) {
    return json({ error: "REQUIRED_SERVER_SECRET_MISSING" }, 500);
  }

  const authorizationHeader = req.headers.get("Authorization");
  // Mirrors x-oauth-connect's precedent: the Supabase Dashboard's own "Send Request" console injects the
  // project secret key without ever revealing it to the operator, so it is accepted here as an admin
  // caller. Every other caller still goes through the real admin_users JWT check below.
  const dashboardSecretOperator = authorizationHeader === `Bearer ${serviceRoleKey}` ||
    req.headers.get("apikey") === serviceRoleKey;
  const admin = dashboardSecretOperator
    ? { authorized: true, userId: null }
    : await resolveAdminAuthorization({ authorizationHeader, supabaseUrl, anonKey, serviceRoleKey });
  if (!admin.authorized) return json({ error: "BRAND_POST_DRY_RUN_UNAUTHORIZED" }, 403);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  try {
    const result = await handleBrandPostDryRunRequest(body, {
      loadBrandContext,
      runBrandPostDryRun,
      fetchRecentKabumoriFingerprints,
      resolveVaultTokenRoutingMetadata,
      openAiApiKey,
      supabaseUrl,
      serviceRoleKey,
    });
    return json(result.body, result.status);
  } catch {
    // Fails closed: any unexpected error never falls through to a default 200.
    return json({ error: "BRAND_POST_DRY_RUN_FAILED" }, 500);
  }
});

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/brand-post-dry-run' \
    --header 'Authorization: Bearer <admin JWT>' \
    --header 'Content-Type: application/json' \
    --data '{"brand_id":"ai_salaryman_lab","post_type":"brand_post"}'

*/
