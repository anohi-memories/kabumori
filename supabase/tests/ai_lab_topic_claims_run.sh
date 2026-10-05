#!/usr/bin/env bash
# Disposable-only proof runner for the AI Lab topic claim migration (20261004090000).
# Creates throwaway databases on a LOCAL Unix-socket PostgreSQL cluster, applies the
# migration as a non-superuser owner, and proves: clean apply + reapply, the claim
# lifecycle (claim / pre-X release / provider start / ambiguous / published / idempotent
# settle / conflicts), lease expiry fencing, evergreen 72h seed / 48h theme cooldown and
# pool-exhausted skip, unresolved-evergreen quarantine, publish-time cooldowns, canonical
# candidate payloads, two-session concurrent claims, effective ACLs (incl. PG17 MAINTAIN and
# role inheritance), owner policy, and that every known kind of schema drift makes a reapply
# fail. Fake data only; never production. The inheritance case temporarily changes the LOCAL
# cluster's role graph and restores it (also on the next run, if a run was interrupted).
#
# Usage: AILAB_PGHOST=/private/tmp/<socket-dir> AILAB_PGPORT=<port> \
#        AILAB_PGSUPER=<local superuser> supabase/tests/ai_lab_topic_claims_run.sh
# AILAB_CANDIDATE points at a (deliberately broken) copy for mutation testing.
set -euo pipefail

host="${AILAB_PGHOST:?AILAB_PGHOST (local socket dir) required}"
port="${AILAB_PGPORT:?AILAB_PGPORT required}"
super="${AILAB_PGSUPER:?AILAB_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: AILAB_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac

here="$(cd "$(dirname "$0")" && pwd)"
candidate="${AILAB_CANDIDATE:-$here/../migrations/20261004090000_ai_lab_topic_claims.sql}"
owner="kb_ai_lab_claims_owner"
psql_bin="${PSQL:-psql}"
dbs=()
as_super=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  for db in "${dbs[@]}"; do
    "${as_super[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

"${as_super[@]}" -d postgres <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = '$owner') then
    create role $owner login nosuperuser nocreatedb nocreaterole;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end \$\$;
-- A previous interrupted run may have left the inheritance-case edge behind.
do \$\$ begin
  if pg_has_role('service_role', '$owner', 'MEMBER') and not pg_has_role('$owner', 'service_role', 'MEMBER') then
    execute 'revoke $owner from service_role';
  end if;
end \$\$;
grant anon, authenticated, service_role to $owner;
SQL

