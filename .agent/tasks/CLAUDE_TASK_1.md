# Claude Task 1

- task_id: send-push-notifications-production-restore-20260910
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
- priority: urgent
- recommended_model: Opus 5
- purpose: 本番 `send-push-notifications` が古い共有checkout版でdeployされ、`alert_settings` のopt-outを無視する状態を、正しいorigin/main版へ安全に復旧し、本番でopt-outが効くことまで実証する。

## Context

直前TASK `important-news-push-producer-wire-20260910` はChatGPTレビューで完了承認済み。

現在確認済み:
- `important-news-monitor` v37 は正しいworktree版へ復旧済み
- 重要ニュースproducerは本番投入済み
- dispatcher Cron `send-push-notifications-dispatch` は毎分active
- 実在ニュースの手動enqueueで `notifications -> Cron -> 実機Push` はPASS
- ただし本番 `send-push-notifications` は過去のdeploy元取り違えにより古い共有checkout版が稼働中
- 本番 `push_send_logic.ts` には `shouldSendNotification` / `AlertSettings` がなく、`alert_settings.push_enabled` / `important_news` opt-outを見ていない
- origin/main側には正しいopt-out実装が存在する
- worktreeからSupabase CLIを使う場合、worktree内 `supabase/config.toml` が無いと親の共有checkoutをproject rootとして誤認する事故が発生した。今回のdeployでは必ずdeploy rootと実ファイルを事前・事後に検証すること

## Model

本番Push、ユーザーopt-out、安全なdeploy復旧、Cron自然実行の検証をまたぐため **Opus 5を使用する**。Sonnet系へ落とさない。

## Required startup checks

1. `PROJECT_RULES.md`
2. `.agent/ORCHESTRATION.md`
3. `.agent/CURRENT_STATE.md`
4. このTASK
5. `origin/main` fresh-check
6. shared checkout / clean worktreeの状態確認
7. `.agent/tasks/CODEX_TASK.md` / `.agent/tasks/CODEX_TASK_2.md` / `.agent/tasks/CLAUDE_TASK.md` をread-only確認し、`send-push-notifications/**`、同じCron、同じproduction設定を他slotが変更していないことを確認
8. 本番 `send-push-notifications` のversion / verify_jwt / deployed sourceをdownloadして現状を確定
9. origin/mainの `send-push-notifications` と本番sourceを比較し、差分をReportする
10. deployに使うworktree内の `supabase/config.toml` / project link / root解決を確認し、共有checkoutを誤って参照しないことを実証

競合があれば開始せず具体的に報告する。
既存未コミット変更は他workstream所有として扱い、変更・stage・commitしない。

## Goal

本番 `send-push-notifications` をorigin/mainの正しい最新版へ復旧し、以下を満たす。

- `alert_settings.push_enabled=false` ならPushを送らず `skipped`
- `source_type='important_news'` で `alert_settings.important_news=false` ならPushを送らず `skipped`
- 設定がONなら従来どおりPush送信可能
- dispatcher Cronは毎分正常稼働
- 他Function / Cron / secrets / producerには影響しない
- deploy後の本番sourceが期待するorigin/mainとバイト一致する

## Phase 1: Audit only

実装・deploy前に以下を確認する。

- origin/mainの `send-push-notifications/index.ts` / `push_send_logic.ts` の現行設計
- `AlertSettings` と `shouldSendNotification()` の条件
- settings行が無いユーザーのdefault動作
- `push_enabled=false` / `important_news=false` の状態遷移
- pending / sent / failed / skipped の既存意味
- device token無し時の動作
- DeviceNotRegistered処理
- batch / Expo ticket / receipt処理
- dispatcher Cron認証方式 `X-Cron-Secret`
- 本番 `SEND_PUSH_NOTIFICATIONS_CRON_SECRET` は変更・rotateしない

今回の目的は**正しい版への復旧**。不要なロジック改修はしない。

## Phase 2: Tests before deploy

