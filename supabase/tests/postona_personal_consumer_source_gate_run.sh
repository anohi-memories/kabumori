#!/usr/bin/env bash
# G5-39: the REAL consumer code that touches the G5 gates, run against the REAL G5 candidates, on a THROW-AWAY LOCAL PostgreSQL 17 with fake data.
#   world   PR #518's integration runner (head fdc281fe, blob checked): the reviewed G5 world 21a5cad4 + D1 / S2-3 / S2-2 / S2-1 from their PR
#           heads, with two substitutions: the S2-3 rollback of PR #521 (0b47b27c) and the S2-2 rollback of PR #525 (a4ce68ff) -- the latest.
#   G3      PR #524 head 32f59387: postona_x_resv.caller() cut from 001_postona_x_reservations.sql (the gate every person-facing X / Threads
#           entry calls first), and the Edge's Supabase Auth verifier supabase_auth.ts.
#   G4      PR #523 head cbd3922c: postona_g4_x_oauth.require_person() / require_owner_epoch() cut from 001_x_oauth_personal_epoch.sql.
#   G6      PR #500 head 636c38b9: the Gateway's G5 transport and authority port (supabase/ai_gateway + the shared modules they import).
# Each consumer file is read with `git show` and its blob checked; only the named functions are cut out (their text is checked in the suite).
# Nothing of G3 / G4 / G6 is changed or written back; no network (the verifier and the transport get fake fetches). Usage:
#   CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/postona_personal_consumer_source_gate_run.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/g539src.XXXXXX")"
trap 'rm -rf "$work"' EXIT
x="$work/x"; mkdir -p "$x"
pinned() {  # commit path blob out
  git -C "$repo" cat-file -e "$1^{commit}" || { echo "Commit $1 missing; run git fetch origin." >&2; exit 2; }
  [ "$(git -C "$repo" rev-parse "$1:$2")" = "$3" ] || { echo "Blob of $2 at $1 differs." >&2; exit 2; }
  git -C "$repo" show "$1:$2" > "$4"
}
pr518=fdc281fe5270d63503e5675b6275f7ffaaee9864
pinned $pr518 supabase/tests/postona_personal_auth_integration_pg_run.sh f965d9de10aa3f9d728427d9026c3781f19d4395 "$work/int_run.sh"
pinned 32f5938762412c38d873a1cc21460c2c39033fb6 supabase/candidates/postona_x_reservations/001_postona_x_reservations.sql 88b5525f6826f02f55dc1c7fd47f7ecf0b37cb56 "$x/g3_001.sql"
pinned 32f5938762412c38d873a1cc21460c2c39033fb6 supabase/functions/_shared/postona_reservations/supabase_auth.ts 0b6e636b422cc575404ddabf6bb0ea976e7ac75b "$x/g3_supabase_auth.ts"
pinned cbd3922c51f363c72e903cd03ed89c518897e0b3 supabase/candidates/postona_g4_x_oauth_personal_epoch/001_x_oauth_personal_epoch.sql 9635d33eed9c88d0b5f0fadc7eae3701985b757f "$x/g4_001.sql"
g6=636c38b9824ae14c734f25da40d2fe6ecaaa1f03
git -C "$repo" cat-file -e "$g6^{commit}" || { echo "Commit $g6 missing." >&2; exit 2; }
mkdir -p "$x/g6"; git -C "$repo" archive "$g6" supabase/ai_gateway supabase/functions/_shared/ai_provider | tar -x -C "$x/g6"
for pair in "supabase/ai_gateway/authority_port.ts 0c7ef2b052ba8af08c7d1bb82d510615fbd34e01" "supabase/ai_gateway/g5_rpc_transport.ts f1fc0ca2571cb0c13c507b80ca762a0c141feb99"; do
  set -- $pair
  [ "$(git hash-object "$x/g6/$1")" = "$2" ] || { echo "G6 blob of $1 differs." >&2; exit 2; }
done
# PR #518's runner, three substitutions (each must match one line): the repository, the two newest rollbacks, and this suite instead of #518's
python3 - "$work/int_run.sh" "$repo" "$here/postona_personal_consumer_source_gate_pg_test.ts" "$x" <<'PY'
import sys
path, repo, test, x = sys.argv[1:]
s = open(path, encoding='utf-8').read()
subs = [
    ('repo="$(cd "$here/../.." && pwd)"\n', f'repo="{repo}"\n'),
    ('cp_pinned s23_rb.sql bbc52a6b78efd9eb4b174f7fbb6835162a631659 $A/003_s2_3_workspace_eligibility_rollback.sql ac50cb29f8cf68e08f293360d615cec7a1296c67\n',
     'cp_pinned s23_rb.sql 0b47b27cbed1a16a5e988854194df059fcd12ef8 $A/003_s2_3_workspace_eligibility_rollback.sql b5bb63b6f9a173802b0b12a054f72a0bd436ddc9\n'),
    ('cp_pinned s22_rb.sql 6d59f3b6690e237c203ba4ee8a8afbf42e7a5e11 $A/004_s2_2_personal_session_rollback.sql f2318751728bff75a6e02a712b923546b35a85ec\n',
     'cp_pinned s22_rb.sql a4ce68ff8e5dd2702c2e8400dfa008556a0d04dd $A/004_s2_2_personal_session_rollback.sql 852a51537b1d422d14b9ef362a0c5648bd441d0c\n'),
    ('( cd "$repo" && CAL_E2E=1 S36_C=', f'( cd "$repo" && CAL_E2E=1 S39_X="{x}" S36_C='),
    ('"$here/postona_personal_auth_integration_pg_test.ts" )', f'"{test}" )'),
]
for old, new in subs:
    if s.count(old) != 1:
        sys.exit(f'substitution site occurs {s.count(old)} times: {old[:70]!r}')
    s = s.replace(old, new)
open(path, 'w', encoding='utf-8').write(s)
PY
bash "$work/int_run.sh"
