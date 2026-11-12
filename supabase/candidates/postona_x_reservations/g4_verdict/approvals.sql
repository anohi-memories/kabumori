-- G3-02 #16 (TEST ONLY, fake data): 018 approvals + notifications in the world behavior.sql and connection_generation.sql left behind
-- (g4_verdict_run.sh, phase VA): G5's real MV / service / restart, G4's real connect / disconnect / precheck, 001's real create_batch.
-- SYNTHETIC (labelled): the service end; the loss of workspace ownership (inside a transaction that is rolled back). No provider is called.
\set ON_ERROR_STOP 1
set timezone = 'UTC';
delete from g48.results;
create function g48.ap(p int, p_sql text) returns text language sql as $$ select g48.as_role('postona_resv_api', p, p_sql) $$;
-- G3-02 #20: SYNTHETIC reservation changes that test the list-time path switch 018's change trigger off around themselves (when it exists)
create function g48.notify_trigger(p_on boolean) returns void language plpgsql as $$
begin
  if exists (select 1 from pg_trigger where tgname = 'reservations_changed_notify') then
    execute format('alter table postona_x_resv.reservations %s trigger reservations_changed_notify', case when p_on then 'enable' else 'disable' end);
  end if;
end $$;
create function g48.ap_submit(p int, p_name text, p_hours int, p_body text default null, p_client uuid default null) returns text language plpgsql as $$
declare v text;
begin
  v := g48.ap(p, format('select candidate_id::text from postona_x_resv.submit_approval(%L, %L::uuid, %L, date_trunc(''hour'', now()) + make_interval(hours => %s))',
                        g48.xacct(p), coalesce(p_client, md5(p_name)::uuid), coalesce(p_body, 'G3-02 #16 本文 ' || p_name), p_hours));
  if v !~ '^ERR' and v <> '<null>' and g48.id(p_name) is null then perform g48.keep(p_name, v::uuid); end if;
  return v;
end $$;
create function g48.ap_rev(p_name text) returns int language sql stable as $$ select revision from postona_x_resv.approval_candidates where id = g48.id(p_name) $$;
create function g48.ap_sha(p_name text) returns text language sql stable as $$ select content_sha256 from postona_x_resv.approval_candidates where id = g48.id(p_name) $$;
create function g48.ap_state(p_name text) returns text language sql stable as $$
  select c.state || '/' || c.revision || '/' || case when c.reservation_id is null then 'none' else 'resv' end from postona_x_resv.approval_candidates c where c.id = g48.id(p_name) $$;
create function g48.ap_approve(p int, p_name text, p_rev int default null, p_sha text default null) returns text language sql as $$
  select g48.ap(p, format('select state || ''/'' || revision from postona_x_resv.approve_candidate(%L::uuid, %s, %L)', g48.id(p_name),
                          coalesce(p_rev, g48.ap_rev(p_name)), coalesce(p_sha, g48.ap_sha(p_name)))) $$;
create function g48.ap_reject(p int, p_name text, p_rev int default null) returns text language sql as $$
  select g48.ap(p, format('select state || ''/'' || revision from postona_x_resv.reject_candidate(%L::uuid, %s)', g48.id(p_name), coalesce(p_rev, g48.ap_rev(p_name)))) $$;
create function g48.ap_notes(p int) returns text language sql as $$
  select g48.ap(p, 'select coalesce(string_agg(kind || ''/'' || state || ''/'' || subject_revision, '','' order by created_at, kind), ''-'') from postona_x_resv.list_notifications(100)') $$;
create function g48.resv_count(p int) returns text language sql stable as $$ select count(*)::text from postona_x_resv.reservations where user_id = g48.u(p) $$;
create function g48.outbox(p int) returns text language sql stable as $$ select count(*)::text from postona_x_resv.push_outbox where user_id = g48.u(p) $$;

select g48.person(4841);
select g48.xconnect(4841, 'ap1', '48410');
select g48.person(4842);
select g48.xconnect(4842, 'ap2', '48420');
select g48.nobody();

