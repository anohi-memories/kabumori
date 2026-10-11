#!/usr/bin/env bash
# 20261011150000_personalized_ondemand_analysis_v1（未適用の候補）の、使い捨ての手元の PostgreSQL での検証。
# Supabase には一切つながない。ホストは /tmp の下のソケットだけを受け付ける。
#
#   OD_PGHOST=/tmp/<socket dir> OD_PGPORT=<port> OD_PGSUPER=<手元の superuser> bash supabase/tests/personalized_ondemand_analysis_run.sh
#
# 1. 事前確認: 土台の表が無いデータベースでは何も作らずに止まる
# 2. 追加だけ: 既存の表・関数・権限・方針は1つも変わらない（通知の表には部分ユニーク索引が1つ増えるだけ）
# 3. 二重の適用は止まる。取り消しの SQL で、適用前と同じ定義に戻る
# 4. 動作（personalized_ondemand_analysis_behavior.sql）
# 5. 2つの接続での同時実行（同じ利用者の同時の依頼、同時の引き取り、完了と期限切れの引き取り直しの両方の順序）
# 6. 変異テスト: 守りを1つずつ外した候補では、4 か 5 が必ず失敗する
set -euo pipefail
export LC_ALL=C
export PGOPTIONS='-c client_min_messages=warning'

host="${OD_PGHOST:?OD_PGHOST（/tmp の下のソケットのディレクトリ）が必要}"
port="${OD_PGPORT:?OD_PGPORT が必要}"
super="${OD_PGSUPER:?OD_PGSUPER が必要}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "拒否: OD_PGHOST は /tmp の下のソケットのディレクトリだけ" >&2; exit 2 ;; esac

here="$(cd "$(dirname "$0")" && pwd)"
migrations="$here/../migrations"
candidate_src="$migrations/20261011150000_personalized_ondemand_analysis_v1.sql"
owner="kb_od_owner"
work="$(mktemp -d "${TMPDIR:-/tmp}/kb_od.XXXXXX")"
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

# 新しいデータベース（名前を返す）。base=1 なら土台（auth の代わり・既存の表・個別レポート・市況レポートの第1/2段階）まで当てる。
new_db() {
  local db="kb_od_$$_$1"
  DBS+=("$db")
  "${S[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null
  "${S[@]}" -d postgres -c "create database $db owner $owner" >/dev/null
  local O=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
  "${O[@]}" -f "$here/personalized_ondemand_analysis_fixture.sql" >/dev/null
  if [[ "$2" == 1 ]]; then
    "${O[@]}" -f "$migrations/20260901061217_add_kabumori_mvp_tables.sql" >/dev/null 2>&1
    "${O[@]}" -f "$migrations/20260911230000_personalized_reports.sql" >/dev/null 2>&1
    "${O[@]}" -f "$migrations/20260919100000_market_report_data_packets_phase1.sql" >/dev/null
    "${O[@]}" -f "$migrations/20260920100000_market_report_packets_phase2.sql" >/dev/null
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
union all
select 'set ' || x_enabled || '/' || app_enabled from public.market_report_consumer_settings
order by 1;
SQL
}

# ---------------------------------------------------------------------------
# 1. 事前確認
# ---------------------------------------------------------------------------
bare="$(new_db bare 0)"
if out="$(O_ "$bare" -f "$candidate_src" 2>&1)"; then echo "FAIL 土台の無いデータベースに当たってしまった" >&2; exit 1; fi
grep -q 'PERSONALIZED_ONDEMAND_PREFLIGHT_FOUNDATION_MISSING' <<<"$out" || { echo "FAIL 事前確認の理由: $out" >&2; exit 1; }
[[ "$(Q_ "$bare" -c "select coalesce(to_regclass('public.personalized_analysis_jobs')::text, 'absent')")" == absent ]] \
  || { echo "FAIL 事前確認で止まったのに表が残った" >&2; exit 1; }
echo "PERSONALIZED_ONDEMAND_PREFLIGHT_PASS"

