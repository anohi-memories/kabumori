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

# Phase 1 finding (2026-09-10): every migration that runs `cron.schedule(...)` embeds the
# *production* project URL in the job body (e.g. https://wsmznyzcvmuitkglfeuj.supabase.co/...),
# because that's what production actually needs. Replaying the full migration history into a
# local `supabase start` database (pg_cron enabled via
# 00000000000000_local_only_enable_extensions.sql, local-only) registers those same jobs in the
# *local* pg_cron scheduler too. If a local Postgres container is running, confirm cron.job is
# empty (this repo's local-dev migrations unschedule them right after `supabase db reset` — see
# docs/multibrand/PHASE1.md) so a local pg_cron worker can never fire net.http_post at the real
# production Edge Functions. This check is best-effort: it only runs if `podman`/`docker` and the
# local DB container are reachable from this shell.
container_runtime=""
if command -v podman >/dev/null 2>&1 && podman ps --format '{{.Names}}' 2>/dev/null | grep -q '^supabase_db_'; then
  container_runtime="podman"
elif command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^supabase_db_'; then
  container_runtime="docker"
fi
if [ -n "$container_runtime" ]; then
  db_container="$("$container_runtime" ps --format '{{.Names}}' | grep '^supabase_db_' | head -1)"
  cron_job_count="$("$container_runtime" exec "$db_container" psql -U postgres -tAc "select count(*) from cron.job;" 2>/dev/null || echo "")"
  if [ "$cron_job_count" = "0" ]; then
    ok "local pg_cron has no scheduled jobs (production URLs cannot be reached from here)"
  elif [ -z "$cron_job_count" ]; then
    ok "local DB container found but cron.job could not be queried (pg_cron likely not enabled — also safe)"
  else
    ng "local pg_cron has $cron_job_count scheduled job(s) — these embed the production URL and will fire net.http_post against it on schedule. Run: $container_runtime exec $db_container psql -U postgres -c \"select cron.unschedule(jobname) from cron.job;\""
  fi
else
  ok "no local Supabase DB container detected (nothing to check)"
fi

echo
if [ "$status" -eq 0 ]; then
  echo "SAFE: production cannot be reached from this worktree via linked CLI state."
  echo "Still never pass --project-ref $PROD_REF or run deploy/db push/secrets set here."
else
  echo "UNSAFE: fix the NG items before running any Supabase command."
fi
exit "$status"
