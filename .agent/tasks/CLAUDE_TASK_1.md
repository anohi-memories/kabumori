# Claude Task 1

- task_id: send-push-notifications-production-restore-20260910
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
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
