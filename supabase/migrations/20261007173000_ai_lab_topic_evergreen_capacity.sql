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
  -- evergreen のキーは evergreen-0〜evergreen-99（テーブルの CHECK）。74件はこの範囲に収まる。
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.ai_lab_topic_claims'::regclass and conname = 'ai_lab_topic_claims_event_key_check'
       and pg_get_constraintdef(oid) like '%evergreen-[0-9]{1,2}%'
  ) then
    raise exception 'AI_LAB_TOPIC_CLAIMS_PREFLIGHT: unexpected event_key constraint';
  end if;
end
$preflight$;

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

commit;
