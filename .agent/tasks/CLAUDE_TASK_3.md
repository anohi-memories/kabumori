# Claude Task 3

- task_id: x-social-mobile-account-deletion-concurrency-fix-phase4c-20260929
- owner: claude
- slot: claude-3
- status: in_progress
- next_owner: claude
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: H2 final acceptanceで残った1件のP1 concurrency holeとDeno test typing defectだけをfocused修正し、PR #52を最終受け入れ可能にする。

## Review source
- PR #52 reviewed head: `002d24ac99df2fbdf4e2423c1428ccb488a79f29`
- H2 verdict: FAIL
- production_mutation=0

## Required correction
- first-onboarding writerとdeletion acquireが、critical pointに入る前に同じper-user serialization primitiveを取得すること。
- onboardingが先に始まり未commitのケースでも、deletionが「workspaceなし」と誤認して先にpurge/finalizeしないこと。
- deletionが先のケースでは、onboardingは安全に待機/拒否されること。
- lock orderを統一し、deadlockを避けること。
- deletion成功後は当該user由来のorphan brand/account/membership/credentialが0であること。
- 既存OAuth挙動は必要最小限だけ変更すること。

## Required tests
1. onboarding starts first and remains uncommitted -> deletion starts
2. deletion starts first -> onboarding starts
3. after reported deletion success, zero orphan rows
4. no deadlock in tested protocol
5. existing R1-R6/client pin regression remains green

## Deno typing fix
- `supabase/functions/social-mobile-account-delete/delete_logic_test.ts` のTS2353を修正。
- default checked `deno test` をPASSさせる。

## Verification
- disposable Postgres full behavior/ACL/race/reconnect/cleanup
- checked Deno tests/check
- social-mobile full tests
- data-view
- typecheck/lint
- Expo web+iOS export
- diff check
- secret/token/log scan
- relevant mutation tests

## Production constraints
No migration apply, Edge deploy, real deletion, Vault mutation, real X/Apple revoke, Auth/provider console changes, or real X post.

`production_mutation=0`.

## Completion / K3
Report exact fixed PR #52 head, common lock design, changed files, both race proofs, orphan invariant, checked Deno tests, full regressions, production_mutation=0, and readiness for one final H2 focused acceptance.

Then status -> review_required, next_owner -> chatgpt, STOP for K3.
