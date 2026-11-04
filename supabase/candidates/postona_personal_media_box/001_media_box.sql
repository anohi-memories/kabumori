-- G5 SOURCE CANDIDATE (2026-11-04, Issue #587 G5-02 task 5; G5-02 task 6 fixes H1 F1 / F2 / F3 of #306 comment 6618373731). NOT applied anywhere. Production NO_GO: a focused H1 security review of this
-- candidate, the owner's approval and a read-only check of the managed project come first (its state is not known: never connected).
--
-- The POSTONA media box ("素材BOX"): a person's private images and short videos in their own personal workspace.
--   bucket       storage.buckets 'postona-media': PRIVATE (no public URL), 50 MiB per object, six content types (below)
--   metadata     private.postona_media_assets (owner-only; no API role reads or writes it): one row per asset, pending -> ready -> deleted
--   API          four SECURITY DEFINER RPCs, EXECUTE for authenticated only:
--                  postona_media_begin_upload(request_id, file_name, content_type, size_bytes)   -> the server-chosen object path to upload to
--                  postona_media_complete_upload(asset_id)                                       -> ready, after the stored object is checked
--                  postona_media_list(limit, before_created_at, before_id)                       -> the person's ready assets, newest first
--                  postona_media_delete(asset_id)                                                -> deleted (idempotent), then the client removes the object
--   Storage      four policies on storage.objects for authenticated; each asks public.postona_media_object_access(bucket, name, version, cmd)
--                with storage-api's storage.operation: the object must be the caller's own asset in the caller's own personal workspace
--                  insert  the asset's STAGING key (<ws>/staging/<id>.<ext>) while pending and its 1-hour upload window is open
--                  update  only storage-api's move (storage.object.move) of that staging object onto the asset's FINAL key (<ws>/<id>.<ext>)
--                          while pending; nothing else may ever write the final key (no insert, upsert or copy onto it, measured)
--                  select  the final object of a ready asset AT ITS PINNED VERSION, for storage-api's authenticated download / info only
--                          (storage.object.get_authenticated / object.get_authenticated_info); the staging object for the move; a deleted
--                          asset's objects for storage-api's removal. NEVER a signed URL (sign / sign_many), a list or a copy
--                  delete  a deleted asset's final and staging objects
--
-- G5-02 task 6 (H1 F1 / F2 / F3 on PR #636):
--   F1  a ready asset's bytes cannot change: they live under a key no client write ever reaches (a late upload, measured to commit after
--       its permission check, lands on the staging key only), and complete pins the final object's version and eTag; reads require it
--   F2  no signed URL at all: the person reads with their own JWT through storage-api's authenticated download, and every read asks the
--       session / lifecycle / workspace / ownership again (sign-out, expiry, service end, membership removal, a stop: the next read is refused)
--   F3  a pending asset that holds an object keeps holding quota after its window closes; complete checks the limits again under T13's lock
--
-- Who the caller is: never a client-given workspace id, brand id or path. The RPCs ask G5's reviewed gates, in W0's order: S2-2
-- private.postona_personal_session() = 'active' (a signed-in, non-anonymous person with a live session), T13 (the lifecycle lock; the x_autopost
-- entitlement active, the account active, no deletion), S2-3 private.postona_personal_workspace_eligibility() = 'own'; the workspace is the
-- derived id ('u_' || substr(md5(user), 1, 24)). The Storage policies cannot use S2-2: storage-api sets the per-claim request.jwt.claim.sub /
-- .role but not .session_id (measured on the local storage-api v1.70.3), so S2-2 answers AUTH_REQUIRED there. They use
-- private.postona_media_session(): S2-2's rules on the JSON claims (which storage-api and PostgREST both set), and any per-claim sub / role must
-- be the same. Instead of T13 (it locks), they read the same account / entitlement / deletion facts in one STABLE statement.
--
-- Run as the lifecycle owner (the owner of the G5 gates; never a superuser) with ON_ERROR_STOP, after MVP_INSTALL.sql (and W0 for a person to
-- get a workspace). Re-running it changes nothing. Stop: 001_media_box_stop.sql (keeps every row and object). Rollback:
-- 001_media_box_rollback.sql (refuses while an asset or an object exists).
--
-- Refusals (SQLSTATE P0001, nothing changed): MEDIA_SUPERUSER, MEDIA_PREREQUISITE_MISSING (a G5 gate, the storage schema / shape, schema
-- private), MEDIA_GATE_CHANGED (a G5 gate is not the reviewed body / owner), MEDIA_OWNER_FILTERED (the owner cannot read every row of
-- storage.objects / auth.sessions), MEDIA_TAKEN (a table / function / bucket / policy of ours exists but is not ours), MEDIA_UNREVIEWED_STORAGE_POLICY
-- (another permissive policy on storage.objects reaches PUBLIC / anon / authenticated), MEDIA_POSTCONDITION_*.

begin;
set local lock_timeout = '5s';
set local search_path = '';

do $pre$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_txt text;
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) then
    raise exception 'MEDIA_SUPERUSER: run it as the lifecycle owner, not a superuser';
  end if;
  if pg_catalog.to_regnamespace('private') is null or pg_catalog.to_regclass('storage.objects') is null or pg_catalog.to_regclass('storage.buckets') is null
     or pg_catalog.to_regprocedure('private.postona_personal_session()') is null
     or pg_catalog.to_regprocedure('private.postona_personal_workspace_eligibility(uuid)') is null
     or pg_catalog.to_regprocedure('private.account_lifecycle_assert_active_service_write(uuid,text)') is null
     or pg_catalog.to_regclass('public.common_accounts') is null or pg_catalog.to_regclass('public.service_entitlements') is null
     or pg_catalog.to_regclass('private.account_lifecycle_operations') is null or pg_catalog.to_regclass('auth.sessions') is null then
    raise exception 'MEDIA_PREREQUISITE_MISSING: schema private, storage, auth.sessions, the P1 lifecycle tables and the MVP gates (S2-2, S2-3, T13) are required';
  end if;
  -- the reviewed gates, by body and owner (S2-2 and T13 as MVP_INSTALL pins them; S2-3 as MVP_INSTALL creates it)
  if (select pg_catalog.md5(p.prosrc) || ':' || (p.proowner = v_owner) from pg_catalog.pg_proc p where p.oid = 'private.postona_personal_session()'::pg_catalog.regprocedure)
       is distinct from 'a5d4d71c532847a8573e86a4bd0c791d:true'
     or (select pg_catalog.md5(p.prosrc) || ':' || (p.proowner = v_owner) from pg_catalog.pg_proc p where p.oid = 'private.postona_personal_workspace_eligibility(uuid)'::pg_catalog.regprocedure)
       is distinct from 'fa4623601fe2ef6efc38478c9f65105e:true'
     or (select pg_catalog.md5(p.prosrc) || ':' || (p.proowner = v_owner) from pg_catalog.pg_proc p where p.oid = 'private.account_lifecycle_assert_active_service_write(uuid,text)'::pg_catalog.regprocedure)
       is distinct from '1f8cd9c764c251f3232c61b7a77ff597:true' then
    raise exception 'MEDIA_GATE_CHANGED: S2-2, S2-3 or T13 is not the reviewed body owned by %', current_user;
  end if;
  -- the storage shape the functions read
  select pg_catalog.string_agg(v.t || '.' || v.c, ', ') into v_txt
    from (values ('storage.objects', 'bucket_id'), ('storage.objects', 'name'), ('storage.objects', 'owner_id'), ('storage.objects', 'metadata'),
                 ('storage.buckets', 'id'), ('storage.buckets', 'public'), ('storage.buckets', 'file_size_limit'), ('storage.buckets', 'allowed_mime_types')) v(t, c)
    left join pg_catalog.pg_attribute a on a.attrelid = pg_catalog.to_regclass(v.t) and a.attname = v.c and a.attnum > 0 and not a.attisdropped
   where a.attnum is null;
  if v_txt is not null or not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'storage.objects'::pg_catalog.regclass) then
    raise exception 'MEDIA_PREREQUISITE_MISSING: storage shape (% / row security on storage.objects)', coalesce(v_txt, 'columns present');
  end if;
  -- the owner reads every row of what the definer functions read
  if not (select r.rolbypassrls from pg_catalog.pg_roles r where r.oid = v_owner) then
    raise exception 'MEDIA_OWNER_FILTERED: % has no BYPASSRLS (storage.objects / auth.sessions would be filtered)', current_user;
  end if;
  -- ours, or absent
  if pg_catalog.to_regclass('private.postona_media_assets') is not null
     and ((select c.relowner from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass('private.postona_media_assets')) <> v_owner
          or (select pg_catalog.string_agg(a.attname::text, ',' order by a.attname) from pg_catalog.pg_attribute a
               where a.attrelid = pg_catalog.to_regclass('private.postona_media_assets') and a.attnum > 0 and not a.attisdropped)
             is distinct from 'bucket_id,content_type,created_at,declared_bytes,deleted_at,display_name,id,kind,object_etag,object_path,object_version,owner_user_id,ready_at,request_id,staging_path,status,stored_bytes,upload_expires_at,workspace_id') then
    raise exception 'MEDIA_TAKEN: private.postona_media_assets is not this version''s (an earlier candidate is installed: roll it back first)';
  end if;
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::text, ', ') into v_txt from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and p.proname like 'postona\_media\_%' and p.proowner <> v_owner;
  if v_txt is not null then
    raise exception 'MEDIA_TAKEN: %', v_txt;
  end if;
  if exists (select 1 from storage.buckets b where b.id = 'postona-media'
              and (b.public or b.file_size_limit is distinct from 52428800
                   or (select pg_catalog.array_agg(m order by m) from pg_catalog.unnest(b.allowed_mime_types) m)
                      is distinct from array['image/heic', 'image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime'])) then
    raise exception 'MEDIA_TAKEN: bucket postona-media exists with another configuration';
  end if;
  -- another permissive policy on storage.objects that reaches an API role would widen what a person may do with these objects
  select pg_catalog.string_agg(p.polname::text, ', ' order by p.polname) into v_txt from pg_catalog.pg_policy p
   where p.polrelid = 'storage.objects'::pg_catalog.regclass and p.polpermissive
     and p.polname not in ('postona_media_insert', 'postona_media_select', 'postona_media_update', 'postona_media_delete')
     and exists (select 1 from pg_catalog.unnest(p.polroles) u
                  where u = 0 or pg_catalog.pg_has_role(pg_catalog.to_regrole('anon'), u, 'MEMBER') or pg_catalog.pg_has_role(pg_catalog.to_regrole('authenticated'), u, 'MEMBER'));
  if v_txt is not null then
    raise exception 'MEDIA_UNREVIEWED_STORAGE_POLICY: %', v_txt;
  end if;
