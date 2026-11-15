#!/bin/bash
# Applies the repository's REAL supabase/migrations/*.sql, in order, to a DISPOSABLE local database after the compat stub.
# Usage: load_real_schema.sh <dbname> <psql connection args...>   (never a remote database)
# Prints: applied / failed lists. A migration runs in one transaction; a failing file is recorded and skipped.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
db="$1"; shift
export LC_ALL=C
psql "$@" -d postgres -qAt -c "drop database if exists $db" -c "create database $db" >/dev/null
psql "$@" -d "$db" -qAt -v ON_ERROR_STOP=1 -f "$here/supabase_stub.sql" >/dev/null
applied=0; failed=()
for f in "$repo"/supabase/migrations/*.sql; do
  if psql "$@" -d "$db" -qAt -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null 2>"$here/.last_err"; then
    applied=$((applied + 1))
  else
    failed+=("$(basename "$f")|$(head -c 200 "$here/.last_err" | tr '\n' ' ')")
  fi
done
echo "applied=$applied failed=${#failed[@]}"
printf '%s\n' "${failed[@]:-}"
