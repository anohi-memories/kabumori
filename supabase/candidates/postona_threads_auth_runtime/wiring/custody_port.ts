import type { OwnerSqlClient } from "../owner_transport.ts";
import { RuntimeRefusal } from "../verified_actor.ts";
// Exact G4 PR144/154 contract. No dependency on their source on this PR139-based branch.
export async function assertCustodyContract(c: OwnerSqlClient): Promise<void> {
  const r = await c.queryObject<{ allowed: boolean }>(`select exists(
    select 1 from pg_proc f join pg_class t on t.oid=to_regclass('public.social_accounts')
    where f.oid=to_regprocedure('public.record_threads_credential_custody(text,timestamptz)')
      and f.proowner=t.relowner and f.proowner=(select oid from pg_roles where rolname=current_user)
      and f.prorettype='void'::regtype and not f.prosecdef and f.prokind='f'
      and f.proconfig @> array['search_path=""']::text[]
      and not exists(select 1 from pg_roles a where a.rolname in ('anon','authenticated','service_role','authenticator')
        and (has_function_privilege(a.oid,f.oid,'EXECUTE') or pg_has_role(a.oid,f.proowner,'MEMBER')))
      and not exists(select 1 from aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a
        where a.grantee=0 and a.privilege_type='EXECUTE')
  ) as allowed`);
  if (r.rows.length !== 1 || r.rows[0].allowed !== true) {
    throw new RuntimeRefusal("CUSTODY_UNAVAILABLE");
  }
}
/** Same client/transaction as parent complete; no attempt-derived expiry or 60-day fallback. */
export async function writeCustody(
  c: OwnerSqlClient,
  account: string,
  expiry: Date,
  now: number,
) {
  if (
    !/^sa_[0-9a-f]{24}$/.test(account) || !Number.isFinite(expiry.getTime()) ||
    expiry.getTime() <= now || expiry.getTime() > now + 61 * 86400000
  ) throw new RuntimeRefusal("CUSTODY_INVALID");
  await c.queryObject(
    "select public.record_threads_credential_custody($1,$2::timestamptz)",
    [account, expiry.toISOString()],
  );
}
