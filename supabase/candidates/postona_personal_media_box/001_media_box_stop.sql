-- G5 SOURCE CANDIDATE (2026-11-04, Issue #587 G5-02 tasks 5 / 6). NOT applied anywhere. The STOP of 001_media_box.sql: every person loses the media
-- box at once and nothing is deleted. It drops the four Storage policies (no upload, move, download or removal of a postona-media
-- object by an API role; G5-02 #6: no signed URL exists to outlive it) and revokes EXECUTE on the five API functions from authenticated. Every asset row and object stays. Re-running
-- 001_media_box.sql turns it on again. Idempotent. Run as the lifecycle owner with ON_ERROR_STOP.

begin;
set local lock_timeout = '5s';
set local search_path = '';

drop policy if exists postona_media_insert on storage.objects;
drop policy if exists postona_media_select on storage.objects;
drop policy if exists postona_media_update on storage.objects;
drop policy if exists postona_media_delete on storage.objects;

do $stop$
begin
  if pg_catalog.to_regprocedure('public.postona_media_begin_upload(uuid,text,text,bigint)') is not null then
    revoke execute on function public.postona_media_begin_upload(uuid, text, text, bigint), public.postona_media_complete_upload(uuid),
      public.postona_media_list(integer, timestamptz, uuid), public.postona_media_delete(uuid), public.postona_media_object_access(text, text, text, text)
      from authenticated;
  end if;
  -- postcondition: no API role reaches any of them, and no policy of ours is left
  if exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace, pg_catalog.pg_roles r
              where n.nspname = 'public' and p.proname like 'postona\_media\_%' and r.rolname in ('anon', 'authenticated', 'service_role')
                and pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE'))
     or exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'storage.objects'::pg_catalog.regclass and p.polname like 'postona\_media\_%') then
    raise exception 'MEDIA_STOP_POSTCONDITION';
  end if;
end;
$stop$;

commit;
