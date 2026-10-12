#!/usr/bin/env bash
# かぶモリ V1（PR143 オンデマンド個別分析 + PR149 共通朝刊・大引けの一斉通知）を、同じ使い捨ての手元の PostgreSQL に
# 両方入れた状態での確認。Supabase には一切つながない。ホストは /tmp の下のソケットだけ。合成の利用者だけ。
#
#   V1_PGHOST=/tmp/<socket dir> V1_PGPORT=<port> V1_PGSUPER=<手元の superuser> bash supabase/tests/g2_v1_release_integration_run.sh
#
# 1. 順序: PR149 の migration を PR143 より先に当てると、何も作らずに止まる
# 2. 両方を当てる → 逆の順（PR149 → PR143）で取り消す → 定義が適用前と完全に一致する
# 3. 端から端まで（g2_v1_release_integration_behavior.sql）
set -euo pipefail
export LC_ALL=C
export PGOPTIONS='-c client_min_messages=warning'

host="${V1_PGHOST:?V1_PGHOST（/tmp の下のソケットのディレクトリ）が必要}"
port="${V1_PGPORT:?V1_PGPORT が必要}"
super="${V1_PGSUPER:?V1_PGSUPER が必要}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "拒否: V1_PGHOST は /tmp の下のソケットのディレクトリだけ" >&2; exit 2 ;; esac

here="$(cd "$(dirname "$0")" && pwd)"
migrations="$here/../migrations"
ondemand="$migrations/20261011150000_personalized_ondemand_analysis_v1.sql"
broadcast="$migrations/20261012100000_market_report_broadcast_push_v1.sql"
owner="kb_v1_owner"
work="$(mktemp -d "${TMPDIR:-/tmp}/kb_v1.XXXXXX")"
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

new_db() {
  local db="kb_v1_$$_$1"
  DBS+=("$db")
  "${S[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null
  "${S[@]}" -d postgres -c "create database $db owner $owner" >/dev/null
  local O=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
  "${O[@]}" -f "$here/personalized_ondemand_analysis_fixture.sql" >/dev/null
  "${O[@]}" -f "$migrations/20260901061217_add_kabumori_mvp_tables.sql" >/dev/null 2>&1
  "${O[@]}" -f "$migrations/20260903160000_add_device_push_tokens.sql" >/dev/null 2>&1
  "${O[@]}" -f "$migrations/20260911230000_personalized_reports.sql" >/dev/null 2>&1
  "${O[@]}" -f "$migrations/20260919100000_market_report_data_packets_phase1.sql" >/dev/null
  "${O[@]}" -f "$migrations/20260920100000_market_report_packets_phase2.sql" >/dev/null
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
select 'col ' || a.attrelid::regclass::text || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
  from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r', 'p', 'v') and a.attnum > 0 and not a.attisdropped
union all
select 'con ' || conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) from pg_constraint where conrelid <> 0
union all
select 'pol ' || polrelid::regclass::text || ' ' || polname from pg_policy
order by 1;
SQL
}

# 1. 順序
early="$(new_db early)"
if out="$(O_ "$early" -f "$broadcast" 2>&1)"; then echo "FAIL PR149 の migration が PR143 より先に当たった" >&2; exit 1; fi
grep -q 'MARKET_REPORT_BROADCAST_PREFLIGHT_ONDEMAND_V1_MISSING' <<<"$out" || { echo "FAIL 順序の理由: $out" >&2; exit 1; }
[[ "$(Q_ "$early" -c "select coalesce(to_regclass('public.market_report_broadcasts')::text, 'absent')")" == absent ]] || { echo "FAIL 表が残った" >&2; exit 1; }
echo "G2_V1_ORDER_PASS"

# 2. 両方を当てて、逆の順で取り消す
undo="$(new_db undo)"
catalog "$undo" > "$work/before"
O_ "$undo" -f "$ondemand" >/dev/null
O_ "$undo" -f "$broadcast" >/dev/null
O_ "$undo" -f "$here/market_report_broadcast_rollback.sql" >/dev/null
O_ "$undo" -f "$here/personalized_ondemand_analysis_rollback.sql" >/dev/null
catalog "$undo" > "$work/after"
diff -q "$work/before" "$work/after" >/dev/null || { echo "FAIL 取り消しのあとの定義が違う" >&2; diff "$work/before" "$work/after" >&2; exit 1; }
echo "G2_V1_APPLY_ROLLBACK_PASS"

# 3. 端から端まで
main="$(new_db main)"
O_ "$main" -f "$ondemand" >/dev/null
O_ "$main" -f "$broadcast" >/dev/null
Q_ "$main" -f "$here/g2_v1_release_integration_behavior.sql" 2>"$work/err" | grep -qx 'G2_V1_INTEGRATION_BEHAVIOR_PASS' \
  || { echo "FAIL 端から端まで" >&2; cat "$work/err" >&2; exit 1; }
echo "G2_V1_INTEGRATION_BEHAVIOR_PASS"
echo "G2_V1_ALL_PASS"
