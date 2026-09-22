-- Market Intelligence Core Central Banks Phase 2B3.
-- Add the deterministic Fed/central-bank event type without recreating the
-- table or changing any existing event type or row.
begin;

alter table public.market_events
  drop constraint if exists market_events_event_type_check;

alter table public.market_events
  add constraint market_events_event_type_check check (event_type in (
    'price_move', 'rate_decision', 'macro_release', 'central_bank_decision',
    'earnings', 'guidance', 'buyback', 'dividend', 'ma_deal', 'large_order',
    'regulatory', 'shareholder_structure', 'sanction', 'geopolitical',
    'political_statement', 'other'
  ));

commit;