最低限:
- `push_enabled=false` -> skip
- important_news=false + source_type=important_news -> skip
- important_news=false + unrelated source_type -> 既存仕様どおり
- settingsなし -> 既存defaultどおり
- enabled -> send対象
- existing regression tests
- `git diff --check`
- secret leakage check

origin/mainに正しい実装が既にありコード変更不要なら、無理に変更commitを作らない。

## Phase 3: Production restore

安全確認PASS後、**`send-push-notifications` だけ**本番deployしてよい。

必須:
- deploy直前に `pwd` / git HEAD / origin/main / 対象ファイル一致を確認
- worktree内 `supabase/config.toml` がrootを固定していることを確認
- `--no-verify-jwt` を付けるか、configで明示的にfalseと確認する。最終的に本番 `verify_jwt=false` を維持
- 他Functionはdeployしない
- Cron変更なし
- secret変更なし
- migration/RPC変更なし

### Post-deploy source verification

必ず `functions download` 等で本番sourceを取得し、期待するorigin/mainの `send-push-notifications` sourceと**全ファイルのバイト一致**を確認する。
一致しなければ成功扱いにせず停止して報告する。

## Phase 4: Production opt-out proof

本人ユーザー・本人端末だけで安全に検証できる場合に限り、本番でopt-outを実証してよい。

推奨順序:
1. 実行直前に他ユーザーpending=0、本人端末のみであることを確認
2. 現在の `alert_settings` を保存
3. `push_enabled=false` に一時変更
4. 本人用の明確なテストnotificationを1件だけpendingで作る
5. Functionを手動invokeせず、毎分Cronが自然に拾って `skipped` にすることを確認
6. 実機にPushが届いていないことを確認
7. 次に必要なら `push_enabled=true` / `important_news=false` で `source_type=important_news` の1件を同様に確認
8. 最後に元の `alert_settings` へ完全に戻す
9. 今回作成したnotification行だけ削除

テスト中に他ユーザーpendingや対象不明があれば、本番書き込みテストは中止しread-onlyで止める。
設定変更は本人の `alert_settings` のテスト対象項目だけ。その他設定を変えない。

## Report correction

前タスク `push-dispatcher-cron-enable-20260910` Reportに、本番dispatcherがopt-outを実装していると誤って記載された点について、今回のReportで明示的に訂正する。
過去Report本文の履歴を破壊的に書き換える必要はないが、「当時の本番は古いdeploy版でopt-out未実装だった。今回復旧した」と正本に残す。

## Forbidden

- `important-news-monitor`変更/deploy
- `x-test-post`変更/deploy
- stocks sync変更/deploy
- dispatcher Cron変更
- secrets rotate/revoke/value表示
- Apple/EAS/APNs変更
- producer変更
- Push本文品質改善
- `/news` RPC修正
- 認証強化タスクの同時実施
- unrelated migration
- 他ユーザーへのPush

## Completion

終了時:
- status: `review_required`
- next_owner: `chatgpt`
- このTASK末尾に `## Report` を追記
- `.agent/ORCHESTRATION.md` 規定どおり同期

Report必須:
- task_id
- result
- model_used
- production_before
- origin_main_expected_source
- deploy_root_verification
- tests
- deploy/version/verify_jwt
- post_deploy_byte_match
- other_functions_unchanged
- cron_health
- opt_out_proof
- settings_restore_proof
- cleanup
- previous_report_correction
- changed_files / commit_hash（変更が無ければその旨）
- push
- remaining_issues
- safety_checks
- next_recommendation

## Report

- task_id: send-push-notifications-production-restore-20260910
- result: **完了**。本番 `send-push-notifications` を origin/main 版へ復旧し（v3 → **v4**）、本番ソースが `566958f` と全ファイルでバイト一致することを確認した。`push_enabled=false` と `important_news=false` の両方で、毎分Cronが手動invokeなしに通知を `skipped` にし、Expoへの送信0件・実機着信なしを本番で実証した。検証後は `alert_settings` を元の「行なし」に戻し、テスト通知だけを削除した。コード変更は無し。
- model_used: Opus 5

