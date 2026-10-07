-- 05 (read-only, AFTER the apply only): a constant-only helper and a STABLE read for a person that does not
-- exist. No start / reactivate RPC is called (they write or lock).
select jsonb_build_object(
  'refusal_deleting', private.account_lifecycle_service_refusal('deleting'),
  'refusal_suspended', private.account_lifecycle_service_refusal('suspended'),
  'refusal_other', private.account_lifecycle_service_refusal('provisioning'),
  'active_answer_nobody', private.account_lifecycle_active_answer('00000000-0000-0000-0000-000000000000'::uuid, 'kabumori', false)
) as result;