# ---------------------------------------------------------------------------
# 2. 追加だけ
# ---------------------------------------------------------------------------
main="$(new_db main 1)"
catalog "$main" > "$work/before"
O_ "$main" -f "$candidate_src" >/dev/null
catalog "$main" > "$work/after"
removed="$(comm -23 "$work/before" "$work/after")"
[[ -z "$removed" ]] || { echo "FAIL 既存の定義が変わった: $removed" >&2; exit 1; }
added_rel="$(comm -13 "$work/before" "$work/after" | grep '^rel ' | awk '{print $2}' | sort | tr '\n' ' ')"
want_rel="notifications_personalized_analysis_once personalized_analysis_jobs personalized_analysis_jobs_leases personalized_analysis_jobs_notify personalized_analysis_jobs_one_active personalized_analysis_jobs_pkey personalized_analysis_jobs_queue personalized_analysis_jobs_request_once personalized_analysis_jobs_user_recent personalized_analysis_results personalized_analysis_results_pkey personalized_analysis_results_user personalized_ondemand_settings personalized_ondemand_settings_pkey "
[[ "$added_rel" == "$want_rel" ]] || { echo "FAIL 追加された表・索引が想定と違う: $added_rel" >&2; exit 1; }
added_fn="$(comm -13 "$work/before" "$work/after" | grep '^fn ' | awk '{print $2}' | sort | tr '\n' ' ')"
want_fn="claim_personalized_analysis_jobs(integer) complete_personalized_analysis_job(uuid,uuid,bigint,jsonb) enqueue_personalized_analysis_notification(uuid) fail_personalized_analysis_job(uuid,uuid,bigint,text,boolean) get_app_market_report(text,date) get_personalized_analysis_status() mark_personalized_analysis_notification_failed(uuid) request_personalized_analysis(text,uuid,text) "
[[ "$added_fn" == "$want_fn" ]] || { echo "FAIL 追加された関数が想定と違う: $added_fn" >&2; exit 1; }
# 新しい列・制約・方針は、新しい3つの表のものだけ。
other="$(comm -13 "$work/before" "$work/after" | grep -E '^(col|con|pol|trg) ' | grep -vE '^(col|con|pol|trg) (public\.)?personalized_(analysis_jobs|analysis_results|ondemand_settings)[ .]' || true)"
[[ -z "$other" ]] || { echo "FAIL 既存の表に列・制約・方針が増えた: $other" >&2; exit 1; }
echo "PERSONALIZED_ONDEMAND_ADDITIVE_PASS"

# 取り消し: 別のデータベースで、適用 → 取り消し → 定義が適用前と完全に一致する。
undo="$(new_db undo 1)"
catalog "$undo" > "$work/undo_before"
O_ "$undo" -f "$candidate_src" >/dev/null
O_ "$undo" -f "$here/personalized_ondemand_analysis_rollback.sql" >/dev/null
catalog "$undo" > "$work/undo_after"
diff -q "$work/undo_before" "$work/undo_after" >/dev/null || { echo "FAIL 取り消しのあとの定義が違う" >&2; diff "$work/undo_before" "$work/undo_after" >&2; exit 1; }
echo "PERSONALIZED_ONDEMAND_ROLLBACK_PASS"

if out="$(O_ "$main" -f "$candidate_src" 2>&1)"; then echo "FAIL 二重の適用が通った" >&2; exit 1; fi
grep -q 'PERSONALIZED_ONDEMAND_ALREADY_APPLIED' <<<"$out" || { echo "FAIL 二重の適用の理由: $out" >&2; exit 1; }
echo "PERSONALIZED_ONDEMAND_REAPPLY_REFUSED_PASS"

# ---------------------------------------------------------------------------
# 4. 動作
# ---------------------------------------------------------------------------
behavior() {  # db -> 0 when PASS
  Q_ "$1" -f "$here/personalized_ondemand_analysis_behavior.sql" 2>"$work/behavior.err" | grep -qx 'PERSONALIZED_ONDEMAND_BEHAVIOR_PASS'
}
behavior "$main" || { echo "FAIL 動作" >&2; cat "$work/behavior.err" >&2; exit 1; }
echo "PERSONALIZED_ONDEMAND_BEHAVIOR_PASS"

