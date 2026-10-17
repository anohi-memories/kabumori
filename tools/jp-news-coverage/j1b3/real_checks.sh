#!/bin/bash
# Real-schema checks on top of real_matrix.sh. Usage: real_checks.sh <template_db> <psql args...> (disposable cluster only)
# 1 signature/secdef/search_path/owner/ACL of every feed + Push function is identical between current and candidate a/b/c
#   (only the new important_news_feed_* helpers are added, all non-executable by app roles)
# 2 anon cannot execute the feed; authenticated cannot read the candidates table directly nor call the helpers
# 3 Push producers return exactly the same rows on current and candidate (shared functions untouched)
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tpl="$1"; shift
CONN=("$@")
export LC_ALL=C
fail=0
VARIANTS="current a b c" ACL=1 "$here/real_matrix.sh" "$tpl" "${CONN[@]}" | grep -E '^(##|sig )' > "$here/.acl.txt"
extract() { awk -v v="$1" '/^## /{cur=$2} cur==v && /^sig /' "$here/.acl.txt" | grep -v "important_news_feed_"; }
for v in a b c; do
  if ! diff <(extract current) <(extract $v) >/dev/null; then echo "FAIL: function signature/ACL differs for variant $v"; diff <(extract current) <(extract $v); fail=1; fi
done
helpers="$(awk '/^## a/{f=1} f && /important_news_feed_/' "$here/.acl.txt" | grep -v 'acl={postgres=X/postgres}' || true)"
if [ -n "$helpers" ]; then echo "FAIL: feed helpers executable by app roles:"; echo "$helpers"; fail=1; fi
helper_count="$(awk '/^## a/{f=1} /^## b/{f=0} f && /important_news_feed_/' "$here/.acl.txt" | wc -l | tr -d ' ')"
[ "$helper_count" = "4" ] || { echo "FAIL: expected 4 feed helpers, found $helper_count"; fail=1; }

db="j1b3_v_a"
anon="$(psql "${CONN[@]}" -d "$db" -qAt -c "set role anon; select count(*) from public.get_my_important_stock_news(5);" 2>&1 | tail -1)"
echo "$anon" | grep -qi "permission denied" || { echo "FAIL: anon could execute the feed: $anon"; fail=1; }
direct="$(psql "${CONN[@]}" -d "$db" -qAt -c "set role authenticated; select count(*) from public.important_news_candidates;" 2>&1 | tail -1)"
echo "$direct" | grep -qiE "permission denied|^0$" || { echo "FAIL: authenticated reads candidates directly: $direct"; fail=1; }
help="$(psql "${CONN[@]}" -d "$db" -qAt -c "set role authenticated; select public.important_news_feed_event_key('x');" 2>&1 | tail -1)"
echo "$help" | grep -qi "permission denied" || { echo "FAIL: authenticated could call a helper: $help"; fail=1; }

push() {
  local v="$1"
  psql "${CONN[@]}" -d "j1b3_v_$v" -qAt -v ON_ERROR_STOP=1 -c "update public.alert_settings set market_critical_news = true, push_enabled = true, important_news = true;" >/dev/null || return 1
  psql "${CONN[@]}" -d "j1b3_v_$v" -qAt -v ON_ERROR_STOP=1 \
    -c "select 'm|' || user_id || '|' || candidate_id from public.enqueue_market_critical_notifications(48);" \
    -c "select 'i|' || row_to_json(t)::text from (select * from public.enqueue_important_news_notifications(48)) t;" \
    | sed -E 's/"notification_id":"[0-9a-f-]+",?//' | sort
}
push current > "$here/.push_current.txt" || { echo "FAIL: push producers did not run on current"; fail=1; }
if grep -qiE "error|psql:" "$here/.push_current.txt"; then echo "FAIL: push output contains errors"; fail=1; fi
for v in a b c; do
  push $v > "$here/.push_$v.txt" || { echo "FAIL: push producers did not run on $v"; fail=1; }
  diff -q "$here/.push_current.txt" "$here/.push_$v.txt" >/dev/null || { echo "FAIL: Push producer output differs for variant $v"; fail=1; }
done
echo "push rows (current): $(wc -l < "$here/.push_current.txt" | tr -d ' ')"
if [ "$fail" = "0" ]; then echo "J1-b3 real-schema checks: PASS"; else echo "J1-b3 real-schema checks: FAIL"; exit 1; fi