end;
$pre$;

-- ---- metadata (owner-only; row security on with no policy: only the definer functions, as the owner, read or write it) ----------------
create table if not exists private.postona_media_assets (
  id uuid primary key,
  owner_user_id uuid not null,
  workspace_id text not null check (workspace_id ~ '^u_[0-9a-f]{24}$'),
  request_id uuid not null,
  bucket_id text not null check (bucket_id = 'postona-media'),
  object_path text not null unique,    -- the FINAL key (no client write reaches it once storage-api's move created it)
  staging_path text not null unique,   -- the upload key
  kind text not null check (kind in ('image', 'video')),
  content_type text not null check (content_type in ('image/heic', 'image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime')),
  display_name text not null check (pg_catalog.char_length(display_name) between 1 and 120),
  declared_bytes bigint not null check (declared_bytes > 0),
  stored_bytes bigint check (stored_bytes > 0),
  object_version text,                 -- storage.objects.version of the final object, pinned by complete; reads require it
  object_etag text,
  status text not null check (status in ('pending', 'ready', 'deleted')),
  created_at timestamptz not null default pg_catalog.now(),
  upload_expires_at timestamptz not null,
  ready_at timestamptz,
  deleted_at timestamptz,
  unique (owner_user_id, request_id),
  check (object_path = workspace_id || '/' || id::text || '.' || case content_type when 'image/heic' then 'heic' when 'image/jpeg' then 'jpg'
         when 'image/png' then 'png' when 'image/webp' then 'webp' when 'video/mp4' then 'mp4' else 'mov' end),
  check (staging_path = workspace_id || '/staging/' || id::text || '.' || case content_type when 'image/heic' then 'heic' when 'image/jpeg' then 'jpg'
         when 'image/png' then 'png' when 'image/webp' then 'webp' when 'video/mp4' then 'mp4' else 'mov' end),
  check ((status = 'ready') = (ready_at is not null and stored_bytes is not null and object_version is not null) or status = 'deleted'),
  check ((status = 'deleted') = (deleted_at is not null))
);
create index if not exists postona_media_assets_list on private.postona_media_assets (owner_user_id, workspace_id, status, created_at desc, id desc);
alter table private.postona_media_assets enable row level security;
revoke all on table private.postona_media_assets from public, anon, authenticated, service_role;

-- ---- the Storage session gate: S2-2's rules on the JSON claims (storage-api does not set request.jwt.claim.session_id) ----------------
create or replace function private.postona_media_session()
returns text language plpgsql stable security definer set search_path = '' set row_security = off as $$
declare
  v_claims jsonb;
  v_sub text;
  v_role text;
  v_session text;
  v_anonymous text;
  v_user uuid;
  v_session_id uuid;
  f_user_exists boolean;
  f_session_state text;
begin
  begin
    v_claims := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb;
  exception when others then
    v_claims := null;
  end;
  if pg_catalog.jsonb_typeof(v_claims) is distinct from 'object' then
    return 'AUTH_REQUIRED';
  end if;
  v_sub := v_claims ->> 'sub';
  v_role := v_claims ->> 'role';
  v_session := v_claims ->> 'session_id';
  -- only the JSON boolean false is not anonymous (as S2-2)
  v_anonymous := case when pg_catalog.jsonb_typeof(v_claims -> 'is_anonymous') = 'boolean' then v_claims ->> 'is_anonymous' end;
  -- storage-api also sets the per-claim sub / role: when set, they must name the same person and role
  if nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '') is distinct from v_sub
       and nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '') is not null
     or nullif(pg_catalog.current_setting('request.jwt.claim.role', true), '') is distinct from v_role
       and nullif(pg_catalog.current_setting('request.jwt.claim.role', true), '') is not null then
    return 'AUTH_REQUIRED';
  end if;
  if v_sub ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and v_session ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and v_role = 'authenticated' and v_anonymous = 'false' then
    if (select auth.uid()) is not distinct from v_sub::uuid then
      v_user := v_sub::uuid;
      v_session_id := v_session::uuid;
    end if;
  end if;
  if v_user is null then
    return 'AUTH_REQUIRED';
  end if;
  select exists (select 1 from auth.users u where u.id = v_user),
         (select case when s.id is null then 'revoked'
                      when s.not_after is null or s.not_after > pg_catalog.clock_timestamp() then 'active' else 'expired' end
            from (select 1) x left join auth.sessions s on s.id = v_session_id and s.user_id = v_user)
    into f_user_exists, f_session_state;
  if not f_user_exists then
    return 'AUTH_REQUIRED';
  end if;
  return case f_session_state when 'active' then 'active' when 'revoked' then 'SESSION_REVOKED' when 'expired' then 'SESSION_EXPIRED' end;
