-- Test-phase budget policies for the AI ledger (Phase 1d). Operator SQL (a WRITE): run once by the applying role
-- (postgres), only after the ledger migration is applied and read back, and only with ChatGPT's decision and the
-- user's approval. Usually run through supabase/tests/ai_provider_budget_ledger_rollout.sh policies.
--
-- Allowlist by construction: every policy is scoped to provider + model + application + feature + subject kind.
-- A call that matches no policy is refused (NO_MATCHING_POLICY), so only the shared market report (system subject,
-- Claude Opus 5.5 via Anthropic) can reserve. A user-subject call, another feature or application, another model
-- or OpenAI matches nothing. Do NOT add an unscoped "whole" or provider-wide policy while this allowlist is wanted:
-- any matching policy lets a call through, so a broad cap would also admit every feature without its own policy.
--
--   monthly (JST month): $5.00 estimated, 40 attempts, $1.00 per attempt
--   daily   (JST day):   $2.00 estimated,  6 attempts, $1.00 per attempt
--
-- Fail-closed: refuses when any policy row already exists (never mixes with or silently duplicates other values),
-- and checks the exact result before COMMIT. Stop switch: update ai_ledger.budget_policies set enabled = false.
begin;

do $$
begin
  if to_regclass('ai_ledger.budget_policies') is null then
    raise exception 'AI_LEDGER_POLICIES_LEDGER_MISSING' using errcode = 'P0001';
  end if;
  if exists (select 1 from ai_ledger.budget_policies) then
    raise exception 'AI_LEDGER_POLICIES_ALREADY_PRESENT' using errcode = 'P0001';
  end if;
end;
$$;

insert into ai_ledger.budget_policies
  (policy_key, scope_provider, scope_model, scope_application, scope_feature, scope_subject_kind,
   period, max_estimated_usd, max_calls, max_usd_per_call, note)
values
  ('anthropic.opus.kabumori.market_report.monthly', 'anthropic', 'claude-opus-5-5', 'kabumori', 'market_report', 'system',
   'month', 5.00, 40, 1.00, 'Phase 1d test cap (JST month). Raise only after measured shadow runs and approval.'),
  ('anthropic.opus.kabumori.market_report.daily', 'anthropic', 'claude-opus-5-5', 'kabumori', 'market_report', 'system',
   'day', 2.00, 6, 1.00, 'Phase 1d daily brake against loops and regeneration storms (JST day).');

do $$
begin
  if (select count(*) from ai_ledger.budget_policies) <> 2
     or exists (select 1 from ai_ledger.budget_policies
                 where not enabled or scope_provider is distinct from 'anthropic' or scope_model is distinct from 'claude-opus-5-5'
                    or scope_application is distinct from 'kabumori' or scope_feature is distinct from 'market_report'
                    or scope_subject_kind is distinct from 'system' or scope_logical_role is not null
                    or scope_brand_id is not null or scope_user_id is not null or per_brand or per_user
                    or max_usd_per_call is distinct from 1.00
                    or (period, max_estimated_usd, max_calls) not in (('month', 5.00, 40), ('day', 2.00, 6))) then
    raise exception 'AI_LEDGER_POLICIES_UNEXPECTED_RESULT' using errcode = 'P0001';
  end if;
end;
$$;

commit;