fresh_db() {  # name -> creates db, mimics Supabase default privileges, sets $db
  db="kabumori_ailab_claims_$1_$$"
  dbs+=("$db")
  "${as_super[@]}" -d postgres -c "create database $db owner $owner" >/dev/null
  "${as_super[@]}" -d "$db" -c "grant usage on schema public to anon, authenticated, service_role; grant create on schema public to $owner;" >/dev/null
  # Supabase-style default privileges: new tables/functions are opened to every API role.
  "${as_super[@]}" -d "$db" -c "alter default privileges for role $owner in schema public grant all on tables to anon, authenticated, service_role; alter default privileges for role $owner in schema public grant all on functions to anon, authenticated, service_role;" >/dev/null
}
owner_psql() { "$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
q() { "$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -c "$1"; }
svc() { q "set role service_role; $1"; }
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1" >&2; exit 1; }
expect_eq() { [[ "$2" == "$3" ]] && pass "$1" || fail "$1 :: got [$2] want [$3]"; }
expect_error() {  # label, sql(as owner), message fragment
  local out
  if out="$("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -c "$2" 2>&1)"; then fail "$1 :: no error"; fi
  grep -qF "$3" <<<"$out" && pass "$1" || fail "$1 :: $out"
}
apply() { owner_psql -f "$candidate" >/dev/null; }
apply_refused() {  # label, message fragment
  local out
  if out="$(owner_psql -f "$candidate" 2>&1)"; then fail "$1 :: reapply accepted drift"; fi
  grep -qF "$2" <<<"$out" && pass "$1" || fail "$1 :: $out"
}

S1=00000000-0000-0000-0000-000000000001
S2=00000000-0000-0000-0000-000000000002
S3=00000000-0000-0000-0000-000000000003
S4=00000000-0000-0000-0000-000000000004
D1='{"kind":"diary","event_key":"diary:20260930-x-auth-test-account-overlap","unit_key":"diary:20260930-x-auth-test-account-overlap#changed","theme_tags":[]}'
D1B='{"kind":"diary","event_key":"diary:20260930-x-auth-test-account-overlap","unit_key":"diary:20260930-x-auth-test-account-overlap#difficulty","theme_tags":[]}'
D2='{"kind":"diary","event_key":"diary:20261001-notification-settings","unit_key":"diary:20261001-notification-settings#decided","theme_tags":[]}'
E0='{"kind":"evergreen","event_key":"evergreen-0","unit_key":"evergreen-0","theme_tags":["unglamorous_work"]}'
E2='{"kind":"evergreen","event_key":"evergreen-2","unit_key":"evergreen-2","theme_tags":[]}'
E5='{"kind":"evergreen","event_key":"evergreen-5","unit_key":"evergreen-5","theme_tags":["rework_reduction","unglamorous_work"]}'
# claim -> "claimed_event_key|rejected key=reason,...|conflict" ("-" when nothing was claimed)
claim() {
  svc "with c as (select public.claim_ai_lab_topic('$1', '$2'::jsonb, ${3:-900}) as j)
       select coalesce(j->'claim'->>'event_key', '-') || '|'
           || coalesce((select string_agg((r->>'event_key') || '=' || (r->>'reason'), ',') from jsonb_array_elements(j->'rejected') r), '')
           || '|' || coalesce(j->>'conflict', '') from c"
}
claimed_key() { claim "$1" "$2" | cut -d'|' -f1; }
claim_id_of() { q "select claim_id from public.ai_lab_topic_claims where scheduled_post_id = '$1' and state not in ('released','expired')"; }

# ---------------------------------------------------------------- apply / reapply
fresh_db main
apply && pass "clean apply"
apply && pass "clean reapply (no drift)"
expect_eq "RLS enabled, no policies" "$(q "select relrowsecurity::text || ',' || (select count(*) from pg_policy where polrelid = c.oid) from pg_class c where oid = 'public.ai_lab_topic_claims'::regclass")" "true,0"

# ---------------------------------------------------------------- ACL (effective)
for role in anon authenticated service_role; do
  for priv in SELECT INSERT UPDATE DELETE TRUNCATE REFERENCES TRIGGER $( [[ "$(q "select current_setting('server_version_num')::int >= 170000")" == t ]] && echo MAINTAIN ); do
    expect_eq "$role has no $priv on table" "$(q "select has_table_privilege('$role', 'public.ai_lab_topic_claims', '$priv')")" "f"
  done
done
for fn in "claim_ai_lab_topic(uuid,jsonb,integer)" "start_ai_lab_topic_provider(uuid,uuid,text)" "release_ai_lab_topic_claim(uuid,uuid,text,text)" "mark_ai_lab_topic_claim_ambiguous(uuid,uuid,text,text)" "settle_ai_lab_topic_claim_published(uuid,uuid,text,text,text)"; do
  expect_eq "anon cannot execute $fn" "$(q "select has_function_privilege('anon', 'public.$fn', 'EXECUTE')")" "f"
  expect_eq "authenticated cannot execute $fn" "$(q "select has_function_privilege('authenticated', 'public.$fn', 'EXECUTE')")" "f"
  expect_eq "public cannot execute $fn" "$(q "select count(*) from pg_proc p, aclexplode(p.proacl) a where p.oid = 'public.$fn'::regprocedure and a.grantee = 0")" "0"
  expect_eq "service_role executes $fn" "$(q "select has_function_privilege('service_role', 'public.$fn', 'EXECUTE')")" "t"
done
expect_error "service_role cannot read the table directly" "set role service_role; select * from public.ai_lab_topic_claims" "permission denied"
expect_error "anon cannot call claim" "set role anon; select public.claim_ai_lab_topic('$S1', '[]'::jsonb, 900)" "permission denied"

# ---------------------------------------------------------------- claim priority / event uniqueness
expect_eq "first schedule claims the newest unused diary event" "$(claimed_key $S1 "[$D2,$D1,$E2]")" "diary:20261001-notification-settings"
out="$(claim $S2 "[$D2,$D1,$E2]")"
expect_eq "second schedule skips the claimed event and takes the next (reason EVENT_CLAIMED)" "$out" "diary:20260930-x-auth-test-account-overlap|diary:20261001-notification-settings=EVENT_CLAIMED|"
expect_eq "a different angle of a claimed event is not claimable" "$(claimed_key $S3 "[$D1B]")" "-"
expect_eq "same schedule cannot hold two active claims" "$(claim $S1 "[$E2]")" "-||SCHEDULE_ALREADY_CLAIMED:CLAIMED"

C1="$(claim_id_of $S1)"; C2="$(claim_id_of $S2)"
# pre-X release (generation / guard / fingerprint failure) frees only this claim
expect_eq "pre-X release" "$(svc "select public.release_ai_lab_topic_claim('$C1', '$S1', 'diary:20261001-notification-settings', 'PRE_X_GENERATION_FAILED')")" "RELEASED"
expect_eq "released event is claimable again" "$(claimed_key $S3 "[$D2]")" "diary:20261001-notification-settings"
expect_eq "a stale worker cannot release someone else's newer claim" "$(svc "select public.release_ai_lab_topic_claim('$C1', '$S1', 'diary:20261001-notification-settings', 'PRE_X_FAILED')")" "RELEASED"
expect_eq "the newer claim is still active" "$(q "select state from public.ai_lab_topic_claims where scheduled_post_id = '$S3'")" "claimed"

# provider start, then outcomes
expect_eq "provider start" "$(svc "select public.start_ai_lab_topic_provider('$C2', '$S2', 'diary:20260930-x-auth-test-account-overlap')")" "t"
expect_eq "provider start is not repeatable" "$(svc "select public.start_ai_lab_topic_provider('$C2', '$S2', 'diary:20260930-x-auth-test-account-overlap')")" "f"
expect_eq "after provider start, a generic release is refused" "$(svc "select public.release_ai_lab_topic_claim('$C2', '$S2', 'diary:20260930-x-auth-test-account-overlap', 'PRE_X_FAILED')")" "PROVIDER_STARTED"
expect_eq "ambiguous outcome is recorded" "$(svc "select public.mark_ai_lab_topic_claim_ambiguous('$C2', '$S2', 'diary:20260930-x-auth-test-account-overlap', 'PROVIDER_OUTCOME_UNKNOWN')")" "AMBIGUOUS"
expect_eq "ambiguous event is never claimable again" "$(claimed_key $S4 "[$D1B]")" "-"
expect_eq "even a proven-no-post release cannot reopen an ambiguous claim" "$(svc "select public.release_ai_lab_topic_claim('$C2', '$S2', 'diary:20260930-x-auth-test-account-overlap', 'PROVIDER_NO_POST:HTTP_400')")" "AMBIGUOUS"
expect_eq "late confirmation settles ambiguous as published" "$(svc "select public.settle_ai_lab_topic_claim_published('$C2', '$S2', 'diary:20260930-x-auth-test-account-overlap', 'diary:20260930-x-auth-test-account-overlap#changed', '1790000000000000002')")" "PUBLISHED"
expect_eq "same claim + same X id is idempotent" "$(svc "select public.settle_ai_lab_topic_claim_published('$C2', '$S2', 'diary:20260930-x-auth-test-account-overlap', 'diary:20260930-x-auth-test-account-overlap#changed', '1790000000000000002')")" "IDEMPOTENT"
expect_error "same claim + different X id is a conflict" "set role service_role; select public.settle_ai_lab_topic_claim_published('$C2', '$S2', 'diary:20260930-x-auth-test-account-overlap', 'diary:20260930-x-auth-test-account-overlap#changed', '1790000000000000099')" "AI_LAB_TOPIC_CLAIM_X_POST_CONFLICT"
expect_error "same claim + different event is a conflict" "set role service_role; select public.settle_ai_lab_topic_claim_published('$C2', '$S2', 'diary:20261001-notification-settings', 'diary:20261001-notification-settings#decided', '1790000000000000002')" "AI_LAB_TOPIC_CLAIM_IDENTITY_CONFLICT"
expect_error "same claim + different unit is a conflict" "set role service_role; select public.settle_ai_lab_topic_claim_published('$C2', '$S2', 'diary:20260930-x-auth-test-account-overlap', 'diary:20260930-x-auth-test-account-overlap#difficulty', '1790000000000000002')" "AI_LAB_TOPIC_CLAIM_IDENTITY_CONFLICT"
C3="$(claim_id_of $S3)"
expect_error "settling a claim that never started X is a conflict" "set role service_role; select public.settle_ai_lab_topic_claim_published('$C3', '$S3', 'diary:20261001-notification-settings', 'diary:20261001-notification-settings#decided', '1790000000000000003')" "AI_LAB_TOPIC_CLAIM_STATE_CONFLICT"
expect_eq "published event is never claimable again" "$(claimed_key $S4 "[$D1]")" "-"

# definitive X rejection may reopen (claim S3 -> start -> 429)
svc "select public.start_ai_lab_topic_provider('$C3', '$S3', 'diary:20261001-notification-settings')" >/dev/null
expect_eq "an unproven provider reason cannot release a started claim" "$(svc "select public.release_ai_lab_topic_claim('$C3', '$S3', 'diary:20261001-notification-settings', 'PROVIDER_REJECTED:403')")" "PROVIDER_STARTED"
expect_eq "a proven no-post outcome (X answered 401) releases" "$(svc "select public.release_ai_lab_topic_claim('$C3', '$S3', 'diary:20261001-notification-settings', 'PROVIDER_NO_POST:HTTP_401')")" "RELEASED"
expect_eq "event reopened only after a proven no-post outcome" "$(claimed_key $S4 "[$D2]")" "diary:20261001-notification-settings"

# ---------------------------------------------------------------- lease expiry fencing
C4="$(claim_id_of $S4)"
q "update public.ai_lab_topic_claims set claimed_at = now() - interval '20 minutes', lease_until = now() - interval '5 minutes' where claim_id = '$C4'" >/dev/null
expect_eq "an abandoned pre-X claim is expired and the event reclaimed" "$(claimed_key 00000000-0000-0000-0000-000000000005 "[$D2]")" "diary:20261001-notification-settings"
expect_eq "the abandoned worker cannot start X afterwards" "$(svc "select public.start_ai_lab_topic_provider('$C4', '$S4', 'diary:20261001-notification-settings')")" "f"
expect_eq "the abandoned worker cannot release the new claim" "$(svc "select public.release_ai_lab_topic_claim('$C4', '$S4', 'diary:20261001-notification-settings', 'PRE_X_FAILED')")" "EXPIRED"
expect_eq "the new claim is untouched" "$(q "select state from public.ai_lab_topic_claims where scheduled_post_id = '00000000-0000-0000-0000-000000000005'")" "claimed"

# ---------------------------------------------------------------- canonical candidate payloads
rows_before="$(q "select count(*) || '/' || count(*) filter (where state = 'claimed') from public.ai_lab_topic_claims")"
X6=00000000-0000-0000-0000-000000000006
bad_payload() {  # label, candidates json
  expect_error "payload rejected: $1" "set role service_role; select public.claim_ai_lab_topic('$X6', '$2'::jsonb, 900)" "AI_LAB_TOPIC_CLAIM_INVALID_ARGUMENT"
}
bad_payload "raw text event key" '[{"kind":"diary","event_key":"X認証の話","unit_key":"X認証の話#changed","theme_tags":[]}]'
bad_payload "extra JSON key" '[{"kind":"evergreen","event_key":"evergreen-2","unit_key":"evergreen-2","theme_tags":[],"body":"x"}]'
bad_payload "missing JSON key" '[{"kind":"evergreen","event_key":"evergreen-2","unit_key":"evergreen-2"}]'
bad_payload "evergreen-5 with forged empty theme tags" '[{"kind":"evergreen","event_key":"evergreen-5","unit_key":"evergreen-5","theme_tags":[]}]'
bad_payload "evergreen-2 with an invented theme tag" '[{"kind":"evergreen","event_key":"evergreen-2","unit_key":"evergreen-2","theme_tags":["unglamorous_work"]}]'
bad_payload "evergreen outside the pool" '[{"kind":"evergreen","event_key":"evergreen-9","unit_key":"evergreen-9","theme_tags":[]}]'
bad_payload "evergreen unit differs from its key" '[{"kind":"evergreen","event_key":"evergreen-2","unit_key":"evergreen-3","theme_tags":[]}]'
bad_payload "diary unit belongs to another event" '[{"kind":"diary","event_key":"diary:20261001-notification-settings","unit_key":"diary:20260930-x-auth-test-account-overlap#changed","theme_tags":[]}]'
bad_payload "diary unit with an unknown angle name" '[{"kind":"diary","event_key":"diary:20261001-notification-settings","unit_key":"diary:20261001-notification-settings#summary","theme_tags":[]}]'
bad_payload "diary candidate with theme tags" '[{"kind":"diary","event_key":"diary:20261001-notification-settings","unit_key":"diary:20261001-notification-settings#changed","theme_tags":["ai_trial_error"]}]'
bad_payload "kind/key mismatch (evergreen key as diary)" '[{"kind":"diary","event_key":"evergreen-2","unit_key":"evergreen-2","theme_tags":[]}]'
bad_payload "unknown kind" '[{"kind":"news","event_key":"evergreen-2","unit_key":"evergreen-2","theme_tags":[]}]'
bad_payload "non-string field" '[{"kind":"evergreen","event_key":2,"unit_key":"evergreen-2","theme_tags":[]}]'
bad_payload "duplicate candidate" "[$E2,$E2]"
bad_payload "a valid first candidate followed by an invalid one" "[$E2,{\"kind\":\"evergreen\",\"event_key\":\"evergreen-9\",\"unit_key\":\"evergreen-9\",\"theme_tags\":[]}]"
expect_eq "rejected payloads had no side effects (no row, no expiry sweep)" "$(q "select count(*) || '/' || count(*) filter (where state = 'claimed') from public.ai_lab_topic_claims")" "$rows_before"
expect_error "lease bounds are enforced" "set role service_role; select public.claim_ai_lab_topic('$X6', '[]'::jsonb, 5)" "AI_LAB_TOPIC_CLAIM_INVALID_ARGUMENT"

# ---------------------------------------------------------------- evergreen cooldowns
fresh_db evergreen
apply
seed_evergreen() {  # schedule, key, tags, hours_ago (claimed, started and published that long ago)
  q "insert into public.ai_lab_topic_claims (scheduled_post_id, topic_kind, event_key, unit_key, theme_tags, state, claimed_at, lease_until, provider_started_at, settled_at, published_at, x_post_id)
     values ('$1', 'evergreen', '$2', '$2', '$3'::text[], 'published', now() - interval '$4 hours', now() - interval '$4 hours' + interval '15 minutes', now() - interval '$4 hours', now() - interval '$4 hours', now() - interval '$4 hours', '17900000000000000$RANDOM')" >/dev/null
}
unresolved_evergreen() {  # schedule, key, tags, state (provider_started|ambiguous), hours_ago
  q "insert into public.ai_lab_topic_claims (scheduled_post_id, topic_kind, event_key, unit_key, theme_tags, state, claimed_at, lease_until, provider_started_at, settled_at)
     values ('$1', 'evergreen', '$2', '$2', '$3'::text[], '$4', now() - interval '$5 hours', now() - interval '$5 hours' + interval '15 minutes', now() - interval '$5 hours', case when '$4' = 'ambiguous' then now() - interval '$5 hours' end)" >/dev/null
}
seed_evergreen 10000000-0000-0000-0000-000000000000 evergreen-0 '{unglamorous_work}' 2
expect_eq "72h seed cooldown + 48h theme cooldown, then the first free seed" "$(claim 10000000-0000-0000-0000-000000000001 "[$E0,$E5,$E2]")" "evergreen-2|evergreen-0=EVERGREEN_SEED_COOLDOWN,evergreen-5=EVERGREEN_THEME_COOLDOWN|"
fresh_db evergreen_age
apply
seed_evergreen 20000000-0000-0000-0000-000000000000 evergreen-0 '{unglamorous_work}' 49
expect_eq "after 48h the theme cooldown is over (seed cooldown still blocks evergreen-0)" "$(claimed_key 20000000-0000-0000-0000-000000000001 "[$E0,$E5]")" "evergreen-5"
fresh_db evergreen_seed_age
apply
seed_evergreen 30000000-0000-0000-0000-000000000000 evergreen-0 '{unglamorous_work}' 73
expect_eq "after 72h the seed is claimable again" "$(claimed_key 30000000-0000-0000-0000-000000000001 "[$E0]")" "evergreen-0"
fresh_db evergreen_exhausted
apply
for i in 0 1 2 3 4 5 6; do seed_evergreen "4000000$i-0000-0000-0000-000000000000" "evergreen-$i" '{}' $((i + 1)); done
all='[{"kind":"evergreen","event_key":"evergreen-0","unit_key":"evergreen-0","theme_tags":["unglamorous_work"]},
{"kind":"evergreen","event_key":"evergreen-1","unit_key":"evergreen-1","theme_tags":["ai_trial_error"]},
{"kind":"evergreen","event_key":"evergreen-2","unit_key":"evergreen-2","theme_tags":[]},
{"kind":"evergreen","event_key":"evergreen-3","unit_key":"evergreen-3","theme_tags":[]},
{"kind":"evergreen","event_key":"evergreen-4","unit_key":"evergreen-4","theme_tags":[]},
{"kind":"evergreen","event_key":"evergreen-5","unit_key":"evergreen-5","theme_tags":["rework_reduction","unglamorous_work"]},
{"kind":"evergreen","event_key":"evergreen-6","unit_key":"evergreen-6","theme_tags":[]}]'
out="$(claim 40000000-0000-0000-0000-000000000009 "$all")"
expect_eq "pool exhausted: nothing claimed (the slot is skipped, cooldown never broken)" "$(cut -d'|' -f1 <<<"$out")" "-"
expect_eq "seven rejections reported" "$(grep -o 'EVERGREEN_SEED_COOLDOWN' <<<"$out" | wc -l | tr -d ' ')" "7"