# ---------------------------------------------------------------------------
# 5. 同時実行（2つの接続。片方は呼び出しのあと pg_sleep で取引を開いたままにする）
# ---------------------------------------------------------------------------
races() {  # db -> 0 when all race checks pass
  local db="$1"
  uid() { printf '00000000-0000-4000-8000-%012d' "$1"; }
  Q_ "$db" >/dev/null <<SQL
update public.personalized_ondemand_settings set ondemand_requests_enabled = true, max_parallel_jobs = 1, daily_request_limit = 50;
insert into auth.users (id) select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid from generate_series(7001, 7004) n;
insert into public.profiles (id) select id from auth.users where id::text like '00000000-0000-4000-8000-0000000070%';
insert into public.stocks_master (ticker_code, company_name) values ('R1', '競合') on conflict do nothing;
insert into public.tracked_stocks (user_id, stock_id, tracking_type)
  select p.id, s.id, 'holding' from public.profiles p, public.stocks_master s
   where p.id::text like '00000000-0000-4000-8000-0000000070%' and s.ticker_code = 'R1';
SQL
  # 5a. 同じ利用者の同時の依頼（別々の依頼 ID）: 1件だけ作られ、もう片方は「処理中のものがある」。
  local u; u="$(uid 7001)"
  ( Q_ "$db" -c "begin; set local request.jwt.claim.sub = '$u'; set local role authenticated; select public.request_personalized_analysis('latest', '$(uid 8001)'); reset role; select pg_sleep(1.5); commit;" >/dev/null ) &
  sleep 0.4
  local second
  second="$(Q_ "$db" -c "begin; set local request.jwt.claim.sub = '$u'; set local role authenticated; select public.request_personalized_analysis('latest', '$(uid 8002)') ->> 'status'; commit;" | grep -v '^$' | tail -1)"
  wait
  [[ "$second" == already_active ]] || { echo "FAIL 5a 同時の依頼の2件目: $second" >&2; return 1; }
  [[ "$(Q_ "$db" -c "select count(*) from public.personalized_analysis_jobs where user_id = '$u'")" == 1 ]] || { echo "FAIL 5a ジョブが2件" >&2; return 1; }
  # 5a'. 同じ依頼 ID の同時の再送: 同じジョブ。
  local v; v="$(uid 7002)"
  ( Q_ "$db" -c "begin; set local request.jwt.claim.sub = '$v'; set local role authenticated; select public.request_personalized_analysis('latest', '$(uid 8003)'); reset role; select pg_sleep(1.5); commit;" >/dev/null ) &
  sleep 0.4
  second="$(Q_ "$db" -c "begin; set local request.jwt.claim.sub = '$v'; set local role authenticated; select public.request_personalized_analysis('latest', '$(uid 8003)') ->> 'status'; commit;" | grep -v '^$' | tail -1)"
  wait
  [[ "$second" == replayed ]] || { echo "FAIL 5a' 同時の再送: $second" >&2; return 1; }

  # 5b. 同時の引き取り（上限1）: 片方が取引を開いたまま → もう片方は待って、上限に達しているので何も取らない。
  ( Q_ "$db" -c "begin; set local role service_role; select count(*) from public.claim_personalized_analysis_jobs(5); reset role; select pg_sleep(1.5); commit;" >/dev/null ) &
  sleep 0.4
  local got
  got="$(Q_ "$db" -c "begin; set local role service_role; select count(*) from public.claim_personalized_analysis_jobs(5); commit;" | grep -v '^$' | tail -1)"
  wait
  [[ "$got" == 0 ]] || { echo "FAIL 5b 上限を超えて引き取った: $got" >&2; return 1; }
  [[ "$(Q_ "$db" -c "select count(*) from public.personalized_analysis_jobs where status = 'processing'")" == 1 ]] || { echo "FAIL 5b 処理中の件数" >&2; return 1; }
  # 上限2で同時に引き取る: 別々のジョブを取り、同じジョブを2回取らない。
  Q_ "$db" -c "update public.personalized_ondemand_settings set max_parallel_jobs = 3" >/dev/null
  Q_ "$db" -c "update public.personalized_analysis_jobs set status = 'failed', failed_at = now(), lease_token = null, lease_expires_at = null where status = 'processing'" >/dev/null
  local w
  for w in 7003 7004; do
    Q_ "$db" -c "begin; set local request.jwt.claim.sub = '$(uid "$w")'; set local role authenticated; select public.request_personalized_analysis('latest', '$(uid $((w + 1000)))'); commit;" >/dev/null
  done
  Q_ "$db" -c "begin; set local request.jwt.claim.sub = '$(uid 7001)'; set local role authenticated; select public.request_personalized_analysis('latest', '$(uid 8009)'); commit;" >/dev/null
  ( Q_ "$db" -c "begin; set local role service_role; create temp table c1 as select job_id from public.claim_personalized_analysis_jobs(2); reset role; select pg_sleep(1.0); commit;" >/dev/null ) &
  sleep 0.3
  got="$(Q_ "$db" -c "begin; set local role service_role; select count(*) from public.claim_personalized_analysis_jobs(5); commit;" | grep -v '^$' | tail -1)"
  wait
  [[ "$got" == 1 ]] || { echo "FAIL 5b' 2つ目の worker の引き取り数: $got" >&2; return 1; }
  [[ "$(Q_ "$db" -c "select count(*) || '/' || count(distinct user_id) || '/' || max(attempt_count) from public.personalized_analysis_jobs where status = 'processing'")" == "3/3/1" ]] \
    || { echo "FAIL 5b' 同じジョブを2回引き取った" >&2; return 1; }

  # 5c. 完了 と 期限切れの引き取り直しの競合（両方の順序）
  local job tok ver
  read -r job tok ver < <(Q_ "$db" -F ' ' -c "select id, lease_token, lease_version from public.personalized_analysis_jobs where status = 'processing' order by requested_at limit 1")
  local pkt; pkt="$(Q_ "$db" -c "select id from public.market_report_packets limit 1")"
  local today; today="$(Q_ "$db" -c "select (now() at time zone 'Asia/Tokyo')::date")"
  local result="{\"title_ja\":\"t\",\"fact_status\":\"passed\",\"reference_report_packet_id\":\"$pkt\",\"report_type\":\"morning\",\"trading_date\":\"$today\"}"
  # (i) 完了が期限内に行をつかむ → その取引の間に期限が過ぎ、引き取り直しが同じ行を期限切れとして更新しに来る
  #     → 待ったあと、完了済みの行には触れない。
  Q_ "$db" -c "update public.personalized_analysis_jobs set lease_expires_at = clock_timestamp() + interval '0.6 seconds' where id = '$job'" >/dev/null
  ( Q_ "$db" -c "begin; set local role service_role; select public.complete_personalized_analysis_job('$job', '$tok', $ver, '$result'); reset role; select pg_sleep(1.5); commit;" >/dev/null ) &
  sleep 0.9
  Q_ "$db" -c "begin; set local role service_role; select count(*) from public.claim_personalized_analysis_jobs(5); commit;" >/dev/null
  wait
  [[ "$(Q_ "$db" -c "select status || '/' || notify_status from public.personalized_analysis_jobs where id = '$job'")" == "completed/pending" ]] \
    || { echo "FAIL 5c(i) 完了が引き取り直しで上書きされた" >&2; return 1; }
  # (ii) 引き取り直しが先（期限切れ → 新しい token）→ 古い worker の完了は待ったあと拒まれる。
  read -r job tok ver < <(Q_ "$db" -F ' ' -c "select id, lease_token, lease_version from public.personalized_analysis_jobs where status = 'processing' order by requested_at limit 1")
  Q_ "$db" -c "update public.personalized_analysis_jobs set lease_expires_at = clock_timestamp() - interval '1 second' where id = '$job'" >/dev/null
  ( Q_ "$db" -c "begin; set local role service_role; select count(*) from public.claim_personalized_analysis_jobs(5); reset role; select pg_sleep(1.2); commit;" >/dev/null ) &
  sleep 0.3
  local late
  late="$(Q_ "$db" -c "begin; set local role service_role; select public.complete_personalized_analysis_job('$job', '$tok', $ver, '$result') ->> 'status'; commit;" | grep -v '^$' | tail -1)"
  wait
  [[ "$late" == lease_lost ]] || { echo "FAIL 5c(ii) 古い worker の完了が通った: $late" >&2; return 1; }
  [[ "$(Q_ "$db" -c "select count(*) from public.personalized_analysis_results where job_id = '$job'")" == 0 ]] \
    || { echo "FAIL 5c(ii) 古い worker の結果が残った" >&2; return 1; }
  return 0
}
races "$main" || exit 1
echo "PERSONALIZED_ONDEMAND_RACES_PASS"