end $$;

-- ---- the reader's account / entitlement / workspace state, without a lock (T13's refusals, read in one STABLE statement) ----------------
create or replace function private.postona_media_reader_state(p_user uuid)
returns text language plpgsql stable security definer set search_path = '' set row_security = off as $$
declare
  f_account text;
  f_entitlement text;
  f_account_deletion boolean;
  f_service_deletion boolean;
  v_state text;
begin
  if p_user is null then
    return 'AUTH_REQUIRED';
  end if;
  select (select a.status from public.common_accounts a where a.user_id = p_user),
         (select e.status from public.service_entitlements e where e.user_id = p_user and e.service_key = 'x_autopost'),
         exists (select 1 from private.account_lifecycle_operations o where o.user_id = p_user and o.operation_type = 'account_deletion' and o.status = 'in_progress'),
         exists (select 1 from private.account_lifecycle_operations o where o.user_id = p_user and o.operation_type = 'service_deletion'
                   and o.service_key = 'x_autopost' and o.status = 'in_progress')
    into f_account, f_entitlement, f_account_deletion, f_service_deletion;
  v_state := case
    when f_account is null then 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND'
    when f_account = 'deleting' or f_account_deletion then 'ACCOUNT_DELETION_IN_PROGRESS'
    when f_account <> 'active' then 'ACCOUNT_LOCKED'
    when f_entitlement is null then 'SERVICE_NOT_REGISTERED'
    when f_entitlement = 'deleting' or f_service_deletion then 'SERVICE_DELETION_IN_PROGRESS'
    when f_entitlement <> 'active' then 'SERVICE_NOT_ACTIVE'
  end;
  if v_state is not null then
    return v_state;
  end if;
  v_state := private.postona_personal_workspace_eligibility(p_user);
  return case v_state when 'own' then null when 'absent' then 'WORKSPACE_REQUIRED' else coalesce(v_state, 'OWN_WORKSPACE_CONFLICT') end;
