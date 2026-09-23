// Source candidate. Not deployed to production by the task that introduced it.
// See delete_logic.ts for the full security model.
import { AccountDeleteError, deleteOwnAccount } from './delete_logic.ts';

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    // Deliberately says nothing about which value is missing.
    return json({ error: 'REQUIRED_SERVER_SECRET_MISSING' }, 500);
  }

  try {
    // The request body is never read: the account to delete is whoever the bearer token belongs to.
    await deleteOwnAccount({
      authorizationHeader: req.headers.get('Authorization'),
      supabaseUrl,
      anonKey,
      serviceRoleKey,
    });
    return json({ success: true });
  } catch (error) {
    if (error instanceof AccountDeleteError) return json({ error: error.message }, error.status);
    return json({ error: 'ACCOUNT_DELETE_FAILED' }, 500);
  }
});

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Delete the account the token belongs to:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/account-delete' \
    --header 'Authorization: Bearer <user JWT>'

*/
