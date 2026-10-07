-- 会社員AIラボ（ai_salaryman_lab）: 題材プールの容量修正（forward migration, 2026-10-07）。
--
-- 原因: evergreen の題材が7件しかなく、同じ seed 72時間・同じテーマ48時間のクールダウンの下では
-- 1日10投稿を続けられず、AI_LAB_TOPIC_POOL_EXHAUSTED で投稿が止まった（容量の設計不足）。
--
-- 変更は claim_ai_lab_topic の2点だけ（関数の他の部分・テーブル・他の4関数・権限は 20261004090000 のまま）:
--   1. 正規の evergreen 対応表 c_evergreen_tags を 7件 → 74件（evergreen-0〜evergreen-73）。既存の0〜6は
--      同じ意味・同じタグのまま（DB の行は添字で seed を指すため、添字の意味は変えない）。追加分はテーマタグなし。
--      TS の EVERGREEN_TOPIC_SEEDS / EVERGREEN_THEME_TAGS と完全一致（テストで確認）。
--   2. 1回の呼び出しで受け付ける候補数の上限 64 → 128（日記＋74件の evergreen を1回で渡せるように）。
-- クールダウン（同じ seed 72時間・同じテーマ48時間）、未解決（claimed / provider_started / ambiguous）の隔離、
-- 日記イベントの一度きり、ブランド単位のロック、候補の全件検証、SECURITY DEFINER / search_path / 権限は変えない。
-- 事後条件で、5関数とテーブルの owner・実効権限（継承・PUBLIC・列権限を含む）を 20261004090000 と同じ基準で再検証する。

begin;

-- 1. Preflight（owner 方針・オーバーロード検査は 20261004090000 と同じ。加えて前提の適用済みを確認）。
do $preflight$
declare
  v_api_roles constant text[] := array['anon', 'authenticated', 'service_role'];
begin
  -- owner 方針（上のヘッダー参照）。ロール構成は変更せず、合わなければ中断する。
  if current_user = any (v_api_roles) or current_user = 'authenticator' then
    raise exception 'AI_LAB_TOPIC_CLAIMS_PREFLIGHT: migration must not run as an API role (%)', current_user;
  end if;
  if exists (
    select 1 from unnest(v_api_roles) as r(role_name)
     where exists (select 1 from pg_roles where rolname = r.role_name)
       and pg_has_role(r.role_name, current_user, 'MEMBER')
  ) then
    raise exception 'AI_LAB_TOPIC_CLAIMS_PREFLIGHT: an API role is a member of the owner role %', current_user;
  end if;
  if exists (
    select 1 from pg_class
     where oid = to_regclass('public.ai_lab_topic_claims') and pg_get_userbyid(relowner) <> current_user
  ) then
    raise exception 'AI_LAB_TOPIC_CLAIMS_PREFLIGHT: public.ai_lab_topic_claims is not owned by %', current_user;
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('claim_ai_lab_topic', 'start_ai_lab_topic_provider', 'release_ai_lab_topic_claim',
                         'mark_ai_lab_topic_claim_ambiguous', 'settle_ai_lab_topic_claim_published')
       and pg_get_userbyid(p.proowner) <> current_user
  ) then
    raise exception 'AI_LAB_TOPIC_CLAIMS_PREFLIGHT: an AI Lab topic claim function is not owned by %', current_user;
  end if;
  if to_regclass('public.ai_lab_topic_event_usage') is not null then
    raise exception 'AI_LAB_TOPIC_CLAIMS_PREFLIGHT: superseded table public.ai_lab_topic_event_usage exists';
  end if;
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'claim_ai_lab_topic', 'start_ai_lab_topic_provider', 'release_ai_lab_topic_claim',
        'mark_ai_lab_topic_claim_ambiguous', 'settle_ai_lab_topic_claim_published'
      )
      and (p.proname, pg_get_function_identity_arguments(p.oid)) not in (
        ('claim_ai_lab_topic', 'p_scheduled_post_id uuid, p_candidates jsonb, p_lease_seconds integer'),
        ('start_ai_lab_topic_provider', 'p_claim_id uuid, p_scheduled_post_id uuid, p_event_key text'),
        ('release_ai_lab_topic_claim', 'p_claim_id uuid, p_scheduled_post_id uuid, p_event_key text, p_reason text'),
        ('mark_ai_lab_topic_claim_ambiguous', 'p_claim_id uuid, p_scheduled_post_id uuid, p_event_key text, p_reason text'),
        ('settle_ai_lab_topic_claim_published', 'p_claim_id uuid, p_scheduled_post_id uuid, p_event_key text, p_unit_key text, p_x_post_id text')
      )
  ) then
    raise exception 'AI_LAB_TOPIC_CLAIMS_PREFLIGHT: unexpected overload of an AI Lab topic claim function';
  end if;
  -- このファイルは 20261004090000 の後に、claim_ai_lab_topic の evergreen 対応表と候補数の上限だけを入れ替える。
  if to_regclass('public.ai_lab_topic_claims') is null
     or to_regprocedure('public.claim_ai_lab_topic(uuid,jsonb,integer)') is null then
    raise exception 'AI_LAB_TOPIC_CLAIMS_PREFLIGHT: requires 20261004090000_ai_lab_topic_claims';
  end if;
