import { supabase } from '@/lib/supabase';
import { deleteMyAccount, type DeletionClient, type DeletionOutcome } from '@/lib/account-deletion';

// The Edge Function is called directly rather than through functions.invoke() so the HTTP status is
// available to deletionOutcome(): the UI must distinguish "the server confirmed the deletion" from
// every other result, and an SDK wrapper that flattens both into an error object cannot do that.
const client: DeletionClient = {
  async invokeAccountDelete(accessToken: string) {
    const response = await fetch(
      `${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/account-delete`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          apikey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
        },
      },
    );
    let body: { success?: unknown; error?: unknown } | null = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  },
};

/** Deletes the signed-in user's own account. The session's token is the only identity sent. */
export async function deleteSignedInAccount(): Promise<DeletionOutcome> {
  const { data } = await supabase.auth.getSession();
  return deleteMyAccount(client, data.session?.access_token);
}
