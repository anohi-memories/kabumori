# Codex Task 2

- task_id: social-mobile-app-phase3-schema-rls-inventory-20260917
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sol Medium/High
- purpose: `apps/social-mobile` Phase 3として、production multibrand/SNS関連schema・ownership・RLSをread-onlyで精査し、mobile appが安全に実データへ接続するためのtenant境界を確定する。必要な不足schema/RLS/membership設計は提案まで行うが、このPhaseではproduction変更を行わない。

## Context

Phase 1 C2 PASS:
- `apps/social-mobile` 独立Expo app shell
- 主要5タブ + Accounts + 素材BOX + 投稿詳細
- domain types / repository boundary

Phase 2 C2 PASS:
- Supabase client foundation
- AuthProvider / session restore / Sign In・Out
- active account context
- mock / Supabase repository adapter selection
- env/auth/RLS/backend errorの明示状態
- implementation commit: `fb83c1568b3e8060dfc87a6bb01fc51dca455ca0`

Phase 2時点のblocker:
- production `brands` / `social_accounts` / `scheduled_posts` の完全なschemaとtenant ownershipが未証明
- RLSがユーザー単位で安全か未証明
- `scheduled_posts` とbrand/accountの安全なrelationが未証明
- したがって `EXPO_PUBLIC_DATA_SOURCE=supabase` のproduction有効化は禁止中

## Mandatory startup / safety

開始前に必ず読む:
1. `.agent/ORCHESTRATION.md`
2. `.agent/CURRENT_STATE.md`
3. this TASK
4. `.agent/CODEX_REPORT_2.md`
5. H1/G1/G2の現行TASK
6. fresh `origin/main`

競合ルール:
- G1はmarket report packet / `x-test-post` / `personalized-reports` / market-report schema候補を扱うため、H2はそれらを変更しない
- H1のOAuth/Vault/x-test-post領域に触れない
- G2領域に触れない
- 既存未コミット変更は他workstream所有として変更・stage・commitしない
- push前にfresh `origin/main`を再確認

## Absolute production boundary

このPhaseで許可:
- production DB/schema/RLS/grant/RPCの**read-only inspection**
- GitHub上のmigration/source確認
- `apps/social-mobile/**` のclient-side adapter/type/UI hardening
- `apps/social-mobile/docs/**` へのinventory/design proposal
- TASK/Report更新

このPhaseで禁止:
- production DB write
- migration適用
- RLS policy追加/変更/削除
- grant/revoke
- RPC/Function作成・変更・deploy
- `supabase db push`
- migration history repair/reconcile
- auth user作成/削除/更新
- SNS OAuth接続
- X/Instagram/Threads投稿
- Vault/token/secret変更
- Storage write
- AI API本接続
- Push通知
- 課金/IAP/Stripe
- Cron/settings変更

**read-only以外のproduction操作は0件で完了すること。**

## Phase 3 goals

### 1. Production schema inventory

productionの実体をread-onlyで確認し、少なくとも以下を整理する:

- brand/workspace相当table
- social account table
- scheduled/planned posts table
- posting history / delivery history table
- posting windows / generation settings / brand settings
- plan/usage関連tableがあるか
- auth userとbrand/workspace/accountを結ぶownership/membership tableまたはcolumn
- primary key / foreign key / unique constraint
- relevant enum/check constraint
- public schema以外に必要なrelationがあるか

候補名を推測だけで確定しない。実production metadataとchecked-in sourceを区別してReportする。

### 2. RLS / tenant isolation audit

mobile clientはanon/publishable key + authenticated session前提。

確認対象:
- relevant tableでRLS enabledか
- `authenticated` がSELECTできる範囲
- policy predicateが `auth.uid()` などユーザーownershipへ結びついているか
- brand/account横断のrow漏洩可能性がないか
- service_role前提のtableをmobileから直接読もうとしていないか
- SECURITY DEFINER RPCをmobile read pathに使う必要があるか
- RPCが必要ならtenant checkをどこで行うべきか

