# Claude Task 1

- task_id: broad-news-phase3-production-rollout-20260913
- owner: claude
- slot: claude-1
- status: in_progress
- next_owner: claude
- priority: urgent
- recommended_model: Opus 5
- purpose: C1承認済みのPhase 3（medium以上のアプリ表示、カテゴリ/重要度表示、通知プリセット、emergency/category設定）を安全に本番反映し、アプリ実画面と自然Cron/Push経路を確認する。

## Approved source

Codex H1 `broad-news-display-and-notification-presets-phase3-20260913` はC1 PASS済み。

承認済み実装commit:
- `f7c17b915c551ba81b1dfc62a0731fd3eba6f008`

承認済み内容:
- market-wide medium以上をアプリ表示
- emergency / critical / high / medium の表示
- 16カテゴリ日本語ラベル
- 通知preset: quiet / standard / many / all_useful
- `emergency_alerts`
- 行形式 `alert_category_settings`
- market emergencyはtracked stock / sector一致不要
- 未分類カテゴリは「設定なし＝有効」
- emergency notificationの `tracked_stock_id` はNULL
- dispatcher / claim RPCは変更なし
- 既存ユーザーはmigration適用だけでは通知量を増やさない

C1確認済みテスト:
- important-news runtime 395/395
- Push/レポート回帰 48/48
- app presentation 27/27
- changed app TypeScript PASS
- iOS Expo export PASS
- git diff --check PASS

## Goal

本番反映と実利用確認を完了する。

順序:
1. origin/main fresh-check + 他slot競合確認
2. exact migrationの本番適用前proof
3. exact migrationのみ本番適用
4. schema / ACL / RLS / RPC / legacy互換のread-back
5. `important-news-monitor` のみdeploy
6. deploy後runtime source read-back / byte compare
7. 他Function / Cron / dispatcher / claim RPC不変確認
8. iOS SimulatorまたはDevelopment Buildでニュース一覧・detail・設定UI確認
9. 自然Cronでcandidate/app copy/enqueueが動くことをread-only観測
10. synthetic/manual Pushなしで、自然通知が発生すれば到達を確認。発生しなければ未観測と明記

## Production authorization

ユーザー承認 + C1 PASSにより、今回許可する本番変更は以下のみ。

### DB
`supabase/migrations/20260913140000_broad_news_visibility_notification_presets.sql`
を単体で適用してよい。

必須:
- `supabase db push` 禁止
- migration history repair/reconcile禁止
- unrelated migration禁止
- destructive変更禁止
- 適用前にrollback-contained proof
- 適用後read-back

### Edge Function
read-backが成功した場合のみ `important-news-monitor` をdeployしてよい。

必須:
- deploy対象は `important-news-monitor` のみ
- production current version/sourceを事前記録
- deploy後sourceをdownload/read-backしてrepo sourceと比較
- 他Edge Function version / updated_at不変確認
- verify_jwt等の既存設定を意図せず変更しない

## Do not touch

G2は別workstreamで進行中。以下を触らない:
- `x-oauth-connect`
- OAuth / Vault / social_accounts
- X token / callback
- AI Lab routing / dry-run

H2 Push hardening境界:
- `send-push-notifications` のclaim/retry/CAS
- `claim_pending_push_notifications`
- notifications claim schema/RPC

その他禁止:
- Cron変更
- X投稿
- synthetic candidate
- manual/synthetic Push
- unrelated user setting変更
- migration history修復
- secrets/token出力

## Required production read-back

最低限確認:
- `alert_settings.notification_preset`
- `alert_settings.emergency_alerts`
- 既存alert_settings行がmigrationだけで勝手にpreset/emergencyへ書き換わっていない
- `alert_category_settings` RLS / grants
- `set_my_important_news_alert_preferences(...)`
- app feed RPCがmedium以上 + emergency無関連許可
- unified producer RPCのservice-role boundary
- NULL tracked_stock_id market notification dedupe index
- `market_critical_news` legacy compatibility
- morning_report / close_report設定不変

## App verification

可能ならSimulator/Development Buildで最低限:
- ニュース一覧が開く
- medium表示条件が反映される
- severity日本語ラベル
- category日本語ラベル
- detail表示
- 4段階preset UI
- emergency toggle
- category ON/OFF
- 保存→再読込一致
- 既存ユーザー初期表示が突然「多め」相当にならない

実ユーザー設定を書き換える必要がある場合は、既存値を記録し最小範囲で確認後、ユーザーが明示的に選んだ値以外へ勝手に変更しない。実設定変更なしでUI確認可能ならそれを優先。

## Natural observation

本番反映後はmanual runをせず、自然Cronをread-only観測する。

確認:
- candidate取得が継続
- coverage severity/categoryが保持
- app copy生成が継続
- producerエラーなし
- duplicate enqueueなし
- dispatcher pending滞留なし
- Pushが自然発生した場合のみdelivery確認

自然ニュースが無ければ「未観測」としてよい。人工ニュース投入は禁止。

## Completion

完了時:
- status: `review_required`
- next_owner: chatgpt
- origin/mainへ安全に同期

Report必須:
- task_id
- result
- model_used
- source_base
- migration_proof
- migration_apply
- schema_readback
- function_before_after
- deploy
- runtime_byte_compare
- other_functions_unchanged
- app_verification
- natural_cron_observation
- natural_push_observation
- settings_compatibility
- tests/rechecks
- production_changes
- changed_files
- commit_hash
- push
- remaining_issues
- safety_checks
- next_recommendation