# ---------------------------------------------------------------- unresolved evergreen is quarantined, not aged out
for state in provider_started ambiguous; do
  fresh_db "quarantine_$state"
  apply
  unresolved_evergreen 50000000-0000-0000-0000-000000000000 evergreen-2 '{}' "$state" 73
  expect_eq "$state evergreen aged 73h is still not claimable" "$(claim 50000000-0000-0000-0000-000000000001 "[$E2]")" "-|evergreen-2=EVERGREEN_SEED_$(tr 'a-z' 'A-Z' <<<"$state")|"
  unresolved_evergreen 50000000-0000-0000-0000-000000000002 evergreen-0 '{unglamorous_work}' "$state" 500
  expect_eq "$state evergreen blocks its theme tag regardless of age" "$(claim 50000000-0000-0000-0000-000000000003 "[$E5]")" "-|evergreen-5=EVERGREEN_THEME_UNRESOLVED|"
done
fresh_db quarantine_claimed
apply
claim 50000000-0000-0000-0000-000000000010 "[$E2]" >/dev/null
expect_eq "a live pre-X evergreen claim blocks the same seed" "$(claim 50000000-0000-0000-0000-000000000011 "[$E2]")" "-|evergreen-2=EVERGREEN_SEED_CLAIMED|"
q "update public.ai_lab_topic_claims set claimed_at = now() - interval '20 minutes', lease_until = now() - interval '5 minutes'" >/dev/null
expect_eq "an expired pre-X evergreen claim is reclaimable" "$(claimed_key 50000000-0000-0000-0000-000000000012 "[$E2]")" "evergreen-2"

