# Codex Task 2

- task_id: x-social-mobile-account-deletion-final-concurrency-acceptance-20260929
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: Sol（高）
- purpose: PR #52 Phase 4c exact headの最終focused acceptance。前回残ったfirst-onboarding/deletion concurrency holeとchecked Deno typing fixだけを独立再現し、source merge可否を確定する。

## Review target
- Draft PR #52
- exact head: `4bc819555c07c8792f5b78ea29aa6b9a35694042`
- previous failed head: `002d24ac99df2fbdf4e2423c1428ccb488a79f29`
- implementation task: `x-social-mobile-account-deletion-concurrency-fix-phase4c-20260929`

## Mandatory startup
1. Read ORCHESTRATION / CURRENT_STATE / this TASK / latest G3 Report / previous H2 final-acceptance report.
2. Independent H2 worktree.
3. Fresh fetch origin/main and exact PR #52 head.
4. Read current Supabase skill/docs relevant to transaction isolation/advisory locking.
5. production_mutation=0.

## Focused acceptance

### A. Onboarding first -> deletion
Reproduce with the real existing first-onboarding RPC:
- onboarding transaction starts first
- guard/creation reaches critical point
- stays uncommitted
- deletion starts after

Expected:
- deletion waits or otherwise serializes safely
- after onboarding commit, deletion sees the committed workspace and deletes/handles it correctly
- reported deletion success => zero orphan brand/account/membership/oauth/credential rows
- no false success.

### B. Deletion first -> onboarding
- deletion acquires its common workspace/user serialization
- onboarding begins while deletion is active

Expected:
- onboarding waits and then fails safely due deletion state, or another explicitly safe result
- no workspace/account recreation
- deletion can complete
- orphan rows = 0.

### C. Lock ordering / isolation
Verify:
- common serialization primitive is truly shared before critical point
- consistent lock order
- no deadlock in the tested two-direction protocol
- READ COMMITTED requirement is explicit and safe for the intended PostgREST RPC path
- non-READ-COMMITTED workspace creation is safely rejected if that's the design.

### D. Finalize invariant
- finalize under lock rechecks no relevant workspace/account rows reappeared.
- if rows exist, must not report completed.
- auth/login deletion + tombstone handling remain consistent.

### E. Checked Deno
- default checked Deno tests pass
- TS2353 is gone
- no reliance on --no-check for correctness.

## Regression preservation
Spot-check that previous accepted fixes remain intact:
- R2 cross-product scope
- R3 Vault ownership
- R4 X credential missing behavior
- R5 Apple retry checkpoint
- R6 CORS/platform
- client exact user/session pinning
- privileged RPC ACL/search_path
- production mutation 0.

## Required verification
- both race directions using real onboarding RPC source
- disposable Postgres full behavior/ACL/race/reconnect/cleanup
- checked Deno test suite + deno check
- social-mobile full tests
- data-view
- typecheck/lint
- Expo web+iOS export
- git diff --check
- secret/token/log scan
- mutation/negative checks relevant to common lock.

## Fix policy
- only small local defect in the reviewed Phase 4c patch may be fixed directly.
- any new design-level issue => FAIL/STOP.
- do not broaden scope.

## Production constraints
No migration apply, Edge deploy, real deletion, Vault mutation, real X/Apple revoke, Auth/provider console changes, or real X post.

`production_mutation=0`.

## Completion / C2
Report:
- PASS / PASS-WITH-FIX / FAIL
- exact reviewed/fixed head
- onboarding-first result
- deletion-first result
- orphan invariant
- deadlock/isolation assessment
- checked Deno result
- regression spot-checks
- production_mutation=0
- source merge ready yes/no
- remaining production gates

Then status -> review_required, next_owner -> chatgpt, STOP for C2.

## H2 completion — 2026-09-29

- verdict: PASS for the exact source head `4bc819555c07c8792f5b78ea29aa6b9a35694042`; source merge ready: YES, subject to C2 accepting this review. No merge or production rollout was performed.
- independently observed common advisory-lock waits in both real first-onboarding/deletion orders; completed deletion leaves zero orphan rows.
- finalize refuses reappeared workspace rows; non-READ-COMMITTED creation fails closed; checked Deno 17/17 and all Edge file checks PASS.
- disposable full behavior/ACL/race/reconnect/cleanup, mobile 72/72, data-view 14/14, typecheck/lint, Expo Web+iOS, diff checks PASS. Four focused disposable DB mutations detected.
- production_mutation=0; source fixes=0. Exact evidence and rollout gates are at the head of `.agent/CODEX_REPORT_2.md`.
- STOP for C2.
