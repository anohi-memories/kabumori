# Claude Task 3

- task_id: x-social-mobile-account-deletion-prod-preflight-20260929
- owner: claude
- slot: claude-3
- status: in_progress
- next_owner: claude
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: PR #52 merge後のaccount deletion本番反映前preflight。production migration/Edge deployを行う前に、現在のlive schema/owner/ACL/isolation/Auth/Vault/Storage/FK/rollback/E2E前提をread-onlyで確認し、exact rollout planとSTOP条件を確定する。**このTASKではapply/deployしない。**

## Accepted source

- PR #52 accepted head: `4bc819555c07c8792f5b78ea29aa6b9a35694042`
- squash merge commit: `136dcd2b35b161ccc4769da15b05e796f095e881`
- H2 final verdict: PASS for source merge
- production_mutation so far: 0

## Mandatory startup

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - latest G3 Report
   - latest H2 PASS report
2. Use a fresh independent G3 worktree/checkout from latest `origin/main`.
3. Confirm no overlap with G4 or any active slot.
4. Read current Supabase skill first.
5. Check current Supabase changelog/docs relevant to:
   - Auth hard delete/session behavior
   - Edge Function JWT verification/CORS
   - SECURITY DEFINER/function ownership
   - Vault permissions
   - managed Auth schema
   - Storage ownership/FKs if relevant
   - PostgREST transaction isolation
6. Read current X revoke and Apple revoke guidance if production assumptions depend on them.
7. Absolutely no production writes.

## Preflight scope

### A. Exact migration inventory

Identify the exact single migration to apply:
`supabase/migrations/20260928160000_social_mobile_account_deletion_candidate.sql`

Verify against latest main:
- file exists exactly once
- no later migration supersedes/duplicates/conflicts with it
- no broad `db push` is needed or allowed
- all referenced tables/functions/columns exist in production with compatible types/constraints
- all 11 guarded writer tables exist and names still match
- all onboarding/reconnect RPCs used by the concurrency design still match reviewed assumptions.

Produce:
- exact migration SHA/content identity
- exact apply command/method to use later
- exact read-back SQL after apply
- exact rollback/recovery plan if apply fails part-way or post-check fails.

### B. Production catalog read-only verification

Read-only confirm:
- owners of `auth.users`, `vault.secrets`, relevant schemas
- current role privileges for `postgres`, `service_role`, anon, authenticated
- existing function EXECUTE grants that may conflict
- RLS state on new/existing exposed tables assumptions
- FK graph relevant to auth/users/profile/membership/social/workspace deletion
- any NO ACTION/CASCADE behavior that changed since review
- triggers on auth.users or affected tables that would materially change finalize semantics
- whether any existing object names collide with candidate migration.

Do not read user rows, token plaintext, or Vault plaintext.

### C. Isolation / locking preflight

Read-only verify production role/function transaction isolation settings relevant to:
- authenticated/PostgREST RPCs
- service_role RPCs
- any function-level `SET default_transaction_isolation` or role setting

Confirm intended READ COMMITTED assumption is true for the target paths, or STOP.

Check there is no production-side writer path for first social workspace creation that bypasses the guarded brands/brand_memberships INSERT points. If uncertain, STOP.

### D. Auth finalization assumptions

Confirm current production behavior/metadata supports:
- direct hard-delete semantics expected by candidate
- profile/main-app protection check
- session rows disappear on hard delete
- no requirement is being assumed for instant JWT invalidation
- no managed Auth trigger/extension makes direct SQL deletion unsafe

If direct SQL auth.users deletion cannot be confidently approved from current official guidance + live metadata, STOP and propose the safer alternative boundary.

### E. Vault capability

Read-only verify:
- candidate function owner at apply time would have intended DELETE capability on Vault secrets
- service_role itself is not accidentally gaining broad direct Vault read/delete surface beyond reviewed design
- no schema/owner drift invalidates the reviewed definer model

No secret values may be queried.

### F. Storage / external dependent preflight

Confirm whether social-mobile account deletion has any Storage-owned objects/FKs in production today.
- if none, record none.
- if any exist, identify exact deletion/retention requirement and STOP if not covered.

Confirm no new tables/RPCs/Edge functions added since PR #52 create an unguarded social workspace/account writer that invalidates the concurrency design.

### G. Edge deployment preflight

For `social-mobile-account-delete`:
- confirm expected `verify_jwt` behavior/config for production
- confirm required environment/secret names exist conceptually; do not print values
- list required X/Apple config gates
- confirm CORS/platform behavior
- define exact deploy command for later
- define post-deploy byte/source identity check
- define health/smoke check that does not delete anything.

No deploy in this task.

### H. Real E2E rollout plan

Design the later disposable-account E2E in safe stages:
1. never-connected user deletion
2. social-only user with Kabumori main profile retained
3. X-connected user revoke path
4. Apple-login user on iOS native
5. lost-response/retry scenario
6. onboarding-vs-deletion race sanity in a disposable environment if practical
7. confirm no unrelated workspace/data touched

Specify what must be observed before enabling:
`EXPO_PUBLIC_ACCOUNT_DELETION_ENABLED=true`.

### I. Legal/operator gates

Inventory only; do not invent legal text.
Confirm remaining owner decisions:
- privacy policy URL
- terms URL
- support URL/email
- retention duration for hashed deletion audit
- wording for published X posts remaining external
- Kabumori-side account-delete coordination

## STOP conditions

STOP and report without apply/deploy if any of these occur:
- production schema differs materially from reviewed assumptions
- migration conflicts with later main migrations
- role/function isolation not READ COMMITTED where required
- function owner/Vault DELETE capability cannot be proven safely
- direct auth.users deletion semantics are uncertain/unsafe
- new unguarded workspace/account writer exists
- Storage dependency exists but deletion design does not cover it
- required X/Apple production configuration is materially different
- rollback/recovery cannot be defined safely
- any slot/worktree conflict.

## Forbidden in this TASK

- no migration apply
- no `db push`
- no Edge deploy
- no Auth/provider console mutation
- no Vault mutation
- no user deletion
- no real X/Apple revoke
- no X post
- no build activation flag
- no legal-text invention

`production_mutation=0`.

## Required Report / K3

Report:
- result: READY_FOR_ROLLOUT / STOP
- fresh main commit
- migration identity
- production catalog findings
- isolation findings
- Auth finalization findings
- Vault findings
- Storage/external dependency findings
- Edge deploy prerequisites
- exact later apply/deploy/read-back plan
- rollback/recovery plan
- E2E plan
- legal/operator gates
- changed_files (should normally be TASK/report/docs only unless a source discrepancy requires STOP; do not silently patch production code)
- tests/checks
- production_mutation=0
- recommended next step

Then status -> review_required, next_owner -> chatgpt, STOP for K3.
