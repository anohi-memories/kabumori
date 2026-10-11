// Server-only dependency adapter. No JWT decode, user_metadata, env or native network.
export type AuthSdk = {
  getUser(
    jwt: string,
  ): Promise<
    {
      data: { user: { id: string; is_anonymous?: boolean } | null };
      error: unknown;
    }
  >;
  getClaims(
    jwt: string,
  ): Promise<
    { data: { claims: Record<string, unknown> } | null; error: unknown }
  >;
};
export type VerifiedActor = Readonly<
  { userId: string; sessionId: string; expiresAt: number }
>;
const actors = new WeakSet<object>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export class RuntimeRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export function requireVerified(actor: VerifiedActor, now = Date.now()): void {
  if (!actors.has(actor) || !Number.isFinite(now) || actor.expiresAt <= now) {
    throw new RuntimeRefusal("AUTH_REQUIRED");
  }
}
/** getClaims verifies signature; getUser checks Auth server state. Session revocation is separately
 * checked AND locked by the owner transport on every transaction, never cached here. */
export function createActorVerifier(
  auth: AuthSdk,
  now: () => number = Date.now,
) {
  return async (authorization: string | null): Promise<VerifiedActor> => {
    if (!authorization?.startsWith("Bearer ") || authorization.length > 16384) {
      throw new RuntimeRefusal("AUTH_REQUIRED");
    }
    const jwt = authorization.slice(7);
    try {
      const { data, error } = await auth.getClaims(jwt);
      const c = data?.claims;
      if (
        error || !c || !uuid.test(String(c.sub)) ||
        !uuid.test(String(c.session_id)) ||
        c.role !== "authenticated" || c.aud !== "authenticated" ||
        c.is_anonymous !== false ||
        typeof c.exp !== "number" || !Number.isFinite(c.exp) ||
        c.exp * 1000 <= now()
      ) {
        throw new RuntimeRefusal("AUTH_REQUIRED");
      }
      const user = await auth.getUser(jwt);
      if (
        user.error || !user.data.user || user.data.user.id !== c.sub ||
        user.data.user.is_anonymous !== false
      ) {
        throw new RuntimeRefusal("AUTH_REQUIRED");
      }
      const actor = Object.freeze({
        userId: c.sub as string,
        sessionId: c.session_id as string,
        expiresAt: c.exp * 1000,
      });
      requireExpiry(actor, now());
      actors.add(actor);
      return actor;
    } catch {
      throw new RuntimeRefusal("AUTH_REQUIRED");
    }
  };
}
function requireExpiry(actor: VerifiedActor, now: number) {
  if (!Number.isFinite(now) || actor.expiresAt <= now) {
    throw new RuntimeRefusal("AUTH_REQUIRED");
  }
}
