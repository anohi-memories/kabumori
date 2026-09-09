# Codex Task

- task_id: expo-ios-push-e2e-20260909
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sol

## Goal

かぶモリExpoアプリで、iPhone実機へPush通知を送受信できるdevelopment環境を完成させる。

前TASKでPushクライアント基盤は実装済み。今回は、正式Bundle ID、EAS/iOS資格情報、development build、実機Push E2Eの確認までを進める。

## Confirmed starting point

- Expo SDK `~57.0.18`
- `expo-notifications` `~57.0.17`
- EAS projectId `eb80adf3-861e-4a48-a373-2d9a85b58899`
- previous push client implementation commit: `5242bf556bfdc1a27e835f778617396098baf06c`
- Push registration / token取得 / foreground handler / notification tap / cold launch処理は実装済み
- `public.device_push_tokens` 保存先は既存
- iOS `bundleIdentifier` は未設定
- Apple Developer Programはユーザーが2026-09-09に登録済み。メンバーシップ有効化状況は未確認の可能性あり

## Required investigation before write

開始時に必ず:

1. `PROJECT_RULES.md`
2. `.agent/ORCHESTRATION.md`
3. `.agent/CURRENT_STATE.md`
4. このTASK
5. `HANDOFF.md`
6. `app.json`, `eas.json`, `package.json`
7. Push関連実装
8. Expo SDK 57 / EAS Build / Push Notificationsの公式ドキュメント
9. origin/main fresh-check
10. shared worktreeの既存未コミット変更確認

既存未コミット変更は他workstream所有物として扱い、変更・stage・commitしない。

## Model guidance

このTASKはApple Developer / EAS credential / Bundle ID / native build / Push E2Eが絡むため **Sol推奨**。

## Step 1: Apple membership / EAS readiness

Apple Developer Programの有効化状態を、利用可能なCLI/EAS情報で安全に確認する。

- 有効化されていない、またはApple login/2FA等でユーザー操作が必要な場合は、その時点までの準備を行い、必要なユーザー操作をReportに具体的に記載する。
- Apple ID password、2FA code、APNs private key等の秘密情報をReport・Git・ログへ残さない。
- 対話操作が必要な場合、無理に回避しない。

## Step 2: Bundle ID

正式Bundle IDを決定・設定する。

優先順位:

1. リポジトリ/既存Apple/EAS設定内に正式なBundle IDが既に存在するなら、それを使用。
2. 存在しない場合、かぶモリ専用として衝突しにくく自然なreverse-DNS identifierを選定する。

候補として `com.anohimemories.kabumori` を使用してよい。ただしApple/EAS側で既存競合・命名方針との不一致がある場合は別名に変更し、その理由をReportへ記載する。

`app.json` の `expo.ios.bundleIdentifier` を設定する。

Android package名は今回勝手に変更しない。

## Step 3: EAS / APNs credentials

Expo SDK 57 / EAS公式手順に沿ってdevelopment build用iOS credentialsを準備する。

許可:
- EASが自動管理するiOS distribution/development credentialsの作成
- Push Notifications capabilityに必要なAPNs credentialのEAS管理設定
- development buildに必要なdevice registration

禁止:
- credentials/private keyの値をReport・Git・consoleログへ転記
- production App Store submit
- 不要なcertificate/key乱造
- 既存他アプリのcredential破壊・revoke

既存credentialがある場合は可能な限り再利用する。

## Step 4: Device registration / development build

ユーザー自身のiPhoneをdevelopment build対象として登録し、iOS development buildを作成できる状態へ進める。

- 端末登録でユーザー側の操作（QR/URLをiPhoneで開く等）が必要なら、作業を安全に止めて手順を明記する。
- EAS Buildを実行できる条件が揃っている場合はdevelopment profileでbuildしてよい。
- App Store submitはしない。

## Step 5: Push E2E

実機buildがインストール可能になったら、最低限以下を確認する。

1. アプリ起動
2. 通知permission prompt
3. Expo Push Token取得
4. `device_push_tokens` への保存
5. テストPush送信
6. backgroundで通知受信
7. foregroundでbanner/list表示
8. 通知タップで既存 `important_news -> /news` routing
9. cold launchで通知タップ routing

テスト通知はユーザー自身の端末だけを対象とする。

既存send-push Edge Function /安全な既存送信経路が使える場合のみ利用してよい。新しい本番配信機構を勝手に作らない。

## Supabase / production boundaries

今回の目的は既存Push経路の実機確認。

原則禁止:
- migration/schema/RLS/GRANT/RPC変更
- X自動投稿関連変更
- Web admin変更
- unrelated Edge Function変更
- production scheduler/Cron変更

既存Push Edge Functionの**read-only調査**と、ユーザー自身への安全なテスト送信は許可。

実機E2Eに不可欠な軽微なPush専用コード修正が判明した場合のみ、原因を確認して最小修正してよい。

## Verification

コード変更がある場合:
- targeted TypeScript check
- `git diff --check`
- Expo config確認
- 可能なら既存lint

EAS/Apple:
- Bundle ID解決
- credentials準備結果
- build結果
- device registration結果

実機:
- 実際に確認した項目だけPASS扱い
- 未確認項目は未確認と明記

## Safety / conflict rules

- 他slotが `app.json`, `eas.json`, Push関連ファイル、同じEAS/Apple production設定を変更中なら競合として停止
- push前にorigin/mainをfresh-check
- 他workstream未コミット変更をstage/commitしない
- secret / Apple credential / token全文をReportへ残さない
- Expo Push Tokenも原則全文をReportへ残さない
- App Store submissionはしない

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
- Apple Developer membership確認結果
- Bundle ID
- changed_files
- EAS credential結果（秘密値なし）
- device registration結果
- development build結果
- 実機インストール結果
- Push E2E各項目のPASS/未確認
- tests
- commit_hash
- push
- deploy/build
- user_action_required
- remaining_issues
- safety_checks
- next_recommendation
