#!/usr/bin/env bash
# G2 QA runner: runs G3's disposable LOCAL PostgreSQL proof for candidate 007 (unchanged) and splices G2's scenarios in
# just before G3's rollback stage, through G3's own THREADS_RESV_ROLLBACK hook (G2 scenarios first, then G3's real
# rollback, so G3's RB checks still run). Same requirements as G3's runner:
#   RESV_PGHOST=/private/tmp/<socket-dir> RESV_PGPORT=<port> RESV_PGSUPER=<local superuser> RESV_G5_SOURCE_DIR=<G5 source>
# Local only; never a remote project. Roles are cluster-wide: run alone.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
g3="$root/supabase/candidates/postona_threads_reservations"
tmp="$(mktemp -d /private/tmp/g2-claim.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
chmod 755 "$tmp"
out="$tmp/g2.out"; : > "$out"; chmod 666 "$out"
cat > "$tmp/rollback_with_g2.sql" <<SQL
\set ON_ERROR_STOP 1
select (to_regnamespace('postona_threads_resv') is not null) as g2_has_schema \gset
\if :g2_has_schema
\set g2out '$out'
\i $here/g2_claim_scenarios.sql
\endif
\i $g3/007_postona_threads_reservations_rollback.sql
SQL
THREADS_RESV_ROLLBACK="$tmp/rollback_with_g2.sql" "$g3/postona_threads_reservations_run.sh"
echo "--- G2 scenario markers"
grep -E '^[[:space:]]*G2_' "$out" | sed 's/^ *//; s/ *$//'
grep -Eq '^[[:space:]]*G2_THREADS_CLAIM_SCENARIOS_ALL_PASS' "$out"