end $$;

-- ---- the writer's gates, in W0's order (S2-2 -> T13 with the lifecycle lock -> S2-3); null = go on, else the answer's status ----------
create or replace function private.postona_media_writer_state()
returns text language plpgsql volatile security definer set search_path = '' set row_security = off as $$
declare
  v_session text;
  v_user uuid;
  v_state text;
begin
  v_session := private.postona_personal_session();
  if v_session is distinct from 'active' then
    return coalesce(v_session, 'AUTH_REQUIRED');
  end if;
  v_user := (select auth.uid());
  begin
    perform private.account_lifecycle_assert_active_service_write(v_user, 'x_autopost');
  exception when insufficient_privilege then
    if sqlerrm in ('ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND', 'ACCOUNT_DELETION_IN_PROGRESS', 'ACCOUNT_LOCKED',
                   'SERVICE_NOT_REGISTERED', 'SERVICE_DELETION_IN_PROGRESS', 'SERVICE_NOT_ACTIVE', 'ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE',
                   'ACCOUNT_LIFECYCLE_BUSY') then
      return sqlerrm;
    end if;
    raise;
  end;
  v_state := private.postona_personal_workspace_eligibility(v_user);
  return case v_state when 'own' then null when 'absent' then 'WORKSPACE_REQUIRED' else coalesce(v_state, 'OWN_WORKSPACE_CONFLICT') end;
end $$;

-- an asset as the API answers it (object_path is the final key; the staging key is told only by begin)
create or replace function private.postona_media_asset_json(a private.postona_media_assets)
returns jsonb language sql immutable set search_path = '' as $$
  select pg_catalog.jsonb_build_object('id', a.id, 'kind', a.kind, 'content_type', a.content_type, 'display_name', a.display_name,
           'bytes', coalesce(a.stored_bytes, a.declared_bytes), 'status', a.status, 'created_at', a.created_at, 'ready_at', a.ready_at,
           'bucket', a.bucket_id, 'object_path', a.object_path)
$$;

