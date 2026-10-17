#!/usr/bin/env bash
# Mutation check of the erasure proof: each mutant removes one safeguard from a COPY of the migration, and the
# proof runner must FAIL on it. A mutant that survives means a test does not see that safeguard.
#
#   ACS_PGHOST=/private/tmp/<socket dir> ACS_PGPORT=54912 ACS_PGSUPER=<superuser> bash supabase/tests/ai_ledger_user_erasure_mutations.sh
set -euo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$HERE/../migrations/20261017150000_ai_ledger_user_erasure.sql"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/aue_mut.XXXXXX")"
trap 'find "$WORK" -type f -delete 2>/dev/null || true; rmdir "$WORK" 2>/dev/null || true' EXIT

killed=0
survived=0
mutant() {
  local name="$1" parts="$2" expr="$3" file="$WORK/$1.sql" log="$WORK/$1.log"
  perl -0pe "$expr" "$SOURCE" >"$file"
  if cmp -s "$SOURCE" "$file"; then echo "BROKEN MUTANT (no change): $name" >&2; exit 1; fi
  if AUE_MIGRATION="$file" AUE_PARTS="$parts" bash "$HERE/ai_ledger_user_erasure_run.sh" >"$log" 2>&1; then
    echo "SURVIVED: $name"
    survived=$((survived + 1))
  else
    echo "KILLED: $name -> $(grep -E 'FAIL|ERROR' "$log" | head -1 | sed 's/^psql:[^ ]* //' | cut -c1-140)"
    killed=$((killed + 1))
  fi
}

# the immutability exception
mutant reservation_any_change_when_announced behaviour \
  "s/    if ai_ledger.erasure_allows\(old.user_id, new.user_id\)\n       and \(to_jsonb\(new\) - 'user_id' - 'attempt_id'\) = \(to_jsonb\(old\) - 'user_id' - 'attempt_id'\) then/    if ai_ledger.erasure_allows(old.user_id, new.user_id) then/"
mutant reservation_user_change_without_announcement behaviour \
  "s/    if ai_ledger.erasure_allows\(old.user_id, new.user_id\)\n       and \(to_jsonb\(new\)/    if (to_jsonb(new)/"
mutant event_any_change_when_announced behaviour \
  "s/  if tg_op = 'UPDATE' and ai_ledger.erasure_allows\(old.user_id, new.user_id\)\n     and \(to_jsonb\(new\) - 'user_id'\) = \(to_jsonb\(old\) - 'user_id'\) then/  if tg_op = 'UPDATE' and ai_ledger.erasure_allows(old.user_id, new.user_id) then/"
mutant event_delete_allowed behaviour \
  "s/  if tg_op = 'UPDATE' and ai_ledger.erasure_allows/  if tg_op = 'DELETE' then return old; end if;\n  if tg_op = 'UPDATE' and ai_ledger.erasure_allows/"
mutant allows_any_target_shape behaviour \
  "s/ and ai_ledger.is_erased_subject\(p_new\)//"
mutant allows_renaming_erased behaviour \
  "s/\n     and not ai_ledger.is_erased_subject\(p_old\) and/\n     and/"
mutant allows_any_announcement behaviour \
  "s/\n     and v = p_old::text \|\| '>' \|\| p_new::text;/;/"
# the erasure RPC
mutant erase_ignores_call_store behaviour \
  "s/  if v_calls > 0 then/  if false then/"
mutant erase_ignores_in_flight behaviour \
  "s/  if v_in_flight > 0 then/  if false then/"
mutant erase_without_reserve_lock concurrency \
  "s/  perform pg_advisory_xact_lock\(hashtextextended\('ai_ledger:reserve', 0\)\);\n//"
mutant erase_without_user_lock concurrency \
  "s/  perform pg_advisory_xact_lock\(hashtextextended\('ai_calls:user:' \|\| v_user::text, 0\)\);\n  perform pg_advisory_xact_lock\(hashtextextended\('ai_ledger:reserve', 0\)\);/  perform pg_advisory_xact_lock(hashtextextended('ai_ledger:reserve', 0));/"
mutant erase_returns_erased_id behaviour \
  "s/'budget_buckets', v_buckets, 'budget_policies', v_policies\);/'budget_buckets', v_buckets, 'budget_policies', v_policies, 'erased_subject', v_erased);/"
mutant erase_dates_buckets behaviour \
  "s/update ai_ledger.budget_buckets b set user_id = v_erased where/update ai_ledger.budget_buckets b set user_id = v_erased, updated_at = now() where/"
mutant erase_keeps_policy_enabled behaviour \
  "s/set scope_user_id = v_erased, enabled = false, policy_key/set scope_user_id = v_erased, policy_key/"
mutant erase_keeps_policy_user behaviour \
  "s/  update ai_ledger.budget_policies pol\n     set scope_user_id = v_erased, enabled = false, policy_key = 'erased.' \|\| pol.id::text, note = null\n   where pol.scope_user_id = v_user;\n  get diagnostics v_policies = row_count;/  v_policies := 0;/"
