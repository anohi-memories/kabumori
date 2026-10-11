#!/usr/bin/env bash
# 20261012100000_market_report_broadcast_push_v1（未適用の候補）の、使い捨ての手元の PostgreSQL での検証。
# Supabase には一切つながない。ホストは /tmp の下のソケットだけを受け付ける。合成の利用者だけを使う。
#
#   BC_PGHOST=/tmp/<socket dir> BC_PGPORT=<port> BC_PGSUPER=<手元の superuser> bash supabase/tests/market_report_broadcast_run.sh
#
# 1. 事前確認: 土台・PR143 の migration が無いデータベースでは何も作らずに止まる
# 2. 追加だけ: 既存の表・関数・権限・方針は1つも変わらない。取り消すと完全に元どおり。二重の適用は止まる
# 3. 動作（market_report_broadcast_behavior.sql）
# 4. 2つの接続での同時実行（分割・引き取り・送る直前・送ったあとと期限切れの引き取り直し）
# 5. 規模: 1万人・10万人（market_report_broadcast_scale.sql。手元の PostgreSQL での実測の時間を出す）
# 6. 変異テスト: 守りを1つずつ外した候補では、3 か 4 が必ず失敗する
set -euo pipefail
export LC_ALL=C
export PGOPTIONS='-c client_min_messages=warning'

host="${BC_PGHOST:?BC_PGHOST（/tmp の下のソケットのディレクトリ）が必要}"
port="${BC_PGPORT:?BC_PGPORT が必要}"
super="${BC_PGSUPER:?BC_PGSUPER が必要}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "拒否: BC_PGHOST は /tmp の下のソケットのディレクトリだけ" >&2; exit 2 ;; esac

here="$(cd "$(dirname "$0")" && pwd)"
migrations="$here/../migrations"
candidate_src="$migrations/20261012100000_market_report_broadcast_push_v1.sql"
owner="kb_bc_owner"
work="$(mktemp -d "${TMPDIR:-/tmp}/kb_bc.XXXXXX")"
DBS=()
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  for db in ${DBS[@]+"${DBS[@]}"}; do "${S[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true; done
  rm -rf "$work"
}
trap cleanup EXIT

"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = '$owner') then create role $owner login nosuperuser nocreatedb nocreaterole; end if;
end \$\$;
grant anon, authenticated, service_role to $owner;
SQL

# 新しいデータベース。level: 0 = auth の代わりだけ、1 = 既存の土台まで、2 = PR143 の migration まで。
new_db() {
  local db="kb_bc_$$_$1"
  DBS+=("$db")
  "${S[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null
  "${S[@]}" -d postgres -c "create database $db owner $owner" >/dev/null
  local O=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
  "${O[@]}" -f "$here/personalized_ondemand_analysis_fixture.sql" >/dev/null
  if [[ "$2" -ge 1 ]]; then
    "${O[@]}" -f "$migrations/20260901061217_add_kabumori_mvp_tables.sql" >/dev/null 2>&1
    "${O[@]}" -f "$migrations/20260903160000_add_device_push_tokens.sql" >/dev/null 2>&1
    "${O[@]}" -f "$migrations/20260911230000_personalized_reports.sql" >/dev/null 2>&1
    "${O[@]}" -f "$migrations/20260919100000_market_report_data_packets_phase1.sql" >/dev/null
    "${O[@]}" -f "$migrations/20260920100000_market_report_packets_phase2.sql" >/dev/null
  fi
  if [[ "$2" -ge 2 ]]; then
    "${O[@]}" -f "$migrations/20261011150000_personalized_ondemand_analysis_v1.sql" >/dev/null
  fi
  echo "$db"
}
O_() { psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$@"; }
Q_() { psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$@"; }

catalog() {
  Q_ "$1" <<'SQL'
select 'fn ' || p.oid::regprocedure::text || ' ' || md5(pg_get_functiondef(p.oid)) || ' ' || coalesce(array_to_string(p.proacl::text[], ','), '-')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'auth') and p.prokind = 'f'
union all
select 'rel ' || c.oid::regclass::text || ' ' || c.relkind::text || ' ' || c.relrowsecurity || ' ' || coalesce(array_to_string(c.relacl::text[], ','), '-')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'auth')
union all
select 'col ' || a.attrelid::regclass::text || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || coalesce(array_to_string(a.attacl::text[], ','), '-')
  from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r', 'p', 'v') and a.attnum > 0 and not a.attisdropped
union all
select 'con ' || conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) from pg_constraint where conrelid <> 0
union all
select 'pol ' || polrelid::regclass::text || ' ' || polname || ' ' || coalesce(pg_get_expr(polqual, polrelid), '-') from pg_policy
union all
select 'trg ' || tgrelid::regclass::text || ' ' || tgname || ' ' || tgenabled::text from pg_trigger where not tgisinternal
order by 1;
SQL
}

