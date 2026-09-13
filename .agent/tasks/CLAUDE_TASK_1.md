# Claude Task 1

- task_id: broad-news-phase4-natural-push-observation-20260913
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Opus 5
- purpose: Phase 3本番反映後の自然ニュース経路をread-only中心で観測し、統合producerの実enqueue、Push到達、重複0、滞留0、coverage分類とアプリカテゴリ表示までを実データで確認する。新規実装や本番変更は原則行わない。

## Approved prior state

Phase 3 `broad-news-phase3-production-rollout-20260913` はK1 PASS。

確認済み:
- `20260913140000_broad_news_visibility_notification_presets.sql` は対象1本だけ本番適用済み。
- `important-news-monitor` v50 が本番稼働中。
- runtime source byte compare PASS。
- 他Function / Cron / dispatcher / claim RPCは不変。
- appのmedium表示、severity/category日本語表示、4段階preset、emergency/category設定は実画面確認済み。
- Phase 3自然観測でmarket mediumのapp copy生成5件を確認。
- Phase 2 coverage分類も自然実データ1件で書き込み確認済み。
- 自然Pushはまだ未観測。
- 現在ユーザー設定は本人操作により `notification_preset='all_useful'`, `emergency_alerts=true`, 16カテゴリすべてenabled=true。
- pending通知滞留0、重複enqueue 0。
- migration履歴乖離は継続中。`supabase db push` 禁止。

## Goal

自然ニュースだけで、以下を確認する。

1. 新規candidateが通常Cronで取得される。
2. `coverage_severity` / `coverage_categories` / `emergency_class` が妥当に付く。
3. medium以上のmarket/companyニュースがapp copy対象になり、Fact-passed日本語copyが生成される。
4. 現在の `all_useful` 設定に合致するニュースで統合producerがnotificationsへ実enqueueする。
5. 同一event/userへ重複enqueueしない。
6. dispatcherが自然にclaim/sendし、pending/processingが滞留しない。
7. iOS Pushが自然発生した場合、ユーザー端末到達を確認できる。
8. アプリ一覧/detailで新規記事のseverity/categoryラベルが表示される。
9. 通知量が体感として多すぎないかを件数ベースで評価する。

## Observation window

まず現在時点から次の平日ニュースが十分流れるまで観測する。

- 2026-09-14 JST以降の自然Cronを優先。
- 少なくとも東京市場の朝〜大引け、可能なら米国市場前後まで観測。
- ただし自然Pushが早期に1件以上発生し、enqueue→send→到達→重複0まで証明できれば、その時点でreview_requiredへ進めてよい。
- 自然ニュースが乏しくPush未発生なら、人工candidateや手動Pushで埋めず「未観測」と報告する。

## Required startup / parallel safety

開始前に必ず読む:
- `.agent/ORCHESTRATION.md`
- `.agent/CURRENT_STATE.md`
- this TASK
- `.agent/tasks/CLAUDE_TASK.md`
- `.agent/tasks/CODEX_TASK.md`
- `.agent/tasks/CODEX_TASK_2.md`
- 前Phase 3 Report
- origin/main fresh-check

G2はX複垢Phase 3Fで進行中。以下は触らない:
- `x-oauth-connect`
- OAuth / Vault / social_accounts
- AI Lab routing / dry-run
- X token / callback

H2 Push hardening境界も変更しない:
- `send-push-notifications` source
- `claim_pending_push_notifications`
- notifications claim schema/RPC

このG1は原則read-only観測。競合するコード変更は行わない。

## Required read-only checks

### A. Candidate / classification

新規candidateについて最低限:
- created_at / published_at
- source_type / source_name
- company_codeの有無
- status / importance
- `coverage_severity`
- `coverage_categories`
- `emergency_class`
- `fact_check_status`
- app copy fact status

明らかな誤分類があれば、修正せず具体例と影響をReportする。

### B. App copy

- medium以上で必要なapp copy生成が走ること。
- `app_copy_fact_status='passed'` を確認。
- 低重要度lowが一覧へ混ざらないこと。
- 古い記事のcategory空欄は既知事項として分離。

### C. Unified producer

自然ニュースで `enqueue_important_news_notifications` が実際に正のenqueueを起こした場合:
- candidate/news id
- user単位のenqueue件数
- source_type/source_id
- tracked_stock_idがcompanyでは適切、market emergencyではNULL
- preset/category/emergency条件との整合
- duplicate rowなし

producerエラーがあればエラー内容をsecretなしで記録。

### D. Dispatcher / delivery

新規notificationができた場合:
- queued/pending → processing → sent の自然遷移
- attempt_count / retry_after / claim token周辺に異常なし
- 同じsource/userの二重送信なし
- pending/processing滞留なし
- Expo/APNs delivery errorなし

`send-push-notifications` やclaim RPCを変更しない。

### E. User-visible Push

自然Pushが発生したらユーザーへ確認を求めてよい。

確認すること:
- iPhoneへ届いたか
- タップで該当ニュースdetailへ遷移できたか
- 文面が過剰/不自然でないか

ユーザー確認が必要な時点で、何を見てほしいか短く明確に伝える。

### F. Volume review

観測期間の自然データで:
- candidate総数
- severity別件数
- app表示対象件数
- Push eligibility件数
- 実enqueue件数
- 実sent件数
を集計。

現在は `all_useful` なので、通知が多すぎる場合は勝手に設定変更せず、`many` / `standard` への変更案をReportする。

## Prohibited

- synthetic candidate
- manual/synthetic Push
- manual invokeで通知を作ること
- user alert settingsの勝手な変更
- Cron変更
- X投稿
- Edge Function deploy
- DB migration/RPC/schema変更
- `supabase db push`
- migration history repair/reconcile
- OAuth/Vault/token変更
- secret/tokenの表示

## Completion

完了時:
- status: `review_required`
- next_owner: `chatgpt`
- origin/mainへ制御情報のみ安全に同期

Report必須:
- task_id
- result
- model_used
- observation_window
- candidate_counts
- classification_examples
- app_copy_observation
- unified_producer_positive_observation
- notification_rows
- duplicate_check
- dispatcher_delivery_observation
- user_push_confirmation
- app_detail_confirmation
- volume_assessment
- production_changes (expected: 0)
- changed_files (expected: task report only)
- push
- remaining_issues
- safety_checks
- next_recommendation

本タスクは観測タスク。問題が見つかっても勝手に修正せず、次タスク候補として切り出す。