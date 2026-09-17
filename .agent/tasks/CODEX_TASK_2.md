# Codex Task 2

- task_id: social-mobile-app-phase5-production-membership-rls-rollout-20260918
- owner: codex
- slot: codex-2
- status: ready
- next_owner: codex
- priority: urgent
- recommended_model: Sol High
- purpose: Phase 4でdisposable DB実証までPASSした `brand_memberships` + tenant RLS candidateを、productionへ最小・可逆・検証可能な形で安全に反映する。blind `supabase db push`は禁止し、preflight → exact candidate apply → postflight → admin互換確認 → rollback readinessまでを実施する。実ユーザーmembership投入とmobile data source ONは、対象が一意に安全確認できる場合のみcanaryとして行い、曖昧なら行わずC2へ返す。

## Approved basis

Phase 4 C2 PASS済み:
- candidate migration: `supabase/migrations/20260918120000_social_mobile_brand_memberships.sql`
- implementation source commit: `c40c96cb66c72c671a145ebdbee2a941c648b6bb`
- disposable PostgreSQL 16でmigration apply PASS
- policy matrix PASS
- anon/non-member 0 row
- brand A/B cross-tenant leakage 0
- existing global admin compatibility PASS
- authenticated mobile membership write denial PASS
- rollback/read-back PASS
- production mutationはこれまで0

## Mandatory startup / parallel safety

開始前に必ず確認:
1. `.agent/ORCHESTRATION.md`
2. `.agent/CURRENT_STATE.md`
3. this TASK
4. `.agent/CODEX_REPORT_2.md`
5. H1/G1/G2の現行TASK
6. fresh `origin/main`

競合ルール:
- H1の `daily_content_plans` / writer RPC / AI Lab領域を変更しない
- G1のmarket-report migration/functions/`x-test-post`/`personalized-reports`を変更しない
- G2領域を変更しない
- 同じmigration/RPC/production settingを別slotが変更中ならSTOP
- 既存未コミット変更は他workstream所有として触らない
- push前にfresh `origin/main`再確認

## Absolute scope

このTASKで許可するproduction変更:
- exact approved candidate `20260918120000_social_mobile_brand_memberships.sql` の内容に限定したDB schema/RLS/grant適用
- 必要なread-only preflight/postflight
- 既存admin path確認
- rollback手順の準備
- 実ユーザーmembership canaryは、対象user_idとbrand_idが既存productionデータから一意かつ明示的に対応づけ可能で、誤付与リスクが無い場合のみ1件まで許可

このTASKで禁止:
- blind `supabase db push`
- migration history repair/reconcile
- candidate外のschema/RPC/Function/Cron/settings変更
- H1/G1/G2 object変更
- production auth user作成/削除/更新
- OAuth/Vault/token/secret変更
- X/Instagram/Threads投稿
- Storage/AI/OpenAI/Push/課金変更
- `EXPO_PUBLIC_DATA_SOURCE=supabase` を既定ONに変更
- 複数user/brandへの一括membership投入
- 不明なuser_id/brand_idを推測してmembership投入

## Gate 1 — exact production preflight（write前）

以下をread-onlyで確認し、1つでも想定外ならproduction writeせずSTOPしてC2へ返す:

- `public.brands.id` = text
- `auth.users.id` = uuid
- `social_accounts.brand_id` / `scheduled_posts.brand_id` / `post_execution_logs.brand_id` / `posting_windows.brand_id` が存在し、型/FKがPhase4前提と一致
- 対象5tableでRLS enabled
- 既存 `private.is_admin()` pathとadmin policiesがPhase4確認時から意図せず変化していない
- `public.brand_memberships` がまだ存在しない、または存在する場合は今回candidateと完全互換であること
- candidate policy名との衝突がない、または同一定義であること
- migration history不整合を理由に `db push` を使う必要がないこと
- H1/G1のproduction migration適用と同時実行にならないこと

preflight結果は件数/型/policy名など非secret情報のみReportへ記録。auth user個人情報やtoken/secret値は記録しない。

## Gate 2 — production apply

Gate 1 PASS時のみ、approved candidateの内容だけをtransactionalにproductionへ適用する。

