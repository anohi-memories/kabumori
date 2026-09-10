# Claude Task 1

- task_id: expo-ios-push-e2e-resume-20260910
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
- priority: high
- purpose: Apple Developer Program有効化後、かぶモリExpoアプリのiPhone実機Push通知E2Eを完成させる。

## Goal

前工程でPushクライアント基盤、EAS projectId、`public.device_push_tokens` 保存先確認、iOS Bundle ID `com.anohimemories.kabumori` 設定までは完了済み。

ユーザーは2026-09-10にApple Developer Programが有効化されたと明示した。まずApple TeamがCLI/EASから認識できることを再確認し、認識できればEAS credentials/APNs、iPhone端末登録、Development Build、実機Push E2Eまで進める。

## Required startup checks

1. `PROJECT_RULES.md`
2. `.agent/ORCHESTRATION.md`
3. `.agent/CURRENT_STATE.md`
4. このTASK
5. `HANDOFF.md`
6. `app.json`, `eas.json`, Push関連コード
7. Expo SDK 57 / EAS Build / Push Notifications公式ドキュメント
8. `origin/main` fresh-check
9. 共有worktreeの未コミット変更確認
10. Codex slot 2が `supabase/functions/x-test-post/**` を担当中のため、その領域へ一切触れない

既存未コミット変更は他workstream所有物として扱い、変更・stage・commitしない。

## Step 1: Apple Team visibility

EAS/Apple CLI経由でPaid Apple Developer Teamが認識されることを確認する。

- Apple login / 2FAが必要なら通常の対話フローを使用してよい
- password / 2FA code / private key等の秘密値をReport・Git・ログへ残さない
- Teamが見えない場合は無理に回避せず停止し、具体的なユーザー操作をReportする
- Bundle ID `com.anohimemories.kabumori` が登録可能か確認する

## Step 2: EAS managed iOS credentials / APNs

Expo/EAS公式手順に沿い、development build用のiOS credentialsを構成する。

許可:
- EAS managed iOS development/distribution credentialsの作成または既存再利用
- Push Notifications capabilityに必要なAPNs credentialのEAS管理設定
- development buildに必要なProvisioning Profile作成

禁止:
- 既存他アプリのcertificate/keyをrevoke・破壊
- 不要なcertificate/key乱造
- credential/private key本文のReport/Git記録
- App Store submit

既存credentialがある場合は可能な限り再利用する。

## Step 3: iPhone device registration

ユーザー自身のiPhoneをdevelopment build対象として登録する。

- EAS device registrationフローを使用してよい
- iPhoneでQR/URLを開く等のユーザー操作が必要なら、そこで安全に停止して必要手順を明記する
- 他人の端末は登録しない

## Step 4: Development Build

条件が揃えば `development` profileでiOS EAS Buildを実行する。

確認:
- Bundle ID `com.anohimemories.kabumori`
- developmentClient=true
- internal distribution
- Push capabilityがbuildに含まれる

App Store submitはしない。

## Step 5: Push E2E

実機インストール後、可能な範囲で以下を実確認する。

1. アプリ起動
2. 通知permission prompt
3. Expo Push Token取得
4. `public.device_push_tokens` への本人token保存
5. 安全な既存送信経路で本人端末だけへテストPush送信
6. background通知受信
7. foreground banner/list表示
8. 通知タップで既存 `important_news -> /news` routing
9. cold launch通知タップ routing

## Boundaries

- 既存send-push Edge Function / 既存安全経路が利用可能な場合のみ使用
- 新しいproduction配信機構は作らない
- migration/schema/RLS/GRANT/RPC/Edge Function/Cron変更は禁止
- 本人端末以外へテスト送信しない
- Expo Push Token全文をReportへ残さない
- `x-test-post`、重要ニュース、朝刊、大引け、Web adminは変更しない
- 実機E2Eに不可欠なPush専用コードの軽微な不具合のみ、原因確認後に最小修正してよい

## Verification

コード変更がある場合:
- targeted TypeScript check
- `git diff --check`
- Expo config確認
- 可能なら既存lint

EAS/Apple:
- Team visibility
- Bundle ID登録結果
- credentials/APNs結果
- device registration結果
- development build結果

実機:
- 実際に確認した項目だけPASS
- 未確認は未確認と明記
- ユーザー操作待ちなら、その地点までを正確にReport

## Completion

終了時:
- `status: review_required`
- `next_owner: chatgpt`
- このTASK末尾に `## Report` を追加
- `.agent/ORCHESTRATION.md` 規定どおりGitHubへ同期

Report必須:
- task_id
- result
- changed_files
- Apple Team確認結果
- Bundle ID
- EAS credentials/APNs結果（秘密値なし）
- device registration結果
- development build結果
- install結果
- Push E2E 1〜9のPASS/未確認
- tests
- commit_hash
- push
- deploy/build
- user_action_required
- remaining_issues
- safety_checks
- next_recommendation
