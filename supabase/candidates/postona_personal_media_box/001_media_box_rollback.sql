-- G5 SOURCE CANDIDATE (2026-11-04, Issue #587 G5-02 task 5). NOT applied anywhere. The ROLLBACK of 001_media_box.sql: removes the three Storage
-- policies, the functions, the metadata table and the (empty) bucket. It refuses while anything is still stored:
--   MEDIA_ROLLBACK_NOT_EMPTY  a pending / ready asset, or any object in postona-media (objects are removable only through storage-api: delete
--                             them there first; deleting storage.objects rows in SQL would orphan the stored bytes)
--   MEDIA_SUPERUSER           run it as the lifecycle owner, not a superuser
-- Deleted assets' tombstone rows go with the table. Idempotent (a second run finds nothing to remove). Run with ON_ERROR_STOP.

begin;
set local lock_timeout = '5s';
set local search_path = '';

do $rollback$
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'MEDIA_SUPERUSER: run it as the lifecycle owner, not a superuser';
  end if;
  if exists (select 1 from storage.objects o where o.bucket_id = 'postona-media') then
    raise exception 'MEDIA_ROLLBACK_NOT_EMPTY: postona-media still holds objects (remove them through storage-api first)';
  end if;
  if pg_catalog.to_regclass('private.postona_media_assets') is not null then
    if exists (select 1 from private.postona_media_assets a where a.status in ('pending', 'ready')) then
      raise exception 'MEDIA_ROLLBACK_NOT_EMPTY: pending or ready assets remain';
    end if;
  end if;
end;
$rollback$;

drop policy if exists postona_media_insert on storage.objects;
drop policy if exists postona_media_select on storage.objects;
drop policy if exists postona_media_delete on storage.objects;
drop function if exists public.postona_media_begin_upload(uuid, text, text, bigint);
drop function if exists public.postona_media_complete_upload(uuid);
drop function if exists public.postona_media_list(integer, timestamptz, uuid);
drop function if exists public.postona_media_delete(uuid);
drop function if exists public.postona_media_object_access(text, text, text);
drop function if exists private.postona_media_orphans();
drop function if exists private.postona_media_writer_state();
drop function if exists private.postona_media_reader_state(uuid);
drop function if exists private.postona_media_session();
drop function if exists private.postona_media_asset_json(private.postona_media_assets);
drop table if exists private.postona_media_assets;

-- the bucket is empty (checked above, under the same transaction); storage's delete guard needs its own switch for this one statement
set local storage.allow_delete_query = 'true';
delete from storage.buckets b where b.id = 'postona-media' and not exists (select 1 from storage.objects o where o.bucket_id = b.id);
reset storage.allow_delete_query;

do $post$
begin
  if exists (select 1 from storage.buckets b where b.id = 'postona-media')
     or exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                 where n.nspname in ('public', 'private') and p.proname like 'postona\_media\_%')
     or exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'storage.objects'::pg_catalog.regclass and p.polname like 'postona\_media\_%')
     or pg_catalog.to_regclass('private.postona_media_assets') is not null then
    raise exception 'MEDIA_ROLLBACK_POSTCONDITION';
  end if;
end;
$post$;

commit;
