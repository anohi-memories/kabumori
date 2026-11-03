import {
  requireVerified,
  RuntimeRefusal,
  type VerifiedActor,
} from "./verified_actor.ts";
import {
  beginRpcPayload,
  completeRpcPayload,
} from "../../functions/_shared/social/threads_connect_rpc_contract.ts";
import { assertCustodyContract, writeCustody } from "./wiring/custody_port.ts";
/** Structural Deno postgres Client interface. Factory must create a NEW dedicated owner connection,
 * never a shared pool transaction, PostgREST/service key proxy, or caller-selected DSN/role. */
export interface OwnerSqlClient {
  queryObject<T>(sql: string, args?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}
export type Claim = Readonly<
  {
    oauth_state_id: string;
    brand_id: string;
    social_account_id: string;
    expires_at: string;
    redirect_uri: string;
  }
>;
export function createOwnerTransport(
  connect: () => Promise<OwnerSqlClient>,
  now = Date.now,
) {
  async function tx<T>(
    actor: VerifiedActor,
    operation: (client: OwnerSqlClient) => Promise<T>,
  ): Promise<T> {
    requireVerified(actor, now());
    const c = await connect();
    let committing = false;
    try {
      requireVerified(actor, now());
      await c.queryObject("begin isolation level read committed");
      await c.queryObject("set local statement_timeout='4s'");
      await c.queryObject("set local lock_timeout='2s'");
      // An API role/role member cannot become the transport even if supplied by a mistaken factory.
      const p = await c.queryObject<{ allowed: boolean }>(`select
        current_user=(select r.rolname from pg_roles r join pg_proc f on f.proowner=r.oid
          where f.oid=to_regprocedure('public.consume_social_mobile_threads_oauth_state(text)'))
        and not (select rolsuper from pg_roles where rolname=current_user)
        and not exists(select 1 from pg_roles r where r.rolname in ('anon','authenticated','service_role','authenticator')
          and pg_has_role(r.oid,current_user,'MEMBER')) as allowed`);
      if (p.rows.length !== 1 || p.rows[0].allowed !== true) {
        throw new RuntimeRefusal("OWNER_TRANSPORT_UNAVAILABLE");
      }
      // Verified actor only. SET LOCAL via set_config prevents identity leakage across connections.
      await c.queryObject("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({
          sub: actor.userId,
          session_id: actor.sessionId,
          role: "authenticated",
        }),
      ]);
      // auth.uid() can prefer the legacy singular GUC. Overwrite both representations from the
      // sealed principal, so DSN/session defaults cannot override the verified JSON claims.
      await c.queryObject(
        "select set_config('request.jwt.claim.sub',$1,true) as verified_sub, set_config('request.jwt.claim.role','authenticated',true) as verified_role, set_config('request.jwt.claim.session_id',$2,true) as verified_session",
        [actor.userId, actor.sessionId],
      );
      const result = await operation(c);
      requireVerified(actor, now());
      committing = true;
      await c.queryObject("commit");
      return result; // claim is durable BEFORE the caller may send an authorization code to Meta
    } catch {
      if (!committing) {
        try {
          await c.queryObject("rollback");
        } catch { /* no raw error / retry */ }
      }
      throw new RuntimeRefusal(
        committing ? "DB_COMMIT_OUTCOME_UNKNOWN" : "DB_OPERATION_REFUSED",
      );
    } finally {
      try {
        await c.end();
      } catch { /* never turn a committed transaction into retry */ }
    }
  }
  return Object.freeze({
    async begin(
      actor: VerifiedActor,
      hash: string,
      redirect: string,
      expiresAt: Date,
    ) {
      const payload = beginRpcPayload({
        stateHash: hash,
        redirectUri: redirect,
        expiresAt,
        now: new Date(now()),
      });
      return await tx(actor, async (c) => {
        await c.queryObject(
          "select postona_threads_runtime.assert_actor($1::uuid,$2::uuid)",
          [actor.userId, actor.sessionId],
        );
        await assertCustodyContract(c);
        const row = await c.queryObject<
          { brand_id: string; social_account_id: string }
        >(
          "select * from public.begin_social_mobile_threads_oauth_connection($1,$2,$3::timestamptz)",
          [hash, redirect, payload.p_expires_at],
        );
        if (row.rows.length !== 1) {
          throw new RuntimeRefusal("DB_OPERATION_REFUSED");
        }
        await c.queryObject(
          "select postona_threads_runtime.remember($1,$2::uuid,$3::uuid,$4)",
          [hash, actor.userId, actor.sessionId, redirect],
        );
        return row.rows[0];
      });
    },
    async claim(
      actor: VerifiedActor,
      hash: string,
      codeHash: string,
      redirect: string,
    ): Promise<Claim> {
      return await tx(actor, async (c) => {
        const r = await c.queryObject<{ claim: Claim }>(
          "select postona_threads_runtime.claim($1,$2,$3::uuid,$4::uuid,$5) as claim",
          [hash, codeHash, actor.userId, actor.sessionId, redirect],
        );
        if (r.rows.length !== 1) {
          throw new RuntimeRefusal("DB_OPERATION_REFUSED");
        }
        return r.rows[0].claim;
      });
    },
    async complete(
      actor: VerifiedActor,
      hash: string,
      payload: Awaited<ReturnType<typeof completeRpcPayload>>,
      expiry: Date,
    ) {
      await tx(actor, async (c) => {
        await c.queryObject(
          "select postona_threads_runtime.assert_actor($1::uuid,$2::uuid)",
          [actor.userId, actor.sessionId],
        );
        // Missing/foreign/API-executable G4 custody contract stops BEFORE the token writer.
        await assertCustodyContract(c);
        // Check bound claimed state BEFORE any parent Vault write. Lock follows T13/session.
        await c.queryObject(
          "select public.social_mobile_account_deletion_workspace_lock(public.social_mobile_account_deletion_workspace($1::uuid))",
          [actor.userId],
        );
        await c.queryObject(
          "select id from public.social_account_oauth_states where id=$1::uuid for update",
          [payload.p_oauth_state_id],
        );
        const r = await c.queryObject<
          { allowed: boolean; social_account_id: string }
        >(
          `select oauth_state_id=$4::uuid and status='claimed' and expires_at>clock_timestamp() as allowed, social_account_id
          from postona_threads_runtime.attempts where state_hash=$1 and user_id=$2::uuid and session_id=$3::uuid for update`,
          [hash, actor.userId, actor.sessionId, payload.p_oauth_state_id],
        );
        if (r.rows.length !== 1 || r.rows[0].allowed !== true) {
          throw new RuntimeRefusal("DB_OPERATION_REFUSED");
        }
        await c.queryObject(
          "select public.complete_social_mobile_threads_oauth_connection($1::uuid,$2,$3,$4,$5)",
          [
            payload.p_oauth_state_id,
            payload.p_platform_user_id,
            payload.p_handle,
            payload.p_access_token,
            payload.p_attestation,
          ],
        );
        await writeCustody(c, r.rows[0].social_account_id, expiry, now());
        await c.queryObject(
          "select postona_threads_runtime.outcome($1,$2::uuid,$3::uuid,'complete',$4::timestamptz)",
          [hash, actor.userId, actor.sessionId, expiry.toISOString()],
        );
      });
    },
    async uncertain(actor: VerifiedActor, hash: string) {
      await tx(
        actor,
        (c) =>
          c.queryObject(
            "select postona_threads_runtime.outcome($1,$2::uuid,$3::uuid,'uncertain',null)",
            [hash, actor.userId, actor.sessionId],
          ),
      );
    },
  });
}
