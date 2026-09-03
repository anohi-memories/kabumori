// Resolves a caller-supplied Supabase Auth access token to an admin decision, without ever handing the
// service role key to the caller: the key is only ever used for the internal admin_users lookup below.
export type AdminAuthResult = {
  authorized: boolean;
  userId: string | null;
};

type FetchLike = typeof fetch;

function extractBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+(.+)$/iu.exec(authorizationHeader.trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}

async function resolveUserId(args: {
  token: string;
  supabaseUrl: string;
  anonKey: string;
  fetcher: FetchLike;
}): Promise<string | null> {
  let response: Response;
  try {
    response = await args.fetcher(`${args.supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${args.token}`, apikey: args.anonKey },
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let user: unknown;
  try {
    user = await response.json();
  } catch {
    return null;
  }
  const id = typeof user === "object" && user !== null ? (user as { id?: unknown }).id : null;
  return typeof id === "string" && id.length > 0 ? id : null;
}

async function isRegisteredAdmin(args: {
  userId: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  fetcher: FetchLike;
}): Promise<boolean> {
  const params = new URLSearchParams({ select: "user_id", user_id: `eq.${args.userId}`, limit: "1" });
  let response: Response;
  try {
    response = await args.fetcher(`${args.supabaseUrl}/rest/v1/admin_users?${params}`, {
      headers: { apikey: args.serviceRoleKey, Authorization: `Bearer ${args.serviceRoleKey}` },
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;
  let rows: unknown;
  try {
    rows = await response.json();
  } catch {
    return false;
  }
  return Array.isArray(rows) && rows.length > 0;
}

// Fails closed on every error path (malformed header, invalid/expired JWT, network failure, non-admin
// user, or an admin_users lookup that itself fails) — the only way to get authorized:true is a token that
// Supabase Auth confirms belongs to a user_id present in admin_users.
export async function resolveAdminAuthorization(args: {
  authorizationHeader: string | null;
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  fetcher?: FetchLike;
}): Promise<AdminAuthResult> {
  const fetcher = args.fetcher ?? fetch;
  const token = extractBearerToken(args.authorizationHeader);
  if (!token) return { authorized: false, userId: null };

  const userId = await resolveUserId({ token, supabaseUrl: args.supabaseUrl, anonKey: args.anonKey, fetcher });
  if (!userId) return { authorized: false, userId: null };

  const authorized = await isRegisteredAdmin({
    userId, supabaseUrl: args.supabaseUrl, serviceRoleKey: args.serviceRoleKey, fetcher,
  });
  return { authorized, userId };
}
