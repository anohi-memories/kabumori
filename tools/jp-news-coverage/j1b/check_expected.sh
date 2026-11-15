#!/bin/bash
# Re-runs every variant and compares with the recorded matrix (expected_matrix.txt); then compares function privileges of
# the current feed against the candidate. Exit 1 on any difference. Throwaway local Postgres only.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
actual="$(mktemp)"
while read -r variant; do
  echo "## $variant"
  VARIANT="$variant" "$here/run_matrix.sh" "$@" | grep -E '^u[0-9]'
done < "$here/variants.txt" > "$actual"
diff -u "$here/expected_matrix.txt" "$actual"
cur="$(VARIANT=current ACL=1 "$here/run_matrix.sh" "$@" | grep -E ' secdef=' | grep -E '^get_my_important_stock_news ')"
cand="$(VARIANT=j1b2_a ACL=1 "$here/run_matrix.sh" "$@" | grep -E ' secdef=' | grep -E '^get_my_important_stock_news ')"
if [ "$cur" != "$cand" ]; then echo "ACL/secdef of get_my_important_stock_news differs:"; echo "$cur"; echo "$cand"; exit 1; fi
helpers="$(VARIANT=j1b2_a ACL=1 "$here/run_matrix.sh" "$@" | grep -E '^important_news_feed_' | grep -v 'anon_exec=false auth_exec=false service_exec=false' || true)"
if [ -n "$helpers" ]; then echo "feed helpers must not be executable by anon/authenticated/service_role:"; echo "$helpers"; exit 1; fi
# the candidate must not redefine anything the Push producers share
if grep -Eiq "create (or replace )?function public\.(important_news_same_event|important_news_market_themes|important_news_theme_sectors|important_news_number_signature|important_news_app_severity|enqueue_|get_my_important_stock_news_phase5_base)" "$here/candidate/20261013_J1B2_news_feed_domestic_visibility_CANDIDATE.sql"; then
  echo "candidate redefines a function shared with Push / the base feed"; exit 1
fi
echo "J1-b2 matrix and privileges: all variants match the recorded expectation"
