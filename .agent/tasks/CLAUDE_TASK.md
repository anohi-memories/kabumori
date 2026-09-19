# Claude Task 2

- task_id: social-mobile-app-phase8-completion-followup-claude-20260919
- owner: claude
- slot: claude-2
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Opus 5
- purpose: Codex slot 2から一時引き継ぎ。Phase 8で既にPASS済みのtenant RLS isolation proofを前提に、残っている mobile/local sign-in QA、profile lifecycle正本確認、test fixture cleanupだけを安全に完了させる。

## User instruction

2026-09-19、ユーザーは「今日の夜までこでさんを休ませたい。いったんくろちゃんにこの先を振って」と指示。

したがって:
- このsocial-mobile workstreamはClaude slot 2が一時担当。
- Codex slot 2はidle。
- 同じsocial-mobile Phase 8対象をCodexと並行変更しない。
- 完了確認はK2。

## Proven state / do not redo

既に本番で以下は確認済み:
- non-admin Auth userをDashboard正規経路で1件作成済み。
- non-admin userは `admin_users` 非所属。
- non-admin userに `ai_salaryman_lab / viewer` membership 1件。
- authenticated + RLS enabledのread-only proofで:
  - brand_memberships: ai_salaryman_lab = 1
  - brands: ai_salaryman_lab = 1
  - social_accounts: ai_salaryman_lab = 1
  - scheduled_posts: ai_salaryman_lab = 24
  - post_execution_logs: ai_salaryman_lab = 46
  - posting_windows: ai_salaryman_lab = 10
  - kabumori = 0
  - mio = 0
- cross-tenant leakage = 0
- client-side brand filterに依存せずtenant isolationを実証済み。
- existing global-admin policy pathは未変更。
- authenticatedのbrand_memberships INSERT/UPDATE/DELETE grantは無し。
- mobileは `auth.getUser()` + self-scoped `brand_memberships`、fail-closed。
- production default `EXPO_PUBLIC_DATA_SOURCE=mock` 維持。
- isolated worktreeで typecheck/lint/Expo export/static policy 5/5/git diff --check PASS。

**上記RLS proofを再実施・再変更しない。**

## Remaining scope only

### 1. mobile/local client sign-in QA

目的:
- 新しいnon-admin QA userを、実際のsocial-mobile client pathでsign-inして動作確認する。

要件:
- local/dev環境だけで `EXPO_PUBLIC_DATA_SOURCE=supabase` を明示。
- production default envは変更しない。
- credential/token/passwordをTASK/Report/commit/logへ残さない。
- service_role禁止。
- signed-out -> auth required
- signed-in non-admin + membership -> ai_salaryman_lab tenantだけread
- kabumori / mioの表示・取得 0
- no-membership -> blocked/no-workspace contract維持
- unavailable / permission denied / schema mismatch分類維持
- silent mock fallback禁止
- scheduled_postsのaccount/body/origin gapは推測で埋めない

実credentialがClaude実行環境から使えない場合:
- 勝手に取得/推測しない。
- local clientで必要な正確なユーザー操作手順まで作成。
- その部分だけユーザー手動QA待ちとして明記してよい。

### 2. profile lifecycle source-of-truth

現状:
- auth.users=2
- admin_users=1
- profiles=1
- 新しいnon-admin QA userにはprofile rowが無い。

調査:
- `profiles` のschema/FK/RLS/trigger
- auth.users作成triggerの有無
- signup/login時にprofileを作るRPC/Edge Function/app codeの有無
- apps/social-mobileがprofile rowを必要としているか
- apps/admin/既存株アプリ側のprofile lifecycleと混同しない

判断:
- social-mobileにprofile不要なら「不要」を根拠付きで確定。
- 必要なら正規onboarding経路を設計する。
- このtaskでは推測INSERTやproduction profile補完を勝手にしない。
- schema変更が必要ならcandidateだけ作り、production applyはK2後。

### 3. test fixture cleanup

現在のtest fixtures:
- non-admin QA user × ai_salaryman_lab/viewer membership
- old global-admin user × ai_salaryman_lab/viewer canary membership

cleanup原則:
- QAが済んだfixtureは削除を優先。
- membershipはexact test rowだけ。
- Auth user削除はSupabase Dashboard/Authの正規経路のみ。
- direct `auth.users` DELETE/INSERTは禁止。
- admin_users、本番brand/social_accounts/admin policyを絶対に触らない。
- safety reviewやtool承認で拒否されたら迂回しない。

Claudeから正規削除経路を実行できない場合:
- ユーザー向けにDashboardでのexact cleanup手順を作る。
- 何を消し、何を残すか明確にする。
- 削除前後のexpected row countを明記する。

## Verification

最低限:
- fresh origin/main
- `.agent/ORCHESTRATION.md`
- `.agent/CURRENT_STATE.md`
- this TASK
- `.agent/tasks/CODEX_TASK_2.md`
- G1/H1 current tasks
- production read-only metadata where needed

実装/QA後:
- npm ci --ignore-scripts など lockfile準拠のinstall only
- package/lock変更なし
- npm run typecheck PASS
- npm run lint PASS
- Expo Web export / route resolution PASS
- static policy contract PASS
- git diff --check PASS

## Production boundary

変更禁止:
- RLS / admin policies / grants / schemaの既存本番変更
- migration history repair/reconcile
- blind db push
- OAuth/Vault
- x-test-post / market-report / daily_content_plans
- Cron/settings
- AI/X/Push/Storage/課金
- production default `EXPO_PUBLIC_DATA_SOURCE=supabase`
- service_roleをmobile bundleへ含める

cleanup以外のproduction writeは原則0。

## Completion / K2

完了時:
- this TASK -> `review_required`
- next_owner -> `chatgpt`
- `## Report` に以下:
  1. mobile/local sign-in QA結果
  2. profile lifecycle正本
  3. cleanup結果 or exact manual cleanup手順
  4. tests
  5. changed files
  6. production mutation一覧
  7. production default mock維持確認
  8. 次Phase（X OAuth login onboarding）へ進める条件
  9. exact commit/push/read-back

push前にfresh `origin/main` を確認。
他workstreamの未コミット変更には触れない。
完了後STOPしてK2待ち。
