#!/usr/bin/env bash
# G5-37: the G5-36 integration suite (PR #518 head fdc281fe, read with `git show`, blobs checked) re-run with ONE substitution: the S2-3 rollback
# is this branch's (the callers / dependents fence). Everything else -- the world, D1, S2-3, S2-2, S2-1, the other rollbacks, the fake consumers
# and the 7 tests -- is PR #518's, unchanged. Optional S36_ABLATE (s21 | s22 | s23) is passed through to PR #518's test (its ablation mode).
# THROW-AWAY LOCAL PostgreSQL 17 only. Usage:
#   CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/postona_personal_s2_3_rollback_integration_run.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
pr518=fdc281fe5270d63503e5675b6275f7ffaaee9864
new_rb="$repo/supabase/candidates/postona_personal_auth/003_s2_3_workspace_eligibility_rollback.sql"
work="$(mktemp -d "${TMPDIR:-/tmp}/g537int.XXXXXX")"
trap 'rm -rf "$work"' EXIT
git -C "$repo" cat-file -e "$pr518^{commit}" || { echo "PR #518's head $pr518 missing; run git fetch origin." >&2; exit 2; }
for pair in "postona_personal_auth_integration_pg_run.sh f965d9de10aa3f9d728427d9026c3781f19d4395" \
            "postona_personal_auth_integration_pg_test.ts 6377969a317abf5538cbf826eda020881558c7d4" \
            "postona_personal_auth_integration_fake_consumers.sql c9ea0fc9c6c2da1fb473898726e17e00cbb31f72"; do
  set -- $pair
  [ "$(git -C "$repo" rev-parse "$pr518:supabase/tests/$1")" = "$2" ] || { echo "Blob of $1 at PR #518 differs." >&2; exit 2; }
  git -C "$repo" show "$pr518:supabase/tests/$1" > "$work/$1"
done
# the two substitutions, each required to match exactly one line: the repository root, and the S2-3 rollback's source
python3 - "$work/postona_personal_auth_integration_pg_run.sh" "$repo" "$new_rb" <<'PY'
import sys
path, repo, new_rb = sys.argv[1:]
s = open(path, encoding='utf-8').read()
subs = [('repo="$(cd "$here/../.." && pwd)"\n', f'repo="{repo}"\n'),
        ('cp_pinned s23_rb.sql bbc52a6b78efd9eb4b174f7fbb6835162a631659 $A/003_s2_3_workspace_eligibility_rollback.sql ac50cb29f8cf68e08f293360d615cec7a1296c67\n',
         f'cp "{new_rb}" "$work/c/s23_rb.sql"  # G5-37: this branch\'s S2-3 rollback\n')]
for old, new in subs:
    if s.count(old) != 1:
        sys.exit(f'substitution site occurs {s.count(old)} times: {old[:60]!r}')
    s = s.replace(old, new)
open(path, 'w', encoding='utf-8').write(s)
PY
bash "$work/postona_personal_auth_integration_pg_run.sh"