### production_before

- `send-push-notifications` v3 / ACTIVE / `verify_jwt=false` / updated 2026-09-10 07:28:54 UTC
- `functions download` で取得した本番ソースは origin/main と2ファイルとも**不一致**だった。
  - `push_send_logic.ts`: `AlertSettings` 型、`DEFAULT_ALERT_SETTINGS`、`shouldSendNotification()` が**存在しない**。
  - `index.ts`: `fetchAlertSettingsForUsers()` と、opt-outユーザーの通知を `skipped` へ振り分ける処理が**存在しない**。全pendingがそのままExpo送信経路に入る。レスポンスに `settingsSkippedCount` も無い。
- 差分はこのopt-out機能に限られ、それ以外のロジック（ticket分類、DeviceNotRegistered処理、batch、X-Cron-Secret認証）は同一。
- 原因は前タスクで確定した事故と同じ。worktreeに `supabase/config.toml` が無かったため、Supabase CLIが親の共有checkoutをproject rootと判定し、共有checkoutの古い作業ツリーをdeployしていた。

### origin_main_expected_source

- deploy元: worktree HEAD = origin/main = `566958f992f62684d76c9979f0e6d13c616c2bb3`
- `send-push-notifications/` の最終変更commitは `7742bff`（Enforce alert_settings in send-push-notifications before delivery）。作業ツリーはHEADと一致（未コミット変更なし）。
- 設計の監査結果:
  - 設定行が無いユーザーは `push_enabled=true` / `important_news=true` 扱い（テーブルのcolumn defaultと同じ。既存ユーザーを黙って遮断しない）。
  - `push_enabled=false` なら source_type に関係なく送らない。`important_news=false` は `source_type='important_news'` だけを止め、他の source_type には影響しない。
  - opt-outされた通知は、既存の終端状態 `skipped`（「端末なし」と同じ）になる。スキーマ変更や新しいstatus値は不要。opt-outユーザーについては端末トークンの取得もExpo送信も行わない。
  - pending / sent / failed / skipped の意味、端末なし時の `skipped`、DeviceNotRegistered時のトークン削除、90件ずつのbatch送信、X-Cron-Secret認証は、いずれも本番の旧版から変わらない。
  - `SEND_PUSH_NOTIFICATIONS_CRON_SECRET` は変更・rotateしていない。

### deploy_root_verification

- `pwd` = `/Users/yuya/Developer/kabumori/.claude/worktrees/ios-push-e2e`、HEAD `566958f`（ユーザーがdeploy実行時の出力で確認）
- worktreeに `supabase/config.toml` が存在し、project rootをworktreeに固定している（`project_id = "wsmznyzcvmuitkglfeuj"`、`[functions.send-push-notifications] verify_jwt = false`）。link情報 `supabase/.temp/project-ref` も同じproject。
- root解決がworktreeに移っていることは、前タスクで config.toml 作成直後に `db query --linked` がlink情報不足で失敗した（＝共有checkoutのlinkを見なくなった）ことで実証済み。
- deployは `--no-verify-jwt` 付き、対象は `send-push-notifications` のみ（ユーザーが実行）。

### tests

- `push_send_logic_test.ts`（origin/main）: **17 passed / 0 failed**
  - `push_enabled=false` → 送らない（source_type不問）
  - `important_news=false` + `source_type='important_news'` → 送らない
  - `important_news=false` + 無関係な source_type → 送る（既存仕様どおり）
  - 設定行なし → 全ON扱い
  - 全ON → 送る
  - あるユーザーの設定は他ユーザーの通知に影響しない
  - 既存の回帰（ticket分類、DeviceNotRegistered、status判定、chunk、tap遷移用のdata）
- コード変更なしのため、`git diff --check` の対象差分なし。秘密情報の漏洩なし（secret値は扱っていない）

### deploy/version/verify_jwt