# ---------------------------------------------------------------- cooldowns run from the confirmed publish time
fresh_db publish_time
apply
q "insert into public.ai_lab_topic_claims (scheduled_post_id, topic_kind, event_key, unit_key, theme_tags, state, claimed_at, lease_until, provider_started_at, settled_at, published_at, x_post_id)
   values ('60000000-0000-0000-0000-000000000000', 'evergreen', 'evergreen-0', 'evergreen-0', '{unglamorous_work}', 'published',
           now() - interval '72 hours 1 minute', now() - interval '71 hours 46 minutes', now() - interval '71 hours 59 minutes',
           now() - interval '71 hours 59 minutes', now() - interval '71 hours 59 minutes', '1790000000000000060')" >/dev/null
expect_eq "claimed 72h1m ago but published 71h59m ago: seed still cooling down" "$(claim 60000000-0000-0000-0000-000000000001 "[$E0]")" "-|evergreen-0=EVERGREEN_SEED_COOLDOWN|"
q "update public.ai_lab_topic_claims set published_at = now() - interval '72 hours 1 minute', settled_at = now() - interval '72 hours 1 minute', claimed_at = now() - interval '72 hours 5 minutes', lease_until = now() - interval '71 hours 50 minutes', provider_started_at = now() - interval '72 hours 2 minutes'" >/dev/null
expect_eq "published 72h1m ago: seed is reusable" "$(claimed_key 60000000-0000-0000-0000-000000000002 "[$E0]")" "evergreen-0"
fresh_db publish_time_theme
apply
q "insert into public.ai_lab_topic_claims (scheduled_post_id, topic_kind, event_key, unit_key, theme_tags, state, claimed_at, lease_until, provider_started_at, settled_at, published_at, x_post_id)
   values ('61000000-0000-0000-0000-000000000000', 'evergreen', 'evergreen-0', 'evergreen-0', '{unglamorous_work}', 'published',
           now() - interval '48 hours 5 minutes', now() - interval '47 hours 50 minutes', now() - interval '47 hours 59 minutes',
           now() - interval '47 hours 59 minutes', now() - interval '47 hours 59 minutes', '1790000000000000061')" >/dev/null
