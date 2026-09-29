# Claude Task 3

- task_id: x-social-mobile-account-deletion-prod-e2e-stage2-20260929
- owner: claude
- slot: claude-3
- status: ready
- next_owner: claude
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: production account-deletion Stage 2。**使い捨てアカウントだけ**で実際の削除フローをE2E検証し、機能有効化前の最終runtime evidenceを作る。

## Accepted production basis

- Stage 1 migration apply/read-back: PASS
- `social-mobile-account-delete` Edge v1 ACTIVE / verify_jwt=true
- deployed source matches accepted repository source
- H2 production verification: target checks PASS
- C2 reconciliation: unrelated concurrent Function change was separately authorized; no deletion defect
- app feature flag remains OFF

## Mandatory startup

1. Read ORCHESTRATION / CURRENT_STATE / this TASK / latest G3 Stage 1 Report / latest H2 production verification / rollout runbook.
2. Fresh independent G3 worktree from latest origin/main.
3. Read current Supabase skill/changelog/docs.
4. Confirm no other slot is touching this migration/Edge/Auth/Vault/X OAuth boundary.
5. Re-run a bounded read-only production identity check before destructive E2E.
6. Use **only disposable test users/workspaces created specifically for this Stage 2**.

## Mandatory approval checkpoint

Before the first request that can actually:
- delete a valid Auth user,
- delete a Vault credential,
- revoke a real X token,

STOP and ask the user for explicit confirmation.

Do not treat the previous Stage 1 approval as approval for Stage 2 destructive E2E.

The confirmation prompt must summarize:
- only disposable accounts will be used,
- what production data/tokens will be created and then deleted/revoked,
- no existing real user/account/workspace is in scope,
- Apple remains excluded unless separately configured/approved.

## Stage 2 scenarios

After explicit user approval, execute in this order:

### E1 — never-connected disposable user
- create a disposable social-mobile test user through the supported public flow
- no X connection
- run preview/delete
- verify expected scope
- verify Auth/login/social workspace cleanup as designed
- verify audit result without leaking raw identifiers
- verify unrelated production data unchanged

### E2 — social-only behavior with Kabumori profile retained
- use a disposable identity with a deliberately created test main-profile condition
- verify deletion chooses social-only behavior
- social-mobile workspace/data removed
- shared Auth/main profile retained exactly as designed
- confirm no hidden cascade

Do not modify the real Kabumori app's account-delete implementation.

### E3 — X-connected disposable user
- create/connect a dedicated disposable X test account only if a safe disposable X account is available and explicitly approved
- verify exact credential ownership
- execute deletion
- verify X revoke path and Vault cleanup
- verify retry/idempotency
- verify no other social account/token/workspace affected

If no safe disposable X account is available, mark E3 BLOCKED and do not substitute a real account.

### E4 — lost-response/retry
- simulate/produce a safe client-side lost-response or repeated request condition on disposable state
- verify durable deletion state/checkpoints
- retry must converge safely without duplicate destructive effects or false success

### E5 — unrelated-data invariants
Before/after each scenario, verify only aggregate/identifier-safe invariants:
- unrelated workspace/account counts/identities unchanged
- no cross-tenant Vault effect
- no unrelated Auth/profile effect
- guard state/tombstone/audit semantics consistent

## Apple

Apple E2E is **not part of this task** unless production Apple configuration is separately approved and configured first.
Current expected behavior remains fail-closed for Apple-login deletion.

## Forbidden

- no existing real user deletion
- no existing production X account revoke
- no unrelated Vault secret mutation
- no X post
- no app feature activation
- no provider-console changes
- no migration/Edge source edits unless a defect is found and task is stopped
- no Kabumori main-app account-delete changes
- no legal copy invention

## Failure policy

If any destructive scenario behaves unexpectedly:
- STOP immediately
- do not continue to later scenarios
- preserve evidence
- do not attempt broad cleanup beyond the documented disposable-user recovery path
- do not enable feature flag.

## Completion / K3

Report:
- PASS / PARTIAL / FAIL / BLOCKED
- explicit user approval obtained? yes/no
- disposable identities only? yes/no
- E1 result
- E2 result
- E3 result or BLOCKED reason
- E4 result
- E5 invariant result
- Auth/Vault/X mutations actually performed on disposable fixtures
- any retries/recovery
- production state after cleanup
- confirmation no real user/account/workspace was touched
- remaining Apple/legal/Kabumori coordination gates
- whether feature activation is ready yes/no
- next recommendation

Then status -> review_required, next_owner -> chatgpt, STOP for K3.

推薦モデル：**Opus5.5（高）**
