#!/bin/bash
# Security checks on a database that has the performance candidate applied (the j1b4_eq_p_perf_a database that
# equivalence.sh leaves behind, or any disposable database prepared the same way).
# Usage: security_checks.sh <db> <psql args...>   (disposable cluster only)
set -uo pipefail
db="$1"; shift
CONN=("$@"); export LC_ALL=C
fail=0
q() { psql "${CONN[@]}" -d "$db" -qAt -c "$1" 2>&1 | tail -1; }
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1: $2"; fail=1; }
U1=10000000-0000-0000-0000-000000000001
U2=10000000-0000-0000-0000-000000000002

# 1 EXECUTE grants
r="$(q "set role anon; select count(*) from public.get_my_important_stock_news(5)")"; echo "$r" | grep -qi "permission denied" && ok "anon cannot execute the feed" || bad "anon feed" "$r"
r="$(q "set role service_role; select count(*) from public.get_my_important_stock_news(5)")"; echo "$r" | grep -qi "permission denied" && ok "service_role cannot execute the feed" || bad "service_role feed" "$r"
r="$(q "set role authenticated; select count(*) from public.get_my_important_stock_news_phase5_base(5)")"; echo "$r" | grep -qi "permission denied" && ok "authenticated cannot execute the base" || bad "base" "$r"
for f in "important_news_feed_event_key('x')" "important_news_feed_themes('fx','x',null)" "important_news_feed_theme_sectors(array['fx'])"; do
  r="$(q "set role authenticated; select public.$f")"; echo "$r" | grep -qi "permission denied" && ok "authenticated cannot call helper $f" || bad "helper $f" "$r"
done
r="$(q "set role authenticated; select public.important_news_number_signature('a 1.5% 1000')")"; echo "$r" | grep -qi "permission denied" && ok "authenticated cannot call the shared signature function" || bad "signature" "$r"

# 2 definer / search_path pinned on every function the candidate (re)defines
r="$(q "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'important_news_feed_%' or p.proname in ('get_my_important_stock_news','get_my_important_stock_news_phase5_base')) and not coalesce(p.proconfig::text,'') like '%search_path%'")"
[ "$r" = "0" ] && ok "search_path is pinned on feed, base and helpers" || bad "search_path pin" "$r functions without it"

# 3 search_path hijack: a shadow schema with same-named functions must not change the feed
base="$(q "set role authenticated; set request.jwt.claim.sub='$U1'; select count(*)||':'||coalesce(string_agg(severity,',' order by news_time,news_id),'') from public.get_my_important_stock_news(50)")"
psql "${CONN[@]}" -d "$db" -qAt -c "create schema if not exists evil; create or replace function evil.lower(text) returns text language sql as \$\$ select 'x'::text \$\$; create or replace function evil.coalesce_(a text) returns text language sql as \$\$ select a \$\$;" >/dev/null 2>&1
hij="$(q "set role authenticated; set search_path = evil, public; set request.jwt.claim.sub='$U1'; select count(*)||':'||coalesce(string_agg(severity,',' order by news_time,news_id),'') from public.get_my_important_stock_news(50)")"
[ "$base" = "$hij" ] && ok "search_path hijack does not change the feed" || bad "hijack" "$base vs $hij"

# 4 cross-user isolation (no per-user data in rows; company rows only for trackers; settings not readable)
r="$(q "set role authenticated; set request.jwt.claim.sub='$U2'; select count(*) from public.tracked_stocks")"
[ "$r" = "1" ] && ok "RLS: a user sees only their own tracked_stocks" || bad "tracked_stocks RLS" "$r"
r="$(q "set role authenticated; set request.jwt.claim.sub='$U2'; select count(*) from public.alert_settings where user_id <> '$U2'")"
[ "$r" = "0" ] && ok "RLS: other users' alert_settings are not readable" || bad "alert_settings RLS" "$r"
r="$(q "set role authenticated; set request.jwt.claim.sub='$U2'; select count(*) from public.get_my_important_stock_news(50) where ticker_code is not null and ticker_code <> '8306'")"
[ "$r" = "0" ] && ok "feed rows carry only the caller's own tracked tickers" || bad "ticker leak" "$r"
r="$(q "set role authenticated; set request.jwt.claim.sub='$U2'; select count(*) from public.get_my_important_stock_news(50) where title like '%[E13]%'")"
[ "$r" = "0" ] && ok "company news of another user's holding is not returned" || bad "company leak" "$r"
r="$(q "set role authenticated; select count(*) from public.get_my_important_stock_news(50)")"
[ "$r" = "0" ] && ok "no auth.uid() -> empty feed" || bad "no uid" "$r"

# 5 the shared Push functions are the original definitions (same md5 in the current and candidate databases is checked by real_checks.sh)
if [ "$fail" = "0" ]; then echo "J1-b5 security checks: PASS"; else echo "J1-b5 security checks: FAIL"; exit 1; fi
