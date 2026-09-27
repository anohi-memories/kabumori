# Claude Task 3

- task_id: x-universal-oauth-refresh-stage3b-second-account-pilot-prep-20260927
- owner: claude
- slot: claude-3
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Opus5.5（高）
- purpose: Stage 3Aで本番実証済みのUniversal X OAuth refreshを、2つ目の実アカウントへ安全に広げるStage 3B pilot準備を行う。今回は候補確認・投稿経路一般化・pilot契約・テスト・ロールバック設計まで。2つ目アカウントの本番有効化はまだ行わない。

## Current production baseline

Stage 3A is fully live:
- PR #38 merged -> `6717b1fe451db83f80e837bf8104268a2b00423d`
- production x-test-post v125
- Stage 3A DB rollout authority live
- AI Lab only = `enabled`
- one natural AI Lab expiry-cycle observed successfully
- proactive refresh generation 6 -> 7
- no duplicate / second401 / uncertain / reauth / stuck
- cross-account check PASS
- Kabumori remains legacy non-Vault
- migration-history debt remains; blind db push / repair prohibited

Known next gap:
- second real account exists as a potential candidate, but Stage 3B publish/content path is not yet proven/generic enough for a controlled pilot.

## Goal

Prepare a safe Stage 3B controlled second-account pilot without activating it yet.

Deliver a source/test/operational package that makes the next production step narrowly auditable:
- exact pilot candidate identified
- account-bound publish path defined
- no brand-first / first-row fallback
- pilot mode semantics proven
- one-account-only rollout mutation procedure defined
- one natural refresh observation procedure defined
- rollback procedure defined

## Mandatory startup

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - latest G3 Stage 3A final report
   - latest H1/C1 Stage 3A report
2. Use an independent G3 worktree/checkout.
3. Fresh fetch `origin/main`.
4. Read current Supabase skill.
5. Fetch current Supabase changelog/docs relevant to:
   - Edge Functions
   - Postgres/RLS/RPC
   - secrets/env
6. Check current CLI version and relevant `--help`.
7. Do not touch G4/Admin Auth PR #33 files.

## Stage 0 — candidate assessment (read-only)

Inspect production safely and identify whether there is exactly one suitable second X account for pilot.

Required checks:
- user/account ownership and intended project/brand binding are unambiguous
- exact `social_account_id`
- platform = x
- identity verified
- publish status and why it is currently disabled/off if applicable
- credential refs present and distinct
- no shared credential refs
- no current refresh lease
- no terminal connection error
- not Kabumori legacy account
- not AI Lab
- no conflicting scheduler/dispatcher ownership

Do not expose token values, secret IDs, Authorization headers, or provider bodies.

If no suitable second account is unambiguous:
- do not guess
- continue with generic source/test preparation
- report candidate selection as a user/operator gate

## Stage 1 — account-bound publish path preparation

Inspect the current `x-test-post` / scheduler / content dispatcher architecture.

Implement the narrowest source change needed so a second Vault-backed X account can be published through the same exact-account auth/refresh machinery without:
- hardcoded AI Lab identity
- brand-first lookup
- first-row fallback
- env token fallback
- legacy token-store fallback
- cross-account content/account mismatch

Requirements:
- publish attempt must resolve one exact `social_account_id`
- content ownership and account ownership must match
- account rollout authority must be checked before Vault/token use
- existing AI Lab path must remain behaviorally unchanged
- Kabumori legacy path must remain unchanged

If a generic account-bound path already exists and only wiring/tests are missing, do not create a parallel path.

## Stage 2 — pilot mode contract

Use existing Stage 3A `pilot` mode.

Define and test a safe default pilot policy for the second account:
- finite expiry
- finite refresh generation ceiling
- unresolved error blocks pilot
- missing rollout row/off fails closed
- only the exact account may be mutated
- global env gate remains kill switch only, never authority

Do not set the real production rollout row in this task.

## Stage 3 — scheduler/content safety

Prove the second account cannot:
- claim AI Lab content
- claim Kabumori content
- publish another brand's scheduled row
- reuse another account's credentials
- receive duplicate claims

If schema currently lacks enough account binding for this, implement the smallest source/schema preparation necessary, but keep production apply out of scope.

Any schema change:
- create migration with current Supabase CLI workflow
- disposable DB only
- no production apply
- no db push
- no migration repair

## Stage 4 — tests

At minimum prove:
1. AI Lab enabled + second account off => only AI Lab can refresh.
2. second account pilot + AI Lab enabled => each account resolves only itself.
3. second account off/missing rollout => zero Vault read / zero token request.
4. wrong account/content pairing => fail closed before X.
5. wrong brand/account pairing => fail closed.
6. missing credential refs => fail closed.
7. invalid_grant affects exact second account only.
8. uncertain refresh commits no credential.
9. pilot expiry / generation ceiling blocks correctly.
10. concurrent refresh lease remains account-local.
11. second account cannot mutate AI Lab state.
12. AI Lab cannot mutate second account state.
13. Kabumori legacy path unchanged.
14. no duplicate claim/post from pilot path.

Run:
- x-test-post relevant tests
- _shared relevant tests
- scheduler/dispatcher/account-binding tests
- disposable PostgreSQL behavior/race tests if DB changes
- tsc/check/lint as applicable
- git diff --check
- targeted secret scan
- advisors if DB objects are added/changed

## Stage 5 — production pilot plan only

Write the exact next-step Stage 3B production activation procedure, but DO NOT execute it.

The plan must include:
- exact pilot account identifier
- preflight
- exact rollout setter call
- pilot expiry
- generation ceiling
- content/scheduler enablement step, if needed
- one natural post observation
- one natural expiry/refresh observation
- exact rollback to OFF
- hard-stop conditions
- cross-account verification
- no historical replay

Hard stops for future pilot:
- account mismatch
- shared credential refs
- unexpected eligible account
- duplicate claim/post
- second 401
- invalid_grant
- uncertain token response
- stuck lease
- credential commit mismatch
- cross-account mutation

## Production restrictions

This task is SOURCE/PLAN-FIRST.

Allowed:
- read-only production inspection
- source changes
- migration file creation if strictly needed
- local/disposable DB tests
- PR creation/update
- test/CI/Preview verification

Not allowed:
- changing second account publish_enabled
- changing second account rollout row
- setting pilot/enabled in production
- manual token refresh
- manual X post
- Edge production deploy
- production DB migration apply
- migration repair
- db push
- replaying historical posts
- changing AI Lab rollout
- changing Kabumori credentials
- touching G4/Admin Auth work

## Deliverable

Report:
- exact candidate assessment
- whether candidate is ready or operator-gated
- architecture/path used for second account
- changed_files
- schema changes if any
- tests/results
- pilot policy
- scheduler/content isolation proof
- migration-history implications
- production mutation=0
- exact Stage 3B activation/observation/rollback plan
- remaining risks
- next recommendation

## Completion / K3

Set:
- status -> review_required
- next_owner -> chatgpt

STOP for K3.

## Report

- pending
