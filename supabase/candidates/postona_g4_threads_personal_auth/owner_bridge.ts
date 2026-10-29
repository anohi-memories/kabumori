// POSTONA Threads connect — G4's owner bridge (G4-50, Issue #319). The same four calls as H5's owner transport
// (candidates/postona_threads_auth_runtime/owner_transport.ts: begin / claim / complete / uncertain), so H5's runtime
// (createThreadsRuntime) can take it unchanged, but every connect goes through G4's binding entry:
//   begin    : PR #124's begin + H5's remember, then postona_threads_binding.record_state_generation (the owner epoch
//              and lifecycle_version this attempt began under) in the SAME transaction.
//   complete : postona_threads_binding.complete_and_attest_binding (PR #124's complete + the binding, G4-42's workspace
//              recheck and G4-43's person-session check, in ONE call) instead of PR #124's complete directly; the
//              custody write then uses the connect proof that call left in this transaction (G4-16).
//   claim / uncertain : H5's own SQL (postona_threads_runtime.*), unchanged.
// The SQL claims carry is_anonymous=false only for a sealed VerifiedActor: createActorVerifier seals an actor only
// when BOTH the JWT claims and GoTrue's user say is_anonymous === false (verified_actor.ts), and requireVerified
// refuses anything else before a connection is opened. Nothing is granted, no ACL is widened, nothing is retried.
// Not wired: H5's server factory constructs its own transport (no port for this bridge yet) and the Edge entry stays
// hard-disabled; production stays NO_GO.

import {
  requireVerified,
  RuntimeRefusal,
  type VerifiedActor,
} from "../postona_threads_auth_runtime/verified_actor.ts";
import type { Claim, OwnerSqlClient } from "../postona_threads_auth_runtime/owner_transport.ts";
import { assertCustodyContract, writeCustody } from "../postona_threads_auth_runtime/wiring/custody_port.ts";
import { beginRpcPayload, type completeRpcPayload } from "../../functions/_shared/social/threads_connect_rpc_contract.ts";

/** The SQL claims of one verified actor: what auth.uid(), G5's T13 and G4-43's person-session check read. */
export function verifiedActorClaims(actor: VerifiedActor, now = Date.now()): string {
  requireVerified(actor, now);
  return JSON.stringify({ sub: actor.userId, session_id: actor.sessionId, role: "authenticated", is_anonymous: false });
}

/**
 * Which G5 authorization profile the database runs (G4-02 #2), pinned by configuration, never detected:
 *   "full"     F5's brand owner epoch (PR #303 / #457): ../postona_threads_binding_epoch/001 + this directory's 001 / 002
 *   "personal" G5's personal MVP (PR #548 / #550, g5pv = lifecycle_version only): ../postona_g4_threads_personal_mvp/001
 * A bridge pinned to one profile calls only that profile's SQL, so against the other one every begin is refused.
 */
export type G4AuthProfile = "full" | "personal";
export const G4_AUTH_PROFILES: readonly G4AuthProfile[] = Object.freeze(["full", "personal"]);