# ---------------------------------------------------------------------------
# 1. 事前確認
# ---------------------------------------------------------------------------
for level in 0 1; do
  db="$(new_db "pre$level" "$level")"
  if out="$(O_ "$db" -f "$candidate_src" 2>&1)"; then echo "FAIL 事前確認（level $level）で止まらなかった" >&2; exit 1; fi
  want=$([[ $level == 0 ]] && echo FOUNDATION_MISSING || echo ONDEMAND_V1_MISSING)
  grep -q "MARKET_REPORT_BROADCAST_PREFLIGHT_$want" <<<"$out" || { echo "FAIL 事前確認の理由（level $level）: $out" >&2; exit 1; }
  [[ "$(Q_ "$db" -c "select coalesce(to_regclass('public.market_report_broadcasts')::text, 'absent')")" == absent ]] \
    || { echo "FAIL 事前確認で止まったのに表が残った" >&2; exit 1; }
done
echo "MARKET_REPORT_BROADCAST_PREFLIGHT_PASS"

# ---------------------------------------------------------------------------
# 2. 追加だけ・取り消し・二重の適用
# ---------------------------------------------------------------------------
main="$(new_db main 2)"
catalog "$main" > "$work/before"
O_ "$main" -f "$candidate_src" >/dev/null
catalog "$main" > "$work/after"
removed="$(comm -23 "$work/before" "$work/after")"
[[ -z "$removed" ]] || { echo "FAIL 既存の定義が変わった: $removed" >&2; exit 1; }
added_rel="$(comm -13 "$work/before" "$work/after" | grep '^rel ' | awk '{print $2}' | sort | tr '\n' ' ')"
want_rel="market_report_broadcast_chunks market_report_broadcast_chunks_leases market_report_broadcast_chunks_no market_report_broadcast_chunks_open market_report_broadcast_chunks_pkey market_report_broadcast_chunks_queue market_report_broadcast_deliveries market_report_broadcast_deliveries_chunk market_report_broadcast_deliveries_pkey market_report_broadcast_settings market_report_broadcast_settings_pkey market_report_broadcasts market_report_broadcasts_once market_report_broadcasts_packet_once market_report_broadcasts_pkey "
[[ "$added_rel" == "$want_rel" ]] || { echo "FAIL 追加された表・索引が想定と違う: $added_rel" >&2; exit 1; }
added_fn="$(comm -13 "$work/before" "$work/after" | grep '^fn ' | awk '{print $2}' | sort | tr '\n' ' ')"
want_fn="begin_market_report_broadcast_chunk(uuid,uuid,bigint) claim_market_report_broadcast_chunks(integer) enqueue_market_report_broadcasts() finish_market_report_broadcast_chunk(uuid,uuid,bigint,jsonb,text) market_report_broadcast_eligible(uuid,text) plan_market_report_broadcast(uuid) purge_market_report_broadcasts(integer) "
[[ "$added_fn" == "$want_fn" ]] || { echo "FAIL 追加された関数が想定と違う: $added_fn" >&2; exit 1; }
other="$(comm -13 "$work/before" "$work/after" | grep -E '^(col|con|pol|trg) ' | grep -vE '^(col|con|pol|trg) (public\.)?market_report_broadcast(s|_settings|_chunks|_deliveries)[ .]' || true)"
[[ -z "$other" ]] || { echo "FAIL 既存の表に列・制約・方針が増えた: $other" >&2; exit 1; }
echo "MARKET_REPORT_BROADCAST_ADDITIVE_PASS"

undo="$(new_db undo 2)"
catalog "$undo" > "$work/undo_before"
O_ "$undo" -f "$candidate_src" >/dev/null
O_ "$undo" -f "$here/market_report_broadcast_rollback.sql" >/dev/null
catalog "$undo" > "$work/undo_after"
diff -q "$work/undo_before" "$work/undo_after" >/dev/null || { echo "FAIL 取り消しのあとの定義が違う" >&2; diff "$work/undo_before" "$work/undo_after" >&2; exit 1; }
echo "MARKET_REPORT_BROADCAST_ROLLBACK_PASS"

