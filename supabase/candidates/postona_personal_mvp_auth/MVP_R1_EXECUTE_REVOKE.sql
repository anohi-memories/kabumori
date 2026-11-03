-- G5 SOURCE CANDIDATE (2026-10-29, Issue #320 G5-01 task 48). NOT applied anywhere. Withdraws MVP_R1_EXECUTE_GRANT.sql: R1-MVP back to owner-only,
-- exactly as MVP_INSTALL.sql ships it. The EMERGENCY STOP for G6's real path: idempotent (a second run, or a run before any grant, succeeds); it
-- does not depend on the body pin, so a drifted R1-MVP can still be closed; and it revokes from EVERY non-owner grantee (also one granted
-- outside these files), so its postcondition cannot fail and leave authenticated granted. It refuses only on the full profile's reviewed R1 (G5-42: its
-- ACL is not this file's), and as a superuser. G6 then gets permission denied for every call: fail-closed, nothing is sent.
-- G5-49 (H1 P2 F1 / F2): a grantee is named by its raw pg_roles.rolname through format(%I) (a quoted role -- hyphen, space, upper case -- is no
-- longer double-quoted), and every REVOKE is CASCADE: a re-grant made from a grant option (owner -> authenticated WITH GRANT OPTION ->
-- another role) goes too instead of failing RESTRICT and rolling the whole stop back. CASCADE here reaches only this one function's ACL (a
-- dependent privilege is the same privilege on the same object); no other object, role or membership is changed.
-- Run as the lifecycle owner (never a superuser) with ON_ERROR_STOP.
begin;

set local lock_timeout = '5s';

do $$
declare v_fn regprocedure := pg_catalog.to_regprocedure('public.common_account_authorization_verdict(text,text,text)');
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) is distinct from false then
    raise exception 'R1MVP_EXEC_REVOKE_PRECONDITION_OWNER_IS_SUPERUSER';
  end if;
  if v_fn is null or not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_fn
                                   and p.proowner = (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
                                   and pg_catalog.strpos(p.prosrc, '''g5pv:'' || f_lifecycle::text') > 0) then
    raise exception 'R1MVP_EXEC_REVOKE_PRECONDITION_NOT_MVP';
  end if;
end $$;

revoke all on function public.common_account_authorization_verdict(text, text, text) from public, anon, authenticated, service_role cascade;

-- every other grantee too (a drifted grant must not make the stop fail and roll back with authenticated still granted): the raw role name, quoted
-- once by %I; CASCADE for a re-grant chain; a grantee already removed by an earlier CASCADE is only a no-op
do $$
declare v_grantee text;
begin
  for v_grantee in select distinct case when x.grantee = 0 then 'public' else pg_catalog.format('%I', r.rolname) end
                     from pg_catalog.pg_proc p cross join pg_catalog.aclexplode(p.proacl) x left join pg_catalog.pg_roles r on r.oid = x.grantee
                    where p.oid = 'public.common_account_authorization_verdict(text,text,text)'::regprocedure and x.grantee <> p.proowner loop
    execute pg_catalog.format('revoke all on function public.common_account_authorization_verdict(text, text, text) from %s cascade', v_grantee);
  end loop;
end $$;

do $$
declare v_fn regprocedure := 'public.common_account_authorization_verdict(text,text,text)'::regprocedure;
begin
  if (select pg_catalog.array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from pg_catalog.format('%s=X/%s', current_user, current_user)
     or exists (select 1 from pg_catalog.pg_roles a join pg_catalog.pg_roles r on pg_catalog.pg_has_role(a.oid, r.oid, 'MEMBER')
                 where a.rolname in ('anon', 'authenticated', 'service_role', 'authenticator') and pg_catalog.has_function_privilege(r.oid, v_fn, 'EXECUTE')) then
    raise exception 'R1MVP_EXEC_REVOKE_POSTCONDITION_ACL';
  end if;
end $$;

commit;