export function createG4ThreadsOwnerBridge(connect: () => Promise<OwnerSqlClient>, now = Date.now, profile: G4AuthProfile = "full") {
  if (!G4_AUTH_PROFILES.includes(profile)) throw new RuntimeRefusal("OWNER_TRANSPORT_UNAVAILABLE");
  async function tx<T>(actor: VerifiedActor, operation: (client: OwnerSqlClient) => Promise<T>): Promise<T> {
    const claims = verifiedActorClaims(actor, now());
    const c = await connect();
    let committing = false;
    try {
      requireVerified(actor, now());
      await c.queryObject("begin isolation level read committed");
      await c.queryObject("set local statement_timeout='4s'");
      await c.queryObject("set local lock_timeout='2s'");
      // The owner of PR #124 AND of G4's binding entry; never a superuser, an API role or a member of one.
      const p = await c.queryObject<{ allowed: boolean }>(`select
        current_user=(select r.rolname from pg_roles r join pg_proc f on f.proowner=r.oid
          where f.oid=to_regprocedure('public.consume_social_mobile_threads_oauth_state(text)'))
        and current_user=(select r.rolname from pg_roles r join pg_proc f on f.proowner=r.oid
          where f.oid=to_regprocedure('postona_threads_binding.complete_and_attest_binding(uuid,text,text,text,text)'))
        and not (select rolsuper from pg_roles where rolname=current_user)
        and not exists(select 1 from pg_roles r where r.rolname in ('anon','authenticated','service_role','authenticator')
          and pg_has_role(r.oid,current_user,'MEMBER')) as allowed`);
      if (p.rows.length !== 1 || p.rows[0].allowed !== true) throw new RuntimeRefusal("OWNER_TRANSPORT_UNAVAILABLE");
      await c.queryObject("select set_config('request.jwt.claims',$1,true)", [claims]);
      // auth.uid() and G5's S2-2 prefer the singular GUCs when sub is set: overwrite all four from the same sealed actor
      // (S2-2 refuses unless request.jwt.claim.is_anonymous is exactly 'false').
      await c.queryObject(
        "select set_config('request.jwt.claim.sub',$1,true) as verified_sub, set_config('request.jwt.claim.role','authenticated',true) as verified_role, set_config('request.jwt.claim.session_id',$2,true) as verified_session, set_config('request.jwt.claim.is_anonymous','false',true) as verified_anonymous",
        [actor.userId, actor.sessionId],
      );
      const result = await operation(c);
      requireVerified(actor, now());
      committing = true;
      await c.queryObject("commit");
      return result;
    } catch {
      if (!committing) {
        try {
          await c.queryObject("rollback");
        } catch { /* no raw error, no retry */ }
      }
      throw new RuntimeRefusal(committing ? "DB_COMMIT_OUTCOME_UNKNOWN" : "DB_OPERATION_REFUSED");
    } finally {
      try {
        await c.end();
      } catch { /* a committed transaction never becomes a retry */ }
    }
  }

  return Object.freeze({
    async begin(actor: VerifiedActor, hash: string, redirect: string, expiresAt: Date) {
      const payload = beginRpcPayload({ stateHash: hash, redirectUri: redirect, expiresAt, now: new Date(now()) });
      return await tx(actor, async (c) => {
        await c.queryObject("select postona_threads_runtime.assert_actor($1::uuid,$2::uuid)", [actor.userId, actor.sessionId]);
        await assertCustodyContract(c);
        const row = await c.queryObject<{ brand_id: string; social_account_id: string }>(
          "select * from public.begin_social_mobile_threads_oauth_connection($1,$2,$3::timestamptz)",
          [hash, redirect, payload.p_expires_at],
        );
        if (row.rows.length !== 1) throw new RuntimeRefusal("DB_OPERATION_REFUSED");
        await c.queryObject("select postona_threads_runtime.remember($1,$2::uuid,$3::uuid,$4)", [
          hash,
          actor.userId,
          actor.sessionId,
          redirect,
        ]);
        if (profile === "personal") {
          // g5pv: the person's lifecycle_version, read in this transaction (after PR #124's T13 check) and recorded
          // against its state; G5's MV checks it at record and again at completion (service ended and restarted: ABA).
          const g = await c.queryObject<{ oauth_state_id: string; lifecycle_version: string | null }>(
            `select a.oauth_state_id::text,
               (select ca.lifecycle_version from public.common_accounts ca where ca.user_id=a.user_id)::text as lifecycle_version
             from postona_threads_runtime.attempts a where a.state_hash=$1 and a.user_id=$2::uuid and a.session_id=$3::uuid`,
            [hash, actor.userId, actor.sessionId],
          );
          const gen = g.rows.length === 1 ? g.rows[0] : null;
          if (!gen || !/^[1-9][0-9]{0,18}$/.test(gen.lifecycle_version ?? "")) throw new RuntimeRefusal("DB_OPERATION_REFUSED");
          await c.queryObject("select postona_threads_binding.record_state_generation($1::uuid,$2::uuid,$3::bigint)", [
            actor.userId,
            gen.oauth_state_id,
            gen.lifecycle_version,
          ]);
          return row.rows[0];
        }
        // The numbers this attempt begins under, read in this transaction and recorded against its state; the
        // completion refuses if either has moved (owner change, service ended and restarted: ABA).
        const g = await c.queryObject<{ oauth_state_id: string; owner_epoch: string | null; lifecycle_version: string | null }>(
          `select a.oauth_state_id::text, private.account_lifecycle_brand_owner_epoch(a.brand_id)::text as owner_epoch,
             (select ca.lifecycle_version from public.common_accounts ca where ca.user_id=a.user_id)::text as lifecycle_version
           from postona_threads_runtime.attempts a where a.state_hash=$1 and a.user_id=$2::uuid and a.session_id=$3::uuid`,
          [hash, actor.userId, actor.sessionId],
        );
        const gen = g.rows.length === 1 ? g.rows[0] : null;
        if (!gen || !/^[1-9][0-9]{0,18}$/.test(gen.owner_epoch ?? "") || !/^[1-9][0-9]{0,18}$/.test(gen.lifecycle_version ?? "")) {
          throw new RuntimeRefusal("DB_OPERATION_REFUSED");
        }
        await c.queryObject("select postona_threads_binding.record_state_generation($1::uuid,$2::uuid,$3::bigint,$4::bigint)", [
          actor.userId,
          gen.oauth_state_id,
          gen.owner_epoch,
          gen.lifecycle_version,
        ]);
        return row.rows[0];
      });
    },
    async claim(actor: VerifiedActor, hash: string, codeHash: string, redirect: string): Promise<Claim> {
      return await tx(actor, async (c) => {
        const r = await c.queryObject<{ claim: Claim }>(
          "select postona_threads_runtime.claim($1,$2,$3::uuid,$4::uuid,$5) as claim",
          [hash, codeHash, actor.userId, actor.sessionId, redirect],
        );
        if (r.rows.length !== 1) throw new RuntimeRefusal("DB_OPERATION_REFUSED");
        return r.rows[0].claim;
      });
    },
    async complete(actor: VerifiedActor, hash: string, payload: Awaited<ReturnType<typeof completeRpcPayload>>, expiry: Date) {
      await tx(actor, async (c) => {
        await c.queryObject("select postona_threads_runtime.assert_actor($1::uuid,$2::uuid)", [actor.userId, actor.sessionId]);
        await assertCustodyContract(c);
        await c.queryObject(
          "select public.social_mobile_account_deletion_workspace_lock(public.social_mobile_account_deletion_workspace($1::uuid))",
          [actor.userId],
        );
        await c.queryObject("select id from public.social_account_oauth_states where id=$1::uuid for update", [payload.p_oauth_state_id]);
        const r = await c.queryObject<{ allowed: boolean; social_account_id: string }>(
          `select oauth_state_id=$4::uuid and status='claimed' and expires_at>clock_timestamp() as allowed, social_account_id
          from postona_threads_runtime.attempts where state_hash=$1 and user_id=$2::uuid and session_id=$3::uuid for update`,
          [hash, actor.userId, actor.sessionId, payload.p_oauth_state_id],
        );
        if (r.rows.length !== 1 || r.rows[0].allowed !== true) throw new RuntimeRefusal("DB_OPERATION_REFUSED");
        await c.queryObject("select postona_threads_binding.complete_and_attest_binding($1::uuid,$2,$3,$4,$5)", [
          payload.p_oauth_state_id,
          payload.p_platform_user_id,
          payload.p_handle,
          payload.p_access_token,
          payload.p_attestation,
        ]);
        await writeCustody(c, r.rows[0].social_account_id, expiry, now());
        await c.queryObject("select postona_threads_runtime.outcome($1,$2::uuid,$3::uuid,'complete',$4::timestamptz)", [
          hash,
          actor.userId,
          actor.sessionId,
          expiry.toISOString(),
        ]);
      });
    },
    async uncertain(actor: VerifiedActor, hash: string) {
      await tx(actor, (c) =>
        c.queryObject("select postona_threads_runtime.outcome($1,$2::uuid,$3::uuid,'uncertain',null)", [
          hash,
          actor.userId,
          actor.sessionId,
        ]));
    },
  });
}