expect_eq "theme cooldown runs from publish time (47h59m)" "$(claim 61000000-0000-0000-0000-000000000001 "[$E5]")" "-|evergreen-5=EVERGREEN_THEME_COOLDOWN|"
q "update public.ai_lab_topic_claims set published_at = now() - interval '48 hours 1 minute', settled_at = now() - interval '48 hours 1 minute'" >/dev/null
expect_eq "theme cooldown is over 48h after publish" "$(claimed_key 61000000-0000-0000-0000-000000000002 "[$E5]")" "evergreen-5"

# ---------------------------------------------------------------- two sessions at the same time
fresh_db race
apply
both="[$D1,$E2]"
race_file="$(mktemp /private/tmp/kabumori-ailab-race.XXXXXX)"
("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" \
   -c "begin; set local role service_role; select public.claim_ai_lab_topic('$S1', '$both'::jsonb, 900)->'claim'->>'event_key'; select pg_sleep(2); commit;" \
   > "$race_file" 2>&1) &
pid=$!
sleep 0.5
b_started=$(date +%s)
b_out="$(claim $S2 "$both")"
b_waited=$(( $(date +%s) - b_started ))
wait $pid
a_key="$(grep -v '^$' "$race_file" | head -1)"; rm -f "$race_file"
b_key="$(cut -d'|' -f1 <<<"$b_out")"
expect_eq "session A (holding its transaction open) claimed the diary event" "$a_key" "diary:20260930-x-auth-test-account-overlap"
expect_eq "session B waited for A and could not take the same event" "$b_key" "evergreen-2"
[[ "$b_waited" -ge 1 ]] && pass "session B was serialized behind A (${b_waited}s)" || fail "session B did not wait"
expect_eq "exactly one active claim of the diary event" "$(q "select count(*) from public.ai_lab_topic_claims where event_key = 'diary:20260930-x-auth-test-account-overlap' and state in ('claimed','provider_started','ambiguous','published')")" "1"