if out="$(O_ "$main" -f "$candidate_src" 2>&1)"; then echo "FAIL 二重の適用が通った" >&2; exit 1; fi
grep -q 'MARKET_REPORT_BROADCAST_ALREADY_APPLIED' <<<"$out" || { echo "FAIL 二重の適用の理由: $out" >&2; exit 1; }
echo "MARKET_REPORT_BROADCAST_REAPPLY_REFUSED_PASS"

# ---------------------------------------------------------------------------
# 3. 動作
# ---------------------------------------------------------------------------
behavior() {
  Q_ "$1" -f "$here/market_report_broadcast_behavior.sql" 2>"$work/behavior.err" | grep -qx 'MARKET_REPORT_BROADCAST_BEHAVIOR_PASS'
}
behavior "$main" || { echo "FAIL 動作" >&2; cat "$work/behavior.err" >&2; exit 1; }
echo "MARKET_REPORT_BROADCAST_BEHAVIOR_PASS"

# ---------------------------------------------------------------------------
# 4. 同時実行（2つの接続。片方は呼び出しのあと pg_sleep で取引を開いたままにする）
# ---------------------------------------------------------------------------
races() {
  local db="$1"
  Q_ "$db" >/dev/null <<'SQL'
delete from public.market_report_broadcasts;
update public.market_report_broadcast_settings
   set enabled = true, sending_enabled = true, pilot_user_ids = null, chunk_size = 50, plan_chunks_per_call = 2, max_parallel_chunks = 1,
       max_chunk_attempts = 3, max_report_age_minutes = 720;
update public.personalized_ondemand_settings set public_market_feed_enabled = true, ondemand_requests_enabled = true;
insert into auth.users (id) select ('00000000-0000-4000-a000-' || lpad(g::text, 12, '0'))::uuid from generate_series(1, 400) g;
insert into public.profiles (id) select id from auth.users where id::text like '00000000-0000-4000-a000-%';
insert into public.alert_settings (user_id, push_enabled, morning_report, close_report)
  select id, true, true, true from auth.users where id::text like '00000000-0000-4000-a000-%';
insert into public.device_push_tokens (user_id, expo_push_token, platform)
  select id, 'ExponentPushToken[r' || id || ']', 'ios' from auth.users where id::text like '00000000-0000-4000-a000-%';
update public.market_report_cycles set report_completed_at = now()
 where trading_date = (now() at time zone 'Asia/Tokyo')::date and report_status = 'completed';
SQL
  Q_ "$db" -c "begin; set local role service_role; select public.enqueue_market_report_broadcasts(); commit;" >/dev/null
  local b; b="$(Q_ "$db" -c "select id from public.market_report_broadcasts where report_type = 'morning' limit 1")"
  [[ -n "$b" ]] || { echo "FAIL 4 一斉通知が作られない" >&2; return 1; }
  # 4a. 2つの分割が同時: 片方が行をつかんだまま → もう片方は待ち、続きの位置から進める（番号の重複・隙間なし）。
  ( Q_ "$db" -c "begin; set local role service_role; select public.plan_market_report_broadcast('$b'); reset role; select pg_sleep(1.2); commit;" >/dev/null ) &
  sleep 0.3
  Q_ "$db" -c "begin; set local role service_role; select public.plan_market_report_broadcast('$b'); commit;" >/dev/null
  wait
  [[ "$(Q_ "$db" -c "select count(*) || '/' || count(distinct chunk_no) || '/' || max(chunk_no) from public.market_report_broadcast_chunks where broadcast_id = '$b'")" == "4/4/4" ]] \
    || { echo "FAIL 4a 同時の分割" >&2; return 1; }
  [[ "$(Q_ "$db" -c "select count(*) from public.market_report_broadcast_chunks c join public.market_report_broadcast_chunks p on p.broadcast_id = c.broadcast_id and p.chunk_no = c.chunk_no - 1 where c.broadcast_id = '$b' and c.user_after is distinct from p.user_to")" == 0 ]] \
    || { echo "FAIL 4a 区切りに隙間" >&2; return 1; }
  # 4b. 同時の引き取り（上限1）: 片方が取引を開いたまま → もう片方は待って、上限に達しているので何も取らない。
  ( Q_ "$db" -c "begin; set local role service_role; select count(*) from public.claim_market_report_broadcast_chunks(4); reset role; select pg_sleep(1.2); commit;" >/dev/null ) &
  sleep 0.3
  local got
  got="$(Q_ "$db" -c "begin; set local role service_role; select count(*) from public.claim_market_report_broadcast_chunks(4); commit;" | grep -v '^$' | tail -1)"
  wait
  [[ "$got" == 0 ]] || { echo "FAIL 4b 上限を超えて引き取った: $got" >&2; return 1; }
  # 4c. 送る直前 と 期限切れの引き取り直しの競合: begin が行をつかんでいる間に期限が過ぎても、引き取り直しは待ち、
  #     begin で「送信中」になった人は unknown になる（二度と送らない）。
  local c tok ver
  read -r c tok ver < <(Q_ "$db" -F ' ' -c "select id, lease_token, lease_version from public.market_report_broadcast_chunks where broadcast_id = '$b' and status = 'processing' limit 1")
  Q_ "$db" -c "update public.market_report_broadcast_chunks set lease_expires_at = clock_timestamp() + interval '0.6 seconds' where id = '$c'" >/dev/null
  ( Q_ "$db" -c "begin; set local role service_role; select count(*) from public.begin_market_report_broadcast_chunk('$c', '$tok', $ver); reset role; select pg_sleep(1.5); commit;" >/dev/null ) &
  sleep 0.9
  Q_ "$db" -c "begin; set local role service_role; select count(*) from public.claim_market_report_broadcast_chunks(4); commit;" >/dev/null
  wait
  [[ "$(Q_ "$db" -c "select count(*) filter (where status = 'unknown') || '/' || count(*) from public.market_report_broadcast_deliveries where chunk_id = '$c'")" == "50/50" ]] \
    || { echo "FAIL 4c 期限切れの送信中が unknown にならない" >&2; return 1; }
  # 4d. 送ったあと と 期限切れの引き取り直し（両方の順序）。まだ誰にも記録が無い区切りを使う。
  Q_ "$db" -c "update public.market_report_broadcast_settings set max_parallel_chunks = 4" >/dev/null
  Q_ "$db" -c "begin; set local role service_role; select count(*) from public.claim_market_report_broadcast_chunks(4); commit;" >/dev/null
  fresh="select id, lease_token, lease_version from public.market_report_broadcast_chunks as k where broadcast_id = '$b' and status = 'processing' and not exists (select 1 from public.market_report_broadcast_deliveries as d where d.chunk_id = k.id) order by chunk_no limit 1"
  read -r c tok ver < <(Q_ "$db" -F ' ' -c "$fresh")
  Q_ "$db" -c "begin; set local role service_role; select count(*) from public.begin_market_report_broadcast_chunk('$c', '$tok', $ver); commit;" >/dev/null
  local results; results="$(Q_ "$db" -c "select jsonb_agg(jsonb_build_object('user_id', user_id, 'outcome', 'sent')) from public.market_report_broadcast_deliveries where chunk_id = '$c' and status = 'sending'")"
  #   (i) 送ったあとが先に行をつかむ → 引き取り直しは待ち、終わった区切りには触れない。
  Q_ "$db" -c "update public.market_report_broadcast_chunks set lease_expires_at = clock_timestamp() + interval '0.6 seconds' where id = '$c'" >/dev/null
  ( Q_ "$db" -c "begin; set local role service_role; select public.finish_market_report_broadcast_chunk('$c', '$tok', $ver, '$results'); reset role; select pg_sleep(1.5); commit;" >/dev/null ) &
  sleep 0.9
  Q_ "$db" -c "begin; set local role service_role; select count(*) from public.claim_market_report_broadcast_chunks(4); commit;" >/dev/null
  wait
  [[ "$(Q_ "$db" -c "select status from public.market_report_broadcast_chunks where id = '$c'")" == done ]] || { echo "FAIL 4d(i)" >&2; return 1; }
  [[ "$(Q_ "$db" -c "select count(*) from public.market_report_broadcast_deliveries where chunk_id = '$c' and status = 'sent'")" == 50 ]] || { echo "FAIL 4d(i) sent" >&2; return 1; }
  #   (ii) 引き取り直しが先 → 古い worker の送ったあとは、待ったあと拒まれる。送信中だった人は unknown。
  read -r c tok ver < <(Q_ "$db" -F ' ' -c "$fresh")
  [[ -n "$c" ]] || { echo "FAIL 4d(ii) 使える区切りが無い" >&2; return 1; }
  Q_ "$db" -c "begin; set local role service_role; select count(*) from public.begin_market_report_broadcast_chunk('$c', '$tok', $ver); commit;" >/dev/null
  results="$(Q_ "$db" -c "select jsonb_agg(jsonb_build_object('user_id', user_id, 'outcome', 'sent')) from public.market_report_broadcast_deliveries where chunk_id = '$c' and status = 'sending'")"
  Q_ "$db" -c "update public.market_report_broadcast_chunks set lease_expires_at = clock_timestamp() - interval '1 second' where id = '$c'" >/dev/null
  ( Q_ "$db" -c "begin; set local role service_role; select count(*) from public.claim_market_report_broadcast_chunks(4); reset role; select pg_sleep(1.2); commit;" >/dev/null ) &
  sleep 0.3
  local late
  late="$(Q_ "$db" -c "begin; set local role service_role; select public.finish_market_report_broadcast_chunk('$c', '$tok', $ver, '$results') ->> 'status'; commit;" | grep -v '^$' | tail -1)"
  wait
  [[ "$late" == lease_lost ]] || { echo "FAIL 4d(ii) 古い worker の送ったあとが通った: $late" >&2; return 1; }
  [[ "$(Q_ "$db" -c "select count(*) from public.market_report_broadcast_deliveries where chunk_id = '$c' and status = 'unknown'")" == 50 ]] \
    || { echo "FAIL 4d(ii) 送信中が unknown にならない" >&2; return 1; }
  return 0
}
races "$main" || exit 1
echo "MARKET_REPORT_BROADCAST_RACES_PASS"

