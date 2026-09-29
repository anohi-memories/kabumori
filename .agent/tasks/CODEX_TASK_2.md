# Codex Task 2

- task_id: x-social-mobile-account-deletion-privileged-review-20260928
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: Sol（高）
- purpose: Draft PR #52 の account deletion / account lifecycle Phase 4 を独立レビューする。service_role DB functions、Vault cleanup、Auth admin user deletion、X revoke、Apple revoke、recent-auth、tenant/workspace境界、partial failure/idempotencyを重点確認し、merge可否を判定する。

## Review target

- Draft PR #52
- exact head: `12146c4ab2bc635a2781b673146e1f8ad8350258`
- branch: `claude/g3-account-lifecycle-p4`
- implementation task: `x-social-mobile-account-lifecycle-release-phase4-20260928`

## Mandatory startup

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - G3 TASK + latest Report
   - PR #52 exact diff
2. Use an independent H2 worktree/checkout. Do not reuse G3 worktree.
3. Fresh fetch `origin/main` and PR #52 exact head.
4. Read current Supabase skill first.
5. Check current Supabase docs/changelog relevant to:
   - Auth admin user deletion
   - session invalidation after user deletion
   - service_role/security definer behavior
   - Vault
   - Edge Function auth
6. Check current official X token revocation docs and Apple revoke guidance where needed.
7. Do not mutate production.

## Core review questions

### A. DB privileged boundary

Inspect migration candidate:
`supabase/migrations/20260928160000_social_mobile_account_deletion_candidate.sql`

Verify:
- exact schemas of all functions/tables
- whether any function is SECURITY DEFINER
- function owner expectations
- fixed safe `search_path`
- PUBLIC execute revoked
- anon/authenticated cannot execute privileged functions
- service_role is the only intended caller
- no BOLA/IDOR path through client-supplied IDs
- exact-user/workspace binding is server-derived
- multi-member/shared/admin/foreign workspace cases fail closed
- advisory locking and idempotency are sound
- in-flight posting / credential refresh races are handled safely
- purge ordering cannot orphan sensitive credentials/data
- unexpected FK dependents cause safe failure, not partial silent deletion
- audit table does not leak raw IDs/secrets

### B. Vault cleanup

Verify:
- whether the execution role/function owner can actually delete intended Vault secrets in production
- secret selection cannot cross user/workspace boundaries
- failure to delete Vault secret does not proceed to false-success auth deletion
- retry semantics are safe
- no Vault plaintext is surfaced to app/logs

If production capability cannot be proven safely from source/read-only metadata, mark as explicit rollout blocker instead of assuming success.

### C. Auth/session deletion

Verify:
- recent-auth requirement cannot be bypassed
- subject/user is derived from verified bearer session, not request body
- exact-user reauthentication in client is meaningful and not merely cosmetic
- auth admin delete happens only after app-data/credential cleanup reaches the intended terminal state
- deleting auth user does not leave usable sessions/tokens in a way that violates the intended security contract
- 404/idempotent retry semantics are safe
- partial failure between app-data purge and auth-user delete is recoverable and observable

### D. X revocation

Verify against current X docs:
- correct endpoint/method/auth requirements
- access vs refresh revoke behavior/order
- client authentication is correct for the app type
- failure semantics: no false deletion completion if revoke was required but failed
- no raw X token or Authorization header logging
- only the exact user/workspace credential is selected

If X docs/config make source assumptions unverifiable, identify the precise gate.

### E. Apple revocation

Verify:
- fresh authorizationCode requirement and exchange
- Apple subject returned by exchange is bound to the authenticated user's own Apple identity
- revocation targets the correct token
- native vs browser Apple identity behavior is not conflated
- failure stops safely
- no client secret/token leakage
- current Apple account-deletion/revoke expectations are met at source-contract level

### F. Product/data semantics

Verify:
- UI does not claim deletion is available unless backend/build gate is enabled
- privacy/terms/support config is truthful
- "deleted vs retained" copy matches actual backend behavior
- published X posts not deleted is clearly disclosed
- retained hashed audit is consistent with documented assumptions
- no accidental deletion of unrelated Kabumori/X-app data outside exact user scope
- note any cross-product coupling that must be resolved before production rollout

## Required verification

Run at least:
- full social-mobile tests
- account deletion tests
- Deno tests/check
- disposable Postgres behavior/ACL/race/rollback tests
- typecheck
- lint
- Expo web+iOS export
- git diff --check
- secret/token/log scan

Also add targeted negative tests if needed for:
- PUBLIC/anon/authenticated function execution
- wrong user/workspace
- shared workspace
- concurrent deletion
- Vault deletion failure
- X revoke failure
- Apple subject mismatch
- auth delete failure after purge
- retry after partial completion

## Fix policy

- Small, obvious, local P1/P2 source defects within this PR may be fixed directly on PR #52 and retested.
- Design-level uncertainty, production capability uncertainty, or destructive rollback ambiguity => report and STOP.
- Do not broaden into unrelated posting backend work.

## Production constraints

Absolutely no:
- migration apply
- Edge deploy
- real user/data deletion
- real Vault mutation
- real X token revoke
- real Apple revoke
- provider/Auth console mutation
- real X post

`production_mutation=0`.

## Completion / C2

Report:
- PASS / PASS-WITH-FIX / FAIL
- exact reviewed/fixed PR #52 head
- DB privileged-boundary assessment
- Vault capability assessment
- Auth/session deletion assessment
- X revoke assessment
- Apple revoke assessment
- partial failure/idempotency assessment
- tests
- any source fixes
- production_mutation=0
- whether PR #52 is safe to merge as source
- exact blockers before production apply/deploy/E2E

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for C2.