要件:
- apply sourceはexact candidate内容と一致することをhash/diffで確認
- 可能なら単一transaction
- `brand_memberships` table + PK/FK/check/RLS
- authenticated self-membership SELECT
- `brands` / `social_accounts` / `scheduled_posts` / `post_execution_logs` / `posting_windows` tenant SELECT policies
- membership INSERT/UPDATE/DELETEはanon/authenticatedへ許可しない
- 既存admin policyをdrop/replaceしない
- 新規SECURITY DEFINER RPCは追加しない
- 失敗時は中途半端な部分適用を残さずrollback

## Gate 3 — postflight/read-back

apply直後にproduction metadataをread-backし、最低限:

- `brand_memberships`存在
- PK `(brand_id,user_id)`
- FK 2本
- role check
- RLS enabled
- candidate policies 6件（membership + operational 5）
- authenticated membership SELECT grantあり
- authenticated membership INSERT/UPDATE/DELETE grantなし
- 既存admin policies件数/definitionが維持
- 対象tableの既存row件数や既存posting dataを変更していない

を確認。

想定外があれば新規membershipを入れず、rollback可否を確認してC2へ返す。

## Gate 4 — admin compatibility production check

既存admin経路をread-onlyで確認する。

- membership無しの既存global admin相当userでも従来admin policyが成立すること
- candidate追加で管理画面のread権限が狭まっていないこと
- admin policyとmembership policyのOR合成がmetadata上維持されていること

人工的な本番auth user作成は禁止。

## Gate 5 — optional single canary membership

### 原則
schema/RLS rolloutとmembership assignmentは分離する。canaryは安全に対象を一意特定できる時だけ行う。

許可条件（全て必須）:
- 既存production dataから対象userが一意
- そのuserが対象brandの正当なowner/adminであることが既存の明示的relation/運用設定から確認可能
- brandも一意
- user/brandを推測していない
- 付与roleが最小権限で説明可能

条件を満たさない場合:
- membership INSERTは0件
- 「schema/RLS rolloutのみ完了、canary membership未実施」とReport
- 次のC2で対象指定方法を決める

条件を満たす場合のみ:
- 1 user × 1 brandをcanaryとしてinsert
- insert後に本人membership/所属brand read contractをread-only確認
- cross-brand rowが返らないことを可能な範囲で確認
- mobile appの既定data sourceはmockのまま

## Gate 6 — rollback readiness

productionで自動rollbackは、明確な不整合/回帰が発生した場合のみ行う。

事前にrollback SQLをexact candidateに対応させて用意し、以下を確認:
- candidate operational policiesだけdrop可能
- self-membership policy drop可能
- `brand_memberships` drop可能
- 既存admin policyはrollback対象に含めない
- canary membershipがあればtable dropで消えることを理解する

正常時はrollbackを実行せず、readyであることをReportする。

## Mobile app state

このTASKでは:
- `EXPO_PUBLIC_DATA_SOURCE=mock` default維持
- production Supabase sourceをONにしない
- app binary/deploy不要
- Phase4 adapter contract変更は原則不要

production schema/RLS + canaryが安全に成立した後、次Phaseで実Auth/mobile read QAとdata source切替を判断する。

## Verification

最低限:
- Gate 1 preflight PASS
- exact candidate apply PASS
- postflight object/policy/grant read-back PASS
- admin compatibility PASS
- production data mutationがcandidate schema/RLS/grant（+条件付き1 canary membership）以外0
- H1/G1/G2 production object変更0
- `git diff --check` PASS（repo変更がある場合）

既存social-mobile sourceに変更がない場合、typecheck/lint/Expo exportの再実行は必須ではないが、candidate sourceが変わった場合はPhase4相当の全検証を再実行する。

## Completion criteria

C2へ返す時点で明確にする:
1. exact preflight結果
2. production applyのexact SQL/source/hash
3. postflight metadata
4. admin compatibility
5. canary membershipを実施したか、しなかったなら理由
6. rollback readiness
7. `EXPO_PUBLIC_DATA_SOURCE=supabase` はまだOFFであること
8. candidate外production mutation 0
9. 次Phaseで必要な実Auth/mobile read QA

完了時:
- `.agent/CODEX_REPORT_2.md` 先頭にPhase5 production rollout report追加
- this TASKを `status: review_required`, `next_owner: chatgpt`
- push前fresh-check
- TASK/Reportのmetadata更新のみ安全にorigin/mainへpush
- push後read-back
- STOPしてC2待ち

## Important stop rule

preflightでschema/policy/parallel conflictが1つでも想定外なら、production writeは0のままSTOPする。
canary対象が曖昧ならmembershipを推測投入しない。