# ---------------------------------------------------------------- drift must make reapply fail
drift_case() {  # name, drift SQL (as superuser), expected message
  fresh_db "drift_$1"
  apply
  "${as_super[@]}" -d "$db" -c "$2" >/dev/null
  apply_refused "drift refused: $1" "$3"
}
drift_case missing_pk "alter table public.ai_lab_topic_claims drop constraint ai_lab_topic_claims_pkey" "AI_LAB_TOPIC_CLAIMS_SCHEMA_DRIFT"
drift_case missing_check "alter table public.ai_lab_topic_claims drop constraint ai_lab_topic_claims_event_key_check" "AI_LAB_TOPIC_CLAIMS_SCHEMA_DRIFT"
drift_case wrong_index "drop index public.ai_lab_topic_claims_diary_event_active_uidx; create unique index ai_lab_topic_claims_diary_event_active_uidx on public.ai_lab_topic_claims (event_key) where state = 'published'" "AI_LAB_TOPIC_CLAIMS_SCHEMA_DRIFT"
drift_case policy "create policy stale_allow_all on public.ai_lab_topic_claims for all to public using (true) with check (true)" "AI_LAB_TOPIC_CLAIMS_SCHEMA_DRIFT"
drift_case rls_off "alter table public.ai_lab_topic_claims disable row level security" "AI_LAB_TOPIC_CLAIMS_SCHEMA_DRIFT"
drift_case trigger "create function public.noop_trg() returns trigger language plpgsql as 'begin return new; end'; create trigger t before insert on public.ai_lab_topic_claims for each row execute function public.noop_trg()" "AI_LAB_TOPIC_CLAIMS_SCHEMA_DRIFT"
drift_case extra_column "alter table public.ai_lab_topic_claims add column post_text text" "AI_LAB_TOPIC_CLAIMS_SCHEMA_DRIFT"
drift_case column_grant "grant select (event_key) on public.ai_lab_topic_claims to anon" "AI_LAB_TOPIC_CLAIMS_SCHEMA_DRIFT"
drift_case overload "create function public.claim_ai_lab_topic(p_scheduled_post_id uuid) returns jsonb language sql as 'select null::jsonb'" "AI_LAB_TOPIC_CLAIMS_PREFLIGHT"
drift_case table_owner_api_role "alter table public.ai_lab_topic_claims owner to service_role" "AI_LAB_TOPIC_CLAIMS_PREFLIGHT"
drift_case function_owner_api_role "alter function public.claim_ai_lab_topic(uuid,jsonb,integer) owner to anon" "AI_LAB_TOPIC_CLAIMS_PREFLIGHT"
# A named grant (e.g. a later "grant all ... to service_role") is not a definition drift: the reapply revokes it
# and the effective-privilege postcondition proves nothing is left.
fresh_db named_grant_repair
apply
"${as_super[@]}" -d "$db" -c "grant all on public.ai_lab_topic_claims to service_role, anon" >/dev/null
apply && pass "reapply repairs a named grant"
expect_eq "after repair service_role has no effective TRUNCATE" "$(q "select has_table_privilege('service_role', 'public.ai_lab_topic_claims', 'TRUNCATE')")" "f"
fresh_db superseded
"${as_super[@]}" -d "$db" -c "create table public.ai_lab_topic_event_usage (scheduled_post_id uuid primary key)" >/dev/null
apply_refused "superseded PR82 table refuses the apply" "AI_LAB_TOPIC_CLAIMS_PREFLIGHT"
expect_eq "refused apply created nothing" "$(q "select coalesce(to_regclass('public.ai_lab_topic_claims')::text, 'absent')")" "absent"

