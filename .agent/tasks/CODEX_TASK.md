# Codex Task

- task_id: expo-ios-push-e2e-resume-20260910
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: high
- recommended_model: Sol Medium

## Goal

Apple Developer ProgramのTeam有効化後、かぶモリExpoアプリのiPhone実機Push通知E2Eを完成させる。

前工程で以下は完了済み:
- Expo SDK 57 Pushクライアント基盤実装済み
- `expo-notifications` / `expo-device` / EAS projectId設定済み
- `public.device_push_tokens` 保存先確認済み
- iOS Bundle IDを `com.anohimemories.kabumori` として `app.json` に設定済み
- 前回はApple Developer PortalがTeamなしと応答したため、credentials以降を安全に停止した

ユーザーは2026-09-10にApple Developer Programが有効化されたと明示した。今回はTeamがCLI/EASから認識できるかを最初に再確認し、認識できれば続行する。

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
10. Codex slot 2が `supabase/functions/x-test-post/**` を担当中の可能性があるため、その領域へ一切触れない

既存未コミット変更は他workstream所有物として扱い、変更・stage・commitしない。

## Step 1: Apple Team visibility

EAS/Apple CLI経由で、Apple Developer Teamが見えることを確認する。

- Apple login / 2FAが必要なら通常の対話フローを使用してよい
- password / 2FA code / private key等の秘密値をReport・Git・ログへ残さない
- Teamがまだ見えない場合は無理に回避せず停止し、具体的なユーザー操作をReportする

確認事項:
- Paid Program Teamが認識されること
- Team ID / Team名は秘密情報ではないが、不要に詳細個人情報をReportへ書かない
- Bundle ID `com.anohimemories.kabumori` が登録可能か

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

Build完了後、ユーザー自身のiPhoneへインストールできる状態まで進める。

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

### 送信経路の制約

- 既存send-push Edge Function / 既存安全経路が利用可能な場合のみ使用
- 新しいproduction配信機構は勝手に作らない
- migration/schema/RLS/GRANT/RPC/Edge Function/Cron変更は禁止
- 本人端末以外へテスト送信しない
- Expo Push Token全文をReportへ残さない

実機E2Eに不可欠なPush専用コードの軽微な不具合が見つかった場合のみ、原因を特定して最小修正してよい。その場合も `x-test-post`、重要ニュース、朝刊、大引け、Web admin等へ触れない。

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
- ユーザー操作待ちになったら、その地点までを正確にReport

## Safety / conflicts

- Codex slot 2の `x-test-post` TASKと完全分離する
- 他slotが `app.json`, `eas.json`, Push関連ファイル、同じApple/EAS設定を変更中なら競合として停止
- push前に `origin/main` fresh-check
- 既存未コミット変更をstage/commitしない
- secrets / Apple credential / 2FA / token全文をReportへ残さない
- App Store submission禁止
- unrelated deploy禁止

## Completion

終了時:
- `status: review_required`
- `next_owner: chatgpt`
- `.agent/CODEX_REPORT.md` 更新
- `.agent/` 制御情報をGitHubへ同期

Report必須:
- task_id
- result
- model_used（可能なら）
- Apple Team確認結果
- Bundle ID
- changed_files
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
