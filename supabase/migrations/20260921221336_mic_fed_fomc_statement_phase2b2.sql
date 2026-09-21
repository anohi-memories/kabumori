-- Market Intelligence Core Central Banks Phase 2B2 (local candidate only).
-- The existing registry has no `central_bank` category, so use the smallest
-- existing compatible category (`macro`) without altering historical CHECKs.
-- The source remains inactive until a later production activation decision.
-- Existing market_events.event_type also has no central_bank_decision value;
-- this migration intentionally does not alter that constraint.

insert into public.mic_source_registry (
  source_key, category, display_name, provider, endpoint_url, source_kind,
  requires_auth, cost_tier, update_frequency_minutes, expected_delay_minutes,
  quality_tier, is_official, is_primary, is_active, reliability_notes
) values (
  'fed',
  'macro',
  'Federal Reserve FOMC statements',
  'Federal Reserve',
  'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
  'html_scrape',
  false,
  'free',
  1440,
  0,
  'official',
  true,
  true,
  false,
  'Official FOMC calendar and statement HTML. Activation is deferred until the central_bank_decision event_type schema is expanded in a later phase.'
)
on conflict (source_key) do nothing;
