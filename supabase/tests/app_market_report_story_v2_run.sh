#!/usr/bin/env bash
# 20261014100000_app_market_report_story_v2（未適用の候補）の、使い捨ての手元の PostgreSQL での検証。
# Supabase には一切つながない。ホストは /tmp の下のソケットだけを受け付ける。合成の利用者だけを使う。
#
#   AM_PGHOST=/tmp/<socket dir> AM_PGPORT=<port> AM_PGSUPER=<手元の superuser> bash supabase/tests/app_market_report_story_v2_run.sh
#
# 1. 事前確認: V1（20261011150000）が無いデータベースでは何も作らずに止まる
# 2. 置き換えだけ: 変わるのは get_app_market_report の本文だけ（引数・権限・他の定義は1つも変わらない）。
#    取り消しの SQL で、適用前と完全に同じ定義・権限に戻る。もう一度当てても同じ定義になる
# 3. 動作: 新しい項目（app_market_report_story_v2_behavior.sql）と、V1・一斉通知・G2 結合の既存の動作の検証がそのまま通る
# 4. 変異テスト: 守りを1つずつ外した候補では、3 が必ず失敗する
set -euo pipefail
export LC_ALL=C
export PGOPTIONS='-c client_min_messages=warning'

host="${AM_PGHOST:?AM_PGHOST（/tmp の下のソケットのディレクトリ）が必要}"
port="${AM_PGPORT:?AM_PGPORT が必要}"
super="${AM_PGSUPER:?AM_PGSUPER が必要}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "拒否: AM_PGHOST は /tmp の下のソケットのディレクトリだけ" >&2; exit 2 ;; esac

here="$(cd "$(dirname "$0")" && pwd)"
migrations="$here/../migrations"
candidate_src="$migrations/20261014100000_app_market_report_story_v2.sql"
ondemand="$migrations/20261011150000_personalized_ondemand_analysis_v1.sql"
broadcast="$migrations/20261012100000_market_report_broadcast_push_v1.sql"
owner="kb_am_owner"
work="$(mktemp -d "${TMPDIR:-/tmp}/kb_am.XXXXXX")"
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
  -- 一斉通知の動作の検証は、その runner と同じ所有者の名前（kb_bc_owner）を前提にしている。
  if not exists (select 1 from pg_roles where rolname = 'kb_bc_owner') then create role kb_bc_owner login nosuperuser nocreatedb nocreaterole; end if;
end \$\$;
grant anon, authenticated, service_role to $owner;
grant anon, authenticated, service_role to kb_bc_owner;
SQL

