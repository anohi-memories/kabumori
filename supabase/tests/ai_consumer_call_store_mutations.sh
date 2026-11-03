#!/usr/bin/env bash
# Mutation check of the call-store proof: each mutant removes one safeguard from a COPY of the migration, and the
# proof runner must FAIL on it. A mutant that survives means a test does not see that safeguard.
#
#   ACS_PGHOST=/private/tmp/<socket dir> ACS_PGPORT=54911 ACS_PGSUPER=<superuser> bash supabase/tests/ai_consumer_call_store_mutations.sh
set -euo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$HERE/../migrations/20261017120000_ai_consumer_call_store.sql"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/acs_mut.XXXXXX")"
trap 'find "$WORK" -type f -delete 2>/dev/null || true; rmdir "$WORK" 2>/dev/null || true' EXIT

# mutant <name> <parts> <perl substitution>: the substitution must change the file.
killed=0
survived=0
mutant() {
  local name="$1" parts="$2" expr="$3" file="$WORK/$1.sql" log="$WORK/$1.log"
  perl -0pe "$expr" "$SOURCE" >"$file"
  if cmp -s "$SOURCE" "$file"; then echo "BROKEN MUTANT (no change): $name" >&2; exit 1; fi
  if ACS_MIGRATION="$file" ACS_PARTS="$parts" bash "$HERE/ai_consumer_call_store_run.sh" >"$log" 2>&1; then
    echo "SURVIVED: $name"
    survived=$((survived + 1))
  else
    echo "KILLED: $name -> $(grep -E 'FAIL|ACS_TEST_FAIL|ERROR' "$log" | head -1 | cut -c1-150)"
    killed=$((killed + 1))
  fi
}

mutant claim_no_busy behaviour \
  "s/  if v_row.state = 'acquired' then\n    return jsonb_build_object\('kind', 'busy'\);\n  end if;\n//"
mutant claim_no_drift_check behaviour \
  "s/is distinct from \(v_tenant, v_fingerprint, v_application, v_feature, v_subject, v_user\)/is distinct from (v_row.tenant_tag, v_row.fingerprint, v_row.application, v_row.feature, v_row.subject_kind, v_row.user_id)/"
mutant claim_no_key_lock concurrency \
  "s/  perform pg_advisory_xact_lock\(hashtextextended\('ai_calls:call:' \|\| v_key, 0\)\);\n\n  select c.\* into v_row from ai_calls.consumer_calls c where c.call_key = v_key for update;/  select c.* into v_row from ai_calls.consumer_calls c where c.call_key = v_key;/"
mutant claim_no_user_lock concurrency \
  "s/  if v_subject = 'user' then\n    perform pg_advisory_xact_lock_shared\(hashtextextended\('ai_calls:user:' \|\| v_user::text, 0\)\);\n  end if;\n//"
mutant forget_no_user_lock concurrency \
  "s/  perform pg_advisory_xact_lock\(hashtextextended\('ai_calls:user:' \|\| v_user::text, 0\)\);\n  select count\(\*\) into v_in_flight/  select count(*) into v_in_flight/"
mutant complete_no_row_lock concurrency \
  "s/(select c.\* into v_row from ai_calls.consumer_calls c where c.call_key = v_key) for update;\n  if not found then\n    raise exception 'AI_CALLS_NOT_CLAIMED'/\$1;\n  if not found then\n    raise exception 'AI_CALLS_NOT_CLAIMED'/"
mutant abandon_no_locks concurrency \
  "s/  perform pg_advisory_xact_lock\(hashtextextended\('ai_calls:call:' \|\| v_key, 0\)\);\n  select c.\* into v_row from ai_calls.consumer_calls c where c.call_key = v_key for update;\n  if not found then\n    return/  select c.* into v_row from ai_calls.consumer_calls c where c.call_key = v_key;\n  if not found then\n    return/"
mutant complete_no_owner_check behaviour \
  "s/if v_row.claim_token is distinct from v_owner or v_row.state = 'abandoned' then/if v_row.state = 'abandoned' then/"
mutant complete_no_result_validation behaviour \
  "s/if not ai_calls.result_ok\(v_result, v_row.call_key, v_row.tenant_tag, v_row.feature\) then/if false then/"
mutant complete_overwrites_result behaviour \
  "s/    if v_row.result = v_result then\n      return jsonb_build_object\('state', 'complete', 'duplicate', true\);\n    end if;\n    raise exception 'AI_CALLS_RESULT_CONFLICT' using errcode = 'P0001';/    return jsonb_build_object('state', 'complete', 'duplicate', true);/"
mutant abandon_no_age_check behaviour \
  "s/if v_row.created_at > now\(\) - make_interval\(secs => v_age\) then/if false then/"
mutant abandon_no_ledger_check behaviour \
  "s/  if v_open > 0 then/  if false then/"
mutant abandon_no_audit_ledger_check behaviour \
  "s/    raise exception 'AI_CALLS_AUDIT_LEDGER_MISMATCH' using errcode = 'P0001';/    null;/"
mutant purge_ignores_window behaviour \
  "s/\n       and c.completed_at <= now\(\) - make_interval\(hours => v_hours::integer\)//"
mutant purge_drops_audit behaviour \
  "s/set result = ai_calls.tombstone\(c.audit\), content_purged_at = now\(\)/set result = jsonb_build_object('ok', false, 'code', 'UNKNOWN', 'audit', null), content_purged_at = now()/"
mutant forget_ignores_in_flight behaviour \
  "s/  if v_in_flight > 0 then/  if false then/"
mutant forget_all_users behaviour \
  "s/delete from ai_calls.consumer_calls c where c.user_id = v_user;/delete from ai_calls.consumer_calls c where c.user_id is not null;/"
mutant trigger_allows_rewrite behaviour \
  "s/  raise exception 'AI_CALLS_TRANSITION: % -> %', old.state, new.state using errcode = 'P0001';/  return new;/"
mutant grant_rpc_to_authenticated behaviour \
  "s/(-- Access verification \(same rules)/grant execute on function public.ai_calls_claim(jsonb) to authenticated;\n\n\$1/"
mutant grant_table_to_service_role behaviour \
  "s/(-- Access verification \(same rules)/grant usage on schema ai_calls to service_role;\ngrant select on ai_calls.consumer_calls to service_role;\n\n\$1/"
mutant rpc_without_definer_search_path behaviour \
  "s/(create function public.ai_calls_forget_user\(p jsonb\)\nreturns jsonb\nlanguage plpgsql\nsecurity definer\n)set search_path = ''\n/\$1/"
mutant rls_off behaviour \
  "s/alter table ai_calls.consumer_calls enable row level security;\n//"

echo "mutants: $killed killed, $survived survived"
[ "$survived" -eq 0 ]
