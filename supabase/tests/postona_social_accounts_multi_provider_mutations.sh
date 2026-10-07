#!/usr/bin/env bash
# Defect-detection proof for postona_social_accounts_multi_provider_run.sh. Each mutation breaks
# exactly one safety property in a COPY of the candidate
# (20261007150000_postona_social_accounts_multi_provider.sql), runs the runner against it and
# requires the runner to fail at the check that guards that property: every mutation names the
# failure it must produce, never a generic one. The real candidate is never edited. An unmutated
# copy must pass first.
# A weakened CHECK also changes the postcondition's expected definition (a second site), so the
# mutant is self-consistent and the behavior proof, not the postcondition, has to catch it.
# Runs ONE AT A TIME: the runner changes cluster-wide role memberships and must run alone.
# Sites of one mutation are separated by \x1f. Disposable local PostgreSQL only; same environment as
# the runner, plus python3.
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

# --- the four constraints (self-consistent: the postcondition expects the weakened definition) -----
mutation "Meta rows may keep an X refresh reference" \
  "check (platform = 'x' or vault_refresh_token_secret_id is null);${S}(vault_refresh_token_secret_id IS NULL))) | true'" \
  "check (platform = 'x' or vault_refresh_token_secret_id is null or vault_access_token_secret_id is not null);${S}(vault_refresh_token_secret_id IS NULL) OR (vault_access_token_secret_id IS NOT NULL))) | true'" \
  "FAIL threads / unconnected / access gen_random_uuid() / refresh gen_random_uuid()"
mutation "a connected Meta row may lack its access reference" \
  "connection_status in ('unconnected', 'authorization_pending', 'failed'));${S}''authorization_pending''::text, ''failed''::text])))) | true'" \
  "connection_status in ('unconnected', 'authorization_pending', 'failed', 'connected', 'identity_verified'));${S}''authorization_pending''::text, ''failed''::text, ''connected''::text, ''identity_verified''::text])))) | true'" \
  "FAIL threads / connected / access null / refresh gen_random_uuid()"
mutation "Meta rows may be publish-enabled" \
  "check (platform = 'x' or publish_enabled is false);${S}(publish_enabled IS FALSE))) | true'" \
  "check (platform = 'x' or publish_enabled is not null);${S}(publish_enabled IS NOT NULL))) | true'" \
  "FAIL threads created publish-enabled refused"
mutation "Instagram is not accepted" \
  "check (platform in ('x', 'threads', 'instagram'));${S}''threads''::text, ''instagram''::text]))) | true'" \
  "check (platform in ('x', 'threads'));${S}''threads''::text]))) | true'" \
  'violates check constraint "social_accounts_platform_supported"'
mutation "an unknown provider is accepted" \
  "check (platform in ('x', 'threads', 'instagram'));${S}''threads''::text, ''instagram''::text]))) | true'" \
  "check (platform in ('x', 'threads', 'instagram', 'tiktok'));${S}''threads''::text, ''instagram''::text, ''tiktok''::text]))) | true'" \
  "FAIL platform 'tiktok' refused"
mutation "provider spelling is not exact" \
  "check (platform in ('x', 'threads', 'instagram'));${S}'social_accounts_platform_supported | CHECK ((platform = ANY" \
  "check (lower(btrim(platform)) in ('x', 'threads', 'instagram'));${S}'social_accounts_platform_supported | CHECK ((lower(btrim(platform)) = ANY" \
  "FAIL platform 'X' refused"
# --- the provider guard ------------------------------------------------------------------------------
# (Self-consistent: the postcondition's pinned guard definition is changed to the mutant's, so the
# behavior proof has to catch the weakened body.)
mutation "a row's provider may change" \
  "  if tg_op = 'UPDATE' and new.platform is distinct from old.platform then${S}= '3f0ee4a3b1adf64819ec97cce7a67808'" \
  "  if false then${S}= '72a01f03b9dc5c4ad5e9df270fa25d9b'" \
  "FAIL owner: sa_x_off -> threads refused"
