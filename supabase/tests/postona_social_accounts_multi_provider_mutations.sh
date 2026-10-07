#!/usr/bin/env bash
# Defect-detection proof for postona_social_accounts_multi_provider_run.sh. Each mutation breaks
# exactly one safety property in a COPY of the candidate
# (20261007150000_postona_social_accounts_multi_provider.sql), runs the runner against it and
# requires the runner to fail at the check that guards that property: every mutation names the
# failure it must produce, never a generic one. The real candidate is never edited. An unmutated
# copy must pass first.
# Runs ONE AT A TIME: the runner changes cluster-wide role memberships and must run alone.
# A mutation may change several sites at once (separated by \x1f) when one property lives in several
# places. Disposable local PostgreSQL only; same environment as the runner, plus python3.
# Usage: POSTONA_PGHOST=... POSTONA_PGPORT=... POSTONA_PGSUPER=... \
#        supabase/tests/postona_social_accounts_multi_provider_mutations.sh
set -euo pipefail
export LC_ALL=C

here="$(cd "$(dirname "$0")" && pwd)"
candidate="$here/../migrations/20261007150000_postona_social_accounts_multi_provider.sql"
runner="$here/postona_social_accounts_multi_provider_run.sh"
tmp="$(mktemp -d /private/tmp/kabumori-postona-mutations.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
S=$'\x1f'

labels=(); olds=(); news=(); expects=()
mutation() { labels+=("$1"); olds+=("$2"); news+=("$3"); expects+=("$4"); }

# --- the three constraints ------------------------------------------------------------------
mutation "Meta rows may keep an X refresh reference" \
  "check (platform = 'x' or vault_refresh_token_secret_id is null)" \
  "check (platform = 'x' or vault_refresh_token_secret_id is null or vault_access_token_secret_id is not null)" \
  "FAIL threads with an X-style refresh reference refused"
mutation "Meta rows may be publish-enabled" \
  "check (platform = 'x' or publish_enabled is false)" \
  "check (platform = 'x' or publish_enabled is not null)" \
  "FAIL threads created publish-enabled refused"
mutation "Instagram is not accepted" \
  "check (platform in ('x', 'threads', 'instagram'))" \
  "check (platform in ('x', 'threads'))" \
  'violates check constraint "social_accounts_platform_supported"'
mutation "an unknown provider is accepted" \
  "check (platform in ('x', 'threads', 'instagram'))" \
  "check (platform in ('x', 'threads', 'instagram', 'tiktok'))" \
  "FAIL platform 'tiktok' refused"
mutation "provider spelling is not exact" \
  "check (platform in ('x', 'threads', 'instagram'))" \
  "check (lower(btrim(platform)) in ('x', 'threads', 'instagram'))" \
  "FAIL platform 'X' refused"
# --- precondition: the X-only CHECK ------------------------------------------------------------
mutation "a NOT VALID X-only CHECK is trusted" \
  "    and pg_catalog.pg_get_constraintdef(c.oid) = 'CHECK ((platform = ''x''::text))';" \
  "    and pg_catalog.pg_get_constraintdef(c.oid) like 'CHECK ((platform = ''x''::text))%';" \
  "FAIL check_not_valid: expected POSTONA_ACCOUNTS_PRECONDITION_PLATFORM_CHECK"
mutation "the X-only CHECK is found by name" \
  "    and pg_catalog.pg_get_constraintdef(c.oid) = 'CHECK ((platform = ''x''::text))';" \
  "    and c.conname = 'social_accounts_platform_check';" \
  "FAIL check_widened: expected POSTONA_ACCOUNTS_PRECONDITION_PLATFORM_CHECK"
mutation "another CHECK on platform is tolerated" \
  "  if v_checks <> 1 or v_old_check is null then" \
  "  if v_old_check is null then" \
  "FAIL check_duplicated: expected POSTONA_ACCOUNTS_PRECONDITION_PLATFORM_CHECK"
mutation "re-apply is not recognised" \
  "    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_ALREADY_APPLIED';" \
  "    null;" \
  "FAIL re-apply: expected ALREADY_APPLIED"
# --- precondition: uniqueness, shape ----------------------------------------------------------
mutation "UNIQUE (brand_id, platform) is not required" \
  "    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_UNIQUE';" \
  "    null;" \
  "FAIL unique_missing: expected POSTONA_ACCOUNTS_PRECONDITION_UNIQUE"
mutation "a partial unique index counts" \
  "i.indisunique and i.indisvalid and i.indpred is null" \
  "i.indisunique and i.indisvalid" \
  "FAIL unique_partial: expected POSTONA_ACCOUNTS_PRECONDITION_UNIQUE"
mutation "column types and nullability are not checked" \
  "= 'uuid'))) <> 5 then" \
  "= 'uuid'))) < 0 then" \
  "FAIL publish_nullable: expected POSTONA_ACCOUNTS_PRECONDITION_SHAPE"
mutation "inheritance is not checked" \
  "     or exists (select 1 from pg_catalog.pg_inherits h where h.inhrelid = v_table or h.inhparent = v_table)
" \
  "" \
  "FAIL inherited: expected POSTONA_ACCOUNTS_PRECONDITION_SHAPE"
# --- precondition: access -------------------------------------------------------------------
mutation "authenticated may update the table" \
  "                   or pg_catalog.has_any_column_privilege(r, v_table, 'UPDATE')
" \
  "" \
  "FAIL auth_update: expected POSTONA_ACCOUNTS_PRECONDITION_ACL"