# ---------------------------------------------------------------------------
# 6. 変異テスト
# ---------------------------------------------------------------------------
mutate() {  # name, old, new -> 0 when the mutant is caught
  local name="$1" mutant="$work/mutant_$1.sql"
  python3 - "$candidate_src" "$mutant" "$2" "$3" <<'PY'
import sys
src, dst, old, new = sys.argv[1:5]
s = open(src, encoding="utf-8").read()
assert s.count(old) == 1, ("mutation anchor", s.count(old), old[:80])
open(dst, "w", encoding="utf-8").write(s.replace(old, new))
PY
  local db; db="$(new_db "m_$name" 1)"
  O_ "$db" -f "$mutant" >/dev/null
  if behavior "$db" && races "$db" 2>/dev/null; then
    echo "FAIL 変異 $name を見逃した" >&2; return 1
  fi
  echo "  変異 $name: 検出"
}
mutate no_version_fence "or v_job.lease_version <> p_lease_version or v_job.lease_expires_at < v_now then" "or v_job.lease_expires_at < v_now then"
mutate no_expiry_fence "or v_job.lease_version <> p_lease_version or v_job.lease_expires_at < v_now then" "or v_job.lease_version <> p_lease_version then"
mutate no_token_fence "if v_job.status <> 'processing' or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_version <> p_lease_version or v_job.lease_expires_at < v_now then" "if v_job.status <> 'processing'
     or v_job.lease_version <> p_lease_version or v_job.lease_expires_at < v_now then"
