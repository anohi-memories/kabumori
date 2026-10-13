#!/usr/bin/env bash
# Disposable-only proof runner for 20261013140000_common_account_service_reconciliation_facts (common account
# Phase 8, F5: the durable reconciliation fact of an end and its read-back). Builds the lifecycle suites'
# production-shaped baseline (fixtures, the real onboarding and social-mobile deletion migrations, Phase 1, 2, 3a, the
# Phase 3b guard, Phase 4, Phase 5 and Phase 6) on a LOCAL Unix-socket PostgreSQL, applies the candidate as a
# non-superuser owner and proves: preflight refusals, the exact schema change, refused re-apply, static source rules,
# the behavior suite and the emergency rollback. Fake data only; never production.
#
# Usage: CAL_PGHOST=/private/tmp/<socket-dir> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> \
#        bash supabase/tests/common_account_service_reconciliation_run.sh
# Optional: CAL_RECON_CANDIDATE=<file> (mutation runs), CAL_RECON_SECTIONS=preflight,exact,static,behavior,rollback
set -euo pipefail
export LC_ALL=C

host="${CAL_PGHOST:?CAL_PGHOST (local socket dir) required}"
port="${CAL_PGPORT:?CAL_PGPORT required}"
super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac

here="$(cd "$(dirname "$0")" && pwd)"
migrations="$here/../migrations"
candidate="${CAL_RECON_CANDIDATE:-$migrations/20261013140000_common_account_service_reconciliation_facts.sql}"
rollback_file="${CAL_RECON_ROLLBACK:-$here/common_account_service_reconciliation_rollback.sql}"
sections="${CAL_RECON_SECTIONS:-all}"
want() { [[ "$sections" == all || ",$sections," == *",$1,"* ]]; }
owner="kb_cal_recon_owner"
tag="$$"
tpl="kabumori_cal_rc_tpl_$tag"
db_exact="kabumori_cal_rc_exact_$tag"
db_run="kabumori_cal_rc_run_$tag"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
psql_o() { local d="$1"; shift; psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" "$@"; }
psql_q() { local d="$1"; shift; psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" "$@"; }
tmp="$(mktemp -d /private/tmp/kabumori-cal-recon.XXXXXX)"
cleanup() {
  rm -rf "$tmp"
  for d in "$db_run" "$db_exact" "kabumori_cal_rc_pf_$tag" "$tpl"; do
    "${S[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = '$owner') then create role $owner login nosuperuser nocreatedb nocreaterole; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'kb_cal_svc_child') then create role kb_cal_svc_child nologin inherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'kb_cal_auth_child') then create role kb_cal_auth_child nologin inherit; end if;
end \$\$;
grant service_role to kb_cal_svc_child;
grant authenticated to kb_cal_auth_child;
grant anon, authenticated, service_role, kb_cal_svc_child, kb_cal_auth_child to $owner;
create database $tpl owner $owner;
SQL
P=(psql_o "$tpl")
"${P[@]}" -f "$here/social_mobile_account_deletion_fixture.sql" >/dev/null
"${P[@]}" -f "$migrations/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1
"${P[@]}" -f "$migrations/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql" >/dev/null
"${P[@]}" -f "$migrations/20260928160000_social_mobile_account_deletion_candidate.sql" >/dev/null
"${P[@]}" -f "$here/common_account_lifecycle_fixture.sql" >/dev/null
"${P[@]}" -f "$migrations/20261001150000_common_account_lifecycle_foundation.sql" >/dev/null
"${P[@]}" -f "$migrations/20261006230000_common_account_service_start_intent.sql" >/dev/null
"${P[@]}" -f "$migrations/20261009120000_common_account_deletion_completion.sql" >/dev/null
"${P[@]}" -f "$here/common_account_write_guard_fixture.sql" >/dev/null
"${S[@]}" -d "$tpl" -c "alter function public.fixture_foreign_owner_service_write(text) owner to kb_cal_svc_child" >/dev/null
for f in 20261010051938_common_account_service_write_guard 20261012130000_common_account_core_service_fence \
         20261012230000_common_account_service_brand_state 20261013120000_common_account_service_deletion_ownership; do
  "${P[@]}" -f "$migrations/$f.sql" >/dev/null
done
echo "COMMON_ACCOUNT_RECONCILIATION_BASELINE_READY"

"${S[@]}" -d postgres -c "create database $db_exact template $tpl owner $owner" >/dev/null
"${S[@]}" -d postgres -c "create database $db_run template $tpl owner $owner" >/dev/null
O=(psql_o "$db_exact")

has_new_objects() {
  psql_q "$1" -c "select to_regprocedure('public.common_account_service_end_result(uuid,text)') is not null"
}
refused_with() {  # database code -> the candidate is refused with it and leaves nothing behind
  local out
  if out="$(psql_o "$1" -f "$candidate" 2>&1)"; then echo "FAIL preflight accepted: expected $2" >&2; exit 1; fi
  grep -q "$2" <<<"$out" || { echo "FAIL preflight reason (expected $2): $out" >&2; exit 1; }
  [[ "$(has_new_objects "$1")" == f ]] || { echo "FAIL preflight left objects ($2)" >&2; exit 1; }
  [[ "$(psql_q "$1" -c "select exists (select 1 from pg_attribute where attrelid = 'private.account_lifecycle_operations'::regclass and attname = 'reconciliation' and not attisdropped)")" == f ]] \
    || { echo "FAIL preflight left the column ($2)" >&2; exit 1; }
}

if want preflight; then
  d="kabumori_cal_rc_pf_$tag"
  # Without Phase 6: refused.
  "${S[@]}" -d postgres -c "create database $d template $tpl owner $owner" >/dev/null
  psql_q "$d" -c "alter function public.claim_service_deletion(uuid,text,uuid,uuid,uuid,integer) rename to claim_service_deletion_moved" >/dev/null
  refused_with "$d" COMMON_ACCOUNT_RECONCILIATION_PREFLIGHT_PHASE6_MISSING
  "${S[@]}" -d postgres -c "drop database $d with (force)" >/dev/null
  # The Phase 6 owner check reachable by an API role: refused.
  "${S[@]}" -d postgres -c "create database $d template $tpl owner $owner" >/dev/null
  psql_q "$d" -c "grant execute on function private.account_lifecycle_owned_service_operation(uuid,text,uuid,uuid) to service_role" >/dev/null
  refused_with "$d" COMMON_ACCOUNT_RECONCILIATION_PREFLIGHT_OWNER_CHECK_ACL
  "${S[@]}" -d postgres -c "drop database $d with (force)" >/dev/null
  # A same-named column of ANOTHER shape is refused, never adopted (and nothing is left behind).
  "${S[@]}" -d postgres -c "create database $d template $tpl owner $owner" >/dev/null
  psql_q "$d" -c "alter table private.account_lifecycle_operations add column reconciliation jsonb" >/dev/null
  if out="$(psql_o "$d" -f "$candidate" 2>&1)"; then echo "FAIL a foreign pre-existing column was accepted" >&2; exit 1; fi
  grep -q COMMON_ACCOUNT_RECONCILIATION_PREFLIGHT_SHAPE <<<"$out" || { echo "FAIL pre-existing column reason: $out" >&2; exit 1; }
  [[ "$(has_new_objects "$d")" == f ]] || { echo "FAIL the refused apply left functions" >&2; exit 1; }
  "${S[@]}" -d postgres -c "drop database $d with (force)" >/dev/null
  echo "COMMON_ACCOUNT_RECONCILIATION_PREFLIGHT_PASS"
fi

catalog() {
  psql_q "$db_exact" <<'SQL'
select 'fn ' || n.nspname || '.' || p.proname || '(' || array_to_string(p.proargtypes::regtype[], ',') || ') ' || md5(pg_get_functiondef(p.oid)) || ' ' || coalesce(array_to_string(p.proacl::text[], ','), '-')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname in ('public', 'private', 'auth', 'storage', 'vault') and p.prokind = 'f'
union all
select 'rel ' || c.oid::regclass::text || ' ' || c.relkind::text || ' ' || c.relrowsecurity || ' ' || coalesce(array_to_string(c.relacl::text[], ','), '-')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'private', 'auth', 'storage', 'vault')
union all
select 'col ' || a.attrelid::regclass::text || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || coalesce(array_to_string(a.attacl::text[], ','), '-')
  from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
 where n.nspname in ('public', 'private', 'auth', 'storage', 'vault') and a.attnum > 0 and not a.attisdropped
union all
select 'con ' || conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) from pg_constraint where conrelid <> 0
union all
select 'pol ' || polrelid::regclass::text || ' ' || polname || ' ' || coalesce(pg_get_expr(polqual, polrelid), '-') || ' ' || coalesce(pg_get_expr(polwithcheck, polrelid), '-') from pg_policy
union all
select 'trg ' || (select n.nspname || '.' || c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = tgrelid) || ' ' || tgname || ' ' || tgenabled::text
  from pg_trigger where not tgisinternal
union all
select 'nsp ' || nspname || ' ' || coalesce(array_to_string(nspacl::text[], ','), '-') from pg_namespace where nspname in ('public', 'private', 'auth', 'storage', 'vault')
order by 1;
SQL
}

if want exact; then
  catalog > "$tmp/before"
  sed -e 's/^commit;$/rollback;/' "$candidate" > "$tmp/rolled_back.sql"
  [[ "$(grep -c '^rollback;$' "$tmp/rolled_back.sql")" == 1 ]] || { echo "FAIL rollback copy" >&2; exit 1; }
  "${O[@]}" -f "$tmp/rolled_back.sql" >/dev/null 2>&1
  catalog > "$tmp/rolled_back"
  cmp -s "$tmp/before" "$tmp/rolled_back" || { echo "FAIL transaction rollback: the catalog changed" >&2; exit 1; }
  "${O[@]}" -f "$candidate" >/dev/null 2>&1
  catalog > "$tmp/after"
  norm() { sed -E 's/^(fn [^ ]+) [0-9a-f]{32} /\1 /'; }
  removed="$(comm -23 "$tmp/before" "$tmp/after" | norm | LC_ALL=C sort)"
  added="$(comm -13 "$tmp/before" "$tmp/after" | norm | LC_ALL=C sort)"
  [[ -z "$removed" ]] || { echo "FAIL change: something existing was altered or removed:" >&2; echo "$removed" >&2; exit 1; }
  expected_added="$(printf '%s\n' \
    'col private.account_lifecycle_operations.reconciliation jsonb -' \
    'con private.account_lifecycle_operations account_lifecycle_operations_reconciliation_shape CHECK (((jsonb_typeof(reconciliation) = '"'"'object'"'"'::text) AND ((reconciliation - '"'"'x_posts_unconfirmed'"'"'::text) = '"'"'{}'"'"'::jsonb) AND ((NOT (reconciliation ? '"'"'x_posts_unconfirmed'"'"'::text)) OR (jsonb_typeof((reconciliation -> '"'"'x_posts_unconfirmed'"'"'::text)) = '"'"'number'"'"'::text))))' \
    'fn public.common_account_service_end_result(uuid,text) kb_cal_recon_owner=X/kb_cal_recon_owner,service_role=X/kb_cal_recon_owner' \
    'fn public.record_owned_service_deletion_reconciliation(uuid,text,uuid,uuid,text,integer) kb_cal_recon_owner=X/kb_cal_recon_owner,service_role=X/kb_cal_recon_owner' \
    | LC_ALL=C sort)"
  [[ "$added" == "$expected_added" ]] || { echo "FAIL change: unexpected additions:" >&2; diff <(echo "$expected_added") <(echo "$added") >&2 || true; exit 1; }
  echo "COMMON_ACCOUNT_RECONCILIATION_EXACT_CHANGE_PASS"
  if out="$("${O[@]}" -f "$candidate" 2>&1)"; then echo "FAIL re-apply accepted" >&2; exit 1; fi
  grep -q 'COMMON_ACCOUNT_RECONCILIATION_ALREADY_APPLIED' <<<"$out" || { echo "FAIL re-apply reason: $out" >&2; exit 1; }
  echo "COMMON_ACCOUNT_RECONCILIATION_REAPPLY_REFUSED_PASS"
else
  "${O[@]}" -f "$candidate" >/dev/null 2>&1
fi

if want static; then
  code="$(sed -e 's/--.*$//' "$candidate")"
  flat="$(tr '\n' ' ' <<<"$code" | tr ';' '\n')"
  if grep -qiE 'auth\.sessions|auth\.identities|auth\.admin|storage\.|vault\.|/auth/v1' <<<"$code"; then echo "FAIL the candidate reaches for GoTrue tables, Storage or Vault" >&2; exit 1; fi
  if grep -qiE '(^|[[:space:]])cascade([[:space:]]|;|$)' <<<"$flat"; then echo "FAIL CASCADE appears" >&2; exit 1; fi
  if grep -qiE 'security[[:space:]]+invoker|delete[[:space:]]+from|truncate|drop[[:space:]]+(table|schema|column|trigger|policy|function)|create or replace' <<<"$code"; then echo "FAIL unexpected statement (nothing existing may be replaced or removed)" >&2; exit 1; fi
  n_fn="$(grep -ciE '^create function' <<<"$code")"
  n_ok="$(grep -ciE 'security definer set search_path = ' <<<"$code")"
  [[ "$n_fn" == 2 && "$n_ok" == 2 ]] || { echo "FAIL both functions must be SECURITY DEFINER with an empty search_path ($n_fn/$n_ok)" >&2; exit 1; }
  if grep -iE '^[[:space:]]*grant[[:space:]]' <<<"$code" | grep -viE 'to service_role;' >/dev/null; then echo "FAIL a grant to something other than service_role" >&2; exit 1; fi
  echo "COMMON_ACCOUNT_RECONCILIATION_STATIC_PASS"
fi

R=(psql_o "$db_run")
RQ=(psql_q "$db_run")
"${R[@]}" -f "$candidate" >/dev/null 2>&1

if want behavior; then
  "${RQ[@]}" -f "$here/common_account_service_reconciliation_behavior.sql" > "$tmp/behavior" 2>&1 || true
  grep -qx 'COMMON_ACCOUNT_RECONCILIATION_BEHAVIOR_PASS' "$tmp/behavior" || { echo "FAIL behavior" >&2; cat "$tmp/behavior" >&2; exit 1; }
  echo "COMMON_ACCOUNT_RECONCILIATION_BEHAVIOR_PASS"
fi

if want rollback; then
  "${O[@]}" -f "$rollback_file" >/dev/null
  [[ "$(has_new_objects "$db_exact")" == f ]] || { echo "FAIL rollback: functions remain" >&2; exit 1; }
  catalog > "$tmp/rolled_back_after"
  diff <(grep -v -e 'reconciliation' "$tmp/before") <(grep -v -e 'reconciliation' "$tmp/rolled_back_after") >/dev/null \
    || { echo "FAIL rollback: the catalog differs beyond the kept column" >&2; diff "$tmp/before" "$tmp/rolled_back_after" >&2 || true; exit 1; }
  if out="$("${O[@]}" -f "$rollback_file" 2>&1)"; then echo "FAIL rollback ran twice" >&2; exit 1; fi
  grep -q COMMON_ACCOUNT_RECONCILIATION_ROLLBACK_NOT_APPLIED <<<"$out" || { echo "FAIL rollback reason: $out" >&2; exit 1; }
  # The column (and its constraint) stay; a re-apply after the rollback works and reaches the same catalog as a fresh apply.
  "${O[@]}" -f "$candidate" >/dev/null 2>&1
  catalog > "$tmp/reapplied"
  cmp -s "$tmp/after" "$tmp/reapplied" || { echo "FAIL re-apply after the rollback differs from a fresh apply" >&2; diff "$tmp/after" "$tmp/reapplied" >&2 || true; exit 1; }
  # ... and the audit data kept by the rollback is read again (db_run holds facts from the behavior suite).
  if want behavior; then
    facts_before="$("${RQ[@]}" -c "select coalesce(string_agg(id::text || ':' || reconciliation::text, ',' order by id), '') from private.account_lifecycle_operations where reconciliation <> '{}'::jsonb")"
    [[ -n "$facts_before" ]] || { echo "FAIL no recorded facts to carry across the rollback" >&2; exit 1; }
    "${R[@]}" -f "$rollback_file" >/dev/null
    "${R[@]}" -f "$candidate" >/dev/null 2>&1
    facts_after="$("${RQ[@]}" -c "select coalesce(string_agg(id::text || ':' || reconciliation::text, ',' order by id), '') from private.account_lifecycle_operations where reconciliation <> '{}'::jsonb")"
    [[ "$facts_before" == "$facts_after" ]] || { echo "FAIL the rollback lost recorded facts" >&2; exit 1; }
  fi
  echo "COMMON_ACCOUNT_RECONCILIATION_ROLLBACK_PASS"
fi

echo "COMMON_ACCOUNT_RECONCILIATION_ALL_PASS"