- `send-push-notifications`: v3 → **v4** / ACTIVE / **`verify_jwt=false` 維持** / updated 2026-09-10 10:07:17 UTC

### post_deploy_byte_match

`functions download` で v4 を取得し、`566958f` と比較:
- `index.ts`: **BYTE-IDENTICAL**
- `push_send_logic.ts`: **BYTE-IDENTICAL**
- `push_send_logic_test.ts` は依存グラフ外なので、downloadに含まれないのが正常
- 本番コードに `export function shouldSendNotification` と `fetchAlertSettingsForUsers` が存在することを確認

### other_functions_unchanged

| function | 今回deploy前 | 今回deploy後 |
|---|---|---|
| important-news-monitor | v37 / 08:43:55 | v37 / 08:43:55（不変） |
| stocks-master-sync | v6 / 09-04 05:15:26 | 不変 |
| stocks-new-listing-sync | v5 / 09-04 05:15:26 | 不変 |
| x-test-post | v93 / 05:53:09（起動時チェック時点） | **v94 / 10:04:06** |

**`x-test-post` は今回のタスク外で v94 に更新されている**。更新時刻（10:04:06 UTC）は今回のdeploy（10:07:17 UTC）の約3分前で、今回deployしたのは `send-push-notifications` だけ。出所は、同期時に origin/main へ入った `f66e1cd`（Record x-test-post v94 deployment）で確認できた。**Codex slot 2 が、clean worktreeの `4e66d49`（close report修正）から `x-test-post` のみを `--no-verify-jwt` 付きでdeployしたもの**で、今回の作業とは独立している。v94 の本番ソースが `4e66d49` とバイト一致するかは、今回のスコープ外のため検証していない。

### cron_health

- `send-push-notifications-dispatch`（毎分）: deploy直後の 10:07:15 以降、全tickがHTTP 200。pendingが無いtickは `{"status":"completed","processedCount":0}`
- `important-news-publish-ready`（5分毎、前タスクから継続して監視）: 10:10 UTC まで全tickがHTTP 200 / `NO_READY_CANDIDATE`。誤投稿の再発なし、`publishing` 0件
- Cronの定義は変更していない

### opt_out_proof

実行直前の確認: profiles 1 / Pushトークン1件（所有者は本人）/ `notifications` の pending 0件（全体0行）/ `alert_settings` 0行。各テストのSQLは、この前提が崩れていれば例外で中止するガード付きで実行した。

**テスト1: `push_enabled=false`**
- 10:09:31 UTC: 本人の `alert_settings` 行を `push_enabled=false, important_news=true` で作成し、テスト通知1件（`source_id=optout-test-push-disabled-20260910`、`source_type=important_news`、title「【opt-outテスト1】届いたら失敗です」）を `pending` で作成
- **10:10:00 UTC の毎分Cronが自然に処理**（手動invokeなし）: `{"status":"completed","processedCount":1,"settingsSkippedCount":1,"messagesSent":0,"deactivatedTokenCount":0}` → 行は **`skipped`**

**テスト2: `push_enabled=true` + `important_news=false`**
- 10:10:32 UTC: 設定を `push_enabled=true, important_news=false` に変更し、テスト通知1件（`source_id=optout-test-important-news-disabled-20260910`、`source_type=important_news`、title「【opt-outテスト2】届いたら失敗です」）を `pending` で作成
- **10:11:00 UTC の毎分Cronが自然に処理**: `{"status":"completed","processedCount":1,"settingsSkippedCount":1,"messagesSent":0,"deactivatedTokenCount":0}` → 行は **`skipped`**

**実機**: テスト時間帯（10:09〜10:12 UTC = 19:09〜19:12 JST）に、iPhoneへテスト通知は**届かなかった**（ユーザー確認済み）。どちらのテストも `messagesSent:0` で、Expoへの送信自体が発生していない。

「設定がONなら従来どおり送信できる」ことは、前タスクの手動enqueue（設定行なし＝全ON）で実機着信まで確認済み。今回はONの状態で再送信するテストは行っていない。