# 新しいデータベース。level: 1 = 既存の土台まで、2 = V1 まで、3 = V1 + 一斉通知まで。3つ目は所有者（省略時は $owner）。
new_db() {
  local db="kb_am_$$_$1" who="${3:-$owner}"
  DBS+=("$db")
  "${S[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null
  "${S[@]}" -d postgres -c "create database $db owner $who" >/dev/null
  local O=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$who" -d "$db")
  "${O[@]}" -f "$here/personalized_ondemand_analysis_fixture.sql" >/dev/null
  "${O[@]}" -f "$migrations/20260901061217_add_kabumori_mvp_tables.sql" >/dev/null 2>&1
  "${O[@]}" -f "$migrations/20260903160000_add_device_push_tokens.sql" >/dev/null 2>&1
  "${O[@]}" -f "$migrations/20260911230000_personalized_reports.sql" >/dev/null 2>&1
  "${O[@]}" -f "$migrations/20260919100000_market_report_data_packets_phase1.sql" >/dev/null
  "${O[@]}" -f "$migrations/20260920100000_market_report_packets_phase2.sql" >/dev/null
  if [[ "$2" -ge 2 ]]; then "${O[@]}" -f "$ondemand" >/dev/null; fi
  if [[ "$2" -ge 3 ]]; then "${O[@]}" -f "$broadcast" >/dev/null; fi
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

# 関数の形（引数・返り値・言語・安定性・definer・search_path・権限）。本文の md5 は含めない。
signature() {
  Q_ "$1" -c "select p.oid::regprocedure::text || ' ' || pg_get_function_result(p.oid) || ' ' || l.lanname || ' ' || p.provolatile::text
    || ' ' || p.prosecdef::text || ' ' || array_to_string(p.proconfig, ',') || ' ' || pg_get_function_arguments(p.oid) || ' '
    || coalesce(array_to_string(p.proacl::text[], ','), '-')
    from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = 'public.get_app_market_report(text,date)'::regprocedure"
}

# ---------------------------------------------------------------------------
# 1. 事前確認
# ---------------------------------------------------------------------------
bare="$(new_db bare 1)"
if out="$(O_ "$bare" -f "$candidate_src" 2>&1)"; then echo "FAIL V1 の無いデータベースに当たってしまった" >&2; exit 1; fi
grep -q 'APP_MARKET_REPORT_STORY_V2_PREFLIGHT_V1_MISSING' <<<"$out" || { echo "FAIL 事前確認の理由: $out" >&2; exit 1; }
[[ "$(Q_ "$bare" -c "select coalesce(to_regprocedure('public.get_app_market_report(text,date)')::text, 'absent')")" == absent ]] \
  || { echo "FAIL 事前確認で止まったのに関数が残った" >&2; exit 1; }
echo "APP_MARKET_REPORT_STORY_V2_PREFLIGHT_PASS"

# ---------------------------------------------------------------------------
# 2. 置き換えだけ・取り消し・もう一度当てる
# ---------------------------------------------------------------------------
main="$(new_db main 3)"
catalog "$main" > "$work/before"
signature "$main" > "$work/sig_before"
O_ "$main" -f "$candidate_src" >/dev/null
catalog "$main" > "$work/after"
signature "$main" > "$work/sig_after"
changed="$(comm -3 "$work/before" "$work/after" | awk '{print $1, $2}' | sort -u | tr '\n' ';')"
[[ "$changed" == "fn get_app_market_report(text,date);" ]] || { echo "FAIL 変わった定義が想定と違う: $changed" >&2; exit 1; }
diff -q "$work/sig_before" "$work/sig_after" >/dev/null || { echo "FAIL 関数の形・権限が変わった" >&2; diff "$work/sig_before" "$work/sig_after" >&2; exit 1; }
grep -q 'authenticated=X/' "$work/sig_after" && ! grep -q 'anon=X/' "$work/sig_after" && ! grep -qE '(^|[ ,])=X/' "$work/sig_after" \
  || { echo "FAIL 権限: $(cat "$work/sig_after")" >&2; exit 1; }
echo "APP_MARKET_REPORT_STORY_V2_REPLACE_ONLY_PASS"

O_ "$main" -f "$candidate_src" >/dev/null
catalog "$main" > "$work/again"
diff -q "$work/after" "$work/again" >/dev/null || { echo "FAIL もう一度当てたら定義が変わった" >&2; exit 1; }
echo "APP_MARKET_REPORT_STORY_V2_REAPPLY_SAME_PASS"

undo="$(new_db undo 3)"
catalog "$undo" > "$work/undo_before"
O_ "$undo" -f "$candidate_src" >/dev/null
O_ "$undo" -f "$here/app_market_report_story_v2_rollback.sql" >/dev/null
catalog "$undo" > "$work/undo_after"
diff -q "$work/undo_before" "$work/undo_after" >/dev/null || { echo "FAIL 取り消しのあとの定義が違う" >&2; diff "$work/undo_before" "$work/undo_after" >&2; exit 1; }
echo "APP_MARKET_REPORT_STORY_V2_ROLLBACK_PASS"

# ---------------------------------------------------------------------------
# 3. 動作
# ---------------------------------------------------------------------------
behavior() {  # db -> 0 when PASS
  Q_ "$1" -f "$here/app_market_report_story_v2_behavior.sql" 2>"$work/behavior.err" | grep -qx 'APP_MARKET_REPORT_STORY_V2_BEHAVIOR_PASS'
}
behavior "$main" || { echo "FAIL 動作" >&2; cat "$work/behavior.err" >&2; exit 1; }
echo "APP_MARKET_REPORT_STORY_V2_BEHAVIOR_PASS"

# 既存の動作の検証（V1・一斉通知・G2 結合）が、V2 を当てたあとでもそのまま通る。
od="$(new_db od 2)"
O_ "$od" -f "$candidate_src" >/dev/null
Q_ "$od" -f "$here/personalized_ondemand_analysis_behavior.sql" 2>"$work/od.err" | grep -qx 'PERSONALIZED_ONDEMAND_BEHAVIOR_PASS' \
  || { echo "FAIL V1 の動作の検証" >&2; cat "$work/od.err" >&2; exit 1; }
echo "APP_MARKET_REPORT_STORY_V2_V1_BEHAVIOR_PASS"
bc="$(new_db bc 3 kb_bc_owner)"
psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U kb_bc_owner -d "$bc" -f "$candidate_src" >/dev/null
psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U kb_bc_owner -d "$bc" -f "$here/market_report_broadcast_behavior.sql" 2>"$work/bc.err" | grep -qx 'MARKET_REPORT_BROADCAST_BEHAVIOR_PASS' \
  || { echo "FAIL 一斉通知の動作の検証" >&2; cat "$work/bc.err" >&2; exit 1; }
echo "APP_MARKET_REPORT_STORY_V2_BROADCAST_BEHAVIOR_PASS"
g2="$(new_db g2 3)"
O_ "$g2" -f "$candidate_src" >/dev/null
Q_ "$g2" -f "$here/g2_v1_release_integration_behavior.sql" 2>"$work/g2.err" | grep -qx 'G2_V1_INTEGRATION_BEHAVIOR_PASS' \
  || { echo "FAIL G2 結合の動作の検証" >&2; cat "$work/g2.err" >&2; exit 1; }
echo "APP_MARKET_REPORT_STORY_V2_G2_INTEGRATION_PASS"

# ---------------------------------------------------------------------------
# 4. 変異テスト
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
  local db; db="$(new_db "m_$name" 2)"
  O_ "$db" -f "$mutant" >/dev/null
  if behavior "$db"; then echo "FAIL 変異 $name を見逃した" >&2; return 1; fi
  echo "  変異 $name: 検出"
}
mutate story_raw "'app_story', case when v_story is not null then jsonb_build_object(" "'app_story', case when v_story is not null then v_story || jsonb_build_object("
mutate yume_raw "'yume', case when v_yume is not null then jsonb_build_object(" "'yume', case when v_yume is not null then v_yume || jsonb_build_object("
mutate review_raw "'review', case when v_review is not null then jsonb_build_object(" "'review', case when v_review is not null then v_review || jsonb_build_object("
mutate session_basis "'direction', s -> 'direction'))" "'direction', s -> 'direction', 'basis', s -> 'basis'))"
mutate session_unguarded "case when pg_catalog.jsonb_typeof(v_payload -> 'session_views') = 'array'
                                     then v_payload -> 'session_views' else '[]'::jsonb end" "coalesce(v_payload -> 'session_views', '[]'::jsonb)"
mutate yume_unguarded "  if pg_catalog.jsonb_typeof(v_payload -> 'yume') = 'object' then" "  if v_payload -> 'yume' is not null then"
mutate no_metric_key ", 'metric_key', m -> 'metric_key'))" "))"
mutate data_payload_time "select pg_catalog.to_char(d.generated_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')" "select d.payload ->> 'generated_at'"
mutate feed_ignores_gate "  if not coalesce((select public_market_feed_enabled from public.personalized_ondemand_settings where id), false) then" "  if false then"
mutate grant_anon "grant execute on function public.get_app_market_report(text, date) to authenticated;" "grant execute on function public.get_app_market_report(text, date) to authenticated, anon;"
echo "APP_MARKET_REPORT_STORY_V2_MUTATIONS_PASS"
echo "APP_MARKET_REPORT_STORY_V2_ALL_PASS"
