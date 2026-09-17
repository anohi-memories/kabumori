# Codex Task 2

- task_id: social-mobile-app-phase4-membership-rls-validation-20260918
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sol Medium/High
- purpose: `apps/social-mobile` Phase 4として、Phase 3で確定したownership/RLS不足をもとに、`brand_memberships`中心のtenant isolation設計をdisposable DBで検証し、production適用前にpolicy matrixとmobile read contractを成立させる。production DBにはまだ適用しない。

## Context

Phase 3 C2 PASS:
- production `brands` / `social_accounts` / `scheduled_posts` / `post_execution_logs` の実schema・brand relationを確認済み
- 一般ユーザーの `auth.users` → brand/workspace/account membership relationは未成立
- `brands` / `social_accounts` は一般authenticated向けの安全なread pathなし
- `scheduled_posts` 等もadmin-only policy中心
- `EXPO_PUBLIC_DATA_SOURCE=supabase` のproduction有効化は禁止中
- Phase 3 implementation: `c0de2dea8310cafbb2ec0824ebeef242d5c43d3f`

## Mandatory startup / safety

開始前に必ず読む:
1. `.agent/ORCHESTRATION.md`
2. `.agent/CURRENT_STATE.md`
3. this TASK
4. `.agent/CODEX_REPORT_2.md`
5. H1/G1/G2の現行TASK
6. fresh `origin/main`

競合ルール:
- H1のAI Lab generation/OAuth/Vault/x-test-post領域を変更しない
- G1のmarket-report schema/functions/x-test-post/personalized-reports領域を変更しない
- G2領域を変更しない
- 既存未コミット変更は他workstream所有として触らない
- push前にfresh `origin/main`再確認

## Absolute production boundary

このPhaseで許可:
- disposable/local/test DBでのmigration/policy検証
- migration candidate / SQL proposalの作成
- `apps/social-mobile/**` のadapter/type/test hardening
- docs/TASK/Report更新
- production DB/schema/RLS/grant/RPCのread-only再確認（必要最小限）

このPhaseで禁止:
- production DB write
- production migration適用
- production RLS policy追加/変更/削除
- production grant/revoke
- production RPC/Function deploy
- `supabase db push`
- migration history repair/reconcile
- auth production user作成/削除/更新
- SNS OAuth接続
- X/Instagram/Threads実投稿
- Vault/token/secret変更
- Storage write
- AI API本接続
- Push通知
- 課金/IAP/Stripe
- Cron/settings変更

**production mutationは0件でC2へ返すこと。**

## Phase 4 goals

### 1. Membership schema candidate

Phase 3提案を具体化し、少なくとも以下を設計する:

`brand_memberships`
- `brand_id` → `brands.id` FK
- `user_id` → `auth.users.id` FK
- `role`（最低 owner/admin/member/viewer 等、必要最小）
- `created_at`
- unique `(brand_id, user_id)`
- role check/enum
- delete/update時の安全境界

必要なら `created_by` / `updated_at` 等を検討してよいが、過剰設計しない。

### 2. RLS policy candidate

少なくとも以下をdisposable DBで実装・検証する:

- `brands` SELECT: membership userのみ対象brand
- `social_accounts` SELECT: membership経由のbrand scoped
- `scheduled_posts` SELECT: membership経由のbrand scoped
- `post_execution_logs` SELECT: membership経由のbrand scoped
- `posting_windows` / brand settings read: membership roleで限定
- anon: 0 row
- non-member: 0 row
- brand A memberがbrand B rowを見られない
- admin dashboard既存 `private.is_admin()` を壊さない

write policyは今回production用に確定する必要がある範囲だけcandidate化。
原則:
- viewer/memberはread中心
- owner/adminだけ設定変更可能候補
- `WITH CHECK`でbrand reassignment不可
- service/backend writeとの責任分離

### 3. Policy matrix test

最低限、disposable DBで以下を自動検証する:

actor:
- anon
- authenticated non-member
- brand A viewer/member
- brand A owner/admin
- brand B member
- existing global admin相当
- service role相当（必要な場合）

resource:
- brands
- social_accounts
- scheduled_posts
- post_execution_logs
- posting_windows / relevant settings

operation:
- SELECT
- 必要なUPDATE/INSERT候補

期待値をmatrixとしてdocs/reportに残す。

### 4. Mobile read contract

Phase 4でmobile appが安全に読む契約を確定する。

決めること:
- direct RLS SELECTを採用するか
- tenant-checked RPC/viewを採用するか
- active account切替時のsource of truth
- no membership時のUI state
- membership role変更時のsession反映
- appが絶対に読まない列（Vault secret refs等）

`service_role`をmobileへ入れない。
SECURITY DEFINERは単なるRLS回避目的で使わない。

### 5. `scheduled_posts` / body / social account gap

Phase 3で未解決:
- `scheduled_posts`に本文正本なし
- `social_account_id`なし
- PostOrigin正本なし

今回、既存posting runtime/sourceをread-onlyで調査し、最小案を決める:
- 安全なread view
- detail table relation
- `social_account_id` FK追加
- content/body source relation

ただし既存投稿経路と競合する変更をproductionには適用しない。

### 6. Migration candidate

本番適用用ではなく、reviewable candidateとして作成してよい。

要件:
- idempotency/既存objectとの衝突を考慮
- Phase 3で確認した実schema前提
- migration history不整合があるためblind push前提にしない
- rollback / preflight / postflight SQLもdocsへ記載
- actual production applyは禁止

migration candidateを作る場合は、G1のmarket-report migrationと同じファイル/objectsを触らない。

### 7. Mobile adapter/tests

安全な契約が固まった範囲で `apps/social-mobile` を更新してよい。

最低限:
- membership absent → blocked/no-workspace
- membership present → tenant-scoped read contract
- permission denied / schema mismatch / unavailableの区別
- cross-tenant rowをclient filterで隠す設計は禁止
- `EXPO_PUBLIC_DATA_SOURCE=mock` default維持
- production Supabase sourceはまだ既定ONにしない

## Verification

最低限:
- disposable DB migration apply PASS
- policy matrix tests PASS
- cross-tenant isolation PASS
- admin compatibility PASS
- `npm run typecheck`
- `npm run lint`
- Expo Web export / route resolution
- adapter tests可能な範囲
- `git diff --check`

production側:
- write 0
- migration/RLS/grant/RPC deploy 0
- auth mutation 0
- SNS/API/X/Push 0
- secret/token exposure 0

## Deliverables

- membership schema candidate
- RLS/policy candidate
- automated policy matrix proof
- mobile read contract
- scheduled_posts/body/account gapの最小案
- production rollout checklist（未実施）
- rollback/preflight/postflight案
- app adapter hardening（必要範囲）

## Completion criteria

C2へ返す時点で明確にする:
1. membership modelは何か
2. member/non-member/anon/adminのpolicy matrixが通るか
3. brand A/B横断漏洩が0か
4. admin既存経路を壊さないか
5. direct SELECT vs RPC/viewのどれを採用するか
6. production migration candidateは安全にreview可能か
7. `EXPO_PUBLIC_DATA_SOURCE=supabase`を次PhaseでONにできる条件
8. production mutationが0であること

完了時:
- `.agent/CODEX_REPORT_2.md` 先頭にPhase 4 report追加
- exact source base / implementation commit / changed files
- disposable DB proof
- policy matrix
- security decision
- production rollout proposal
- tests
- production mutation 0
を記載
- this TASKを `status: review_required`, `next_owner: chatgpt`
- push前fresh-check、push後origin/main read-back
- C2待ちでSTOP

## Important decision rule

Phase 4は**本番適用ではなく証明フェーズ**。
policy matrix・cross-tenant isolation・admin compatibilityのどれかが不十分なら、本番適用案を進めずblockerとしてC2へ返すこと。
