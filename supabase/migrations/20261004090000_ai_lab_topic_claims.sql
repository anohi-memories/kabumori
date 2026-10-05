-- 会社員AIラボ（ai_salaryman_lab）専用: 題材イベントの「X送信前の確保（claim）」と、その後の決着の記録。
--
-- 目的: 同じ開発日記イベントを、切り口（changed / difficulty / decided / angle）だけ変えて何度も投稿しない。
-- 並行実行・DB失敗・プロセス停止まで含めて、同じイベントが2回 X に届く経路を作らない。
--
-- ライフサイクル（1行 = 1回の確保。claim_id がフェンシングトークン）:
--   claimed           X 送信前の確保。lease_until まで有効。生成・内容ガード等の X 前の失敗では released へ戻せる。
--                     lease が切れた claimed は、次の claim 呼び出しが expired にする（X は provider_started を
--                     コミットしてからでないと呼ばないので、claimed のまま止まった処理は X に触れていない）。
--   provider_started  X へ送る直前にコミットする。以後は「投稿されていない」と証明できないので、自動では
--                     再開放しない（送信の内側で「X が投稿を作らなかった」と観測できた場合だけ released に戻せる）。
--   ambiguous         X の結果が不明（タイムアウト・通信断・応答喪失）。再開放しない。
--   published         X の post id を確認済み（published_at に確定時刻）。以後の題材選定の正本。
--   released/expired  確保の解除。X には届いていない。
--
-- 日記イベント（diary:<event_id>）は、claimed/provider_started/ambiguous/published の行が1つでもあれば二度と
-- 確保できない（部分 UNIQUE + ブランド単位の advisory lock）。evergreen（evergreen-N）は再利用するが、
--   - claimed（lease 内）/ provider_started / ambiguous の seed は、時間に関係なく隔離（自動では再確保しない）。
--     同じ汎用テーマタグを持つ seed も同様に止める（投稿された可能性がある未解決状態のため）。
--   - published の seed は、確定時刻（published_at）から同じ seed は72時間、同じテーマタグは48時間あける。
-- 全候補が使えなければ確保なし（その枠は投稿しない。クールダウンや隔離を破って埋めない）。
-- 候補 JSON は DB 側の正規の形（キー・evergreen のテーマタグ対応・日記の切り口キー）で丸ごと検証してから処理する。
--
-- 長い DB トランザクションは X をまたいで保持しない: 各関数は短い1トランザクションで終わる。
--
-- 権限: テーブルには誰にも直接権限を与えない（RLS 有効・ポリシーなし）。service_role は下の5関数の EXECUTE のみ。
-- owner 方針: テーブルと5関数の owner は、この migration を実行するロール（Supabase では postgres）でなければならず、
-- そのロールは API ロール（anon / authenticated / service_role）自身であってはならず、API ロールがそのロールの
-- メンバー（継承や SET ROLE で owner 権限を得られる状態）であってもならない。違えば中断する（ロール構成は変更しない）。
-- 既存の published_content_fingerprints / complete_ai_salaryman_lab_brand_post / scheduled_posts / 他ブランドは
-- 変更しない。scheduled_posts への外部キーは張らない（他ワークストリームの削除処理を巻き込まない）。
--
-- 再適用: テーブルが既にあれば、同じ定義を一時スキーマに作って列・制約・インデックス・RLS・ポリシー・トリガーを
-- 比較し、少しでも違えば中断する（未知のドリフトを黙って受け入れない）。関数は create or replace で正の定義に戻し、
-- 想定外のオーバーロードがあれば中断する。最後に ACL の実効値を検証する。

begin;

-- 1. Preflight: 置き換え前の候補（PR #82 初版の ai_lab_topic_event_usage）や想定外のオーバーロードがあれば中断。
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
end
$preflight$;

