-- Market Intelligence Core (MIC) Phase 3C: Scenario evaluator Cron automation.
--
-- NOT APPLIED ANYWHERE. Source-only candidate. Once applied to a shared
-- database this file must never be edited again (fix forward with a new
-- migration).
--
-- Architecture: an INDEPENDENT Cron (not a call from the State evaluator).
-- The Scenario evaluator already decides deterministically whether AI is
-- needed: with no new State evaluation run (or fewer than two usable States)
-- an invocation ends as 'no_change' with zero AI calls. So "the Cron ran"
-- never means "AI was called"; AI is called only when a source State has a
-- source_evaluation_run_id the current Scenario was not built from.
--
-- Slots are derived from the State evaluator jobs that feed the Scenario's
-- three source domains (rates, macro, equity_index), each 10 minutes after
-- the State evaluators' :15 start. The evaluators of one batch are separate
-- jobs firing in the same minute; the 21:15 batch was measured in
-- Production at 4.7-6.9 s per domain, so :25 leaves a wide margin. A
-- Scenario that still catches a half-updated set is safe anyway: the RPC
-- re-verifies every source State under lock and fails closed, and the next
-- slot rebuilds it.
--
--   State evaluator job (Production)                Scenario slot
--   rates/macro/equity_index-after-fred-0100  01:15 Tue-Sat  ->  01:25 Tue-Sat
--   rates-after-mof-jgb-0600                  06:15 Mon-Fri  ->  06:25 Mon-Fri
--   rates-after-mof-jgb-0900                  09:15 Mon-Fri  ->  09:25 Mon-Fri
--   rates/macro/equity_index-after-fred-2100  21:15 Mon-Fri  ->  21:25 Mon-Fri
--   macro-after-estat                         22:15 Mon-Fri  ->  22:25 Mon-Fri
--
-- That is at most 5 invocations per day. Failure isolation: if a State
-- evaluator or a Scenario invocation fails, nothing else changes -- States
-- stay as they are, the Scenario stays as it was (the Phase 3B read gate
-- reports invalid/expired), and the next slot retries.
--
-- Safety (same pattern as the existing MIC automation migrations):
-- 1. No secret VALUE is written here. Both jobs reference only the Vault
--    secret NAME 'mic_scenario_evaluator_cron_secret'; it must be created
--    (with the same value as the Edge secret MIC_SCENARIO_EVALUATOR_CRON_SECRET)
--    before the jobs do anything. Until then `from secret` is empty and no
--    HTTP request is ever made, so applying this migration first is safe.
-- 2. `cron.schedule(name, ...)` upserts by job name: re-running is safe, and
--    only the two 'mic-scenario-after-state-*' names below are touched. No
--    existing MIC or non-MIC job is modified.
-- 3. No immediate/in-process retry: a failed run is picked up (or not) by
--    the next slot.
-- 4. timeout_milliseconds matches the other MIC jobs (150 s); a Scenario
--    invocation takes ~18 s with one model call and is bounded well below
--    that by the evaluator's own 45 s per-call timeout.

select cron.schedule(
  'mic-scenario-after-state-0100',
  '25 1 * * 2-6',
  $$
  with secret as (
    select decrypted_secret
    from vault.decrypted_secrets
    where name = 'mic_scenario_evaluator_cron_secret'
      and decrypted_secret is not null and decrypted_secret <> ''
    limit 1
  )
  select net.http_post(
    url := 'https://wsmznyzcvmuitkglfeuj.supabase.co/functions/v1/market-intelligence-scenario-evaluator',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', secret.decrypted_secret),
    body := '{"trigger":"cron"}'::jsonb,
    timeout_milliseconds := 150000
  )
  from secret;
  $$
);

select cron.schedule(
  'mic-scenario-after-state-weekday',
  '25 6,9,21,22 * * 1-5',
  $$
  with secret as (
    select decrypted_secret
    from vault.decrypted_secrets
    where name = 'mic_scenario_evaluator_cron_secret'
      and decrypted_secret is not null and decrypted_secret <> ''
    limit 1
  )
  select net.http_post(
    url := 'https://wsmznyzcvmuitkglfeuj.supabase.co/functions/v1/market-intelligence-scenario-evaluator',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', secret.decrypted_secret),
    body := '{"trigger":"cron"}'::jsonb,
    timeout_milliseconds := 150000
  )
  from secret;
  $$
);