# P2: policy key / note
mutant policy_note_kept behaviour \
  "s/, policy_key = 'erased.' \|\| pol.id::text, note = null/, policy_key = 'erased.' || pol.id::text/"
mutant policy_key_kept behaviour \
  "s/, enabled = false, policy_key = 'erased.' \|\| pol.id::text, note = null/, enabled = false, note = null/"
mutant no_stray_mention_refusal behaviour \
  "s/  if v_mentions > 0 then/  if false then/"
mutant no_key_conflict_check behaviour \
  "s/  if exists \(select 1 from ai_ledger.budget_policies pol\n               join ai_ledger.budget_policies other/  if false and exists (select 1 from ai_ledger.budget_policies pol\n               join ai_ledger.budget_policies other/"
mutant mentions_keep_dashes behaviour \
  "s/position\(replace\(p_user::text, '-', ''\) in lower\(replace\(p_text, '-', ''\)\)\)/position(p_user::text in lower(p_text))/"
mutant mentions_case_sensitive behaviour \
  "s/in lower\(replace\(p_text, '-', ''\)\)\)/in replace(p_text, '-', ''))/"
mutant footprint_no_policy_mentions behaviour \
  "s/    'policy_mentions', \(select count\(\*\) from ai_ledger.budget_policies pol\n                         where ai_ledger.mentions_user\(pol.policy_key, v_user\) or ai_ledger.mentions_user\(pol.note, v_user\)\),\n//"
# P3b: READ COMMITTED only
mutant erase_any_isolation snapshot \
  "s/(create function public.ai_ledger_erase_user[\s\S]*?)  if current_setting\('transaction_isolation'\) <> 'read committed' then/\$1  if false then/"
mutant footprint_any_isolation snapshot \
  "s/(create function public.ai_ledger_user_footprint[\s\S]*?)  if current_setting\('transaction_isolation'\) <> 'read committed' then/\$1  if false then/"
mutant forget_brand_any_isolation snapshot \
  "s/(create function public.ai_calls_forget_system_brand[\s\S]*?)  if current_setting\('transaction_isolation'\) <> 'read committed' then/\$1  if false then/"
# P3a: never delete an acquired row
mutant forget_brand_deletes_acquired concurrency \
  "s/ and c.brand_ref = v_brand and c.state <> 'acquired';/ and c.brand_ref = v_brand;/"
mutant erase_leaves_setting behaviour \
  "s/  perform set_config\('ai_ledger.erasure', '', true\);\n//"
mutant erase_accepts_erased_subject behaviour \
  "s/  if ai_ledger.is_erased_subject\(v_user\) then/  if false then/"
# the call-store helpers
mutant forget_brand_any_slug behaviour \
  "s/'brand_ref', true, '\^u_\[0-9a-f\]\{24\}\\\$'\)/'brand_ref', true, '^[a-z][a-z0-9_]{1,40}\\\$')/"
mutant forget_brand_also_user_rows behaviour \
  "s/   where c.subject_kind = 'system' and c.brand_ref = v_brand and c.state <> 'acquired';/   where c.brand_ref = v_brand and c.state <> 'acquired';/"
mutant forget_brand_ignores_in_flight behaviour \
  "s/  if v_in_flight > 0 then\n    return jsonb_build_object\('forgotten'/  if false then\n    return jsonb_build_object('forgotten'/"
mutant candidates_ignore_age behaviour \
  "s/ and c.created_at <= now\(\) - make_interval\(secs => v_age\)//"
mutant candidates_leak_user behaviour \
  "s/      select c.call_key, c.tenant_tag, c.application,/      select c.call_key, c.user_id, c.tenant_tag, c.application,/"
mutant footprint_misses_call_store behaviour \
  "s/,\n    'call_rows', \(select count\(\*\) from ai_calls.consumer_calls c where c.user_id = v_user\)\);/);/"
# access
mutant grant_erase_to_authenticated behaviour \
  "s/(-- Access verification over BOTH schemas)/grant execute on function public.ai_ledger_erase_user(jsonb) to authenticated;\n\n\$1/"
mutant helper_security_definer behaviour \
  "s/create function ai_ledger.erasure_allows\(p_old uuid, p_new uuid\)\nreturns boolean\nlanguage plpgsql\nstable\n/create function ai_ledger.erasure_allows(p_old uuid, p_new uuid)\nreturns boolean\nlanguage plpgsql\nstable\nsecurity definer\n/"
mutant rpc_without_search_path behaviour \
  "s/(create function public.ai_ledger_erase_user\(p jsonb\)\nreturns jsonb\nlanguage plpgsql\nsecurity definer\n)set search_path = ''\n/\$1/"

echo "mutants: $killed killed, $survived survived"
[ "$survived" -eq 0 ]
