#!/usr/bin/env bash
# G3 SOURCE CANDIDATE (2026-10-30, Issue #318 G3-51): the POSTONA X + Threads reservation rollout for the PERSONAL MVP profile, in one
# runner. NOT run against anything but a THROW-AWAY LOCAL PostgreSQL: the host must be a /tmp socket directory, or 127.0.0.1 (G3-02 #1: the
# local Supabase stack's database is reached only through its loopback TCP port). There is no managed / production mode (PRODUCTION_NO_GO);
# a real rollout needs the reviewed plan, G4 / G5 adoption and the user's approval first. A loopback tunnel to another server cannot be
# told apart from a local one: never point 127.0.0.1 at anything but a throw-away local stack.
#   rollout.sh preflight  manifest sha256 + preflight.sql (mode install): prerequisites and a fresh G3 state; changes nothing.
#   rollout.sh install    preflight, then every `install` step of MANIFEST.tsv in order (each file is its own transaction). If a step
#                         fails, the steps already applied are rolled back in the manifest's rollback order and the G3 catalog
#                         fingerprint must equal the one before the install (else G3_ROLLOUT_INSTALL_PARTIAL: operator action).
#                         Then preflight.sql mode postcheck (nothing exposed, roles closed, G4 / U8 unchanged).
#   rollout.sh rollback   preflight (mode rollback: installed exactly), then, before ANY change: no live row (X / Threads planned,
#                         claimed, uncertain), the finished rows stated exactly (X 001 discards them; Threads 007 drops its schema with
#                         every row), the consumers outside G3's schemas stated exactly, no login / option on the API / worker roles;
#                         then every `rollback` step in order. A refusal
#                         stops at that step (each step is atomic; the steps before it stay rolled back).
# Environment: G3RO_PGHOST (a /tmp socket dir, or 127.0.0.1; a password comes from the caller's PGPASSWORD / .pgpass), G3RO_PGPORT, G3RO_DB, G3RO_OWNER (the non-superuser lifecycle owner G3's objects
# belong to; G5 / G4 objects must belong to it too). rollback only: G3RO_X_DISCARD_ROWS ('<reservations>:<batches>:<audit>', 001),
# G3RO_THREADS_DISCARD_ROWS ('<reservations>:<audit>'), G3RO_ACK_CONSUMERS (001's consumer list, empty when none). Optional:
# G3RO_MANIFEST (another manifest; paths may be absolute).
# After an install the Edge entries stay closed: release gates OFF in source, G4's X token read / Threads credential statement
# NOT_CONNECTED (deny), Threads publish-disabled by U8. This runner never opens them. Nothing is logged but codes and counts.
set -euo pipefail
export LC_ALL=C PGOPTIONS='-c client_min_messages=warning'
mode="${1:-}"
case "$mode" in preflight|install|rollback) ;; *) echo "usage: rollout.sh preflight|install|rollback" >&2; exit 2 ;; esac
host="${G3RO_PGHOST:?G3RO_PGHOST (a local /tmp socket directory, or 127.0.0.1) required}"
port="${G3RO_PGPORT:?G3RO_PGPORT required}"
db="${G3RO_DB:?G3RO_DB required}"
owner="${G3RO_OWNER:?G3RO_OWNER (the lifecycle owner) required}"
case "$host" in
  /private/tmp/*|/tmp/*|127.0.0.1) ;;
  *) echo "G3_ROLLOUT_REFUSED_HOST: local /tmp socket or 127.0.0.1 only (PRODUCTION_NO_GO: no managed / production mode)" >&2; exit 2 ;;
esac
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
manifest="${G3RO_MANIFEST:-$here/MANIFEST.tsv}"
P=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
die() { echo "$*" >&2; exit 1; }
path_of() { case "$1" in /*) printf '%s' "$1" ;; *) printf '%s/%s' "$root" "$1" ;; esac; }

# --- manifest: every listed file present with its pinned sha256 (nothing is touched before this) ---------------------------------------
[ -f "$manifest" ] || die "G3_ROLLOUT_MANIFEST_MISSING"
n_install=0; n_rollback=0
while IFS="$(printf '\t')" read -r kind step rel sha; do
  case "$kind" in ''|'#'*) continue ;; install) n_install=$((n_install + 1)) ;; rollback) n_rollback=$((n_rollback + 1)) ;; *) die "G3_ROLLOUT_MANIFEST_KIND: $kind" ;; esac
  f="$(path_of "$rel")"
  [ -f "$f" ] || die "G3_ROLLOUT_MANIFEST_FILE_MISSING: $kind $step"
  [ "$(shasum -a 256 "$f" | cut -d ' ' -f 1)" = "$sha" ] || die "G3_ROLLOUT_MANIFEST_SHA: $kind $step"
done < "$manifest"
[ "$n_install" -gt 0 ] && [ "$n_install" = "$n_rollback" ] || die "G3_ROLLOUT_MANIFEST_SHAPE: $n_install install / $n_rollback rollback"
steps_of() { awk -F '\t' -v k="$1" '$1 == k { print $2 "\t" $3 }' "$manifest"; }

preflight() {
  local out
  out="$("${P[@]}" -v mode="$1" -f "$here/preflight.sql" 2>&1)" || { printf '%s\n' "$out" | grep -o 'G3_ROLLOUT_PREFLIGHT_[A-Z0-9_]*:.*' | head -1 >&2; die "G3_ROLLOUT_PREFLIGHT_REFUSED ($1)"; }
  printf '%s\n' "$out" | grep -q "^G3_ROLLOUT_PREFLIGHT_OK $1 " || die "G3_ROLLOUT_PREFLIGHT_NO_ANSWER ($1)"
}

# G3's catalog: schemas, functions (body md5, owner, ACL), relations, columns, triggers, the API / worker roles and their members, and
# every function outside G3's schemas whose body names them (a consumer).
fingerprint() {
  "${P[@]}" -c "select md5(coalesce((select string_agg(x, '|' order by x) from (
    select 'n:' || n.nspname || ':' || pg_get_userbyid(n.nspowner) || ':' || coalesce(n.nspacl::text, '-') as x from pg_namespace n where n.nspname in ('postona_x_resv', 'postona_threads_resv')
    union all select 'p:' || p.oid::regprocedure::text || ':' || md5(p.prosrc) || ':' || pg_get_userbyid(p.proowner) || ':' || coalesce(p.proacl::text, '-')
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('postona_x_resv', 'postona_threads_resv')
    union all select 'c:' || c.oid::regclass::text || ':' || c.relkind::text || ':' || pg_get_userbyid(c.relowner) || ':' || coalesce(c.relacl::text, '-')
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('postona_x_resv', 'postona_threads_resv')
    union all select 'a:' || c.oid::regclass::text || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || coalesce(a.attacl::text, '-')
      from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('postona_x_resv', 'postona_threads_resv') and a.attnum > 0 and not a.attisdropped
    union all select 't:' || t.tgname || ':' || t.tgrelid::regclass::text || ':' || t.tgenabled::text from pg_trigger t join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('postona_x_resv', 'postona_threads_resv') and not t.tgisinternal
    union all select 'r:' || r.rolname || ':' || r.rolcanlogin::text from pg_roles r where r.rolname in ('postona_resv_api', 'postona_resv_worker')
    union all select 'm:' || pg_get_userbyid(m.roleid) || '>' || pg_get_userbyid(m.member) from pg_auth_members m
      where pg_get_userbyid(m.roleid) in ('postona_resv_api', 'postona_resv_worker') or pg_get_userbyid(m.member) in ('postona_resv_api', 'postona_resv_worker')
    union all select 'x:' || p.oid::regprocedure::text || ':' || md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname not in ('postona_x_resv', 'postona_threads_resv', 'pg_catalog', 'information_schema') and p.prosrc ~* 'postona_(x|threads)_resv'
  ) s), ''))"
}

run_rollback_steps() {  # <applied steps, space separated, or ALL> -> 0 when every listed step rolled back
  local applied="$1" step rel
  while IFS="$(printf '\t')" read -r step rel; do
    case " $applied " in *" $step "*) ;; *) [ "$applied" = ALL ] || continue ;; esac
    if ! "${P[@]}" -c "set postona_resv_rollback.discard_rows = '${G3RO_X_DISCARD_ROWS:-0:0:0}'" \
         -c "set postona_resv_rollback.ack_consumers = '${G3RO_ACK_CONSUMERS:-}'" -f "$(path_of "$rel")" >/dev/null 2>"$errf"; then
      echo "G3_ROLLOUT_ROLLBACK_STOPPED_AT: $step $(grep -oE '(G3|POSTONA)_[A-Z0-9_]+(: .*)?' "$errf" | head -1)" >&2
      return 1
    fi
  done < <(steps_of rollback)
}
errf="$(mktemp /private/tmp/g3ro.XXXXXX)"
trap 'rm -f "$errf"' EXIT

case "$mode" in
preflight)
  preflight install
  echo "G3_ROLLOUT_PREFLIGHT_PASS fresh install_steps=$n_install"
  ;;
install)
  preflight install
  before="$(fingerprint)"
  applied=""
  while IFS="$(printf '\t')" read -r step rel; do
    if ! "${P[@]}" -f "$(path_of "$rel")" >/dev/null 2>"$errf"; then
      echo "G3_ROLLOUT_INSTALL_FAILED_AT: $step $(grep -oE '(G3|POSTONA)_[A-Z0-9_]+(: .*)?' "$errf" | head -1)" >&2
      if run_rollback_steps "$applied" && [ "$(fingerprint)" = "$before" ]; then
        die "G3_ROLLOUT_INSTALL_ROLLED_BACK: nothing of G3 left (catalog as before the install)"
      fi
      die "G3_ROLLOUT_INSTALL_PARTIAL: applied [${applied# }] not fully rolled back -- operator action, nothing opened"
    fi
    applied="$applied $step"
  done < <(steps_of install)
  preflight postcheck
  echo "G3_ROLLOUT_INSTALLED steps=$n_install -- release gates OFF, G4 token read / Threads credential NOT_CONNECTED (deny), Threads publish-disabled (U8)"
  ;;
rollback)
  preflight rollback
  live="$("${P[@]}" -c "select (select count(*) from postona_x_resv.reservations where status in ('planned', 'claimed', 'uncertain'))::text || '/'
    || (select count(*) from postona_threads_resv.reservations where status in ('planned', 'claimed', 'uncertain'))::text")"
  [ "$live" = "0/0" ] || die "G3_ROLLOUT_ROLLBACK_LIVE_ROWS: X/Threads $live (finish or resolve them first; nothing changed)"
  xrows="$("${P[@]}" -c "select (select count(*) from postona_x_resv.reservations)::text || ':' || (select count(*) from postona_x_resv.batches)::text || ':' || (select count(*) from postona_x_resv.audit)::text")"
  [ "$xrows" = "${G3RO_X_DISCARD_ROWS:-0:0:0}" ] || die "G3_ROLLOUT_ROLLBACK_X_ROWS_NOT_STATED: G3RO_X_DISCARD_ROWS must be $xrows (export first; nothing changed)"
  trows="$("${P[@]}" -c "select (select count(*) from postona_threads_resv.reservations)::text || ':' || (select count(*) from postona_threads_resv.audit)::text")"
  [ "$trows" = "${G3RO_THREADS_DISCARD_ROWS:-0:0}" ] || die "G3_ROLLOUT_ROLLBACK_THREADS_ROWS_NOT_STATED: G3RO_THREADS_DISCARD_ROWS must be $trows (export first; nothing changed)"
  consumers="$("${P[@]}" -c "select coalesce(string_agg(p.oid::regprocedure::text, ',' order by p.oid::regprocedure::text), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname not in ('postona_x_resv', 'postona_threads_resv') and n.nspname !~ '^(pg_catalog|information_schema|pg_toast|pg_temp_|pg_toast_temp_)' and p.prosrc ~* 'postona_x_resv'")"
  [ "$consumers" = "${G3RO_ACK_CONSUMERS:-}" ] || die "G3_ROLLOUT_ROLLBACK_CONSUMERS_NOT_STATED: G3RO_ACK_CONSUMERS must be '$consumers' (nothing changed)"
  # 002's rollback refuses a member of the API role (and drops it only when the owner's implicit ADMIN-only membership is the sole one); the
  # worker role is held to the same rule here, so a live login is detached by the operator before anything is rolled back
  members="$("${P[@]}" -c "select coalesce(string_agg(pg_get_userbyid(m.roleid) || '>' || pg_get_userbyid(m.member), ',' order by 1), '') from pg_auth_members m
    where m.member in (select oid from pg_roles where rolname in ('postona_resv_api', 'postona_resv_worker'))
       or (m.roleid in (select oid from pg_roles where rolname in ('postona_resv_api', 'postona_resv_worker'))
           and not (m.member = (select oid from pg_roles where rolname = current_user) and m.admin_option and not m.inherit_option and not m.set_option))")"
  [ -z "$members" ] || die "G3_ROLLOUT_ROLLBACK_ROLE_MEMBERS: $members (revoke the logins / options first; nothing changed)"
  run_rollback_steps ALL || die "G3_ROLLOUT_ROLLBACK_STOPPED (the steps before it stay rolled back; each step is atomic)"
  echo "G3_ROLLOUT_ROLLED_BACK steps=$n_rollback"
  ;;
esac