mutate expire_without_version_bump "lease_token = null, lease_expires_at = null, lease_version = j.lease_version + 1,
         available_at = v_now, updated_at = v_now" "lease_token = null, lease_expires_at = null,
         available_at = v_now, updated_at = v_now"
mutate no_claim_lock "  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('personalized_analysis:claim', 0));" ""
mutate no_request_lock "  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('personalized_analysis:' || v_user::text, 0));" ""
mutate no_capacity "greatest(v_settings.max_parallel_jobs - v_running, 0)" "20"
mutate no_push_check "  if not coalesce(v_push, false) then" "  if false then"
mutate no_daily_limit "  if v_today >= v_settings.daily_request_limit then" "  if false then"
mutate owner_policy_open "for select to authenticated using (auth.uid() = user_id);
create policy personalized_analysis_results_owner_select" "for select to authenticated using (true);
create policy personalized_analysis_results_owner_select"
mutate feed_leaks_payload "    'fact_status', coalesce(v_payload #>> '{fact,ai_status}', 'passed')" "    'fact_status', coalesce(v_payload #>> '{fact,ai_status}', 'passed'), 'raw', v_payload"
mutate feed_ignores_gate "  if not coalesce((select public_market_feed_enabled from public.personalized_ondemand_settings where id), false) then" "  if false then"
mutate tier_open "  if p_model_tier is distinct from 'standard' then" "  if false then"
echo "PERSONALIZED_ONDEMAND_MUTATIONS_PASS"
echo "PERSONALIZED_ONDEMAND_ALL_PASS"