-- 2. テーブル定義（正本）。同じ定義を pg_temp にも作れるよう、スキーマを引数に取る。
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
    (select string_agg(format('idx %s %s', i.relname,
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
begin
  if to_regclass('public.ai_lab_topic_claims') is null then
    perform pg_temp.ai_lab_topic_claims_create('public');
  else
    perform pg_temp.ai_lab_topic_claims_create('pg_temp');
    if pg_temp.ai_lab_topic_claims_shape('public.ai_lab_topic_claims'::regclass)
       is distinct from pg_temp.ai_lab_topic_claims_shape(to_regclass('pg_temp.ai_lab_topic_claims')) then
      raise exception 'AI_LAB_TOPIC_CLAIMS_SCHEMA_DRIFT: existing public.ai_lab_topic_claims differs from the expected definition';
    end if;
    drop table pg_temp.ai_lab_topic_claims;
  end if;
end
$table$;

drop function pg_temp.ai_lab_topic_claims_shape(regclass);
drop function pg_temp.ai_lab_topic_claims_create(text);

comment on table public.ai_lab_topic_claims is
  'AI Lab only: pre-X claims of topic events (no post text). claim_id is the fencing token. Diary events are claimable once; evergreen seeds have 72h seed / 48h theme cooldowns.';

-- 3. 確保: 優先順の候補を先頭から試し、最初に確保できた1件を返す（ブランド単位のロックで直列化）。
--    候補は先に全件を正規の形で検証し、1件でも不正なら何もせずに中断する（途中までの副作用を作らない）。
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
    "evergreen-6": []
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
     or p_candidates is null or jsonb_typeof(p_candidates) <> 'array' or jsonb_array_length(p_candidates) > 64 then
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

-- 4. X へ送る直前の確定。lease 内の自分の claimed だけを provider_started にする。false なら X へ進まない。
create or replace function public.start_ai_lab_topic_provider(
  p_claim_id uuid,
  p_scheduled_post_id uuid,
  p_event_key text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.ai_lab_topic_claims
     set state = 'provider_started', provider_started_at = now()
   where claim_id = p_claim_id
     and scheduled_post_id = p_scheduled_post_id
     and event_key = p_event_key
     and state = 'claimed'
     and lease_until > now();
  return found;
end;
$$;

-- 5. 解除。X 前（claimed）は理由を問わず解除できる。provider_started は、送信の内側で「X が投稿を作らなかった」と
--    観測できた場合（PROVIDER_NO_POST:<evidence>、ai_lab_provider_outcome.ts）だけ。
--    それ以外（結果不明・投稿済み・別の claim）は変更せず、現在の状態を返す。
create or replace function public.release_ai_lab_topic_claim(
  p_claim_id uuid,
  p_scheduled_post_id uuid,
  p_event_key text,
  p_reason text
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text;
begin
  if p_reason is null or p_reason !~ '^[A-Z0-9_:]{1,64}$' then
    raise exception 'AI_LAB_TOPIC_CLAIM_INVALID_ARGUMENT';
  end if;
  update public.ai_lab_topic_claims
     set state = 'released', settled_at = now(), outcome_reason = p_reason
   where claim_id = p_claim_id
     and scheduled_post_id = p_scheduled_post_id
     and event_key = p_event_key
     and (state = 'claimed'
          or (state = 'provider_started'
              and p_reason ~ '^PROVIDER_NO_POST:(NOT_SENT|HTTP_400|HTTP_401|HTTP_422|HTTP_429)$'));
  if found then
    return 'RELEASED';
  end if;
  select upper(state) into v_state
    from public.ai_lab_topic_claims
   where claim_id = p_claim_id and scheduled_post_id = p_scheduled_post_id and event_key = p_event_key;
  return coalesce(v_state, 'NOT_FOUND');
end;
$$;

-- 6. X の結果不明を記録（provider_started → ambiguous）。再開放はしない。
create or replace function public.mark_ai_lab_topic_claim_ambiguous(
  p_claim_id uuid,
  p_scheduled_post_id uuid,
  p_event_key text,
  p_reason text
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text;
begin
  if p_reason is null or p_reason !~ '^[A-Z0-9_:]{1,64}$' then
    raise exception 'AI_LAB_TOPIC_CLAIM_INVALID_ARGUMENT';
  end if;
  update public.ai_lab_topic_claims
     set state = 'ambiguous', settled_at = now(), outcome_reason = p_reason
   where claim_id = p_claim_id
     and scheduled_post_id = p_scheduled_post_id
     and event_key = p_event_key
     and state = 'provider_started';
  if found then
    return 'AMBIGUOUS';
  end if;
  select upper(state) into v_state
    from public.ai_lab_topic_claims
   where claim_id = p_claim_id and scheduled_post_id = p_scheduled_post_id and event_key = p_event_key;
  return coalesce(v_state, 'NOT_FOUND');
end;
$$;

-- 7. X 成功の確定。同じ claim・同じ X post id の再送は IDEMPOTENT。別の X post id や別のイベント/切り口は
--    明示的なエラー。X に触れていないはずの状態（claimed/released/expired）もエラー。
create or replace function public.settle_ai_lab_topic_claim_published(
  p_claim_id uuid,
  p_scheduled_post_id uuid,
  p_event_key text,
  p_unit_key text,
  p_x_post_id text
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim public.ai_lab_topic_claims%rowtype;
begin
  select * into v_claim from public.ai_lab_topic_claims where claim_id = p_claim_id for update;
  if not found then
    raise exception 'AI_LAB_TOPIC_CLAIM_NOT_FOUND';
  end if;
  if v_claim.scheduled_post_id is distinct from p_scheduled_post_id
     or v_claim.event_key is distinct from p_event_key
     or v_claim.unit_key is distinct from p_unit_key then
    raise exception 'AI_LAB_TOPIC_CLAIM_IDENTITY_CONFLICT';
  end if;
  if v_claim.state = 'published' then
    if v_claim.x_post_id = p_x_post_id then
      return 'IDEMPOTENT';
    end if;
    raise exception 'AI_LAB_TOPIC_CLAIM_X_POST_CONFLICT';
  end if;
  if v_claim.state not in ('provider_started', 'ambiguous') then
    raise exception 'AI_LAB_TOPIC_CLAIM_STATE_CONFLICT';
  end if;
  update public.ai_lab_topic_claims
     set state = 'published', x_post_id = p_x_post_id, settled_at = now(), published_at = now(), outcome_reason = null
   where claim_id = p_claim_id;
  return 'PUBLISHED';
end;
$$;

-- 8. 権限: テーブルは誰にも直接開けない。関数は service_role の EXECUTE のみ。
revoke all on table public.ai_lab_topic_claims from public, anon, authenticated, service_role;
revoke all on function public.claim_ai_lab_topic(uuid, jsonb, integer) from public, anon, authenticated;
revoke all on function public.start_ai_lab_topic_provider(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.release_ai_lab_topic_claim(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.mark_ai_lab_topic_claim_ambiguous(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.settle_ai_lab_topic_claim_published(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_ai_lab_topic(uuid, jsonb, integer) to service_role;
grant execute on function public.start_ai_lab_topic_provider(uuid, uuid, text) to service_role;
grant execute on function public.release_ai_lab_topic_claim(uuid, uuid, text, text) to service_role;
grant execute on function public.mark_ai_lab_topic_claim_ambiguous(uuid, uuid, text, text) to service_role;
grant execute on function public.settle_ai_lab_topic_claim_published(uuid, uuid, text, text, text) to service_role;

-- 9. 事後条件: owner 方針と、API ロールから見た「実効」権限（継承・PUBLIC・列権限を含む）を検証する。
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

commit;