mutation "any role may write Meta rows" \
  "  if new.platform is distinct from 'x'
     and (select c.relowner${S}= '3f0ee4a3b1adf64819ec97cce7a67808'" \
  "  if false
     and (select c.relowner${S}= '588141d2a36e72cb8ff50709f9f8d062'" \
  "FAIL service_role: relabel by upsert refused"
# (Body only, every other property and the pinned definition kept: the postcondition must refuse.)
mutation "guard body allows relabeling (postcondition)" \
  "  if tg_op = 'UPDATE' and new.platform is distinct from old.platform then" \
  "  if false then" \
  "FAIL apply: refused (POSTONA_ACCOUNTS_POSTCONDITION_GUARD)"
mutation "guard body skips the Meta write protection (postcondition)" \
  "  if new.platform is distinct from 'x'
     and (select c.relowner" \
  "  if false
     and (select c.relowner" \
  "FAIL apply: refused (POSTONA_ACCOUNTS_POSTCONDITION_GUARD)"
mutation "guard body returns NEW without any check (postcondition)" \
  "begin
  -- A row's provider never changes, whoever writes and whatever else the statement changes." \
  "begin
  return new;
  -- A row's provider never changes, whoever writes and whatever else the statement changes." \
  "FAIL apply: refused (POSTONA_ACCOUNTS_POSTCONDITION_GUARD)"
mutation "the guard fires on INSERT only" \
  "  before insert or update on public.social_accounts${S}BEFORE INSERT OR UPDATE ON public.social_accounts FOR EACH ROW EXECUTE FUNCTION public.social_accounts_provider_guard() | O'" \
  "  before insert on public.social_accounts${S}BEFORE INSERT ON public.social_accounts FOR EACH ROW EXECUTE FUNCTION public.social_accounts_provider_guard() | O'" \
  "FAIL owner: sa_x_off -> threads refused"
mutation "the guard function keeps default EXECUTE grants" \
  "revoke all on function public.social_accounts_provider_guard() from public, anon, authenticated, service_role;" \
  "" \
  "FAIL apply: refused (POSTONA_ACCOUNTS_POSTCONDITION_GUARD)"
# --- precondition: the X-only CHECK ------------------------------------------------------------------
mutation "a NOT VALID X-only CHECK is trusted" \
  "    and pg_catalog.pg_get_constraintdef(c.oid) = 'CHECK ((platform = ''x''::text))';" \
  "    and pg_catalog.pg_get_constraintdef(c.oid) like 'CHECK ((platform = ''x''::text))%';" \
  "FAIL check_not_valid: expected POSTONA_ACCOUNTS_PRECONDITION_PLATFORM_CHECK"
mutation "the X-only CHECK is found by name" \
  "    and pg_catalog.pg_get_constraintdef(c.oid) = 'CHECK ((platform = ''x''::text))';" \
  "    and c.conname = 'social_accounts_platform_check';" \
  "FAIL check_widened: expected POSTONA_ACCOUNTS_PRECONDITION_PLATFORM_CHECK"
mutation "another CHECK on platform is tolerated" \
  "and v_platform = any (c.conkey)) <> 1" \
  "and v_platform = any (c.conkey)) < 0" \
  "FAIL check_duplicated: expected POSTONA_ACCOUNTS_PRECONDITION_PLATFORM_CHECK"
mutation "re-apply is not recognised" \
  "    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_ALREADY_APPLIED';" \
  "    null;" \
  "FAIL re-apply: expected ALREADY_APPLIED"
# --- precondition: uniqueness and identity -------------------------------------------------------------
mutation "UNIQUE (brand_id, platform) is not required" \
  "    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_UNIQUE';" \
  "    null;" \
  "FAIL unique_missing: expected POSTONA_ACCOUNTS_PRECONDITION_UNIQUE"
mutation "a partial or wider UNIQUE (brand_id, platform) counts" \
  "= 'CREATE UNIQUE INDEX ON public.social_accounts USING btree (brand_id, platform)') then" \
  "like 'CREATE UNIQUE INDEX ON public.social_accounts USING btree (brand_id, platform%') then" \
  "FAIL unique_partial: expected POSTONA_ACCOUNTS_PRECONDITION_UNIQUE"
mutation "the provider-identity index is not required" \
  "    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_IDENTITY_UNIQUE';" \
  "    null;" \
  "FAIL identity_missing: expected POSTONA_ACCOUNTS_PRECONDITION_IDENTITY_UNIQUE"
mutation "an X-only or otherwise partial identity index counts" \
  "= 'CREATE UNIQUE INDEX ON public.social_accounts USING btree (platform, platform_user_id) WHERE (platform_user_id IS NOT NULL)') then" \
  "like 'CREATE UNIQUE INDEX ON public.social_accounts USING btree (platform, platform_user_id) WHERE %') then" \
  "FAIL identity_x_only: expected POSTONA_ACCOUNTS_PRECONDITION_IDENTITY_UNIQUE"
mutation "an invalid identity index counts" \
  "                 where i.indrelid = v_table and i.indisvalid and i.indisready and i.indislive and i.indimmediate
                   and pg_catalog.regexp_replace(pg_catalog.pg_get_indexdef(i.indexrelid), '^(CREATE (UNIQUE )?INDEX )\S+ ON ', '\1ON ')
                       = 'CREATE UNIQUE INDEX ON public.social_accounts USING btree (platform, platform_user_id)" \
  "                 where i.indrelid = v_table
                   and pg_catalog.regexp_replace(pg_catalog.pg_get_indexdef(i.indexrelid), '^(CREATE (UNIQUE )?INDEX )\S+ ON ', '\1ON ')
                       = 'CREATE UNIQUE INDEX ON public.social_accounts USING btree (platform, platform_user_id)" \
  "FAIL identity_invalid: expected POSTONA_ACCOUNTS_PRECONDITION_IDENTITY_UNIQUE"
# --- precondition: starting contract -----------------------------------------------------------------
mutation "columns are not checked" \
  "    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_SHAPE';" \
  "    null;" \
  "FAIL column_plaintext_token: expected POSTONA_ACCOUNTS_PRECONDITION_SHAPE"
mutation "inheritance is not checked" \
  "     or exists (select 1 from pg_catalog.pg_inherits h where h.inhrelid = v_table or h.inhparent = v_table)
" \
  "" \
  "FAIL inherited: expected POSTONA_ACCOUNTS_PRECONDITION_SHAPE"
mutation "unknown constraints are tolerated" \
  "    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_CONSTRAINTS';" \
  "    null;" \
  "FAIL constraint_unknown_check: expected POSTONA_ACCOUNTS_PRECONDITION_CONSTRAINTS"
mutation "unknown indexes are tolerated" \
  "    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_INDEXES';" \
  "    null;" \
  "FAIL index_unknown: expected POSTONA_ACCOUNTS_PRECONDITION_INDEXES"
mutation "RLS may be off" \
  "  if (select c.relrowsecurity and not c.relforcerowsecurity from" \
  "  if (select not c.relforcerowsecurity from" \
  "FAIL rls_off: expected POSTONA_ACCOUNTS_PRECONDITION_POLICIES"
mutation "forced RLS is tolerated" \
  "  if (select c.relrowsecurity and not c.relforcerowsecurity from" \
  "  if (select c.relrowsecurity from" \
  "FAIL rls_forced: expected POSTONA_ACCOUNTS_PRECONDITION_POLICIES"
mutation "a policy's permissive/restrictive mode is not compared" \
  "
           select pg_catalog.concat_ws(' | ', p.polname, p.polcmd::text, p.polpermissive::text," \
  "
           select pg_catalog.concat_ws(' | ', p.polname, p.polcmd::text, 'true'," \
  "FAIL policy_restrictive: expected POSTONA_ACCOUNTS_PRECONDITION_POLICIES"
mutation "unknown triggers are tolerated" \
  "    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_TRIGGERS';" \
  "    null;" \
  "FAIL trigger_unknown: expected POSTONA_ACCOUNTS_PRECONDITION_TRIGGERS"
mutation "trigger function bodies are not compared" \
  "                 p.prosecdef::text, coalesce(p.proconfig::text, ''), pg_catalog.md5(p.prosrc)) as x${S}| 2d50233f129216a8f6580734835ced39'${S}| dc37138099df32c24142addf012e9132'" \
  "                 p.prosecdef::text, coalesce(p.proconfig::text, ''), 'body') as x${S}| body'${S}| body'" \
  "FAIL trigger_function_body: expected POSTONA_ACCOUNTS_PRECONDITION_TRIGGERS"
mutation "authenticated may hold any privilege" \
  "and not (a.grantee = 'authenticated'::regrole and a.privilege_type = 'SELECT' and not a.is_grantable)" \
  "and not (a.grantee = 'authenticated'::regrole and not a.is_grantable)" \
  "FAIL acl_auth_update: expected POSTONA_ACCOUNTS_PRECONDITION_ACL"
mutation "service_role may hold TRIGGER" \
  "'TRUNCATE', 'REFERENCES', 'MAINTAIN')))" \
  "'TRUNCATE', 'REFERENCES', 'MAINTAIN', 'TRIGGER')))" \
  "FAIL acl_service_trigger: expected POSTONA_ACCOUNTS_PRECONDITION_ACL"
mutation "column ACLs are not checked" \
  "     or exists (select 1 from pg_catalog.pg_attribute a
                where a.attrelid = v_table and a.attnum > 0 and a.attacl is not null) then" \
  "     then" \
  "FAIL acl_column_auth_insert: expected POSTONA_ACCOUNTS_PRECONDITION_ACL"
# --- precondition: owner, role graph -------------------------------------------------------------------
mutation "the creator need not own the table" \
  "    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_OWNER';" \
  "    null;" \
  "FAIL creator is not the owner: expected POSTONA_ACCOUNTS_PRECONDITION_OWNER"
mutation "a superuser owner may apply" \
  "     or (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then" \
  "     then" \
  "FAIL table owned by a superuser, applied by it: expected POSTONA_ACCOUNTS_PRECONDITION_OWNER"
mutation "the role graph is not checked" \
  "    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_ROLE_GRAPH';" \
  "    null;" \
  "FAIL auth_inherits_service: expected POSTONA_ACCOUNTS_PRECONDITION_ROLE_GRAPH"
mutation "SET-only (non-inherited) memberships are missed" \
  "join pg_catalog.pg_roles r on pg_catalog.pg_has_role(a.app, r.oid, 'MEMBER')
             where r.oid = v_owner" \
  "join pg_catalog.pg_roles r on pg_catalog.pg_has_role(a.app, r.oid, 'USAGE')
             where r.oid = v_owner" \
  "FAIL auth_set_service: expected POSTONA_ACCOUNTS_PRECONDITION_ROLE_GRAPH"
mutation "only anon's reachable roles are checked" \
  "from (values ('anon'::name), ('authenticated'::name)) a(app)" \
  "from (values ('anon'::name)) a(app)" \
  "FAIL auth_inherits_service: expected POSTONA_ACCOUNTS_PRECONDITION_ROLE_GRAPH"
# --- precondition: the existing trigger functions (C1-R1) -----------------------------------------
mutation "a trigger function's owner is not checked" \
  "p.prokind::text, (p.proowner = v_owner)::text," \
  "p.prokind::text, 'true'," \
  "FAIL trigger_function_owner: expected POSTONA_ACCOUNTS_PRECONDITION_TRIGGER_FUNCTIONS"
mutation "trigger function definitions are not compared" \
  "(p.proowner = v_owner)::text,
                 pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid))) as x${S}| f1e297288b09647b4af78140c2d9d799'${S}| fda71f31421d760b16d163e57e9836b2'" \
  "(p.proowner = v_owner)::text,
                 'definition') as x${S}| definition'${S}| definition'" \
  "FAIL trigger_function_cost: expected POSTONA_ACCOUNTS_PRECONDITION_TRIGGER_FUNCTIONS"
mutation "EXECUTE reachable from app roles is not checked" \
  "    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_TRIGGER_FUNCTION_EXECUTE';" \
  "    null;" \
  "FAIL trigger_function_public_execute: expected POSTONA_ACCOUNTS_PRECONDITION_TRIGGER_FUNCTION_EXECUTE"
mutation "EXECUTE reachable only by SET ROLE is missed" \
  "join pg_catalog.pg_roles r on pg_catalog.pg_has_role(a.app, r.oid, 'MEMBER')
             where t.tgrelid = v_table" \
  "join pg_catalog.pg_roles r on pg_catalog.pg_has_role(a.app, r.oid, 'USAGE')
             where t.tgrelid = v_table" \
  "FAIL trigger_function_set_execute: expected POSTONA_ACCOUNTS_PRECONDITION_TRIGGER_FUNCTION_EXECUTE"
mutation "an empty trigger-function ACL passes (bad entries rejected, the owner's entry not required)" \
  "             where t.tgrelid = v_table and not t.tgisinternal
               and (select pg_catalog.array_agg(pg_catalog.concat_ws(' | ', (a.grantor = v_owner)::text, (a.grantee = v_owner)::text,
                                                                       a.privilege_type, a.is_grantable::text))
                    from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a)
                   is distinct from array['true | true | EXECUTE | false']) then" \
  "             cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
             where t.tgrelid = v_table and not t.tgisinternal
               and not (a.grantee = v_owner and a.grantor = v_owner and a.privilege_type = 'EXECUTE' and not a.is_grantable)) then" \
  "FAIL trigger_function_empty_acl_x_account_refresh_reset_on_reconnect: expected POSTONA_ACCOUNTS_PRECONDITION_TRIGGER_FUNCTION_ACL"
