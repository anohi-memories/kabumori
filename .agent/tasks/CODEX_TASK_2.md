# Codex Task 2

- task_id: social-mobile-app-phase8-nonadmin-test-user-setup-and-tenant-proof-20260918
- owner: codex
- slot: codex-2
- status: idle
- next_owner: chatgpt
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


## Manual non-admin tenant isolation proof — 2026-09-18

User executed a read-only SQL session in Supabase Dashboard against stock-x-autopost / main / PRODUCTION, simulating the newly created non-admin Auth user with authenticated role and RLS enabled, wrapped in BEGIN/ROLLBACK.

Observed visible rows:
- brand_memberships: ai_salaryman_lab = 1
- brands: ai_salaryman_lab = 1
- social_accounts: ai_salaryman_lab = 1
- scheduled_posts: ai_salaryman_lab = 24
- post_execution_logs: ai_salaryman_lab = 46
- posting_windows: ai_salaryman_lab = 10
- kabumori rows: 0
- mio rows: 0

Conclusion:
- non-admin tenant isolation is now manually demonstrated across all six target resources without client-side brand filtering.
- existing global-admin path remains separate and was not modified.
- SQL was read-only with transaction rollback; no production data mutation from this proof.

Next H2:
- do not recreate users or memberships.
- verify mobile authenticated membership INSERT/UPDATE/DELETE denial if safe.
- perform local/dev adapter QA with non-admin credentials/session if available, keeping secrets out of reports.
- run typecheck/lint/Expo with dependency install only if package/lock remain unchanged.
- decide cleanup of test non-admin membership/user and old global-admin canary using only approved deletion paths.
- production default EXPO_PUBLIC_DATA_SOURCE remains mock.


## C2 review — 2026-09-18

**PARTIAL PASS / NOT COMPLETE — tenant isolation proofはPASS、Phase 8全体は未完了。**

PASS確認:
- 正規Dashboard経路でnon-admin Auth userを1件作成。
- non-admin userは `admin_users` 非所属。
- non-admin userに `ai_salaryman_lab / viewer` membership 1件。
- authenticated + RLS enabledのread-only SQL proofで、6 resourceすべて `ai_salaryman_lab` のみ可視。
- `kabumori=0`、`mio=0`、cross-tenant leakage 0。
- client-side brand filterに依存せずtenant isolationを実証。
- authenticatedの `brand_memberships` INSERT/UPDATE/DELETE grantは無いことを確認。
- existing global-admin policy pathは未変更。
- mobile adapterは `auth.getUser()` + self-scoped membership、fail-closed、silent mock fallbackなし、service-role/secret依存なし。
- production default `EXPO_PUBLIC_DATA_SOURCE=mock` 維持。
- isolated worktreeで `npm run typecheck` PASS、`npm run lint` PASS、Expo Web export PASS、static policy 5/5 PASS、`git diff --check` PASS。
- package/lock変更なし。

未完了:
1. 実mobile/local clientでnon-admin credentialを使ったサインインruntime QA未実施。
2. non-admin Auth userにprofile rowが未作成。profile lifecycleの正本確認が必要。
3. test fixtures cleanup未完了:
   - non-admin QA user + membership
   - old global-admin canary membership
4. membership write denialはACL/policy metadataで確認済みだが、実authenticated sessionからの拒否runtime proofは未実施。

C2 decision:
- **tenant RLS isolationそのものは本番proof済みとして承認。**
- ただしPhase 8のcompletion criteriaを満たし切っていないため `done` にはしない。
- TASKは `review_required` のまま。
- 次は実mobile sign-in QA + profile lifecycle確認 + test fixture cleanupだけに限定してよい。
- RLS/admin policy/schema/grantを変更する必要はない。
- production default data sourceは引き続きmock。


## Phase 8 completion follow-up authorized — 2026-09-18

ユーザーがPhase 8残作業の続行を明示承認。

このH2では、既にPASS済みのtenant RLS proofを再実施・再変更せず、残り3点だけを処理する。

### Remaining scope only

1. **実mobile/local client sign-in QA**
   - 新しく作成済みのnon-admin QA userを使用。
   - local/devのみで `EXPO_PUBLIC_DATA_SOURCE=supabase` を明示。
   - production default envはmockのまま。
   - credential/tokenをReportへ記録しない。
   - signed-in後、`ai_salaryman_lab` tenantだけが読めることをアプリ経路で確認。
   - signed-out / no-membership / unavailable分類も既存contractどおりか確認。
   - service_role禁止。

2. **profile lifecycle確認**
   - なぜDashboard作成のnon-admin QA userに `profiles` rowが無いか、read-onlyで正本を確認。
   - trigger/RPC/app signup flowのどれがprofile作成主体か特定。
   - 一般ユーザー本番onboardingでprofileが必要なら、その正規作成経路を設計。
   - このfollow-upでは推測INSERTしない。
   - profileがsocial-mobileに不要なら、その理由を明記。

3. **test fixture cleanup**
   - current fixtures:
     - non-admin QA user + ai_salaryman_lab/viewer membership
     - old global-admin canary membership
   - 正規/承認済み削除経路がある場合のみcleanup。
   - Auth userはDashboard/Auth正常経路以外で削除しない。
   - membershipはexact test rowsだけ。
   - safety reviewで拒否されたら迂回しない。
   - cleanup不可なら、ユーザー向け手動Dashboard手順を具体的にReportしてSTOP。

### Do not change

- RLS / admin policies / grants / schema
- migration history
- x-test-post / market-report / daily_content_plans
- OAuth/Vault
- Cron/settings
- AI/X/Push/Storage/課金
- production default data source

### Verification required

- mobile/local non-admin sign-in QA result
- profile lifecycle source-of-truth
- cleanup result or exact manual cleanup steps
- npm run typecheck
- npm run lint
- Expo Web export / route resolution
- git diff --check
- production mutation list
- secrets/personal data excluded from report

完了時:
- CODEX_REPORT_2.md先頭へPhase 8 completion follow-up report
- TASK -> review_required / next_owner: chatgpt
- origin/main fresh-check + push + read-back
- STOPしてC2待ち


## Temporary handoff — 2026-09-19

ユーザー指示により、Codex（こでさん）は本日夜まで休止。Phase 8 completion follow-upの残作業は一時的にClaude slot 2へ引き継ぐ。

- H2はここでidle。
- Claude slot 2が同workstreamを担当する間、Codex slot 2はsocial-mobile Phase 8関連の実装・DB・Auth・cleanupに触れない。
- Claude側の完了確認はK2。
- 夜以降にCodexへ戻す場合は、K2結果と最新mainを確認してから再armする。