-- (G5-02 #6, H1 F3) what a person holds: every ready asset, and every pending asset that holds an object (staging or final) or whose upload
-- window is still open; the bytes are the larger of the declaration / record and what storage-api stored. An expired pending asset releases
-- its quota only once no object of it exists (H1: an expired asset with an object left the count, then a late complete made 201).
create or replace function private.postona_media_usage(p_user uuid, p_except uuid)
returns table (assets bigint, open_uploads bigint, bytes bigint)
language sql stable security definer set search_path = '' set row_security = off as $$
  with mine as (
    select a.*, pg_catalog.clock_timestamp() < a.upload_expires_at as window_open,
           (select pg_catalog.max(case when o.metadata ->> 'size' ~ '^[0-9]{1,12}$' then (o.metadata ->> 'size')::bigint else 52428800 end)
              from storage.objects o where o.bucket_id = a.bucket_id and o.name in (a.object_path, a.staging_path)) as object_bytes
      from private.postona_media_assets a
     where a.owner_user_id = p_user and a.status <> 'deleted' and a.id is distinct from p_except)
  select pg_catalog.count(*) filter (where m.status = 'ready' or m.object_bytes is not null or m.window_open),
         pg_catalog.count(*) filter (where m.status = 'pending' and m.window_open),
         coalesce(pg_catalog.sum(case when m.status = 'ready' then greatest(m.stored_bytes, coalesce(m.object_bytes, 0))
                                      when m.object_bytes is not null or m.window_open then greatest(m.declared_bytes, coalesce(m.object_bytes, 0)) end), 0)::bigint
    from mine m
$$;

-- ---- API ----------------------------------------------------------------------------------------------------------------------------
create or replace function public.postona_media_begin_upload(p_request_id uuid, p_file_name text, p_content_type text, p_size_bytes bigint)
returns jsonb language plpgsql volatile security definer set search_path = '' set row_security = off as $$
declare
  v_state text;
  v_user uuid;
  v_ws text;
  v_kind text;
  v_ext text;
  v_max bigint;
  v_name text;
  v_row private.postona_media_assets;
  v_id uuid;
  v_use record;
begin
  v_state := private.postona_media_writer_state();
  if v_state is not null then
    return pg_catalog.jsonb_build_object('status', v_state);
  end if;
  v_user := (select auth.uid());
  v_ws := 'u_' || pg_catalog.substr(pg_catalog.md5(v_user::text), 1, 24);
  -- the input: the content type decides the kind, the extension and the size limit (the file name decides nothing)
  select t.kind, t.ext, t.max_bytes into v_kind, v_ext, v_max
    from (values ('image/jpeg', 'image', 'jpg', 20971520::bigint), ('image/png', 'image', 'png', 20971520), ('image/webp', 'image', 'webp', 20971520),
                 ('image/heic', 'image', 'heic', 20971520), ('video/mp4', 'video', 'mp4', 52428800), ('video/quicktime', 'video', 'mov', 52428800)) t(ct, kind, ext, max_bytes)
   where t.ct = p_content_type;
  if p_request_id is null or p_size_bytes is null or p_size_bytes < 1 then
    return pg_catalog.jsonb_build_object('status', 'MEDIA_INPUT_INVALID');
  end if;
  if v_kind is null then
    return pg_catalog.jsonb_build_object('status', 'MEDIA_TYPE_UNSUPPORTED');
  end if;
  if p_size_bytes > v_max then
    return pg_catalog.jsonb_build_object('status', 'MEDIA_TOO_LARGE', 'max_bytes', v_max);
  end if;
  -- the display name only: the last path segment, without control characters, at most 120 characters
  v_name := pg_catalog.regexp_replace(coalesce(p_file_name, ''), '^.*[/\\]', '');
  v_name := pg_catalog.btrim(pg_catalog.regexp_replace(v_name, '[[:cntrl:]]', '', 'g'));
  v_name := pg_catalog.left(case when v_name = '' then 'untitled' else v_name end, 120);

  -- the same request again (a retry): the same answer, if it asks the same thing
  select * into v_row from private.postona_media_assets a where a.owner_user_id = v_user and a.request_id = p_request_id for update;
  if found then
    if v_row.workspace_id <> v_ws or v_row.content_type <> p_content_type or v_row.declared_bytes <> p_size_bytes or v_row.display_name <> v_name then
      return pg_catalog.jsonb_build_object('status', 'MEDIA_REQUEST_CONFLICT');
    end if;
    if v_row.status = 'deleted' then
      return pg_catalog.jsonb_build_object('status', 'MEDIA_NOT_FOUND');
    end if;
    if v_row.status = 'ready' then
      return pg_catalog.jsonb_build_object('status', 'ready', 'asset', private.postona_media_asset_json(v_row));
    end if;
    if v_row.upload_expires_at <= pg_catalog.clock_timestamp() then
      return pg_catalog.jsonb_build_object('status', 'MEDIA_UPLOAD_EXPIRED');
    end if;
    -- moved = an earlier try already put the bytes on the final key: the client goes straight to complete
    return pg_catalog.jsonb_build_object('status', 'upload', 'asset', private.postona_media_asset_json(v_row),
             'upload', pg_catalog.jsonb_build_object('bucket', v_row.bucket_id, 'object_path', v_row.staging_path, 'final_path', v_row.object_path,
                                                     'content_type', v_row.content_type, 'max_bytes', v_max, 'expires_at', v_row.upload_expires_at,
                                                     'moved', exists (select 1 from storage.objects o where o.bucket_id = v_row.bucket_id and o.name = v_row.object_path)));
  end if;

  -- quotas (the lifecycle lock T13 took serializes this person's writers): 200 assets, 10 open uploads, 2 GiB
  select * into v_use from private.postona_media_usage(v_user, null);
  if v_use.assets >= 200 or v_use.open_uploads >= 10 or v_use.bytes + p_size_bytes > 2147483648 then
    return pg_catalog.jsonb_build_object('status', 'MEDIA_QUOTA_EXCEEDED');
  end if;

  v_id := pg_catalog.gen_random_uuid();
  insert into private.postona_media_assets (id, owner_user_id, workspace_id, request_id, bucket_id, object_path, staging_path, kind, content_type,
                                            display_name, declared_bytes, status, upload_expires_at)
  values (v_id, v_user, v_ws, p_request_id, 'postona-media', v_ws || '/' || v_id::text || '.' || v_ext, v_ws || '/staging/' || v_id::text || '.' || v_ext,
          v_kind, p_content_type, v_name, p_size_bytes, 'pending', pg_catalog.clock_timestamp() + interval '1 hour')
  returning * into v_row;
  return pg_catalog.jsonb_build_object('status', 'upload', 'asset', private.postona_media_asset_json(v_row),
           'upload', pg_catalog.jsonb_build_object('bucket', v_row.bucket_id, 'object_path', v_row.staging_path, 'final_path', v_row.object_path,
                                                   'content_type', v_row.content_type, 'max_bytes', v_max, 'expires_at', v_row.upload_expires_at, 'moved', false));
end $$;

-- complete: the client has uploaded to the staging key and moved it onto the final key (storage-api's move). The final object storage-api
-- recorded must be the person's, of the declared type and size; its version and eTag are pinned (reads require that version); the limits
-- are checked again with everything else this person holds (H1 F3: a late complete may not take an asset over 200 / 2 GiB).
create or replace function public.postona_media_complete_upload(p_asset_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' set row_security = off as $$
declare
  v_state text;
  v_user uuid;
  v_ws text;
  v_row private.postona_media_assets;
  v_use record;
  f_found boolean;
  f_owner text;
  f_mime text;
  f_size text;
  f_version text;
  f_etag text;
  f_staged boolean;
begin
  v_state := private.postona_media_writer_state();
  if v_state is not null then
    return pg_catalog.jsonb_build_object('status', v_state);
  end if;
  v_user := (select auth.uid());
  v_ws := 'u_' || pg_catalog.substr(pg_catalog.md5(v_user::text), 1, 24);
  select * into v_row from private.postona_media_assets a
   where a.id = p_asset_id and a.owner_user_id = v_user and a.workspace_id = v_ws for update;
  if not found or v_row.status = 'deleted' then
    return pg_catalog.jsonb_build_object('status', 'MEDIA_NOT_FOUND');
  end if;
  if v_row.status = 'ready' then
    return pg_catalog.jsonb_build_object('status', 'ready', 'asset', private.postona_media_asset_json(v_row));
  end if;
  select true, o.owner_id, o.metadata ->> 'mimetype', o.metadata ->> 'size', o.version, o.metadata ->> 'eTag'
    into f_found, f_owner, f_mime, f_size, f_version, f_etag
    from storage.objects o where o.bucket_id = v_row.bucket_id and o.name = v_row.object_path;
  if f_found is null then
    f_staged := exists (select 1 from storage.objects o where o.bucket_id = v_row.bucket_id and o.name = v_row.staging_path);
    return pg_catalog.jsonb_build_object('status', case when f_staged then 'MEDIA_MOVE_REQUIRED'
                                                        when v_row.upload_expires_at <= pg_catalog.clock_timestamp() then 'MEDIA_UPLOAD_EXPIRED'
                                                        else 'MEDIA_OBJECT_MISSING' end);
  end if;
  if f_owner is distinct from v_user::text or f_mime is distinct from v_row.content_type or f_size is null or f_size !~ '^[0-9]{1,12}$'
     or f_size::bigint is distinct from v_row.declared_bytes or f_version is null then
    return pg_catalog.jsonb_build_object('status', 'MEDIA_OBJECT_MISMATCH');
  end if;
  select * into v_use from private.postona_media_usage(v_user, v_row.id);
  if v_use.assets + 1 > 200 or v_use.bytes + f_size::bigint > 2147483648 then
    return pg_catalog.jsonb_build_object('status', 'MEDIA_QUOTA_EXCEEDED');
  end if;
  update private.postona_media_assets a set status = 'ready', stored_bytes = f_size::bigint, object_version = f_version, object_etag = f_etag,
         ready_at = pg_catalog.clock_timestamp()
   where a.id = v_row.id returning * into v_row;
  return pg_catalog.jsonb_build_object('status', 'ready', 'asset', private.postona_media_asset_json(v_row));
end $$;

create or replace function public.postona_media_list(p_limit integer default 30, p_before_created_at timestamptz default null, p_before_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' set row_security = off as $$
declare
  v_session text;
  v_user uuid;
  v_state text;
  v_ws text;
  v_limit integer;
  v_items jsonb;
  v_more boolean;
begin
  v_session := private.postona_personal_session();
  if v_session is distinct from 'active' then
    return pg_catalog.jsonb_build_object('status', coalesce(v_session, 'AUTH_REQUIRED'));
  end if;
  v_user := (select auth.uid());
  v_state := private.postona_media_reader_state(v_user);
  if v_state is not null then
    return pg_catalog.jsonb_build_object('status', v_state);
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 50 or (p_before_created_at is null) <> (p_before_id is null) then
    return pg_catalog.jsonb_build_object('status', 'MEDIA_INPUT_INVALID');
  end if;
  v_ws := 'u_' || pg_catalog.substr(pg_catalog.md5(v_user::text), 1, 24);
  v_limit := p_limit;
  -- only an asset whose final object is still there at the pinned version (a readable one)
  with page as (
    select private.postona_media_asset_json(a) j, a.created_at c, a.id i from private.postona_media_assets a
     where a.owner_user_id = v_user and a.workspace_id = v_ws and a.status = 'ready'
       and exists (select 1 from storage.objects o where o.bucket_id = a.bucket_id and o.name = a.object_path and o.version = a.object_version)
       and (p_before_created_at is null or (a.created_at, a.id) < (p_before_created_at, p_before_id))
     order by a.created_at desc, a.id desc
     limit v_limit + 1),
  numbered as (select page.*, pg_catalog.row_number() over (order by page.c desc, page.i desc) n from page)
  select coalesce(pg_catalog.jsonb_agg(numbered.j order by numbered.c desc, numbered.i desc) filter (where numbered.n <= v_limit), '[]'::jsonb),
         pg_catalog.count(*) > v_limit
    into v_items, v_more
    from numbered;
  return pg_catalog.jsonb_build_object('status', 'ok', 'items', v_items,
           'next', case when v_more then pg_catalog.jsonb_build_object('before_created_at', v_items -> (v_limit - 1) ->> 'created_at', 'before_id', v_items -> (v_limit - 1) ->> 'id') end);
end $$;

create or replace function public.postona_media_delete(p_asset_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' set row_security = off as $$
declare
  v_state text;
  v_user uuid;
  v_ws text;
  v_row private.postona_media_assets;
  v_already boolean;
begin
  v_state := private.postona_media_writer_state();
  if v_state is not null then
    return pg_catalog.jsonb_build_object('status', v_state);
  end if;
  v_user := (select auth.uid());
  v_ws := 'u_' || pg_catalog.substr(pg_catalog.md5(v_user::text), 1, 24);
  select * into v_row from private.postona_media_assets a
   where a.id = p_asset_id and a.owner_user_id = v_user and a.workspace_id = v_ws for update;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'MEDIA_NOT_FOUND');
  end if;
  v_already := v_row.status = 'deleted';
  if not v_already then
    update private.postona_media_assets a set status = 'deleted', deleted_at = pg_catalog.clock_timestamp() where a.id = v_row.id returning * into v_row;
  end if;
  -- the objects go through storage-api (the client's remove, allowed for a deleted asset only); a retry is safe
  return pg_catalog.jsonb_build_object('status', 'deleted', 'already', v_already,
           'remove', pg_catalog.jsonb_build_object('bucket', v_row.bucket_id, 'object_paths', pg_catalog.jsonb_build_array(v_row.object_path, v_row.staging_path)));
end $$;

-- ---- the Storage policies' question (storage-api's operation decides what each command may do) ------------------------------------
create or replace function public.postona_media_object_access(p_bucket text, p_name text, p_version text, p_cmd text)
returns boolean language plpgsql stable security definer set search_path = '' set row_security = off as $$
declare
  v_user uuid;
  v_op text := pg_catalog.current_setting('storage.operation', true);
begin
  if p_bucket is distinct from 'postona-media' or p_name is null or p_cmd is null
     or p_cmd not in ('insert', 'update_using', 'update_check', 'select', 'delete') then
    return false;
  end if;
  if private.postona_media_session() is distinct from 'active' then
    return false;
  end if;
  v_user := (select auth.uid());
  if private.postona_media_reader_state(v_user) is not null then
    return false;
  end if;
  return exists (
    select 1 from private.postona_media_assets a
     where a.bucket_id = p_bucket and a.owner_user_id = v_user
       and a.workspace_id = 'u_' || pg_catalog.substr(pg_catalog.md5(v_user::text), 1, 24)
       and case p_cmd
             -- upload: the staging key only, while pending and the window is open
             when 'insert' then p_name = a.staging_path and a.status = 'pending' and a.upload_expires_at > pg_catalog.clock_timestamp()
             -- storage-api's move of the staging object onto the final key (the old row / the new row), while pending
             when 'update_using' then p_name = a.staging_path and a.status = 'pending' and v_op = 'storage.object.move'
             when 'update_check' then p_name = a.object_path and a.status = 'pending' and v_op = 'storage.object.move'
             when 'select' then
               -- the person's own authenticated download / info of a ready asset, at its pinned version (no sign, list or copy)
               (p_name = a.object_path and a.status = 'ready' and p_version is not distinct from a.object_version
                and v_op in ('storage.object.get_authenticated', 'object.get_authenticated_info'))
               -- the move reads its source and its destination (measured: three SELECT checks, the last on the new row)
               or (p_name in (a.staging_path, a.object_path) and a.status = 'pending' and v_op = 'storage.object.move')
               -- storage-api's removal of a deleted asset's objects
               or (p_name in (a.object_path, a.staging_path) and a.status = 'deleted' and v_op = 'storage.object.delete_many')
             else p_name in (a.object_path, a.staging_path) and a.status = 'deleted'
           end);
end $$;

-- ---- an owner-only view of what needs cleaning (for the operator; nothing is removed here: objects go only through storage-api) -------
create or replace function private.postona_media_orphans()
returns table (kind text, bucket_id text, object_path text, owner text)
language sql stable security definer set search_path = '' set row_security = off as $$
  -- an object no live asset stands for: a deleted asset's object the client never removed, a late upload that landed on the staging key of an
  -- asset that is no longer pending, or no asset at all
  select 'object_without_asset', o.bucket_id, o.name, o.owner_id from storage.objects o
   where o.bucket_id = 'postona-media'
     and not exists (select 1 from private.postona_media_assets a
                      where (a.status in ('pending', 'ready') and a.object_path = o.name) or (a.status = 'pending' and a.staging_path = o.name))
  union all
  -- (G5-02 #6) a pending asset whose window closed while it holds an object: it keeps its quota until completed or deleted
  select 'expired_upload_with_object', a.bucket_id, o.name, a.owner_user_id::text from private.postona_media_assets a
    join storage.objects o on o.bucket_id = a.bucket_id and o.name in (a.object_path, a.staging_path)
   where a.status = 'pending' and a.upload_expires_at <= pg_catalog.clock_timestamp()
  union all
  -- a pending asset whose window closed without an object (it holds nothing; its row can go)
  select 'expired_upload', a.bucket_id, a.staging_path, a.owner_user_id::text from private.postona_media_assets a
   where a.status = 'pending' and a.upload_expires_at <= pg_catalog.clock_timestamp()
     and not exists (select 1 from storage.objects o where o.bucket_id = a.bucket_id and o.name in (a.object_path, a.staging_path))
  union all
  -- a ready asset whose final object is gone or no longer at its pinned version (not readable; not listed)
  select 'broken_ready', a.bucket_id, a.object_path, a.owner_user_id::text from private.postona_media_assets a
   where a.status = 'ready'
     and not exists (select 1 from storage.objects o where o.bucket_id = a.bucket_id and o.name = a.object_path and o.version = a.object_version)
$$;

revoke all on function private.postona_media_session(), private.postona_media_reader_state(uuid), private.postona_media_writer_state(),
  private.postona_media_asset_json(private.postona_media_assets), private.postona_media_usage(uuid, uuid), private.postona_media_orphans(),
  public.postona_media_begin_upload(uuid, text, text, bigint), public.postona_media_complete_upload(uuid),
  public.postona_media_list(integer, timestamptz, uuid), public.postona_media_delete(uuid), public.postona_media_object_access(text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.postona_media_begin_upload(uuid, text, text, bigint), public.postona_media_complete_upload(uuid),
  public.postona_media_list(integer, timestamptz, uuid), public.postona_media_delete(uuid), public.postona_media_object_access(text, text, text, text)
  to authenticated;

-- ---- the private bucket and the four policies ---------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('postona-media', 'postona-media', false, 52428800, array['image/heic', 'image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime'])
on conflict (id) do nothing;
drop policy if exists postona_media_insert on storage.objects;
drop policy if exists postona_media_select on storage.objects;
drop policy if exists postona_media_update on storage.objects;
drop policy if exists postona_media_delete on storage.objects;
create policy postona_media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'postona-media' and public.postona_media_object_access(bucket_id, name, version, 'insert'));
create policy postona_media_select on storage.objects for select to authenticated
  using (bucket_id = 'postona-media' and public.postona_media_object_access(bucket_id, name, version, 'select'));
create policy postona_media_update on storage.objects for update to authenticated
  using (bucket_id = 'postona-media' and public.postona_media_object_access(bucket_id, name, version, 'update_using'))
  with check (bucket_id = 'postona-media' and public.postona_media_object_access(bucket_id, name, version, 'update_check'));
create policy postona_media_delete on storage.objects for delete to authenticated
  using (bucket_id = 'postona-media' and public.postona_media_object_access(bucket_id, name, version, 'delete'));

-- ---- postconditions ---------------------------------------------------------------------------------------------------------------
do $post$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_auth oid := pg_catalog.to_regrole('authenticated');
  v_txt text;
begin
  -- the API: definer, empty search path, owned here, EXECUTE for the owner and authenticated only (no other role reaches it)
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::text, ', ') into v_txt from pg_catalog.pg_proc p
   where p.oid in ('public.postona_media_begin_upload(uuid,text,text,bigint)'::pg_catalog.regprocedure, 'public.postona_media_complete_upload(uuid)'::pg_catalog.regprocedure,
                   'public.postona_media_list(integer,timestamptz,uuid)'::pg_catalog.regprocedure, 'public.postona_media_delete(uuid)'::pg_catalog.regprocedure,
                   'public.postona_media_object_access(text,text,text,text)'::pg_catalog.regprocedure)
     and (p.proowner <> v_owner or not p.prosecdef or p.proconfig is distinct from array['search_path=""', 'row_security=off']
          or exists (select 1 from pg_catalog.pg_roles r
                      where not r.rolsuper and r.oid not in (v_owner, v_auth) and pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE')
                        and not pg_catalog.pg_has_role(r.oid, v_owner, 'USAGE') and not pg_catalog.pg_has_role(r.oid, v_auth, 'USAGE'))
          or pg_catalog.has_function_privilege(pg_catalog.to_regrole('anon'), p.oid, 'EXECUTE')
          or pg_catalog.has_function_privilege(pg_catalog.to_regrole('service_role'), p.oid, 'EXECUTE')
          or not pg_catalog.has_function_privilege(v_auth, p.oid, 'EXECUTE'));
  if v_txt is not null then
    raise exception 'MEDIA_POSTCONDITION_API_ACL: %', v_txt;
  end if;
  -- the helpers and the table: owner-only. Their ACLs name the owner alone, and no API role reaches them through any membership. (Supabase's
  -- platform roles that read every table -- supabase_read_only_user / supabase_etl_admin via pg_read_all_data, measured -- are not granted
  -- anything here; they read this table as they read every other one.)
  select pg_catalog.string_agg(x, ', ') into v_txt from (
    select p.oid::pg_catalog.regprocedure::text || ' grants ' || a.grantee::pg_catalog.regrole::text x
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace,
           pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
     where n.nspname = 'private' and p.proname like 'postona\_media\_%' and a.grantee <> v_owner
    union all
    select 'private.postona_media_assets grants ' || case when a.grantee = 0 then 'PUBLIC' else a.grantee::pg_catalog.regrole::text end
      from pg_catalog.pg_class c, pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
     where c.oid = 'private.postona_media_assets'::pg_catalog.regclass and a.grantee <> v_owner
    union all
    select r.rolname || ' reaches ' || k
      from pg_catalog.pg_roles r, pg_catalog.unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) k
     where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
       and case when k = 'DELETE' then pg_catalog.has_table_privilege(r.oid, 'private.postona_media_assets', k)
                else pg_catalog.has_any_column_privilege(r.oid, 'private.postona_media_assets', k) end
    union all
    select r.rolname || ' reaches ' || p.oid::pg_catalog.regprocedure::text
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace, pg_catalog.pg_roles r
     where n.nspname = 'private' and p.proname like 'postona\_media\_%' and r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
       and pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE')) s;
  if v_txt is not null or not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'private.postona_media_assets'::pg_catalog.regclass) then
    raise exception 'MEDIA_POSTCONDITION_PRIVATE_ACL: %', coalesce(v_txt, 'row security off');
  end if;
  -- the bucket: private, the limits above
  if not exists (select 1 from storage.buckets b where b.id = 'postona-media' and not b.public and b.file_size_limit = 52428800
                  and (select pg_catalog.array_agg(m order by m) from pg_catalog.unnest(b.allowed_mime_types) m)
                      = array['image/heic', 'image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime']) then
    raise exception 'MEDIA_POSTCONDITION_BUCKET';
  end if;
  -- the four policies, exactly; and still no other permissive policy for an API role
  if (select pg_catalog.count(*) from pg_catalog.pg_policy p
       where p.polrelid = 'storage.objects'::pg_catalog.regclass and p.polpermissive and p.polroles = array[v_auth]
         and ((p.polname, p.polcmd) in (('postona_media_insert', 'a'), ('postona_media_select', 'r'), ('postona_media_update', 'w'), ('postona_media_delete', 'd')))) <> 4
     or exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'storage.objects'::pg_catalog.regclass and p.polpermissive
                 and p.polname not in ('postona_media_insert', 'postona_media_select', 'postona_media_update', 'postona_media_delete')
                 and exists (select 1 from pg_catalog.unnest(p.polroles) u
                              where u = 0 or pg_catalog.pg_has_role(pg_catalog.to_regrole('anon'), u, 'MEMBER') or pg_catalog.pg_has_role(v_auth, u, 'MEMBER'))) then
    raise exception 'MEDIA_POSTCONDITION_POLICIES';
  end if;
end;
$post$;

commit;
