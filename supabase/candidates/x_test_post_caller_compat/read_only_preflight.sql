-- x-test-post caller gate (PR #349) -- READ-ONLY PREFLIGHT TEMPLATE (G3 Issue #318 TASK 5/50, 2026-10-20).
-- NOT EXECUTED by this task. Run only after the user's separate, explicit approval, in one read-only transaction,
-- against production. It returns BOOLEANS ONLY: the Cron command text, header values, secrets and keys are never
-- selected, printed or copied. Map the answer to a profile in rollout_model.ts before any deploy decision.
begin transaction read only;

-- 1. The dispatch Cron: identity and which header SHAPES its command contains (no values).
select jobid,
       jobname,
       schedule,
       active,
       md5(command)                                   as command_fingerprint,          -- compare with 88b3310282eedc9f49d56878992b1094 (2026-10-17)
       command like '%/functions/v1/x-test-post%'      as calls_x_test_post,
       command ~* '"?authorization"?\s*[:,]'          as sends_authorization_header,
       command ~* 'bearer'                             as sends_bearer,
       command ~* '"?apikey"?\s*[:,]'                 as sends_apikey_header,
       command ~* 'x-cron-secret'                      as sends_x_cron_secret,
       command ~* 'vault\.decrypted_secrets'           as reads_vault_at_call_time,
       command ~* 'service_role'                       as mentions_service_role,
       command ~* 'anon'                               as mentions_anon,
       command ~* 'sb_secret_'                         as embeds_new_secret_key_literal,
       command ~* 'sb_publishable_'                    as embeds_publishable_key_literal,
       command ~* 'eyJ[A-Za-z0-9_-]{10,}\.'           as embeds_jwt_literal
  from cron.job
 where jobname = 'dispatch-scheduled-posts';

-- 2. If the command reads Vault: which secret NAMES exist (names only, never decrypted values).
select name, (description is not null) as has_description, created_at, updated_at
  from vault.secrets
 where name ~* '(cron|x_test_post|service_role|dispatch)'
 order by name;

-- 3. Recent outcome mix of the dispatch (status codes only; no bodies).
select status_code, count(*)
  from net._http_response
 where created > now() - interval '1 hour'
 group by status_code
 order by status_code;

rollback;

-- Outside SQL (read-only, also only after approval):
--   * `supabase functions list --project-ref <ref>` -> verify_jwt of x-test-post (expected false per 2026-10-16/17 audits).
--   * The Function secret NAMES (`supabase secrets list`) -> whether X_TEST_POST_CRON_SECRET exists (digest only shown).
-- Profile mapping (rollout_model.ts CronProfile):
--   sends_bearer & mentions_service_role (or a Vault read of the service-role key) -> service_role_bearer
--     (confirm the key is the LEGACY JWT the Function's SUPABASE_SERVICE_ROLE_KEY holds; sb_secret_ -> new_secret_key_bearer)
--   sends_x_cron_secret                                                           -> x_cron_secret
--   sends_bearer & mentions_anon / embeds_publishable_key_literal                 -> anon_bearer
--   sends_apikey_header & not sends_authorization_header                          -> apikey_only
--   none of the above                                                             -> no_auth
--   anything ambiguous                                                            -> stays UNKNOWN (NO_GO)
