-- Initial budget policies for the AI ledger (Phase 1c proposal). NOT applied. Operator SQL, run once by the
-- applying role (postgres) only after: the ledger migration is applied and read back, the user has confirmed the
-- Anthropic organisation / credit / workspace spend limit in the Console, and ChatGPT + the user approved the values.
--
-- Allowlist by construction: every policy is scoped to provider + model + application + feature + subject kind.
-- A call that matches no policy is refused (NO_MATCHING_POLICY), so only the shared market report (system subject,
-- Claude Opus 5.5) can reserve. A user-subject call, another feature, another model or OpenAI matches nothing.
-- Do NOT add an unscoped "whole" or provider-wide policy while this allowlist is wanted: any matching policy lets a
-- call through, so a broad cap would also admit every feature without its own policy.
begin;
insert into ai_ledger.budget_policies
  (policy_key, scope_provider, scope_model, scope_application, scope_feature, scope_subject_kind,
   period, max_estimated_usd, max_calls, max_usd_per_call, note)
values
  ('anthropic.opus.kabumori.market_report.monthly', 'anthropic', 'claude-opus-5-5', 'kabumori', 'market_report', 'system',
   'month', 5.00, 40, 1.00, 'Phase 2a shadow test cap (JST month). Raise only after measured shadow runs.'),
  ('anthropic.opus.kabumori.market_report.daily', 'anthropic', 'claude-opus-5-5', 'kabumori', 'market_report', 'system',
   'day', 2.00, 6, null, 'Daily brake against loops / regeneration storms (JST day).');
commit;