# ---------------------------------------------------------------- inherited owner privileges (role graph, restored)
fresh_db inheritance
apply
"${as_super[@]}" -d postgres -c "revoke service_role from $owner; grant $owner to service_role" >/dev/null
restore_roles() { "${as_super[@]}" -d postgres -c "revoke $owner from service_role; grant service_role to $owner" >/dev/null; }
inherit_truncate="$(q "select has_table_privilege('service_role', 'public.ai_lab_topic_claims', 'TRUNCATE')")"
if out="$(owner_psql -f "$candidate" 2>&1)"; then restore_roles; fail "inheritance: reapply accepted service_role inheriting the owner"; fi
restore_roles
expect_eq "inheritance precondition: service_role really had effective TRUNCATE via the owner" "$inherit_truncate" "t"
grep -qF "AI_LAB_TOPIC_CLAIMS_PREFLIGHT" <<<"$out" && pass "inheritance: reapply refused (service_role member of the owner)" || fail "inheritance message :: $out"
fresh_db inheritance_fresh
"${as_super[@]}" -d postgres -c "revoke service_role from $owner; grant $owner to service_role" >/dev/null
if out="$(owner_psql -f "$candidate" 2>&1)"; then restore_roles; fail "inheritance: fresh apply accepted service_role inheriting the owner"; fi
restore_roles
grep -qF "AI_LAB_TOPIC_CLAIMS_PREFLIGHT" <<<"$out" && pass "inheritance: fresh apply refused" || fail "inheritance fresh message :: $out"
expect_eq "refused fresh apply created nothing" "$(q "select coalesce(to_regclass('public.ai_lab_topic_claims')::text, 'absent')")" "absent"

echo "ALL AI LAB TOPIC CLAIM CHECKS PASSED"