end
$preflight$;

-- 1b. 役割の経路（B1）: API ロール（anon / authenticated）から、メンバーシップの連鎖（直接・間接）で
--     特権ロールへ届く経路があれば中断する。PostgreSQL 16 以降は辺ごとに INHERIT / SET の別があり、
--     INHERIT FALSE でも SET TRUE なら SET ROLE で相手の権限を使えるので、ここでは辺のオプションを問わず
--     「経路があれば届く」とみなす（保守的）。届いてはいけない相手: superuser、この表と関数の owner、
--     5関数のどれかを実行できるロール（service_role を含む）、表に何らかの権限を持つロール。
--     service_role から owner / superuser への経路も拒否する。ロール構成は変更しない（直さずに止める）。
do $roles$
declare
  v_owner constant oid := (select relowner from pg_catalog.pg_class where oid = 'public.ai_lab_topic_claims'::regclass);
  v_functions constant text[] := array[
    'public.claim_ai_lab_topic(uuid,jsonb,integer)',
    'public.start_ai_lab_topic_provider(uuid,uuid,text)',
    'public.release_ai_lab_topic_claim(uuid,uuid,text,text)',
    'public.mark_ai_lab_topic_claim_ambiguous(uuid,uuid,text,text)',
    'public.settle_ai_lab_topic_claim_published(uuid,uuid,text,text,text)'
  ];
  v_hit text;
