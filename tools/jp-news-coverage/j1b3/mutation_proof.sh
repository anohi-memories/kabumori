#!/bin/bash
# Shows that the checks notice a regression: m1 = helper granted to authenticated, m2 = shared theme->sector function widened.
# Usage: mutation_proof.sh <template_db> <psql args...>
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; tpl="$1"; shift
VARIANTS="m1" ACL=1 "$here/real_matrix.sh" "$tpl" "$@" | grep "important_news_feed_event_key" | grep -q "authenticated=X" && echo "m1: helper ACL mutation is visible in the ACL report (real_checks.sh would FAIL)"
VARIANTS="current m2" "$here/real_matrix.sh" "$tpl" "$@" >/dev/null 2>&1
for v in current m2; do
  psql "$@" -d "j1b3_v_$v" -qAt -c "update public.alert_settings set market_critical_news=true, push_enabled=true, important_news=true" >/dev/null
  echo "$v market_critical push rows: $(psql "$@" -d "j1b3_v_$v" -qAt -c "select count(*) from public.enqueue_market_critical_notifications(48)")"
done