-- AP1 submit: pending, one notification + one outbox row; not a reservation
select g48.check_('AP1 submit', 'ok', case when g48.ap_submit(4841, 'a1', 600) ~ '^[0-9a-f-]{36}$' then 'ok' else g48.ap_submit(4841, 'a1', 600) end);
select g48.check_('AP1 state', 'pending_approval/1/none', g48.ap_state('a1'));
select g48.check_('AP1 not a reservation', '0', g48.resv_count(4841));
select g48.check_('AP1 notification', 'approval_requested/pending_approval/1', g48.ap_notes(4841));
select g48.check_('AP1 outbox', '1', g48.outbox(4841));
-- AP2 the same request again: the same row, nothing new; another payload under the same request id: refused
select g48.check_('AP2 replay', g48.id('a1')::text, g48.ap_submit(4841, 'a1', 600));
select g48.check_('AP2 replay, notifications', '1', (select count(*)::text from postona_x_resv.notifications where user_id = g48.u(4841)));
select g48.check_('AP2 other payload', 'ERR:POSTONA_RESV_IDEMPOTENCY_CONFLICT', g48.ap_submit(4841, 'a1x', 600, 'another text', md5('a1')::uuid));
-- AP3 input rules (as create): empty text, too long, too soon / too late
select g48.check_('AP3 empty', 'ERR:POSTONA_RESV_TEXT_INVALID', g48.ap_submit(4841, 'bad1', 600, '   '));
select g48.check_('AP3 too long', 'ERR:POSTONA_RESV_TEXT_INVALID', g48.ap_submit(4841, 'bad2', 600, repeat('あ', 141)));
select g48.check_('AP3 too soon', 'ERR:POSTONA_RESV_TIME_OUT_OF_RANGE', g48.ap_submit(4841, 'bad3', 0));
select g48.check_('AP3 too late', 'ERR:POSTONA_RESV_TIME_OUT_OF_RANGE', g48.ap_submit(4841, 'bad4', 24 * 91));
-- AP4 another person / no session: nothing of A's, the same NOT_FOUND
select g48.check_('AP4 B get', 'ERR:POSTONA_RESV_NOT_FOUND', g48.ap(4842, format('select state from postona_x_resv.get_approval(%L::uuid)', g48.id('a1'))));
select g48.check_('AP4 B approve', 'ERR:POSTONA_RESV_NOT_FOUND', g48.ap_approve(4842, 'a1'));
select g48.check_('AP4 B reject', 'ERR:POSTONA_RESV_NOT_FOUND', g48.ap_reject(4842, 'a1'));
select g48.check_('AP4 B revise', 'ERR:POSTONA_RESV_NOT_FOUND', g48.ap(4842, format('select state from postona_x_resv.revise_approval(%L::uuid, 1, ''x'', now() + interval ''700 hours'')', g48.id('a1'))));
select g48.check_('AP4 B list of A''s account', '0', g48.ap(4842, format('select count(*)::text from postona_x_resv.list_approvals(%L)', g48.xacct(4841))));
select g48.check_('AP4 B submit on A''s account', 'ERR:POSTONA_RESV_ACCOUNT_NOT_FOUND', g48.ap(4842, format('select state from postona_x_resv.submit_approval(%L, gen_random_uuid(), ''x'', now() + interval ''700 hours'')', g48.xacct(4841))));
select g48.check_('AP4 B notifications', '-', g48.ap_notes(4842));
select g48.check_('AP4 B mark A''s read', 'ERR:POSTONA_RESV_NOT_FOUND', g48.ap(4842, format('select kind from postona_x_resv.mark_notification_read(%L::uuid)', (select id from postona_x_resv.notifications where user_id = g48.u(4841) limit 1))));
select g48.check_('AP4 no session', 'ERR:POSTONA_RESV_AUTH_REQUIRED', g48.as_role('postona_resv_api', null, format('select state from postona_x_resv.get_approval(%L::uuid)', g48.id('a1'))));
-- AP5 the boundary: only the API role reaches the eight; nobody reaches the tables or the helpers
select g48.check_('AP5 authenticated', 'denied', case when g48.as_role('authenticated', 4841, 'select count(*)::text from postona_x_resv.list_notifications(10)') ~ 'permission denied' then 'denied' else 'reached' end);
select g48.check_('AP5 anon', 'denied', case when g48.as_role('anon', 4841, format('select state from postona_x_resv.get_approval(%L::uuid)', g48.id('a1'))) ~ 'permission denied' then 'denied' else 'reached' end);
select g48.check_('AP5 worker', 'denied', case when g48.as_role('postona_resv_worker', 4841, format('select state from postona_x_resv.approve_candidate(%L::uuid, 1, %L)', g48.id('a1'), g48.ap_sha('a1'))) ~ 'permission denied' then 'denied' else 'reached' end);
select g48.check_('AP5 API role, table', 'denied', case when g48.ap(4841, 'select count(*)::text from postona_x_resv.approval_candidates') ~ 'permission denied' then 'denied' else 'reached' end);
select g48.check_('AP5 API role, outbox', 'denied', case when g48.ap(4841, 'select count(*)::text from postona_x_resv.push_outbox') ~ 'permission denied' then 'denied' else 'reached' end);
select g48.check_('AP5 API role, notify', 'denied', case when g48.ap(4841, format('select postona_x_resv.notify(%L::uuid, ''b'', ''approval_requested:00000000-0000-4000-8000-000000000000'', ''approval_requested'', null, null, 1, ''x'', null)::text', g48.u(4841))) ~ 'permission denied' then 'denied' else 'reached' end);
-- AP6 revision: a stale revise / approve is refused; a revise moves the hash, so the old hash no longer approves
select g48.check_('AP6 revise stale', 'ERR:POSTONA_RESV_STALE_REVISION', g48.ap(4841, format('select state from postona_x_resv.revise_approval(%L::uuid, 7, ''G3-02 #16 v2'', now() + interval ''610 hours'')', g48.id('a1'))));
select g48.sha('G3-02 #16 本文 a1') as old_sha \gset
select g48.check_('AP6 revise', 'pending_approval/2', g48.ap(4841, format('select state || ''/'' || revision from postona_x_resv.revise_approval(%L::uuid, 1, ''G3-02 #16 v2'', now() + interval ''610 hours'')', g48.id('a1'))));
select g48.check_('AP6 revise notification', 'approval_requested/pending_approval/1,approval_requested/pending_approval/2', g48.ap_notes(4841));
select g48.check_('AP6 approve at the old revision', 'ERR:POSTONA_RESV_STALE_REVISION', g48.ap_approve(4841, 'a1', 1));
select g48.check_('AP6 approve the old text', 'ERR:POSTONA_RESV_CONSENT_REQUIRED', g48.ap_approve(4841, 'a1', 2, :'old_sha'));
select g48.check_('AP6 still no reservation', '0', g48.resv_count(4841));
-- AP7 approve: one reservation through create_batch (planned, confirmed, this text); a retry of the same approval makes nothing new
select g48.check_('AP7 approve', 'approved/3', g48.ap_approve(4841, 'a1', 2));
select g48.check_('AP7 state', 'approved/3/resv', g48.ap_state('a1'));
select g48.check_('AP7 the reservation', 'planned/confirmed/G3-02 #16 v2/appr', (select r.status || '/' || r.consent_state || '/' || r.body || '/' || split_part(r.draft_id, ':', 1)
  from postona_x_resv.reservations r join postona_x_resv.approval_candidates c on c.reservation_id = r.id where c.id = g48.id('a1')));
