// In-app account deletion for the consumer mobile app. Source candidate -- not deployed by the task
// that introduced it.
//
// Security model, in one place:
//   * The user id is read from GET /auth/v1/user using the caller's own bearer token. It is never
//     read from the request body, the query string, or a header the client controls. A request that
//     carries someone else's id in its body deletes the *caller*, not that id.
//   * The service role key is used for exactly one call -- DELETE /auth/v1/admin/users/{id} -- with
//     the id that verification returned. It is never returned to the client, never put in an error
//     message, and never logged.
//   * Deletion is a hard delete of the auth user. public.profiles references auth.users(id) on
//     delete cascade, and every user-owned table references public.profiles(id) on delete cascade,
//     so one delete removes the user's own rows in a single database operation. No per-table delete
//     list is maintained here that could drift from the schema.
//   * Repeating the call is safe: a user that is already gone answers 404, which is reported as
//     success because the caller's requested end state already holds.
//   * Every failure path returns an error, so the app can never show a "deleted" state the server
//     did not confirm.

export class AccountDeleteError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'AccountDeleteError';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const AUTH_REQUIRED = 'ACCOUNT_DELETE_AUTH_REQUIRED';
const FAILED = 'ACCOUNT_DELETE_FAILED';

export function bearerToken(authorizationHeader: string | null): string | null {
  const match = authorizationHeader ? /^Bearer\s+(.+)$/iu.exec(authorizationHeader.trim()) : null;
  const token = match?.[1]?.trim();
  return token ? token : null;
}

/** Resolves the caller's own user id from the token, or fails closed with 401. */
export async function resolveCallerUserId({
  authorizationHeader,
  supabaseUrl,
  anonKey,
  fetchImpl = fetch,
}: {
  authorizationHeader: string | null;
  supabaseUrl: string;
  anonKey: string;
  fetchImpl?: FetchLike;
}): Promise<string> {
  const token = bearerToken(authorizationHeader);
  if (!token) throw new AccountDeleteError(AUTH_REQUIRED, 401);

  let response: Response;
  try {
    response = await fetchImpl(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
    });
  } catch {
    throw new AccountDeleteError(AUTH_REQUIRED, 401);
  }
  if (!response.ok) throw new AccountDeleteError(AUTH_REQUIRED, 401);

  let user: unknown;
  try {
    user = await response.json();
  } catch {
    throw new AccountDeleteError(AUTH_REQUIRED, 401);
  }
  const id = typeof user === 'object' && user !== null ? (user as { id?: unknown }).id : null;
  if (typeof id !== 'string' || !id) throw new AccountDeleteError(AUTH_REQUIRED, 401);
  return id;
}

export type DeletionResult = { userId: string; alreadyDeleted: boolean };

export async function deleteOwnAccount({
  authorizationHeader,
  supabaseUrl,
  anonKey,
  serviceRoleKey,
  fetchImpl = fetch,
}: {
  authorizationHeader: string | null;
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  fetchImpl?: FetchLike;
}): Promise<DeletionResult> {
  const userId = await resolveCallerUserId({ authorizationHeader, supabaseUrl, anonKey, fetchImpl });

  let response: Response;
  try {
    response = await fetchImpl(
      `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
      {
        method: 'DELETE',
        headers: {
          // A hard delete, not a soft delete: a soft-deleted user keeps the row and the email,
          // which would block the same person from signing up again and would leave user-owned
          // rows in place because nothing cascades.
          Authorization: `Bearer ${serviceRoleKey}`,
          apikey: serviceRoleKey,
        },
      },
    );
  } catch {
    throw new AccountDeleteError(FAILED, 500);
  }

  if (response.status === 404) return { userId, alreadyDeleted: true };
  if (!response.ok) throw new AccountDeleteError(FAILED, 500);
  return { userId, alreadyDeleted: false };
}
