# Codex Task 2

- task_id: x-social-mobile-account-deletion-prod-stage1-verification-20260929
- owner: codex
- slot: codex-2
- status: ready
- next_owner: codex
- priority: critical
- recommended_model: Sol（高）
- purpose: production Stage 1で適用済みのaccount deletion migration/Edge Functionを独立verificationし、Stage 2 disposable-account E2Eへ進めるか判定する。

## Review target

- accepted source merge: `136dcd2b35b161ccc4769da15b05e796f095e881`
- migration:
  `supabase/migrations/20260928160000_social_mobile_account_deletion_candidate.sql`
- expected sha256:
  `7481078f91e87447216a2ae93e0c12b78ce6a68801205f4fdd74bb9bd6588657`
- deployed Edge:
  `social-mobile-account-delete`
- G3 Stage 1 verdict: PASS

## Mandatory startup

1. Read ORCHESTRATION / CURRENT_STATE / this TASK / latest G3 Stage 1 Report / rollout runbook.
2. Independent H2 worktree.
3. Fresh fetch origin/main.
4. Read current Supabase skill/changelog/docs.
5. Production verification may use read-only catalog/function metadata and non-destructive HTTP smoke only.
6. No destructive mutation.

## Verification scope

### A. Migration identity/read-back
Independently verify:
- migration source hash still matches accepted value
- deployed function inventory/body identity matches expected source
- function owners/search_path/EXECUTE grants are correct
- anon/authenticated cannot execute privileged deletion RPCs
- service_role execute surface matches intended functions only
- state/audit tables have expected RLS/privilege posture
- all expected guard triggers are present/enabled
- no unexpected collisions/duplicate objects
- isolation assumptions remain READ COMMITTED for intended paths
- onboarding workspace-creator assumptions still hold

Do not expose sensitive privilege detail in public report; sanitize.

### B. Edge deployment verification
Verify:
- function ACTIVE
- `verify_jwt=true`
- deployed source matches accepted repository source
- only intended source files included
- no secret/token logging
- Apple path remains fail-closed if production Apple config absent
- no unrelated function/version changed by this rollout

### C. Non-destructive smoke
Independently repeat safe checks:
- OPTIONS/CORS
- missing auth -> 401
- malformed JWT -> 401
- unauthenticated preview/delete request -> safe reject
- invalid action -> 400
- GET -> 405
- no deletion state/audit rows created

No valid authenticated deletion request.

### D. Production mutation audit
Confirm Stage 1 mutation scope was limited to:
- accepted migration objects
- new Edge function deploy
and no:
- user deletion
- Vault token deletion
- X revoke
- Apple revoke
- X post
- provider/Auth console change
- app activation flag.

### E. Stage 2 readiness
Assess whether it is safe to proceed to disposable-account E2E for:
1. never-connected user
2. social-only user with Kabumori profile retained
3. X-connected disposable user
4. lost-response/retry scenario
5. unrelated-data invariants

Apple E2E remains separately gated until Apple production configuration exists.

## STOP conditions

FAIL/STOP if:
- any production read-back differs from reviewed source
- ACL/search_path/owner surface is unsafe
- guard trigger missing
- Edge source/verify_jwt differs
- smoke reaches destructive path unexpectedly
- state/audit rows appear from non-destructive requests
- unrelated production changes are detected
- any sensitive detail would need to be published; sanitize instead.

## Production constraints

Absolutely no:
- real user deletion
- real X/Apple revoke
- Vault mutation
- Auth/provider config changes
- feature activation
- migration rewrite/rollback
- Edge redeploy unless explicitly assigned as a bounded fix later.

## Completion / C2

Report:
- PASS / PASS-WITH-FIX / FAIL
- migration production identity verdict
- RPC/ACL/search_path verdict (sanitized)
- trigger/isolation verdict
- Edge deployment identity verdict
- non-destructive smoke results
- production mutation audit
- Stage 2 readiness yes/no
- remaining operator/legal/Apple/cross-app gates
- production_mutation_by_H2=0

Then status -> review_required, next_owner -> chatgpt, STOP for C2.
