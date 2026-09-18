# Codex Task 2

- task_id: social-mobile-app-phase8-nonadmin-test-user-setup-and-tenant-proof-20260918
- owner: codex
- slot: codex-2
- status: ready
- next_owner: codex
- priority: high
- recommended_model: Sol High
- purpose: Phase 7で確認したadmin/user分離設計を、productionのnon-admin test userで実証する。正規のSupabase Auth lifecycleでtest userを用意し、ai_salaryman_labだけ見えるtenant isolationを実Auth sessionで確認する。global admin既存経路は触らない。

## Approved basis

Phase 7 audit:
- production Auth userは1件のみ。
- その唯一のAuth userはadmin_usersにも存在しglobal admin。
- mobileはadmin_users/private.is_admin()に依存せず、auth.getUser() + brand_membershipsでfail-closed。
- non-admin Auth userは現状0。
- current test canary: global-admin user × ai_salaryman_lab × viewer が1件残存。
- EXPO_PUBLIC_DATA_SOURCE=mock維持。
- user decision: 普段使い一般ユーザーAuthと管理者Authを分離する。

## Goal

1. non-admin test userを正規Auth lifecycleで用意。
2. test userをadmin_usersには入れない。
3. ai_salaryman_labへのviewer membershipを1件だけ付与。
4. 実Auth sessionでtenant isolationを証明。
5. ai_salaryman_labのみread可。
6. kabumori / mioは0。
7. mobile authenticated roleからmembership write不可。
8. admin経路のregressionなし。
9. current global-admin canaryは一般ユーザー証明には使わず、安全な承認済み削除経路があればcleanup。
10. production default data sourceはmockのまま。

## Mandatory startup

- .agent/ORCHESTRATION.md
- .agent/CURRENT_STATE.md
- this TASK
- .agent/CODEX_REPORT_2.md
- H1/G1/G2 current tasks
- fresh origin/main

既存未コミット変更は他workstream所有。x-test-post / market-report / daily_content_plans / OAuth/Vaultは触らない。

## Gate 1 — Auth lifecycle inspection

read-onlyで以下を確認:
- Supabase Auth provider/settingsで、test userを作る正規かつ最小の方法。
- email/password signup, invite, magic link等のうち、今回のQAに最も限定的で後片付け可能な方法。
- profile rowがどの経路で作られるか。
- test user作成時にproduction side effectが何か。
- anonymous/temporary userが使えるか。使えない/不適なら採用しない。

重要:
- password/token/session secretをReportへ書かない。
- user作成をSQL直書きしない。
- auth.usersへ直接INSERTしない。
- toolが正規Auth user creationを提供しない場合、手動Dashboard手順を正確に作ってSTOPしてよい。

## Gate 2 — non-admin test user creation

正規Auth経路が安全に使える場合のみ:
- non-admin test userを1件だけ作成。
- admin_usersへ追加しない。
- profile lifecycleを確認。
- test user ID/email等の個人識別子はReportへ残さない。

ツール側で作成経路が無い/承認されない場合:
- production mutation 0でSTOP。
- Supabase Dashboardでの具体的な最小手順をReport。
- ユーザーが手動作成後にH2再開できる状態にする。

## Gate 3 — membership setup

non-admin test user作成後:
- ai_salaryman_lab / viewer membershipを1件のみ。
- 既存global-admin canaryとは別userであること。
- kabumori/mio membership 0。
- membership insertがツール安全審査で拒否されたら迂回禁止。必要ならDashboard手動SQL/GUIの最小手順をReportしてSTOP。

## Gate 4 — real tenant isolation proof

non-admin authenticated sessionで、client-side brand filterに頼らず:
- brand_memberships: own rowのみ
- brands: ai_salaryman_labのみ
- social_accounts: ai_salaryman_labのみ
- scheduled_posts: ai_salaryman_labのみ
- post_execution_logs: ai_salaryman_labのみ
- posting_windows: ai_salaryman_labのみ
- kabumori rows = 0
- mio rows = 0
- cross-tenant leakage = 0
- membership INSERT/UPDATE/DELETE = denied
- secret/token/Vault columnsをselectしない
- service_roleをmobileへ渡さない

## Gate 5 — mobile adapter QA

apps/social-mobile:
- local/dev onlyでEXPO_PUBLIC_DATA_SOURCE=supabaseを明示
- signed-out -> auth required
- signed-in non-admin + membership -> ai_salaryman_lab tenant only
- no membership -> blocked/no-workspace
- permission denied/schema mismatch/unavailable分類維持
- silent mock fallbackなし
- scheduled_postsのaccount/body/origin gapは推測しない
- production default envはmockのまま

依存関係が無いisolated worktreeなら、正式package lockに基づくinstallが安全に可能か確認。
安全ならinstallして:
- npm run typecheck
- npm run lint
- Expo Web export / route resolution
- git diff --check

package/lock更新は禁止。installで生成差分が出たら戻す。

## Gate 6 — cleanup

test用fixtureはQA後cleanupを原則:
- non-admin test userのmembership 1件
- test user本体
- 必要ならprofile row
- current global-admin canary 1件

ただし削除は正規/承認済み経路がある場合のみ。
削除不可なら迂回せず、残存fixtureを正確にReportする。
既存本番user/brand/account/admin policyは絶対に削除しない。

## Production safety

禁止:
- auth.users直接SQL INSERT/DELETE
- admin_users変更
- global admin policy変更
- RLS/grant緩和
- migration history repair/reconcile
- blind db push
- OAuth/Vault/X/Push/Cron/AI/Storage/課金変更
- EXPO_PUBLIC_DATA_SOURCE=supabaseをproduction defaultへ変更
- service_roleをmobile bundleへ含める

## Completion / STOP conditions

C2へ返す時に必ず:
1. non-admin test user作成可否
2. 正規Auth lifecycle
3. membership作成可否
4. tenant isolation runtime proof
5. kabumori/mio 0
6. membership write denial
7. admin regression
8. adapter QA
9. typecheck/lint/Expo
10. cleanup結果
11. production default mock維持
12. production mutation一覧
13. 次にX OAuth login onboardingへ進める条件

完了時:
- CODEX_REPORT_2.md先頭へPhase 8 report
- TASK -> review_required / next_owner: chatgpt
- push前fresh origin/main
- push後read-back
- STOPしてC2待ち

## Important stop rule

non-admin user作成またはmembership作成に正規/承認済み経路が無ければ、迂回せずproduction mutation 0または最小状態でSTOPする。
tenant isolation proofにglobal admin accountを使わない。
