-- G4-42 (Issue #319): B10 for Threads. Run by postona_g4_threads_entry_recheck_run.sh as the non-superuser table owner on a
-- disposable PG17 world (real G5 lifecycle + F5 owner epoch + PR #124 + binding-epoch 001 + G5 PR #506's predicate body
-- copied verbatim), AFTER the tb.* helpers of postona_threads_binding_epoch_behavior.sql (the runner prepends them).
-- mode=current: the binding-epoch 001 entry as it is (the gap REPRODUCES); mode=candidate: + 001_threads_entry_workspace_recheck.
select set_config('g4t.mode', :'mode', false);
create function tb.want(p_case text, p_got text, p_current text, p_candidate text) returns void language plpgsql as $$
declare v_exp text := case current_setting('g4t.mode') when 'current' then p_current else p_candidate end;
begin
  perform tb.check(p_got = v_exp, p_case || ': expected ' || v_exp || ', got ' || p_got);
end $$;
-- begin + record the numbers of the allow, as H5's owner transport does
create function tb.begin_recorded(p_user uuid, p_tag text) returns text language plpgsql as $$
declare v text;
begin
  v := tb.begin(p_user, p_tag);
  if v not like 'sa_%' then return v; end if;
  return tb.record(p_user, p_tag, tb.epoch(p_user), tb.lifecycle(p_user));
end $$;

-- T1 the normal connect
select tb.enroll(1) as a \gset
select tb.want('T1 begin', tb.begin_recorded(:'a', 'a1'), 'OK', 'OK');
select tb.want('T1 connect', tb.connect(:'a', 'a1', '17841400000000101'), 'OK', 'OK');

-- T2 the person became the owner of another brand between begin and the callback
select tb.enroll(2) as b \gset
select tb.want('T2 begin', tb.begin_recorded(:'b', 'b1'), 'OK', 'OK');
insert into public.brands (id, display_name, is_active, publish_mode, code_profile_key)
  values ('legacy_t2', 'Legacy', false, 'disabled', 'legacy_v0');
insert into public.brand_memberships (brand_id, user_id, role) values ('legacy_t2', :'b', 'owner');
select tb.epoch(:'b') = (select g.owner_epoch from postona_threads_binding.state_generations g where g.oauth_state_id = tb.state('b1'))
  as b_epoch_same \gset
select tb.check(:'b_epoch_same'::boolean, 'T2 the workspace owner epoch did not move (so the entry''s epoch check cannot see it)');
select tb.snap() as s2 \gset
select tb.want('T2 callback after owning another brand', tb.connect(:'b', 'b1', '17841400000000102'), 'OK', 'ERR:OWN_WORKSPACE_CONFLICT');
select tb.check(current_setting('g4t.mode') = 'current' or (tb.snap() = :'s2' and tb.unbound('b1')),
                'T2 the refusal left nothing (PR #124 complete undone with it)');
-- recovery: once the other brand is gone the same state connects (nothing was consumed by the refusal)
delete from public.brand_memberships where brand_id = 'legacy_t2';
select tb.want('T2 the same state after the other brand is gone',
  case when current_setting('g4t.mode') = 'current' then 'n/a' else tb.connect(:'b', 'b1', '17841400000000102') end, 'n/a', 'OK');

-- T3 somebody else was added to the person's workspace between begin and the callback
select tb.enroll(3) as c \gset
select tb.enroll(4) as d \gset
select tb.want('T3 begin', tb.begin_recorded(:'c', 'c1'), 'OK', 'OK');
insert into public.brand_memberships (brand_id, user_id, role) values (tb.ws(:'c'), :'d', 'member');
select tb.want('T3 callback with another member', tb.connect(:'c', 'c1', '17841400000000103'), 'OK', 'ERR:OWN_WORKSPACE_CONFLICT');

-- T4 the existing refusals keep their code and come first (someone else's state)
select tb.enroll(5) as e \gset
select tb.want('T4 begin', tb.begin_recorded(:'e', 'e1'), 'OK', 'OK');
select tb.want('T4 another person''s callback', left(tb.connect(:'e', 'e1', '17841400000000104', :'a'), 30),
  'ERR:THREADS_OAUTH_STATE_NOT_CO', 'ERR:THREADS_OAUTH_STATE_NOT_CO');

select 'G4T_THREADS_RECHECK_BEHAVIOR_PASS mode=' || current_setting('g4t.mode') as result;
