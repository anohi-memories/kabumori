# Codex Task 2

- task_id: social-mobile-app-phase7-auth-role-separation-and-tenant-isolation-20260918
- owner: codex
- slot: codex-2
- status: ready
- next_owner: codex
- priority: high
- recommended_model: Sol High
- purpose: social-mobileの一般利用者Authとglobal admin権限を分離し、一般利用者が自分のtenant/brandだけ読めることをproduction相当で実証する。既存admin経路は管理用途に限定し、通常モバイル利用ではglobal admin権限を使わない。

## User decision

2026-09-18、ユーザー了承:
- 普段使いの一般ユーザーAuthと管理者Authを分離する。
- 一般ユーザーは自分のworkspace/brandだけ見える設計にする。
- 管理者権限は管理画面/管理用途に限定し、通常モバイル利用へ持ち込まない。

## Current production facts

- Supabase project: stock-x-autopost
- current only Auth user is also present in admin_users and therefore has global-admin read path.
- Phase 6 canary membership: ai_salaryman_lab / viewer が1件残存。
- canary userはglobal adminでもあるため、kabumori operational rowsが既存admin policy経由で見え、tenant-only isolationは未証明。
- EXPO_PUBLIC_DATA_SOURCE=mock 維持。
- migration history repair/reconcileは禁止。

## Goals

1. Auth role separation designを明文化。
2. mobile appの通常Auth pathがglobal admin判定に依存しないことを確認/修正。
3. admin-only pathとuser tenant pathを分離。
4. non-admin Auth userでtenant isolationを実証。
5. ai_salaryman_labのみread可、kabumori/mioは0を確認。
6. mobile authenticated userからmembership INSERT/UPDATE/DELETE不可を実証。
7. current test canaryの扱いを安全に整理。
8. production default data sourceはまだmock維持。

## Safety / production boundary

許可:
- read-only schema/policy/auth metadata確認。
- apps/social-mobile/** のauth/adapter/UI stateに必要な最小変更。
- 必要ならadmin/user role separation用のcandidate schema/RLS migrationをreview-onlyで作成。
- non-admin test userのQA設計と、承認済み経路が明確な場合のみbounded canary setup。
- current test canary 1件の削除は承認済み経路がある場合のみ。

禁止:
- global admin policyを削除/緩和/置換。
- existing admin_usersの意味を壊す変更。
- auth userの本番作成/削除を迂回SQLで行うこと。
- migration history repair/reconcile。
- blind supabase db push。
- service_roleをmobileへ渡す。
- OAuth/Vault/X/Push/Cron/AI/Storage/課金変更。
- production default EXPO_PUBLIC_DATA_SOURCE=supabase への切替。
- 他workstreamのx-test-post/market-report/daily_content_plans変更。

## Required design

一般ユーザー:
- Supabase Auth user
- brand_membershipsで所属brandを決定
- tenant RLSだけでoperational dataをread
- admin_users/global admin権限なし

管理者:
- admin_users等の既存global-admin経路
- 管理画面/管理操作専用
- 通常モバイルユーザー体験では使用しない

mobile app:
- signed-out → auth required
- signed-in + no membership → blocked/no-workspace
- signed-in + membership → own tenant only
- signed-in + global adminは通常ユーザー経路のQA対象から除外
- mockへのsilent fallback禁止
- secret/token列はselectしない

## Phase 7 execution plan

### Gate 1 — inspect current auth/admin coupling
- admin_users / profiles / auth.users / brand_memberships relationをread-only確認。
- apps/social-mobile内でglobal adminを前提にしたコードが無いか確認。
- apps/adminとmobileの責務境界を確認。

### Gate 2 — choose non-admin QA path
優先順:
1. 既存non-admin Auth userがあれば使用。
2. 無ければ、Supabase Authの正規手段でtest userを用意する計画を作る。
3. tool/production safetyでuser作成が許可されない場合は勝手に作らずSTOPし、必要な手動手順をReportする。

test user要件:
- admin_usersに存在しない
- profile/user lifecycleが正規
- ai_salaryman_labへviewer/member membership 1件だけ
-個人情報やpassword/tokenをReportへ記録しない

### Gate 3 — tenant isolation QA
non-admin authenticated sessionで:
- brand_memberships self-read = own row only
- brands = ai_salaryman_lab only
- social_accounts = ai_salaryman_lab only
- scheduled_posts = ai_salaryman_lab only
- post_execution_logs = ai_salaryman_lab only
- posting_windows = ai_salaryman_lab only
- kabumori = 0
- mio = 0
- client-side brand filterなしでもcross-tenant leakage 0
- membership write denied

### Gate 4 — admin regression
- existing global admin pathが管理用途として引き続きread可能であることを確認。
- admin policyの削除/変更0。
- mobile一般ユーザー経路とは分離されていることを明記。

### Gate 5 — current canary cleanup
- current ai_salaryman_lab/viewer canaryはglobal-admin user向けの試験fixture。
- 承認済み削除経路があればその1件だけ削除。
- 削除不可なら残存を明記し、一般ユーザーQAの判定には使わない。

## Verification

最低限:
- npm run typecheck
- npm run lint
- Expo Web export / route resolution
- git diff --check
- static policy contract
- non-admin tenant isolation runtime proof
- admin regression proof
- production default data source mock維持
- production mutationを明示
- secret/token/passwordをReportへ残さない

## Completion criteria

C2へ返す時:
1. admin/user role separation設計
2. non-admin test userを用意できたか
3. ai_salaryman_labのみ見えたか
4. kabumori/mioが0か
5. membership write denial
6. admin regression
7. current canaryを削除/残置どちらにしたか
8. mobile adapter QA
9. typecheck/lint/Expo結果
10. production default data sourceがmockのままか
11. 次にX OAuth login onboardingへ進める条件

完了時:
- CODEX_REPORT_2.md先頭へPhase7 report
- this TASK → review_required / next_owner: chatgpt
- push前fresh origin/main確認
- push後read-back
- STOPしてC2待ち

## Important stop rule

一般ユーザーtenant isolationの証明にglobal admin accountを使わない。
正規non-admin Auth userを用意できない場合、権限を緩めたり迂回作成せずSTOPする。