重要:
- RLS不足をclient-side filterで補わない
- ownershipを証明できないtable/rowはappに出さない
- `service_role`をmobileへ入れない

### 3. Auth → workspace/account ownership model

次のどれがproductionで成立しているか判定する:

A. `auth.users.id` → brand/workspace owner column
B. membership table経由
C. account-level owner relation
D. 現状はownership relation無し

Dまたは不十分なら、最小の安全設計を提案する。

提案時は以下を含める:
- table/column/membership候補
- required FK/unique
- RLS policy設計
- insert/update権限の境界
- admin/backend-only writeとmobile readの分離

**SQL proposalはdocsへ記載してよいが、migration fileとしてproduction適用可能状態にして自動deployしない。**

### 4. Domain mapping

既存production schemaからmobile domain modelへのmapping表を作る:

- Workspace
- SocialAccount
- PlannedPost
- PostStatus / PostOrigin
- UsageSummary / PlanTier

各fieldについて:
- production source column
- transform
- nullability
- ownership safety
- 現在不足している場合はgap

### 5. `scheduled_posts` safety

特に精査する:
- brand/account FKが実際にあるか
- generated text/bodyのsource tableはどこか
- schedule_date / scheduled_for / slot_noの正本関係
- status lifecycle
- publish result/historyとのrelation
- multi-brand tenant keyが無い場合、mobile direct readは禁止のままにする

### 6. Supabase adapter hardening

read-only inventoryの結果、安全に確定できる範囲だけ `apps/social-mobile` のSupabase adapterを改善してよい。

要件:
- 実schemaに存在しないcolumnを決め打ちしない
- safe ownership pathが証明できないresourceはblocked stateを維持
- mock fallbackをsilentにしない
- RLS/permission errorとschema mismatchを区別
- UIがSupabase SDKへ直接依存しない既存境界を維持

production data sourceを既定でONにしない。`EXPO_PUBLIC_DATA_SOURCE=mock` defaultを維持する。

### 7. Security/design document

`apps/social-mobile/docs/phase3-schema-rls-inventory.md` 等に以下をまとめる:

- confirmed production tables/columns
- confirmed FK/constraints
- confirmed RLS state/policies
- auth→tenant ownership path
- mobile direct-read可能/不可の分類
- domain mapping
- blockers
- proposed minimal schema/RLS changes
- Phase 4で安全に適用する手順

secret/token/valueは絶対に記載しない。

## Verification

変更を行った場合、最低限:
- `npm run typecheck`
- `npm run lint`
- Expo Web export / route resolution
- adapter/error-stateに関する可能なテスト
- `git diff --check`

さらにread-only auditについて:
- production write 0を明記
- migration/RLS/RPC/grant/deploy 0を明記
- auth mutation 0を明記
- SNS/X API call 0を明記

## Completion criteria

C2へ返す時点で以下が明確であること:

1. mobile appが安全に直接読めるproduction resourceは何か
2. 現時点で読めないresourceは何か、なぜか
3. user→workspace/brand/account ownership relationがどう成立しているか
4. RLSでtenant isolationが保証されているか
5. Phase 4で必要な最小DB/RLS変更は何か
6. production data sourceをONにしてよいか / まだ不可か
7. 実production変更が0であること

完了時:
- `.agent/CODEX_REPORT_2.md` 先頭にPhase 3 report追加
- exact source base / commit / changed files
- audit結果
- domain mapping
- security blockers
- proposed Phase 4
- tests
- production mutation 0
を記載
- this TASKを `status: review_required`, `next_owner: chatgpt`
- push前fresh-check、push後origin/main read-back
- C2待ちでSTOP

## Important decision rule

もしproduction ownership/RLSが不十分なら、それは失敗ではない。
**無理に接続せず「blocked」と確定し、安全なPhase 4 migration/RLS設計をC2へ返すことが正解。**
