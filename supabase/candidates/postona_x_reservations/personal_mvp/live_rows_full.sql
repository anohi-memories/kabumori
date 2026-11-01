-- G3-42 (TEST ONLY): after the 008 rollback with only finished MVP-bound rows left (personal_mvp_run.sh, phase LR). The FULL world comes
-- back -- TEST STAND-IN: a W1 that answers active -- and B's FULL-bound row is due: claim_due runs (no restored-rule violation from a
-- finished MVP row -- G3-43: nor from the expired non-single row le, which nothing updates) and claims it, nothing else. Then the stand-ins are removed again (W1, B's row, t42) for the RB checks.
\ir helpers.sql
create function pg_temp.id(p_name text) returns uuid language sql stable as $$ select id from t42.ids where name = p_name $$;

select pg_temp.expect(exists (select 1 from pg_constraint c where c.conrelid = 'postona_x_resv.reservations'::regclass
  and pg_get_constraintdef(c.oid) = 'CHECK (((bound_owner_epoch IS NULL) = (bound_lifecycle_version IS NULL))) NOT VALID'), 'F0 pair rule restored');
select pg_temp.expect(not exists (select 1 from postona_x_resv.reservations where bound_owner_epoch is null and bound_lifecycle_version is not null
                                    and status not in ('published', 'failed', 'cancelled') and not (status = 'expired' and draft_id !~ '^single:')),
  'F1 only finished MVP rows');
select pg_temp.expect(pg_temp.row_of(pg_temp.id('le')) = 'expired/-', 'F1 le (expired, not single) stayed');
create function private.account_lifecycle_worker_brand_verdict(text, text, bigint, bigint) returns text language sql stable as $$ select 'active' $$;
select pg_temp.make_due(pg_temp.id('bf'));
select pg_temp.expect(pg_temp.claim() like pg_temp.id('bf') || '=%', 'F2 B claimed, nothing else');
select pg_temp.expect(pg_temp.claim() = '', 'F2 no second claim');
select pg_temp.expect(pg_temp.row_of(pg_temp.id('bf')) = 'claimed/-', 'F2 B row');
select pg_temp.expect(pg_temp.row_of(pg_temp.id('le')) = 'expired/-', 'F3 claim_due left le alone');
drop function private.account_lifecycle_worker_brand_verdict(text, text, bigint, bigint);
delete from postona_x_resv.reservations where id = pg_temp.id('bf');
drop schema t42 cascade;
select 'G3_LIVE_ROWS_FULL_PASS';
