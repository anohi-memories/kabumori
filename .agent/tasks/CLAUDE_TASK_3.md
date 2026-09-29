# Claude Task 3

- task_id: x-social-mobile-account-deletion-prod-e2e-stage2-resume-20260930
- owner: claude
- slot: claude-3
- status: in_progress
- next_owner: claude
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: PR #59でonboarding deletion entryを修正・mergeしたため、Stage 2 disposable-account E2Eを再開する。

## Accepted basis
- account deletion production Stage 1: PASS
- H2 production verification: target checks PASS; C2 reconciled
- PR #59 merged as `cbf3945c0c576695fc7d5d5cb2e108ae15f65bea`
- deletion feature remains OFF

## Rules
- use only disposable test identities
- before the first destructive valid-user action, STOP and obtain fresh explicit user confirmation
- no existing real user/account/workspace may be touched
- Apple remains excluded unless separately configured/approved
- no app feature activation

## Scenarios
1. never-connected disposable user
2. social-only disposable user with main-profile retention
3. disposable X-connected user if a safe disposable X account is available
4. lost-response/retry
5. unrelated-data invariants

If a safe disposable X account is unavailable, mark scenario 3 BLOCKED and continue only where safe.

## Completion / K3
Report PASS/PARTIAL/FAIL/BLOCKED, confirmation status, each scenario result, actual disposable-only mutations, invariants, cleanup state, feature-activation readiness, and remaining Apple/legal/cross-app gates.
Then status -> review_required, next_owner -> chatgpt, STOP for K3.