select g48.check_('AP7 retry', 'approved/3', g48.ap_approve(4841, 'a1', 2));
select g48.check_('AP7 retry, reservations', '1', g48.resv_count(4841));
select g48.check_('AP7 another approve', 'ERR:POSTONA_RESV_APPROVAL_NOT_PENDING', g48.ap_approve(4841, 'a1', 3));
select g48.check_('AP7 reject after approve', 'ERR:POSTONA_RESV_APPROVAL_NOT_PENDING', g48.ap_reject(4841, 'a1', 3));
select g48.check_('AP7 notification', 'approval_approved/approved/3', (select kind || '/' || state || '/' || subject_revision from postona_x_resv.notifications where candidate_id = g48.id('a1') and kind = 'approval_approved'));
-- AP8 reject: no reservation; a retry answers the same; approve after reject refused
select g48.ap_submit(4841, 'a2', 620);
select g48.check_('AP8 reject', 'rejected/2', g48.ap_reject(4841, 'a2', 1));
select g48.check_('AP8 retry', 'rejected/2', g48.ap_reject(4841, 'a2', 1));
select g48.check_('AP8 approve after reject', 'ERR:POSTONA_RESV_APPROVAL_NOT_PENDING', g48.ap_approve(4841, 'a2', 2));
select g48.check_('AP8 reservations', '1', g48.resv_count(4841));
-- AP9 reservation_changed: a reschedule and a cancel of the approved reservation show up once each, on the next list
select g48.check_('AP9 reschedule', 'planned', g48.ap(4841, format('select status from postona_x_resv.reschedule(%L::uuid, 1, now() + interval ''630 hours'')', (select reservation_id from postona_x_resv.approval_candidates where id = g48.id('a1')))));
select g48.ap_notes(4841) as n1 \gset
select g48.check_('AP9 one event', '1', (select count(*)::text from postona_x_resv.notifications where candidate_id = g48.id('a1') and kind = 'reservation_changed'));
select g48.check_('AP9 list twice, no duplicate', :'n1', g48.ap_notes(4841));
select g48.check_('AP9 cancel', 'cancelled', g48.ap(4841, format('select status from postona_x_resv.cancel(%L::uuid, 2)', (select reservation_id from postona_x_resv.approval_candidates where id = g48.id('a1')))));
select g48.ap_notes(4841);
select g48.check_('AP9 events', 'planned/2,cancelled/3', (select string_agg(state || '/' || subject_revision, ',' order by subject_revision) from postona_x_resv.notifications where candidate_id = g48.id('a1') and kind = 'reservation_changed'));
select g48.check_('AP9 outbox per notification', (select count(*)::text from postona_x_resv.notifications where user_id = g48.u(4841)), g48.outbox(4841));
-- AP10 mark read: own only, idempotent (the first time stays)
select id as nid from postona_x_resv.notifications where user_id = g48.u(4841) order by created_at limit 1 \gset
select g48.check_('AP10 read', 'read', g48.ap(4841, format('select case when read_at is not null then ''read'' else ''unread'' end from postona_x_resv.mark_notification_read(%L::uuid)', :'nid')));
select read_at::text as r1 from postona_x_resv.notifications where id = :'nid' \gset
select g48.ap(4841, format('select kind from postona_x_resv.mark_notification_read(%L::uuid)', :'nid'));
select g48.check_('AP10 read twice', :'r1', (select read_at::text from postona_x_resv.notifications where id = :'nid'));
select g48.check_('AP10 bad limit', 'ERR:POSTONA_RESV_REQUEST_INVALID', g48.ap(4841, 'select kind from postona_x_resv.list_notifications(1000)'));
-- AP11 disconnected (G4's real SQL): approve refused, nothing written; reject still works
select g48.ap_submit(4841, 'a3', 640);
select g48.ap_submit(4841, 'a4', 650);
select g48.xdisconnect(4841);
select g48.check_('AP11 approve', 'ERR:POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED', g48.ap_approve(4841, 'a3'));
select g48.check_('AP11 submit', 'ERR:POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED', g48.ap_submit(4841, 'a5', 660));
select g48.check_('AP11 nothing written', 'pending_approval/1/none|1', g48.ap_state('a3') || '|' || g48.resv_count(4841));
select g48.xconnect(4841, 'ap3', '48410');
select g48.nobody();
-- AP12 service ended (SYNTHETIC end): approve / submit refused (SERVICE_NOT_ACTIVE); reject, list, read go on
select g48.cg_end(4841);
select g48.check_('AP12 approve', 'ERR:POSTONA_RESV_SERVICE_NOT_ACTIVE', g48.ap_approve(4841, 'a3'));
select g48.check_('AP12 reject', 'rejected/2', g48.ap_reject(4841, 'a4', 1));
select g48.check_('AP12 list', 'ok', case when g48.ap_notes(4841) ~ '^ERR' then 'err' else 'ok' end);
-- AP13 restarted: with the old connection refused (reconnect); after a reconnect, a candidate of the earlier generation is refused,
-- a new one is approved
select g48.check_('AP13 restart', 'active', g48.cg_restart(4841));
select g48.nobody();
select g48.check_('AP13 old connection', 'ERR:POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED', g48.ap_approve(4841, 'a3'));
select g48.xconnect(4841, 'ap4', '48410');
select g48.nobody();
select g48.check_('AP13 earlier generation', 'ERR:POSTONA_RESV_APPROVAL_GENERATION_CHANGED', g48.ap_approve(4841, 'a3'));
select g48.check_('AP13 still pending, no reservation', 'pending_approval/1/none', g48.ap_state('a3'));
select g48.ap_submit(4841, 'a6', 670);
select g48.check_('AP13 new candidate approved', 'approved/2', g48.ap_approve(4841, 'a6'));
-- AP14 the workspace is no longer the caller's (SYNTHETIC, rolled back): nothing readable or writable
begin;
delete from public.brand_memberships where user_id = g48.u(4841) and brand_id = g48.ws(4841);
select g48.ap(4841, format('select state from postona_x_resv.get_approval(%L::uuid)', g48.id('a3'))) as w_get,
       g48.ap(4841, 'select count(*)::text from postona_x_resv.list_notifications(100)') as w_notes,
       g48.ap_reject(4841, 'a3') as w_reject \gset
rollback;
select g48.check_('AP14 get', 'ERR:POSTONA_RESV_NOT_FOUND', :'w_get');
select g48.check_('AP14 notifications', '0', :'w_notes');
select g48.check_('AP14 reject', 'ERR:POSTONA_RESV_NOT_FOUND', :'w_reject');
-- AP15 the worker never sees a candidate: due reservations are only the approved ones
select g48.check_('AP15 claimable rows are reservations', '0', (select count(*)::text from postona_x_resv.reservations r where r.user_id = g48.u(4841)
  and r.draft_id like 'appr:%' and not exists (select 1 from postona_x_resv.approval_candidates c where c.reservation_id = r.id and c.state = 'approved')));
-- AP16 a deleted workspace / account takes its candidates and notifications with it (CATALOG ONLY: the foreign keys cascade; deleting a real
-- workspace here is blocked by other owners' tables, and G5's deletion saga is not run)
select g48.check_('AP16 cascades', 'approval_candidates>brands:c,approval_candidates>reservations:n,approval_candidates>social_accounts:c,notifications>approval_candidates:c,notifications>brands:c,push_outbox>notifications:c',
  (select string_agg(x, ',' order by x collate "C") from (
     select regexp_replace(c.conrelid::regclass::text, '^.*\.', '') || '>' || regexp_replace(c.confrelid::regclass::text, '^.*\.', '') || ':' || c.confdeltype::text as x
     from pg_constraint c
    where c.contype = 'f' and c.conrelid in ('postona_x_resv.approval_candidates'::regclass, 'postona_x_resv.notifications'::regclass, 'postona_x_resv.push_outbox'::regclass)) t));

-- AP17 (G3-02 #17, H1 #37 P2-1) a disconnect + reconnect of the SAME account (G4's real SQL), G5's generation unchanged: a candidate
-- submitted under the earlier connection is refused and no reservation is made; a revise under the new connection rebinds it
select g48.person(4843);
select g48.xconnect(4843, 'ap7', '48430');
select g48.nobody();
select g48.xacct(4843) as acct17, (select lifecycle_version::text from public.common_accounts where user_id = g48.u(4843)) as life17,
       postona_x_resv.x_credential_generation(g48.xacct(4843)) as gen17 \gset
select g48.ap_submit(4843, 'g1', 680);
select g48.ap_submit(4843, 'g2', 690);
select g48.xdisconnect(4843);
select g48.xconnect(4843, 'ap8', '48430');
select g48.nobody();
select g48.check_('AP17 the same account', :'acct17', g48.xacct(4843));
select g48.check_('AP17 G5 generation unchanged', :'life17', (select lifecycle_version::text from public.common_accounts where user_id = g48.u(4843)));
select g48.check_('AP17 G4 generation moved', 'moved', case when postona_x_resv.x_credential_generation(g48.xacct(4843)) is distinct from :'gen17' then 'moved' else 'same' end);
select g48.check_('AP17 old candidate', 'ERR:POSTONA_RESV_APPROVAL_GENERATION_CHANGED', g48.ap_approve(4843, 'g1'));
select g48.check_('AP17 nothing written', 'pending_approval/1/none|0', g48.ap_state('g1') || '|' || g48.resv_count(4843));
select g48.check_('AP17 revise under the new connection', 'pending_approval/2', g48.ap(4843, format('select state || ''/'' || revision from postona_x_resv.revise_approval(%L::uuid, 1, ''G3-02 #17 g2 v2'', now() + interval ''700 hours'')', g48.id('g2'))));
select g48.check_('AP17 then approved', 'approved/3', g48.ap_approve(4843, 'g2'));
select g48.check_('AP17 one reservation', '1', g48.resv_count(4843));
-- AP18 (G3-02 #17, H1 #37 P2-2) a former owner's list writes no notification and no outbox row; the current owner's list writes the event once
create function g48.note_rows(p int) returns text language sql stable as $$
  select (select count(*) from postona_x_resv.notifications where user_id = g48.u(p))::text || '/' || (select count(*) from postona_x_resv.push_outbox where user_id = g48.u(p))::text $$;
begin;
select g48.notify_trigger(false);
update postona_x_resv.reservations set status = 'cancelled', revision = revision + 1 where id = (select reservation_id from postona_x_resv.approval_candidates where id = g48.id('g2'));
select g48.notify_trigger(true);
select g48.note_rows(4843) as before18 \gset
delete from public.brand_memberships where user_id = g48.u(4843) and brand_id = g48.ws(4843);
select g48.ap_notes(4843) as l1, g48.ap_notes(4843) as l2 \gset
select g48.note_rows(4843) as after18 \gset
rollback;
select g48.check_('AP18 former owner: list answers nothing', '-|-', :'l1' || '|' || :'l2');
select g48.check_('AP18 former owner: 0 writes', :'before18', :'after18');
begin;
select g48.notify_trigger(false);
update postona_x_resv.reservations set status = 'cancelled', revision = revision + 1 where id = (select reservation_id from postona_x_resv.approval_candidates where id = g48.id('g2'));
select g48.notify_trigger(true);
select g48.note_rows(4843) as before18b \gset
select g48.ap_notes(4843) as m1 \gset
select g48.ap_notes(4843) as m2 \gset
select g48.note_rows(4843) as after18b, (select count(*)::text from postona_x_resv.notifications where candidate_id = g48.id('g2') and kind = 'reservation_changed') as ev18 \gset
rollback;
select g48.check_('AP18 current owner: one event', '1', :'ev18');
select g48.check_('AP18 current owner: +1 notification, +1 outbox', (split_part(:'before18b', '/', 1)::int + 1)::text || '/' || (split_part(:'before18b', '/', 2)::int + 1)::text, :'after18b');
select g48.check_('AP18 listed twice, the same answer', :'m1', :'m2');
-- AP19 a candidate cannot be stored without its connection (NOT NULL, 64 hex)
select g48.check_('AP19 column', 'NO|true', (select is_nullable from information_schema.columns where table_schema = 'postona_x_resv' and table_name = 'approval_candidates' and column_name = 'bound_credential_generation')
  || '|' || exists (select 1 from pg_constraint where conrelid = 'postona_x_resv.approval_candidates'::regclass and pg_get_constraintdef(oid) ~ 'bound_credential_generation.*\{64\}')::text);

-- AP20 (G3-02 #17) the write guard itself, not only the list's filter: notify() as the owner for a person who no longer owns the
-- workspace writes nothing; and a person whose G5 eligibility is no longer 'own' (they also own another workspace, SYNTHETIC) gets no
-- derived event (both rolled back)
begin;
delete from public.brand_memberships where user_id = g48.u(4843) and brand_id = g48.ws(4843);
select g48.note_rows(4843) as b20 \gset
select postona_x_resv.notify(g48.u(4843), g48.ws(4843), 'approval_requested:' || gen_random_uuid() || ':r1', 'approval_requested', null, null, 1, 'pending_approval', null);
select g48.note_rows(4843) as a20 \gset
rollback;
select g48.check_('AP20 notify for a former owner', :'b20', :'a20');
begin;
select g48.notify_trigger(false);
update postona_x_resv.reservations set status = 'cancelled', revision = revision + 1 where id = (select reservation_id from postona_x_resv.approval_candidates where id = g48.id('g2'));
select g48.notify_trigger(true);
insert into public.brand_memberships (brand_id, user_id, role) values (g48.ws(4842), g48.u(4843), 'owner');
select private.postona_personal_workspace_eligibility(g48.u(4843)) as elig20, g48.note_rows(4843) as b20b \gset
select g48.ap_notes(4843) as n20 \gset
select g48.note_rows(4843) as a20b \gset
rollback;
select g48.check_('AP20 G5 eligibility not own', 'not own', case when :'elig20' = 'own' then 'own' else 'not own' end);
select g48.check_('AP20 no derived event', :'b20b', :'a20b');

-- AP21 (G3-02 #20, G2 #11) marking read is a write: refused after a service end (SYNTHETIC end), read_at unchanged; reading goes on;
-- after the restart it works again (all rolled back)
select n.id as nid21 from postona_x_resv.notifications n where n.user_id = g48.u(4843) and n.read_at is null order by n.created_at limit 1 \gset
begin;
select g48.cg_end(4843);
select g48.ap(4843, format('select kind from postona_x_resv.mark_notification_read(%L::uuid)', :'nid21')) as m21,
       g48.ap(4843, 'select count(*)::text from postona_x_resv.list_notifications(100)') as l21,
       g48.ap(4843, format('select count(*)::text from postona_x_resv.list_approvals(%L)', g48.xacct(4843))) as a21 \gset
select coalesce(read_at::text, 'unread') as r21 from postona_x_resv.notifications where id = :'nid21' \gset
select g48.cg_restart(4843) as restart21 \gset
select g48.nobody();
select g48.ap(4843, format('select case when read_at is null then ''unread'' else ''read'' end from postona_x_resv.mark_notification_read(%L::uuid)', :'nid21')) as m21b \gset
rollback;
select g48.check_('AP21 markRead after the end', 'ERR:POSTONA_RESV_SERVICE_NOT_ACTIVE', :'m21');
select g48.check_('AP21 read_at unchanged', 'unread', :'r21');
select g48.check_('AP21 notifications still read', 'ok', case when :'l21' ~ '^[0-9]+$' and :'l21'::int > 0 then 'ok' else :'l21' end);
select g48.check_('AP21 candidates still read', 'ok', case when :'a21' ~ '^[0-9]+$' then 'ok' else :'a21' end);
select g48.check_('AP21 restarted', 'active|read', :'restart21' || '|' || :'m21b');
-- AP22 (G3-02 #20 / #21) the change trigger only RECORDS the event (reservation_events) in the change's own transaction; the list turns it
-- into one notification + outbox row and deletes the record; 'claimed' is not an event; a later list adds nothing (rolled back)
create function g48.events43() returns text language plpgsql stable as $$
declare v text;
begin
  if pg_catalog.to_regclass('postona_x_resv.reservation_events') is null then return 'none'; end if;   -- an 018 before G3-02 #21
  execute 'select count(*)::text from postona_x_resv.reservation_events where user_id = $1' into v using g48.u(4843);
  return v;
end $$;
begin;
select g48.ap_notes(4843);
select g48.note_rows(4843) as b22, g48.events43() as e22 \gset
update postona_x_resv.reservations set status = 'claimed', lease_token = gen_random_uuid(), lease_expires_at = now() + interval '5 minutes', claimed_by = 'g3-ap22'
 where id = (select reservation_id from postona_x_resv.approval_candidates where id = g48.id('g2'));
select g48.note_rows(4843) as c22, g48.events43() as ce22 \gset
update postona_x_resv.reservations set status = 'failed', outcome_code = 'G3_AP22_TEST', lease_token = null, lease_expires_at = null, revision = revision + 1
 where id = (select reservation_id from postona_x_resv.approval_candidates where id = g48.id('g2'));
select g48.note_rows(4843) as f22, g48.events43() as fe22 \gset
select g48.ap_notes(4843);
select g48.note_rows(4843) as l22, g48.events43() as le22,
       (select count(*)::text from postona_x_resv.notifications where candidate_id = g48.id('g2') and kind = 'reservation_changed' and state = 'failed') as ev22 \gset
select g48.ap_notes(4843);
select g48.note_rows(4843) as l22b \gset
rollback;
select g48.check_('AP22 claimed: no event, nothing recorded', :'b22' || '|' || :'e22', :'c22' || '|' || :'ce22');
select g48.check_('AP22 failed: recorded, no notification yet', :'b22' || '|' || coalesce((nullif(regexp_replace(:'e22', '[^0-9]', '', 'g'), '')::int + 1)::text, 'no event table'), :'f22' || '|' || :'fe22');
select g48.check_('AP22 the list: +1 / +1, the record gone', (split_part(:'b22', '/', 1)::int + 1)::text || '/' || (split_part(:'b22', '/', 2)::int + 1)::text || '|' || :'e22', :'l22' || '|' || :'le22');
select g48.check_('AP22 one failed event', '1', :'ev22');
select g48.check_('AP22 a later list adds nothing', :'l22', :'l22b');
-- AP23 the change never fails on its notification: a former owner's reservation change commits and writes nothing (rolled back)
begin;
delete from public.brand_memberships where user_id = g48.u(4843) and brand_id = g48.ws(4843);
select g48.note_rows(4843) as b23 \gset
update postona_x_resv.reservations set status = 'cancelled', revision = revision + 1 where id = (select reservation_id from postona_x_resv.approval_candidates where id = g48.id('g2'));
select g48.note_rows(4843) as a23, (select status from postona_x_resv.reservations where id = (select reservation_id from postona_x_resv.approval_candidates where id = g48.id('g2'))) as s23 \gset
rollback;
select g48.check_('AP23 the change committed', 'cancelled', :'s23');
select g48.check_('AP23 nothing written for a former owner', :'b23', :'a23');

-- AP24 (G3-02 #20) a notification that cannot be written never fails the reservation change (notify() missing, SYNTHETIC, rolled back)
begin;
alter function postona_x_resv.notify(uuid, text, text, text, uuid, uuid, integer, text, timestamptz) rename to notify_g3ap24;
select g48.try('update postona_x_resv.reservations set status = ''cancelled'', revision = revision + 1 where id = (select reservation_id from postona_x_resv.approval_candidates where id = g48.id(''g2'')) returning status') as u24 \gset
rollback;
select g48.check_('AP24 the change commits without its notification', 'cancelled', :'u24');
-- AP25 markRead while the workspace is no longer the person's own personal one (they own a second workspace, SYNTHETIC): refused,
-- read_at unchanged (rolled back)
select n.id as nid25 from postona_x_resv.notifications n where n.user_id = g48.u(4843) and n.read_at is null order by n.created_at limit 1 \gset
begin;
insert into public.brand_memberships (brand_id, user_id, role) values (g48.ws(4842), g48.u(4843), 'owner');
select g48.ap(4843, format('select kind from postona_x_resv.mark_notification_read(%L::uuid)', :'nid25')) as m25 \gset
select coalesce(read_at::text, 'unread') as r25 from postona_x_resv.notifications where id = :'nid25' \gset
rollback;
select g48.check_('AP25 refused', 'refused', case when :'m25' ~ '^ERR:POSTONA_RESV_' then 'refused' else :'m25' end);
select g48.check_('AP25 read_at unchanged', 'unread', :'r25');
\echo AP25_ANSWER :m25

-- AP26 (G3-02 #21, H1 #46 P3) version 2 and version 3 each become one notification, even when version 2 was recorded while notifications
-- could not be written (the workspace briefly not the person's own personal one, SYNTHETIC; rolled back)
begin;
select g48.ap_notes(4843);   -- nothing pending before the test
select g48.note_rows(4843) as b26 \gset
insert into public.brand_memberships (brand_id, user_id, role) values (g48.ws(4842), g48.u(4843), 'owner');
update postona_x_resv.reservations set revision = revision + 1 where id = (select reservation_id from postona_x_resv.approval_candidates where id = g48.id('g2'));
select g48.ap_notes(4843);
select g48.note_rows(4843) as m26, g48.events43() as me26 \gset
update postona_x_resv.reservations set revision = revision + 1 where id = (select reservation_id from postona_x_resv.approval_candidates where id = g48.id('g2'));
delete from public.brand_memberships where brand_id = g48.ws(4842) and user_id = g48.u(4843);
select g48.ap_notes(4843);
select g48.ap_notes(4843);
select g48.note_rows(4843) as a26, g48.events43() as ae26,
       (select coalesce(string_agg(subject_revision::text, ',' order by subject_revision), 'none') from postona_x_resv.notifications
         where candidate_id = g48.id('g2') and kind = 'reservation_changed' and subject_revision >= (select revision - 1 from postona_x_resv.reservations
           where id = (select reservation_id from postona_x_resv.approval_candidates where id = g48.id('g2'))))
       as revs26, (select (revision - 1)::text || ',' || revision::text from postona_x_resv.reservations
         where id = (select reservation_id from postona_x_resv.approval_candidates where id = g48.id('g2'))) as want26 \gset
rollback;
select g48.check_('AP26 not personal: recorded, nothing written', :'b26' || '|1', :'m26' || '|' || :'me26');
select g48.check_('AP26 personal again: both versions once', :'want26', :'revs26');
select g48.check_('AP26 +2 / +2 and nothing left recorded', (split_part(:'b26', '/', 1)::int + 2)::text || '/' || (split_part(:'b26', '/', 2)::int + 2)::text || '|0', :'a26' || '|' || :'ae26');

select n, case_id, case when expected = actual then 'ok' else 'FAIL expected ' || coalesce(expected, '<null>') || ' got ' || coalesce(actual, '<null>') end from g48.results order by n;
do $$ begin
  if exists (select 1 from g48.results where expected is distinct from actual) then raise exception 'G3_APPROVALS_BEHAVIOR_FAIL'; end if;
  if (select count(*) from g48.results) < 75 then raise exception 'G3_APPROVALS_BEHAVIOR_INCOMPLETE %', (select count(*) from g48.results); end if;
end $$;
select 'G3_APPROVALS_BEHAVIOR_PASS';