# ---------------------------------------------------------------------------
# 5. 規模（合成の利用者。手元の PostgreSQL での実測の時間）
# ---------------------------------------------------------------------------
for n in 10000 100000; do
  db="$(new_db "scale$n" 2)"
  O_ "$db" -f "$candidate_src" >/dev/null
  out="$(Q_ "$db" -v n="$n" -f "$here/market_report_broadcast_scale.sql" 2>&1)" || { echo "FAIL 規模 $n: $out" >&2; exit 1; }
  grep -qx 'MARKET_REPORT_BROADCAST_SCALE_PASS' <<<"$out" || { echo "FAIL 規模 $n: $out" >&2; exit 1; }
  grep '^TIMING' <<<"$out" | sed "s/^/  $n人 /"
  "${S[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null
done
echo "MARKET_REPORT_BROADCAST_SCALE_PASS"

# ---------------------------------------------------------------------------
# 6. 変異テスト
# ---------------------------------------------------------------------------
mutate() {
  local name="$1" mutant="$work/mutant_$1.sql"
  python3 - "$candidate_src" "$mutant" "$2" "$3" <<'PY'
import sys
src, dst, old, new = sys.argv[1:5]
s = open(src, encoding="utf-8").read()
assert s.count(old) == 1, ("mutation anchor", s.count(old), old[:80])
open(dst, "w", encoding="utf-8").write(s.replace(old, new))
PY
  local db; db="$(new_db "m_$name" 2)"
  O_ "$db" -f "$mutant" >/dev/null
  if behavior "$db" && races "$db" 2>/dev/null; then
    echo "FAIL 変異 $name を見逃した" >&2; return 1
  fi
  echo "  変異 $name: 検出"
  "${S[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null
}
mutate begin_no_token "  if not found or v_c.status <> 'processing' or v_c.lease_token is distinct from p_lease_token
     or v_c.lease_version <> p_lease_version or v_c.lease_expires_at < v_now then
    raise exception 'MARKET_REPORT_BROADCAST_LEASE_LOST'" "  if not found or v_c.status <> 'processing'
     or v_c.lease_version <> p_lease_version or v_c.lease_expires_at < v_now then
    raise exception 'MARKET_REPORT_BROADCAST_LEASE_LOST'"