begin
  with recursive reach(api, role_oid) as (
    select r.rolname::text, m.roleid
      from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid = m.member
     where r.rolname in ('anon', 'authenticated', 'service_role')
    union
    select reach.api, m.roleid
      from reach join pg_catalog.pg_auth_members m on m.member = reach.role_oid
  )
  select string_agg(distinct reach.api || '->' || t.rolname, ', ') into v_hit
    from reach join pg_catalog.pg_roles t on t.oid = reach.role_oid
   where t.oid = v_owner
      or t.rolsuper
      or (reach.api in ('anon', 'authenticated') and (
            t.rolname = 'service_role'
         or exists (select 1 from unnest(v_functions) as f(signature)
                     where pg_catalog.has_function_privilege(t.oid, f.signature::regprocedure, 'EXECUTE'))
         or pg_catalog.has_table_privilege(t.oid, 'public.ai_lab_topic_claims'::regclass,
                                           'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         or pg_catalog.has_any_column_privilege(t.oid, 'public.ai_lab_topic_claims'::regclass, 'SELECT,INSERT,UPDATE,REFERENCES')));
  if v_hit is not null then
    raise exception 'AI_LAB_TOPIC_CLAIMS_PREFLIGHT: an API role can reach a privileged role through role membership (%)', v_hit;
  end if;
end
$roles$;

-- 1c. 前提の表の形（B2）: 20261004090000 の正本の定義を pg_temp に作り、列・型・NOT NULL・既定値・PK・
--     CHECK の全文・インデックス（キー・述語・一意性・valid/ready/live）・RLS / FORCE・ポリシー数・
--     トリガー数・列 ACL の数を比べる（下の2つの関数は 20261004090000 からそのまま写したもの）。
--     この migration は表を変えないので、適用前（容量修正前）と再適用時の正しい形は同じ。違えば中断し、
--     表・RLS・インデックス・ACL は直さない。加えて表の ACL の境界（明示 ACL は owner のみ、API ロールは
--     実効権限なし。列単位・継承・PUBLIC を含む）を、関数の置き換え前に確認する。
create function pg_temp.ai_lab_topic_claims_create(p_schema text) returns void
language plpgsql as $create$
begin
  execute format($ddl$
    create table %1$I.ai_lab_topic_claims (
      claim_id uuid not null default gen_random_uuid(),
      brand_id text not null default 'ai_salaryman_lab',
      scheduled_post_id uuid not null,
      topic_kind text not null,
      event_key text not null,
      unit_key text not null,
      theme_tags text[] not null default '{}'::text[],
      state text not null,
      claimed_at timestamptz not null default now(),
      lease_until timestamptz not null,
      provider_started_at timestamptz,
      settled_at timestamptz,
      published_at timestamptz,
      x_post_id text,
      outcome_reason text,
      constraint ai_lab_topic_claims_pkey primary key (claim_id),
      constraint ai_lab_topic_claims_brand_check check (brand_id = 'ai_salaryman_lab'),
      constraint ai_lab_topic_claims_kind_check check (topic_kind in ('diary', 'evergreen')),
      constraint ai_lab_topic_claims_event_key_check check (
        (topic_kind = 'diary' and event_key ~ '^diary:[0-9]{8}-[a-z][a-z0-9]*(-[a-z0-9]+)*$' and char_length(event_key) <= 70)
        or (topic_kind = 'evergreen' and event_key ~ '^evergreen-[0-9]{1,2}$')
      ),
      constraint ai_lab_topic_claims_unit_key_check check (
        char_length(unit_key) <= 96
        and unit_key ~ '^[a-z0-9:#-]+$'
        and (unit_key = event_key or left(unit_key, char_length(event_key) + 1) = event_key || '#')
      ),
      constraint ai_lab_topic_claims_theme_tags_check check (
        cardinality(theme_tags) <= 7
        and theme_tags <@ array['no_code_day', 'research_only_day', 'rework_reduction', 'unglamorous_work',
                                'looks_no_progress', 'ai_trial_error', 'solo_dev_hard']::text[]
      ),
      constraint ai_lab_topic_claims_state_check check (
        state in ('claimed', 'provider_started', 'ambiguous', 'published', 'released', 'expired')
      ),
      constraint ai_lab_topic_claims_lease_check check (lease_until > claimed_at),
      constraint ai_lab_topic_claims_x_post_id_check check (x_post_id is null or x_post_id ~ '^[0-9]{1,32}$'),
      constraint ai_lab_topic_claims_published_check check (
        (state = 'published') = (x_post_id is not null) and (state = 'published') = (published_at is not null)
      ),
      constraint ai_lab_topic_claims_provider_check check (
        state not in ('provider_started', 'ambiguous', 'published') or provider_started_at is not null
      ),
      constraint ai_lab_topic_claims_reason_check check (outcome_reason is null or outcome_reason ~ '^[A-Z0-9_:]{1,64}$')
    )
  $ddl$, p_schema);
  -- 同じ日記イベントの有効な確保は全期間で1つだけ（投稿済み・結果不明も含む）。
  execute format($ddl$
    create unique index ai_lab_topic_claims_diary_event_active_uidx on %1$I.ai_lab_topic_claims (event_key)
    where topic_kind = 'diary' and state in ('claimed', 'provider_started', 'ambiguous', 'published')
  $ddl$, p_schema);
  -- 1つの scheduled post が同時に持てる有効な確保は1つだけ。
  execute format($ddl$
    create unique index ai_lab_topic_claims_schedule_active_uidx on %1$I.ai_lab_topic_claims (scheduled_post_id)
    where state in ('claimed', 'provider_started', 'ambiguous', 'published')
  $ddl$, p_schema);
  -- evergreen の隔離・クールダウン判定用。
  execute format($ddl$
    create index ai_lab_topic_claims_evergreen_idx on %1$I.ai_lab_topic_claims (event_key, state, published_at)
    where topic_kind = 'evergreen'
  $ddl$, p_schema);
  execute format('alter table %1$I.ai_lab_topic_claims enable row level security', p_schema);
end
$create$;

-- テーブルの「形」を正規化した文字列にする（スキーマ名は伏せる）。
create function pg_temp.ai_lab_topic_claims_shape(p_rel regclass) returns text
language sql stable as $shape$
  select concat_ws(E'\n',
    (select string_agg(format('col %s %s notnull=%s default=%s', a.attname, format_type(a.atttypid, a.atttypmod),
                              a.attnotnull, coalesce(pg_get_expr(d.adbin, d.adrelid), '-')), E'\n' order by a.attnum)
       from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = p_rel and a.attnum > 0 and not a.attisdropped),
    (select string_agg(format('con %s %s %s', c.conname, c.contype, pg_get_constraintdef(c.oid)), E'\n' order by c.conname)
       from pg_constraint c where c.conrelid = p_rel),
    -- Matching DDL alone can hide an invalid/not-ready concurrent index build.
    (select string_agg(format('idx %s valid=%s ready=%s live=%s %s', i.relname,
                              x.indisvalid, x.indisready, x.indislive,
                              regexp_replace(pg_get_indexdef(i.oid), ' ON [^ ]+\.ai_lab_topic_claims ', ' ON T ')),
                       E'\n' order by i.relname)
       from pg_index x join pg_class i on i.oid = x.indexrelid where x.indrelid = p_rel),
    (select format('rel kind=%s rls=%s force=%s', relkind, relrowsecurity, relforcerowsecurity) from pg_class where oid = p_rel),
    (select format('policies=%s', count(*)) from pg_policy where polrelid = p_rel),
    (select format('triggers=%s', count(*)) from pg_trigger where tgrelid = p_rel and not tgisinternal),
    (select format('column_acls=%s', count(*)) from pg_attribute where attrelid = p_rel and attnum > 0 and attacl is not null)
  )
$shape$;

do $table$
declare
  v_role text;
begin
  perform pg_temp.ai_lab_topic_claims_create('pg_temp');
  if pg_temp.ai_lab_topic_claims_shape('public.ai_lab_topic_claims'::regclass)
     is distinct from pg_temp.ai_lab_topic_claims_shape(to_regclass('pg_temp.ai_lab_topic_claims')) then
    raise exception 'AI_LAB_TOPIC_CLAIMS_SCHEMA_DRIFT: public.ai_lab_topic_claims differs from the canonical definition';
  end if;
  drop table pg_temp.ai_lab_topic_claims;
  if exists (
    select 1 from pg_catalog.pg_class c, pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
     where c.oid = 'public.ai_lab_topic_claims'::regclass and a.grantee <> c.relowner
  ) then
    raise exception 'AI_LAB_TOPIC_CLAIMS_PREFLIGHT: table grants beyond the owner exist';
  end if;
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if pg_catalog.has_table_privilege(v_role, 'public.ai_lab_topic_claims'::regclass,
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
         || case when pg_catalog.current_setting('server_version_num')::integer >= 170000 then ',MAINTAIN' else '' end)
       or pg_catalog.has_any_column_privilege(v_role, 'public.ai_lab_topic_claims'::regclass, 'SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'AI_LAB_TOPIC_CLAIMS_PREFLIGHT: % has an effective privilege on the table', v_role;
    end if;
  end loop;
end
$table$;

drop function pg_temp.ai_lab_topic_claims_shape(regclass);
drop function pg_temp.ai_lab_topic_claims_create(text);

-- 1d. 置き換えない4関数と claim 関数の中身（B3）: メタデータだけでなく、関数本体の文字列 prosrc（CREATE 時の
--     $$ と $$ の間がそのまま保存され、PostgreSQL のバージョンで変わらない）の md5 を、承認済みの値と比べる。
--     あわせて引数（名前・順序・型）、戻り値、言語、SECURITY DEFINER、search_path、volatility、STRICT、owner、
--     直接 ACL（owner と service_role の再付与なし EXECUTE 1件だけ）を確認する。claim は「容量修正前の本体」か
--     「この migration の本体」（再適用）のどちらかだけを受け付ける。期待値は Deno のテストが migration の
--     ソースから計算し直して一致を確認する。違えば中断し、4関数は書き換えない。
do $functions$
declare
  v_owner constant oid := (select relowner from pg_catalog.pg_class where oid = 'public.ai_lab_topic_claims'::regclass);
  e record;
begin
  for e in
    select * from (values
      ('start_ai_lab_topic_provider', 'p_claim_id uuid, p_scheduled_post_id uuid, p_event_key text', 'boolean', array['78e38a88ab63cb7856211cd9f709e5b0']),
      ('release_ai_lab_topic_claim', 'p_claim_id uuid, p_scheduled_post_id uuid, p_event_key text, p_reason text', 'text', array['d17f6946ba8e34e6ca3141ed4cb5eebc']),
      ('mark_ai_lab_topic_claim_ambiguous', 'p_claim_id uuid, p_scheduled_post_id uuid, p_event_key text, p_reason text', 'text', array['85c26cb92f430a7842b1b8b234fb9a78']),
      ('settle_ai_lab_topic_claim_published', 'p_claim_id uuid, p_scheduled_post_id uuid, p_event_key text, p_unit_key text, p_x_post_id text', 'text', array['2c9b82c6ea58c6b280c5d6079a2f012d']),
      ('claim_ai_lab_topic', 'p_scheduled_post_id uuid, p_candidates jsonb, p_lease_seconds integer', 'jsonb',
       array['a3cbe66723878b209a84bbd32b2bdc21', '9aefd06d1ab537fbc6bde527997dace7'])
    ) as expected(name, identity_args, return_type, body_md5)
  loop
    if (select count(*) from pg_catalog.pg_proc p
         where p.pronamespace = 'public'::regnamespace and p.proname = e.name) <> 1
       or not exists (
         select 1 from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang
          where p.pronamespace = 'public'::regnamespace and p.proname = e.name
            and pg_catalog.pg_get_function_identity_arguments(p.oid) = e.identity_args
            and p.prorettype = e.return_type::regtype and not p.proretset and p.prokind = 'f'
            and l.lanname = 'plpgsql' and p.prosecdef and p.proconfig = array['search_path=""']
            and p.provolatile = 'v' and not p.proisstrict and p.proowner = v_owner
            and pg_catalog.md5(p.prosrc) = any (e.body_md5)) then
      raise exception 'AI_LAB_TOPIC_CLAIMS_PREFLIGHT: % definition differs from the approved one', e.name;
    end if;
    if exists (
         select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
          where p.pronamespace = 'public'::regnamespace and p.proname = e.name and a.grantee <> p.proowner
            and not (a.grantee = 'service_role'::regrole and a.privilege_type = 'EXECUTE' and not a.is_grantable))
       or (select count(*) from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
            where p.pronamespace = 'public'::regnamespace and p.proname = e.name and a.grantee = 'service_role'::regrole) <> 1 then
      raise exception 'AI_LAB_TOPIC_CLAIMS_PREFLIGHT: % ACL differs from owner + service_role EXECUTE', e.name;
    end if;
  end loop;
end
$functions$;

-- 2. claim_ai_lab_topic を、対応表と候補数の上限だけ変えて置き換える（本体の他の部分は同一）。
create or replace function public.claim_ai_lab_topic(
  p_scheduled_post_id uuid,
  p_candidates jsonb,
  p_lease_seconds integer default 900
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- evergreen seed とテーマタグの正規の対応（TS の EVERGREEN_THEME_TAGS と同じ。テストで一致を確認）。
  -- 呼び出し側がタグを省略・偽装して48時間のテーマクールダウンを回避できないよう、DB 側の値だけを使う。
  c_evergreen_tags constant jsonb := '{
    "evergreen-0": ["unglamorous_work"],
    "evergreen-1": ["ai_trial_error"],
    "evergreen-2": [],
    "evergreen-3": [],
    "evergreen-4": [],
    "evergreen-5": ["rework_reduction", "unglamorous_work"],
    "evergreen-6": [],
    "evergreen-7": [],
    "evergreen-8": [],
    "evergreen-9": [],
    "evergreen-10": [],
    "evergreen-11": [],
    "evergreen-12": [],
    "evergreen-13": [],
    "evergreen-14": [],
    "evergreen-15": [],
    "evergreen-16": [],
    "evergreen-17": [],
    "evergreen-18": [],
    "evergreen-19": [],
    "evergreen-20": [],
    "evergreen-21": [],
    "evergreen-22": [],
    "evergreen-23": [],
    "evergreen-24": [],
    "evergreen-25": [],
    "evergreen-26": [],
    "evergreen-27": [],
    "evergreen-28": [],
    "evergreen-29": [],
    "evergreen-30": [],
    "evergreen-31": [],
    "evergreen-32": [],
    "evergreen-33": [],
    "evergreen-34": [],
    "evergreen-35": [],
    "evergreen-36": [],
    "evergreen-37": [],
    "evergreen-38": [],
    "evergreen-39": [],
    "evergreen-40": [],
    "evergreen-41": [],
    "evergreen-42": [],
    "evergreen-43": [],
    "evergreen-44": [],
    "evergreen-45": [],
    "evergreen-46": [],
    "evergreen-47": [],
    "evergreen-48": [],
    "evergreen-49": [],
    "evergreen-50": [],
    "evergreen-51": [],
    "evergreen-52": [],
    "evergreen-53": [],
    "evergreen-54": [],
    "evergreen-55": [],
    "evergreen-56": [],
    "evergreen-57": [],
    "evergreen-58": [],
    "evergreen-59": [],
    "evergreen-60": [],
    "evergreen-61": [],
    "evergreen-62": [],
    "evergreen-63": [],
    "evergreen-64": [],
    "evergreen-65": [],
    "evergreen-66": [],
    "evergreen-67": [],
    "evergreen-68": [],
    "evergreen-69": [],
    "evergreen-70": [],
    "evergreen-71": [],
    "evergreen-72": [],
    "evergreen-73": []
  }'::jsonb;
  v_candidate jsonb;
  v_kind text;
  v_key text;
  v_unit text;
  v_tags text[];
  v_seen text[] := '{}'::text[];
  v_state text;
  v_rejected jsonb := '[]'::jsonb;
  v_claim public.ai_lab_topic_claims%rowtype;
begin
  if p_scheduled_post_id is null
     or p_lease_seconds is null or p_lease_seconds < 60 or p_lease_seconds > 1800
     or p_candidates is null or jsonb_typeof(p_candidates) <> 'array' or jsonb_array_length(p_candidates) > 128 then
    raise exception 'AI_LAB_TOPIC_CLAIM_INVALID_ARGUMENT';
  end if;

  -- (a) 検証だけを先に全件。キーは厳密に4つ、型も固定。
  for v_candidate in select value from jsonb_array_elements(p_candidates) loop
    if jsonb_typeof(v_candidate) <> 'object'
       or (select array_agg(k order by k) from jsonb_object_keys(v_candidate) as k)
          is distinct from array['event_key', 'kind', 'theme_tags', 'unit_key']
       or jsonb_typeof(v_candidate -> 'kind') <> 'string'
       or jsonb_typeof(v_candidate -> 'event_key') <> 'string'
       or jsonb_typeof(v_candidate -> 'unit_key') <> 'string'
       or jsonb_typeof(v_candidate -> 'theme_tags') <> 'array' then
      raise exception 'AI_LAB_TOPIC_CLAIM_INVALID_ARGUMENT';
    end if;
    v_kind := v_candidate ->> 'kind';
    v_key := v_candidate ->> 'event_key';
    v_unit := v_candidate ->> 'unit_key';
    if v_key = any (v_seen) then
      raise exception 'AI_LAB_TOPIC_CLAIM_INVALID_ARGUMENT';
    end if;
    v_seen := v_seen || v_key;
    if v_kind = 'evergreen' then
      -- 正規の seed だけ。切り口キーはイベントキーと同じ。テーマタグは正規の対応と完全一致（順不同）。
      if not (c_evergreen_tags ? v_key)
         or v_unit <> v_key
         or (select coalesce(jsonb_agg(t order by t), '[]'::jsonb) from jsonb_array_elements(v_candidate -> 'theme_tags') as t)
            is distinct from
            (select coalesce(jsonb_agg(t order by t), '[]'::jsonb) from jsonb_array_elements(c_evergreen_tags -> v_key) as t) then
        raise exception 'AI_LAB_TOPIC_CLAIM_INVALID_ARGUMENT';
      end if;
    elsif v_kind = 'diary' then
      -- イベントキーは diary:<event_id>、切り口キーは <イベントキー>#(changed|difficulty|decided|angleN)、タグは無し。
      -- v_key は先に形を確認しているので、正規表現へそのまま連結しても特殊文字は含まれない。
      if char_length(v_key) > 70
         or v_key !~ '^diary:[0-9]{8}-[a-z][a-z0-9]*(-[a-z0-9]+)*$'
         or v_unit !~ ('^' || v_key || '#(changed|difficulty|decided|angle[1-9][0-9]?)$')
         or jsonb_array_length(v_candidate -> 'theme_tags') <> 0 then
        raise exception 'AI_LAB_TOPIC_CLAIM_INVALID_ARGUMENT';
      end if;
    else
      raise exception 'AI_LAB_TOPIC_CLAIM_INVALID_ARGUMENT';
    end if;
  end loop;

  perform pg_advisory_xact_lock(hashtextextended('ai_lab_topic_claims:ai_salaryman_lab', 0));

  -- lease 切れの claimed は X に触れていない（X の前に provider_started をコミットする）ので解除する。
  update public.ai_lab_topic_claims
     set state = 'expired', settled_at = now(), outcome_reason = 'LEASE_EXPIRED'
   where state = 'claimed' and lease_until <= now();

  select state into v_state
    from public.ai_lab_topic_claims
   where scheduled_post_id = p_scheduled_post_id
     and state in ('claimed', 'provider_started', 'ambiguous', 'published')
   limit 1;
  if found then
    return jsonb_build_object('claim', null, 'conflict', 'SCHEDULE_ALREADY_CLAIMED:' || upper(v_state), 'rejected', '[]'::jsonb);
  end if;

  -- (b) 確保。検証済みなので、ここでの失敗は確保の可否だけ。
  for v_candidate in select value from jsonb_array_elements(p_candidates) loop
    v_kind := v_candidate ->> 'kind';
    v_key := v_candidate ->> 'event_key';
    v_unit := v_candidate ->> 'unit_key';
    v_tags := '{}'::text[];

    if v_kind = 'diary' then
      select state into v_state
        from public.ai_lab_topic_claims
       where topic_kind = 'diary' and event_key = v_key
         and state in ('claimed', 'provider_started', 'ambiguous', 'published')
       limit 1;
      if found then
        v_rejected := v_rejected || jsonb_build_object('event_key', v_key, 'reason', 'EVENT_' || upper(v_state));
        continue;
      end if;
    else
      select coalesce(array_agg(tag order by tag), '{}'::text[]) into v_tags
        from jsonb_array_elements_text(c_evergreen_tags -> v_key) as tag;
      -- 未解決（確保中・送信開始・結果不明）の同じ seed は、時間に関係なく隔離。
      select state into v_state
        from public.ai_lab_topic_claims
       where topic_kind = 'evergreen' and event_key = v_key
         and state in ('claimed', 'provider_started', 'ambiguous')
       limit 1;
      if found then
        v_rejected := v_rejected || jsonb_build_object('event_key', v_key, 'reason', 'EVERGREEN_SEED_' || upper(v_state));
        continue;
      end if;
      if exists (
        select 1 from public.ai_lab_topic_claims
         where topic_kind = 'evergreen' and event_key = v_key and state = 'published'
           and published_at > now() - interval '72 hours'
      ) then
        v_rejected := v_rejected || jsonb_build_object('event_key', v_key, 'reason', 'EVERGREEN_SEED_COOLDOWN');
        continue;
      end if;
      if cardinality(v_tags) > 0 then
        if exists (
          select 1 from public.ai_lab_topic_claims
           where topic_kind = 'evergreen' and theme_tags && v_tags
             and state in ('claimed', 'provider_started', 'ambiguous')
        ) then
          v_rejected := v_rejected || jsonb_build_object('event_key', v_key, 'reason', 'EVERGREEN_THEME_UNRESOLVED');
          continue;
        end if;
        if exists (
          select 1 from public.ai_lab_topic_claims
           where topic_kind = 'evergreen' and theme_tags && v_tags and state = 'published'
             and published_at > now() - interval '48 hours'
        ) then
          v_rejected := v_rejected || jsonb_build_object('event_key', v_key, 'reason', 'EVERGREEN_THEME_COOLDOWN');
          continue;
        end if;
      end if;
    end if;

    insert into public.ai_lab_topic_claims (scheduled_post_id, topic_kind, event_key, unit_key, theme_tags, state, lease_until)
    values (p_scheduled_post_id, v_kind, v_key, v_unit, v_tags, 'claimed', now() + make_interval(secs => p_lease_seconds))
    returning * into v_claim;

    return jsonb_build_object(
      'claim', jsonb_build_object(
        'claim_id', v_claim.claim_id,
        'kind', v_claim.topic_kind,
        'event_key', v_claim.event_key,
        'unit_key', v_claim.unit_key,
        'lease_until', v_claim.lease_until
      ),
      'rejected', v_rejected
    );
  end loop;

  return jsonb_build_object('claim', null, 'rejected', v_rejected);
end;
$$;

revoke all on function public.claim_ai_lab_topic(uuid, jsonb, integer) from public, anon, authenticated;
grant execute on function public.claim_ai_lab_topic(uuid, jsonb, integer) to service_role;

-- 3. 事後条件: owner 方針と、API ロールから見た「実効」権限（継承・PUBLIC・列権限を含む）を検証する。
--    1つでも外れれば中断（トランザクションごと取り消し）。ロール構成はここでも変更しない。
do $acl$
declare
  v_table constant regclass := 'public.ai_lab_topic_claims'::regclass;
  v_functions constant text[] := array[
    'public.claim_ai_lab_topic(uuid,jsonb,integer)',
    'public.start_ai_lab_topic_provider(uuid,uuid,text)',
    'public.release_ai_lab_topic_claim(uuid,uuid,text,text)',
    'public.mark_ai_lab_topic_claim_ambiguous(uuid,uuid,text,text)',
    'public.settle_ai_lab_topic_claim_published(uuid,uuid,text,text,text)'
  ];
  v_api_roles constant text[] := array['anon', 'authenticated', 'service_role'];
  v_privileges text[] := array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  v_role text;
  v_privilege text;
  v_function text;
begin
  if current_setting('server_version_num')::integer >= 170000 then
    v_privileges := array_append(v_privileges, 'MAINTAIN');
  end if;

  -- owner: テーブルと5関数がすべてこの migration の実行ロールのもの。
  if pg_get_userbyid((select relowner from pg_class where oid = v_table)) <> current_user then
    raise exception 'AI_LAB_TOPIC_CLAIMS_ACL: table owner is not %', current_user;
  end if;
  foreach v_function in array v_functions loop
    if pg_get_userbyid((select proowner from pg_proc where oid = v_function::regprocedure)) <> current_user then
      raise exception 'AI_LAB_TOPIC_CLAIMS_ACL: % owner is not %', v_function, current_user;
    end if;
  end loop;

  foreach v_role in array v_api_roles loop
    if not exists (select 1 from pg_roles where rolname = v_role) then
      continue;
    end if;
    -- API ロールが owner のメンバー（継承・SET ROLE）なら、owner の全権限が漏れる。
    if pg_has_role(v_role, current_user, 'MEMBER') then
      raise exception 'AI_LAB_TOPIC_CLAIMS_ACL: % is a member of the owner role', v_role;
    end if;
    -- テーブルへの実効権限は一切なし（列単位も含む）。
    foreach v_privilege in array v_privileges loop
      if has_table_privilege(v_role, v_table, v_privilege) then
        raise exception 'AI_LAB_TOPIC_CLAIMS_ACL: % has effective % on the table', v_role, v_privilege;
      end if;
    end loop;
    if has_any_column_privilege(v_role, v_table, 'SELECT') or has_any_column_privilege(v_role, v_table, 'INSERT')
       or has_any_column_privilege(v_role, v_table, 'UPDATE') or has_any_column_privilege(v_role, v_table, 'REFERENCES') then
      raise exception 'AI_LAB_TOPIC_CLAIMS_ACL: % has effective column privileges on the table', v_role;
    end if;
    -- 関数: service_role だけが EXECUTE できる。
    foreach v_function in array v_functions loop
      if has_function_privilege(v_role, v_function::regprocedure, 'EXECUTE') <> (v_role = 'service_role') then
        raise exception 'AI_LAB_TOPIC_CLAIMS_ACL: unexpected EXECUTE state of % for %', v_function, v_role;
      end if;
    end loop;
  end loop;

  -- 明示 ACL にも owner / service_role 以外（PUBLIC を含む）が載っていないこと。
  if exists (
    select 1 from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
     where c.oid = v_table and a.grantee <> c.relowner
  ) or exists (
    select 1 from pg_attribute where attrelid = v_table and attnum > 0 and attacl is not null
  ) then
    raise exception 'AI_LAB_TOPIC_CLAIMS_ACL: table grants beyond the owner remain';
  end if;
  if exists (
    select 1
      from unnest(v_functions) as f(signature)
      join pg_proc p on p.oid = f.signature::regprocedure,
      lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     where a.grantee not in (p.proowner, 'service_role'::regrole)
  ) then
    raise exception 'AI_LAB_TOPIC_CLAIMS_ACL: function EXECUTE granted beyond owner/service_role';
  end if;
  if (
    select count(*)
      from unnest(v_functions) as f(signature)
      join pg_proc p on p.oid = f.signature::regprocedure
     where p.prosecdef and p.proconfig = array['search_path=""']
  ) <> 5 then
    raise exception 'AI_LAB_TOPIC_CLAIMS_ACL: functions are not exactly the five security-definer entry points';
  end if;
end
$acl$;


-- 4. 置き換え後の claim 関数の本体が、この migration の本体と完全に一致すること。
do $claim$
begin
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
       where p.oid = 'public.claim_ai_lab_topic(uuid,jsonb,integer)'::regprocedure)
     is distinct from '9aefd06d1ab537fbc6bde527997dace7' then
    raise exception 'AI_LAB_TOPIC_CLAIMS_ACL: claim_ai_lab_topic body is not the approved capacity definition';
  end if;
end
$claim$;

commit;
