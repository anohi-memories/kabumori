-- Reproduction of the PR256 review P2 (disposable database; ledger, call-store and erasure migrations + the three
-- fixtures). A policy scoped to one user whose policy_key embeds the full user id and whose note holds an e-mail:
-- after ai_ledger_erase_user, neither string may remain anywhere in the ledger, and the footprint must not report
-- zero while they do. Prints P2_REPRO_PASS, or raises P2_REPRO_FAIL with what was left.
\set ON_ERROR_STOP 1
\set QUIET 1
do $$
declare
  u uuid := '00000000-0000-4000-8000-00000000c0de';
  r jsonb;
  fp jsonb;
  left_key bigint;
  left_note bigint;
  left_any bigint;
begin
  insert into ai_ledger.budget_policies (policy_key, scope_application, scope_subject_kind, scope_user_id, period, max_calls, note)
  values ('override.user.' || u::text, 'postona', 'user', u, 'month', 500, 'support ticket: jane@example.com');
  perform aue_test.seed_user(u, 'p2-repro');
  r := aue_test.erase(u);
  fp := aue_test.footprint(u);
  select count(*) filter (where pol.policy_key like '%' || u::text || '%'),
         count(*) filter (where pol.note like '%jane@example.com%')
    into left_key, left_note
    from ai_ledger.budget_policies pol;
  left_any := aue_test.mentions(u::text) + aue_test.mentions('jane@example.com');
  raise notice 'P2_REPRO erase=% footprint=% policy_key_with_user_id=% note_with_email=% rows_mentioning=%', r, fp, left_key, left_note, left_any;
  if left_key > 0 or left_note > 0 or left_any > 0 then
    raise exception 'P2_REPRO_FAIL: after erasure % policy key(s) still hold the user id, % note(s) the e-mail (% rows in ai_ledger / ai_calls); footprint %',
      left_key, left_note, left_any, fp;
  end if;
end;
$$;
\echo 'P2_REPRO_PASS'