### settings_restore_proof

- 元の状態: 本人の `alert_settings` は**行なし**（デフォルトで全ON）
- 復元: テストで作った設定行を削除（1件）
- 復元後の確認: `alert_settings` 0行、`notifications` 0行、pending 0件、profiles 1、トークン1件（本人所有）

### cleanup

- テスト通知2件だけを `source_id` 指定で削除（`test_notifications_deleted: 2`）
- 設定行1件を削除（元の「行なし」へ）
- `notifications` / `alert_settings` にテストの残骸なし

### previous_report_correction

**前タスク `push-dispatcher-cron-enable-20260910` のReportの訂正**: 同Reportは、本番dispatcherが `alert_settings` のopt-out（`push_enabled` / `important_news`）を送信時に判定すると記載していたが、**誤りだった**。当時の本番 `send-push-notifications`（v3）は、deploy元の取り違えにより古い共有checkout版がdeployされており、**opt-outは実装されていなかった**。同Reportの監査はリポジトリのコード（origin/main）を読んだもので、本番にdeployされたコードを確認していなかった。**今回 v4 で origin/main 版へ復旧し、本番でopt-outが効くことを実証した**（上記 opt_out_proof）。

なお、v3 の稼働期間（2026-09-10 07:28〜10:07 UTC）に、opt-outしていたユーザーへ送信された通知は無い。本番のユーザーは1名で、`alert_settings` は0行（＝全ON）だったため、実害は発生していない。

### changed_files / commit_hash

- コード変更なし（origin/main に正しい実装が既に存在したため、変更commitは作っていない）
- `.agent/tasks/CLAUDE_TASK_1.md`（status / Report）のみ。commitはこの直後

### push

- `origin/main` へ同期済み

### remaining_issues

1. **`x-test-post` v94 の本番ソースは未照合**（上記 other_functions_unchanged）。Codex slot 2 の記録では clean worktree の `4e66d49` からdeployされているが、今回の2件の事故は「deploy元の記録は正しいのに、CLIが別のrootを解決していた」ことが原因だった。記録だけでは不十分なので、`functions download` によるバイト照合で確定することを推奨。
2. **`supabase/config.toml` がリポジトリ管理外**。今回の2件の事故の直接原因。現在はこのworktreeにだけローカル作成されている。他のworktreeや今後の作業で再発しうるので、リポジトリで管理するかを判断すべき。
3. 自然publishを起点にしたPush E2E（前タスク③）は未観測のまま（前タスクから継続）。
4. Push本文がTDnetの生テキストで読みにくい（前タスクから継続）。
5. `get_my_important_stock_news` が `published` を含まない（前タスクから継続）。
6. `important-news-monitor` / `x-test-post` の認証不足（前タスクから継続）。
7. dispatcherに原子的claimが無い（前タスクから継続）。

### safety_checks

- deployしたのは `send-push-notifications` だけ。deployの前後で、pwd・HEAD・対象ファイル・本番ソースのバイト一致を確認した
- `verify_jwt=false` を維持した
- Cron・secret・migration・RPC・producer・他Functionは変更していない
- テストの書き込みは、本人の `alert_settings`（テスト対象の2項目）と、本人向けの明示的なテスト通知2件だけ。どちらも元に戻した
- テスト中、他ユーザーのpendingは0件。対象外への送信も0件
- 共有checkoutの未コミット変更には触れていない（読み取りも今回は不要だった）
- Expo Push Tokenやsecretの値は、Reportやリポジトリに残していない

### next_recommendation

1. `x-test-post` v94 の本番ソースを `4e66d49` とバイト照合する（remaining_issues 1。C2レビューの一環で行うのが自然）
2. `supabase/config.toml` をリポジトリで管理するかを決める（remaining_issues 2）
3. 残りの既知課題（Push本文の品質 / `/news` RPC / 認証 / 自然E2E観測）を、それぞれ単独タスクとして順に進める