mutation "a trigger function's direct ACL is not checked" \
  "    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_TRIGGER_FUNCTION_ACL';" \
  "    null;" \
  "FAIL trigger_function_service_execute: expected POSTONA_ACCOUNTS_PRECONDITION_TRIGGER_FUNCTION_ACL"
mutation "service_role may reach the owner" \
  "     or pg_catalog.pg_has_role('service_role', v_owner, 'MEMBER')
" \
  "" \
  "FAIL service_set_owner: expected POSTONA_ACCOUNTS_PRECONDITION_ROLE_GRAPH"
# --- locking -----------------------------------------------------------------------------------------
mutation "lock waits are unbounded" \
  "set local lock_timeout = '5s';" \
  "" \
  "FAIL lock held: expected the lock timeout"
mutation "the table is not held from the precondition on" \
  "  lock table public.social_accounts in access exclusive mode;" \
  "" \
  "FAIL lock taken: a writer got in"
# --- postcondition -------------------------------------------------------------------------------------
mutation "the postcondition does not compare the snapshot" \
  "  if pg_temp.postona_accounts_state(v_new, array['social_accounts_provider_guard'])" \
  "  if false and pg_temp.postona_accounts_state(v_new, array['social_accounts_provider_guard'])" \
  "FAIL postcondition: grant_select_anon: expected POSTONA_ACCOUNTS_POSTCONDITION_UNCHANGED"