mutate begin_no_expiry "     or v_c.lease_version <> p_lease_version or v_c.lease_expires_at < v_now then
    raise exception 'MARKET_REPORT_BROADCAST_LEASE_LOST'" "     or v_c.lease_version <> p_lease_version then
    raise exception 'MARKET_REPORT_BROADCAST_LEASE_LOST'"
mutate finish_no_expiry "     or v_c.lease_version <> p_lease_version or v_c.lease_expires_at < v_now then
    return jsonb_build_object('status', 'lease_lost', 'chunk_status', v_c.status);" "     or v_c.lease_version <> p_lease_version then
    return jsonb_build_object('status', 'lease_lost', 'chunk_status', v_c.status);"
mutate expiry_keeps_sending "     set status = 'unknown', error_code = 'LEASE_EXPIRED_OUTCOME_UNKNOWN', updated_at = v_now" "     set error_code = 'LEASE_EXPIRED_OUTCOME_UNKNOWN', updated_at = v_now"
# 送信済みの人を外す守りは2か所（対象の選び方と、記録の更新の条件）。両方を外した版で確かめる。
mutate begin_resends "          where d.broadcast_id = v_c.broadcast_id and d.user_id = s.user_id and d.status <> 'retry'
       )
  ), marked as (
    insert into public.market_report_broadcast_deliveries as d
      (broadcast_id, user_id, chunk_id, status, attempt_count, device_count, updated_at)
    select v_c.broadcast_id, t.user_id, v_c.id, 'sending', 1,
           (select count(*) from public.device_push_tokens as k where k.user_id = t.user_id), v_now
      from targets as t
    on conflict (broadcast_id, user_id) do update
       set status = 'sending', attempt_count = d.attempt_count + 1, chunk_id = excluded.chunk_id,
           device_count = excluded.device_count, error_code = null, updated_at = v_now
     where d.status = 'retry'" "          where d.broadcast_id = v_c.broadcast_id and d.user_id = s.user_id and false
       )
  ), marked as (
    insert into public.market_report_broadcast_deliveries as d
      (broadcast_id, user_id, chunk_id, status, attempt_count, device_count, updated_at)
    select v_c.broadcast_id, t.user_id, v_c.id, 'sending', 1,
           (select count(*) from public.device_push_tokens as k where k.user_id = t.user_id), v_now
      from targets as t
    on conflict (broadcast_id, user_id) do update
       set status = 'sending', attempt_count = d.attempt_count + 1, chunk_id = excluded.chunk_id,
           device_count = excluded.device_count, error_code = null, updated_at = v_now"
mutate begin_no_recheck "       and public.market_report_broadcast_eligible(s.user_id, v_type)
       and not exists" "       and not exists"
mutate missing_result_not_unknown "     set status = 'unknown', error_code = 'RESULT_MISSING', updated_at = v_now" "     set status = 'sent', error_code = 'RESULT_MISSING', updated_at = v_now"
mutate no_claim_lock "  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('market_report_broadcast:claim', 0));" ""
mutate no_capacity "greatest(v_settings.max_parallel_chunks - v_running, 0)" "16"
mutate no_plan_lock "  select * into v_b from public.market_report_broadcasts where id = p_broadcast_id for update;" "  select * into v_b from public.market_report_broadcasts where id = p_broadcast_id;"
mutate feed_gate_ignored "  if not found or not v_ondemand.public_market_feed_enabled then" "  if false then"
mutate legacy_gate_ignored "  if not v_ondemand.ondemand_requests_enabled and not v_settings.allow_with_legacy_personalized_reports then" "  if false then"
mutate fact_not_checked "       or v_fact not in ('passed', 'advisory') or v_headline = '' then" "       or v_headline = '' then"
mutate age_not_checked "       and c.report_completed_at >= v_now - pg_catalog.make_interval(mins => v_settings.max_report_age_minutes)" ""
mutate sending_gate_ignored "  if not found or not v_settings.enabled or not v_settings.sending_enabled then
    return;" "  if not found or not v_settings.enabled then
    return;"
mutate pilot_ignored_at_send "    and coalesce((select g.pilot_user_ids is null or p_user_id = any(g.pilot_user_ids)
                     from public.market_report_broadcast_settings as g where g.id), false);" ";"
mutate pilot_ignored_in_plan "           and (v_settings.pilot_user_ids is null or s.user_id = any(v_settings.pilot_user_ids))
" ""
mutate stale_sent "       and b.created_at < v_now - pg_catalog.make_interval(mins => v_settings.max_report_age_minutes)" "       and false"
mutate final_retry_kept "                    when r.outcome = 'retry' and not v_final_attempt then 'retry'" "                    when r.outcome = 'retry' then 'retry'"
echo "MARKET_REPORT_BROADCAST_MUTATIONS_PASS"
echo "MARKET_REPORT_BROADCAST_ALL_PASS"
