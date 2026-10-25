-- G4-43 (Issue #319): the Threads callback entry with G5's S2-2 person-session verdict (002_threads_entry_person_session.sql),
-- run after the tb.* helpers and postona_g4_threads_person_session_claims.sql. mode=g442: G4-42's 001 entry only;
-- mode=g443: + 002. Disposable PG17; fake attestation key, fake tokens.
select set_config('g4t.mode', :'mode', false);
create function tb.want(p_case text, p_got text, p_g442 text, p_g443 text) returns void language plpgsql as $$
declare v_exp text := case current_setting('g4t.mode') when 'g442' then p_g442 else p_g443 end;
begin
  perform tb.check(p_got = v_exp, p_case || ': expected ' || v_exp || ', got ' || p_got);
end $$;
create function tb.begin_recorded(p_user uuid, p_tag text) returns text language plpgsql as $$
declare v text;
begin
  v := tb.begin(p_user, p_tag);
  if v not like 'sa_%' then return v; end if;
  return tb.record(p_user, p_tag, tb.epoch(p_user), tb.lifecycle(p_user));
end $$;
create function tb.anon(p text) returns void language sql as $$ select set_config('g4t.anon', p, false) $$;
-- tb.connect with an explicit session id in the claims (the transport carries the id it verified, even if that session ended)
create function tb.connect_as_session(p_user uuid, p_session uuid, p_tag text, p_puid text) returns text language plpgsql as $$
declare v_state uuid := tb.state(p_tag);
begin
  perform tb.claims(p_user, p_session);
  perform postona_threads_binding.complete_and_attest_binding(v_state, p_puid, 'h' || p_puid, tb.token(p_tag),
                                                              tb.attest(v_state, p_puid, 'h' || p_puid, tb.token(p_tag)));
  perform tb.claims(null, null);
  return 'OK';
exception when others then
  perform tb.claims(null, null);
  return 'ERR:' || sqlerrm;
end $$;

-- S1 what H5's transport sends today (no is_anonymous): 002 refuses every callback -> the H5 / G5 dependency
select tb.anon('omit');
select tb.enroll(1) as a \gset
select tb.want('S1 begin', tb.begin_recorded(:'a', 'a1'), 'OK', 'OK');
select tb.snap() as s1 \gset
select tb.want('S1 callback without is_anonymous', tb.connect(:'a', 'a1', '17841400000000201'), 'OK', 'ERR:THREADS_SESSION_NOT_ACTIVE');
select tb.check(current_setting('g4t.mode') = 'g442' or (tb.snap() = :'s1' and tb.unbound('a1')), 'S1 the refusal left nothing');

-- S2 is_anonymous false (a real person): connects
select tb.anon('false');
select tb.enroll(2) as b \gset
select tb.want('S2 begin', tb.begin_recorded(:'b', 'b1'), 'OK', 'OK');
select tb.want('S2 callback of a signed-in person', tb.connect(:'b', 'b1', '17841400000000202'), 'OK', 'OK');
-- the state that S1 left unconsumed under 002 connects once the claim is there
select tb.want('S1b the same state with is_anonymous false', case when current_setting('g4t.mode') = 'g442' then 'n/a'
  else tb.connect(:'a', 'a1', '17841400000000201') end, 'n/a', 'OK');

-- S3 an anonymous session: the entry alone lets it through today (main's T13 has no anonymous rule in this world)
select tb.anon('false');
select tb.enroll(3) as c \gset
select tb.want('S3 begin', tb.begin_recorded(:'c', 'c1'), 'OK', 'OK');
select tb.anon('true');
select tb.want('S3 callback of an anonymous session', tb.connect(:'c', 'c1', '17841400000000203'), 'OK', 'ERR:THREADS_SESSION_NOT_ACTIVE');

-- S4 the session ended between begin and the callback (main's T13 in this world already refuses it, before 002 asks)
select tb.anon('false');
select tb.enroll(4) as d \gset
select tb.want('S4 begin', tb.begin_recorded(:'d', 'd1'), 'OK', 'OK');
select tb.session(:'d') as d_session \gset
update auth.sessions set not_after = now() - interval '1 second' where id = :'d_session';
select tb.want('S4 callback after the session ended (claims still carry its id)',
  tb.connect_as_session(:'d', :'d_session', 'd1', '17841400000000204'), 'ERR:ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'ERR:ACCOUNT_LIFECYCLE_AUTH_REQUIRED');

-- S5 G4-42's workspace recheck still refuses (another owned brand), with a real person's claims
select tb.anon('false');
select tb.enroll(5) as e \gset
select tb.want('S5 begin', tb.begin_recorded(:'e', 'e1'), 'OK', 'OK');
insert into public.brands (id, display_name, is_active, publish_mode, code_profile_key)
  values ('legacy_s5', 'Legacy', false, 'disabled', 'legacy_v0');
insert into public.brand_memberships (brand_id, user_id, role) values ('legacy_s5', :'e', 'owner');
select tb.want('S5 callback after owning another brand', tb.connect(:'e', 'e1', '17841400000000205'),
  'ERR:OWN_WORKSPACE_CONFLICT', 'ERR:OWN_WORKSPACE_CONFLICT');

select 'G4T_PERSON_SESSION_BEHAVIOR_PASS mode=' || current_setting('g4t.mode') as result;
