#!/usr/bin/env bash
# Multibrand worktree safety check. Read-only: inspects files, changes nothing.
# Run before any Supabase CLI command in this worktree:
#   bash scripts/multibrand/check-safe-env.sh
set -u

PROD_REF="wsmznyzcvmuitkglfeuj"
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "NG: not inside a git worktree"; exit 1; }
cd "$ROOT" || exit 1
status=0

ok() { echo "OK: $1"; }
ng() { echo "NG: $1"; status=1; }

branch="$(git rev-parse --abbrev-ref HEAD)"
case "$branch" in
  main) ng "on branch main — multibrand work must stay on feature/multibrand-* branches" ;;
  feature/multibrand-*) ok "branch $branch" ;;
  *) ng "unexpected branch $branch" ;;
esac

[ "$ROOT" = "/Users/yuya/Developer/kabumori" ] && ng "this is the shared production checkout, not the multibrand worktree"

if [ -f supabase/config.toml ]; then
  if grep -q "$PROD_REF" supabase/config.toml; then
    ng "supabase/config.toml references the production project ref"
  else
    ok "supabase/config.toml is local-only (CLI root is anchored in this worktree)"
  fi
else
  ng "supabase/config.toml missing — CLI may walk up into another checkout"
fi

if [ -e supabase/.temp/project-ref ] || [ -e supabase/.temp/linked-project.json ]; then
  ng "supabase/.temp link files exist — this worktree must not be linked (remove them)"
else
  ok "not linked to any remote Supabase project"
fi

if ls .env .env.* 2>/dev/null | grep -qv '\.example$'; then
  ng ".env file present — production secrets must not live in this worktree"
else
  ok "no .env files"
fi

if [ -n "${SUPABASE_ACCESS_TOKEN:-}" ] || [ -n "${SUPABASE_DB_PASSWORD:-}" ]; then
  ng "SUPABASE_ACCESS_TOKEN / SUPABASE_DB_PASSWORD set in this shell"
fi

echo
if [ "$status" -eq 0 ]; then
  echo "SAFE: production cannot be reached from this worktree via linked CLI state."
  echo "Still never pass --project-ref $PROD_REF or run deploy/db push/secrets set here."
else
  echo "UNSAFE: fix the NG items before running any Supabase command."
fi
exit "$status"