mutation "the snapshot does not include rows" \
  "             from public.social_accounts sa))" \
  "             from public.social_accounts sa where false))" \
  "FAIL postcondition: row_changed: expected POSTONA_ACCOUNTS_POSTCONDITION_UNCHANGED"
mutation "the snapshot does not include trigger bodies" \
  "coalesce(p.proconfig::text, ''), coalesce(p.proacl::text, ''), pg_catalog.md5(p.prosrc),
                            pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid))) as x" \
  "coalesce(p.proconfig::text, ''), coalesce(p.proacl::text, ''), 'body',
                            'definition') as x" \
  "FAIL postcondition: trigger_body: expected POSTONA_ACCOUNTS_POSTCONDITION_UNCHANGED"
mutation "the snapshot does not include trigger function ACLs" \
  "p.proowner::regrole::text, p.prosecdef::text,
                            coalesce(p.proconfig::text, ''), coalesce(p.proacl::text, '')," \
  "p.proowner::regrole::text, p.prosecdef::text,
                            coalesce(p.proconfig::text, ''), 'acl'," \
  "FAIL postcondition: trigger_function_grant: expected POSTONA_ACCOUNTS_POSTCONDITION_UNCHANGED"
mutation "the snapshot does not include the policy mode" \
  "
                   select pg_catalog.concat_ws(' | ', p.polname, p.polcmd::text, p.polpermissive::text," \
  "
                   select pg_catalog.concat_ws(' | ', p.polname, p.polcmd::text, 'true'," \
  "FAIL postcondition: policy_restrictive: expected POSTONA_ACCOUNTS_POSTCONDITION_UNCHANGED"
mutation "the postcondition does not check the new constraints" \
  "    raise exception 'POSTONA_ACCOUNTS_POSTCONDITION_CONSTRAINTS';" \
  "    null;" \
  "FAIL postcondition: extra_check: expected POSTONA_ACCOUNTS_POSTCONDITION_CONSTRAINTS"
mutation "the postcondition does not check the guard" \
  "    raise exception 'POSTONA_ACCOUNTS_POSTCONDITION_GUARD';" \
  "    null;" \
  "FAIL postcondition: guard_disabled: expected POSTONA_ACCOUNTS_POSTCONDITION_GUARD"

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