mutation "an app role may truncate the table" \
  "                   or pg_catalog.has_table_privilege(r, v_table, 'TRUNCATE')" \
  "" \
  "FAIL auth_truncate: expected POSTONA_ACCOUNTS_PRECONDITION_ACL"
mutation "only anon's privileges are checked" \
  "unnest(array['anon', 'authenticated']) r" \
  "unnest(array['anon']) r" \
  "FAIL auth_update: expected POSTONA_ACCOUNTS_PRECONDITION_ACL"
mutation "RLS may be off" \
  "  if (select c.relrowsecurity and not c.relforcerowsecurity from" \
  "  if (select not c.relforcerowsecurity from" \
  "FAIL rls_off: expected POSTONA_ACCOUNTS_PRECONDITION_ACL"
mutation "forced RLS is tolerated" \
  "  if (select c.relrowsecurity and not c.relforcerowsecurity from" \
  "  if (select c.relrowsecurity from" \
  "FAIL rls_forced: expected POSTONA_ACCOUNTS_PRECONDITION_ACL"
# --- precondition: owner, role graph ----------------------------------------------------------
mutation "the creator need not own the table" \
  "    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_OWNER';" \
  "    null;" \
  "FAIL creator is not the owner: expected POSTONA_ACCOUNTS_PRECONDITION_OWNER"
mutation "a superuser owner may apply" \
  "     or (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) is distinct from false then" \
  "     then" \
  "FAIL table owned by a superuser, applied by it: expected POSTONA_ACCOUNTS_PRECONDITION_OWNER"
mutation "app roles may inherit the owner" \
  "    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_ROLE_GRAPH';" \
  "    null;" \
  "FAIL authenticated inherits the owner: expected POSTONA_ACCOUNTS_PRECONDITION_ROLE_GRAPH"
# --- locking ----------------------------------------------------------------------------------
mutation "lock waits are unbounded" \
  "set local lock_timeout = '5s';" \
  "" \
  "FAIL lock held: expected the lock timeout"
mutation "the table is not held from the precondition on" \
  "  lock table public.social_accounts in access exclusive mode;" \
  "" \
  "FAIL lock taken: a writer got in"
# --- postcondition ----------------------------------------------------------------------------
mutation "the postcondition does not compare the snapshot" \
  "  if v_before is distinct from pg_catalog.jsonb_build_object(" \
  "  if false and v_before is distinct from pg_catalog.jsonb_build_object(" \
  "FAIL postcondition: grant_select_anon: expected POSTONA_ACCOUNTS_POSTCONDITION_UNCHANGED"
mutation "the postcondition does not compare rows" \
  "               from public.social_accounts sa))::text${S}               from public.social_accounts sa)) then" \
  "               from public.social_accounts sa where false))::text${S}               from public.social_accounts sa where false)) then" \
  "FAIL postcondition: row_changed: expected POSTONA_ACCOUNTS_POSTCONDITION_UNCHANGED"
mutation "the postcondition does not count the new constraints" \
  "and c.convalidated and c.conname = any (v_new)) <> 3" \
  "and c.convalidated and c.conname = any (v_new)) < 0" \
  "FAIL postcondition: new_check_dropped: expected POSTONA_ACCOUNTS_POSTCONDITION_CONSTRAINTS"

total="${#labels[@]}"
make_copy() { # source target olds news
  python3 - "$1" "$2" "$3" "$4" <<'PY'
import sys
source, target, olds, news = sys.argv[1:5]
text = open(source, encoding="utf-8").read()
olds, news = olds.split("\x1f"), news.split("\x1f")
if len(olds) != len(news):
    sys.exit("mutation sites and replacements differ in number")
for old, new in zip(olds, news):
    if text.count(old) != 1:
        sys.exit(f"mutation site matched {text.count(old)} times: {old!r}")
    text = text.replace(old, new)
open(target, "w", encoding="utf-8").write(text)
PY
}

# Control: an unmutated copy passes.
cp "$candidate" "$tmp/control.sql"
POSTONA_CANDIDATE="$tmp/control.sql" "$runner" > "$tmp/control.out" 2>&1 || { cat "$tmp/control.out" >&2; echo "FAIL the unmutated copy does not pass" >&2; exit 1; }
grep -q POSTONA_ACCOUNTS_CLEANUP_PASS "$tmp/control.out" || { echo "FAIL control run incomplete" >&2; exit 1; }
echo "CONTROL_PASS"

detected=0
for i in $(seq 0 $((total - 1))); do
  work="$tmp/m$i"; status=0
  mkdir -p "$work"
  if ! make_copy "$candidate" "$work/mutant.sql" "${olds[$i]}" "${news[$i]}" 2> "$work/out"; then
    echo "INVALID  ${labels[$i]}: $(cat "$work/out")" >&2; continue
  fi
  POSTONA_CANDIDATE="$work/mutant.sql" "$runner" > "$work/out" 2>&1 || status=$?
  if [[ "$status" -ne 0 ]] && grep -qF -- "${expects[$i]}" "$work/out"; then
    detected=$((detected + 1))
    echo "DETECTED  ${labels[$i]}"
  elif [[ "$status" -ne 0 ]]; then
    echo "WRONG_REASON  ${labels[$i]}: $(grep -E 'FAIL|ERROR' "$work/out" | grep -v NOTICE | head -2)" >&2
  else
    echo "SURVIVED  ${labels[$i]}" >&2
  fi
done
[[ "$detected" -eq "$total" ]] || { echo "FAIL $((total - detected)) of $total mutations were not detected as expected" >&2; exit 1; }
echo "POSTONA_ACCOUNTS_MUTATIONS_ALL_DETECTED $detected/$total"
