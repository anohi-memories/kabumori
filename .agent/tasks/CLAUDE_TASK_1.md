# Claude Task 1

- task_id: broad-news-display-and-notification-presets-phase3-20260913
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
- priority: urgent
- recommended_model: Opus 5
- purpose: Phase 2で本番接続した広域ニュース収集をユーザー体験へつなげる。まずアプリのニュース表示範囲をmediumまで広げてカテゴリ/重要度を見える化し、その上でユーザーが通知量を選べるプリセット設計・実装を行う。収集ロジックとPush配信基盤の安全性は維持する。

## Context / approved previous phase

Phase 2 `broad-market-news-coverage-phase2-production-wiring-20260912` はK1承認済み。

確認済み:
- `important-news-monitor` v47 が本番稼働中。
- 北朝鮮/ミサイル/Jアラート、災害は固定検索で毎サイクル実行。
- ホルムズ/海運/原油/金融システム等は回転検索。
- 気象庁フィード稼働。
- `coverage_categories` / `coverage_severity` / `emergency_class` / `coverage_classified_at` が本番schemaへ追加済み。
- 直近の自然データで新分類が少なくとも1件実際に付与されたことをChatGPT側でread-only確認済み。
- 直近24hのPush 0件は端末や設定故障ではなく、現行通知条件がまだ狭いことが主因。
- Push設定は `push_enabled=true`, `important_news=true`, `market_critical_news=true`、iOS Push tokenも存在。

重要原則:
**collection / app visibility / push notification policy を分離する。**
収集範囲を広げたこと自体を理由に、勝手にPushを大量送信しない。

## Goal

### Phase 3A — app visibility

まずアプリで保存済みニュースを見えるようにする。

- 現在のmarket-wideニュース表示条件を監査する。
- `medium` 以上をアプリニュース一覧へ表示できるようにする。
- `low` は原則一覧対象外のまま。ただし将来切替可能な設計にしてよい。
- company/holding/watch関連ニュースの既存表示を壊さない。
- market-wide medium/high/critical/emergencyを表示対象にする。
- `emergency` は最上位表示。
- categoryを日本語ラベルで表示する。
  - geopolitics → 地政学
  - disaster → 災害
  - monetary_policy → 金融政策
  - fx → 為替
  - rates → 金利
  - oil_energy → 原油・エネルギー
  - commodities → コモディティ
  - shipping_logistics → 海運・物流
  - semiconductors → 半導体
  - ai_tech → AI・テック
  - us_market → 米国市場
  - japan_market → 日本市場
  - regulation_policy → 政策・規制
  - corporate → 企業
  - earnings → 決算
  - financial_system → 金融システム
- severityも日本語で視認可能にする。
  - emergency → 緊急
  - critical → 最重要
  - high → 重要
  - medium → 注目
- app detailでもカテゴリ/重要度を確認できるようにする。
- 既存Fact-passed日本語本文/内部detail routeを維持する。

## Phase 3B — notification presets

ユーザーが通知量を選べるようにする。

### Presets

最低限4段階:

1. `quiet` / 静かめ
   - holding/watch: critical以上
   - market-wide: emergencyのみ

2. `standard` / 標準
   - holding/watch: high以上
   - market-wide: critical以上

3. `many` / 多め
   - holding/watch: medium以上
   - market-wide: high以上

4. `all_useful` / かなり多め
   - holding/watch: medium以上
   - market-wide: medium以上
   - lowは当面Pushしない

既定値は既存ユーザーの体験を急変させないことを優先する。
既存 `important_news` / `market_critical_news` 設定との互換性を設計し、migrationで勝手に全員の通知量を増やさない。

### Emergency

- `emergency_alerts` 専用設定を設計する。
- market emergency はtracked stock / sector一致を不要にする。
- ただし以下は必須:
  - Fact passed
  - 日本語app copyが成立
  - freshness条件
  - dedupe
  - push_enabled
  - important_news master toggleとの関係を明示
- 既定ON案を使う場合も、既存ユーザーへの影響をReportで定量評価してから本番適用する。

### Categories

将来/今回可能ならカテゴリ別ON/OFF:
- 地政学
- 災害
- 為替
- 金利
- 原油・エネルギー
- 半導体
- 米国市場
- 日本市場
- 企業
- 決算

schemaは行形式の `alert_category_settings(user_id, category, enabled)` を優先。
カテゴリ追加でmigrationが不要な構造にする。

## Data/schema direction

Phase 1設計 `docs/news-coverage/REDESIGN.md` を再確認。

候補:
- `alert_settings.notification_preset text not null default 'standard'`
- `alert_settings.emergency_alerts boolean not null ...`
- `alert_category_settings(user_id, category, enabled)`

原則:
- expand-only
- RLS本人のみ
- service role producer
- authenticated app settings updateは必要列のみ
- migration history乖離があるため `supabase db push` 禁止

既存schema/RPCと重複するなら最小変更へ修正してよい。

## Producer / dispatcher boundary

重要:
- `send-push-notifications` のclaim/retry/CAS/Expo送信ロジックは変更しない。
- `claim_pending_push_notifications` RPCは変更しない。
- producer側でnotification eligibilityを決め、既存notifications queueへenqueueする。
- Push hardeningで入ったsource/settings recheckと矛盾しないこと。

もしdispatcherまたはclaim RPCを変更しないと実現できないと判明したら、勝手に変更せずSTOPしてReportする。

## Existing settings compatibility

現在の既存トグル:
- push_enabled
- important_news
- market_critical_news
- morning_report
- close_report

今回触るのは重要ニュース関連だけ。
朝刊・大引け設定は変更しない。

`market_critical_news` をどう扱うか:
- legacy互換用に残すか
- preset + emergency_alertsへ段階移行するか
を設計してReportする。

既存ユーザーが何も操作しなくても突然「多め」相当へならないこと。

## Required startup / parallel safety

開始前:
1. `.agent/ORCHESTRATION.md`
2. `.agent/CURRENT_STATE.md`
3. このTASK
4. `.agent/tasks/CLAUDE_TASK.md`
5. `.agent/tasks/CODEX_TASK.md`
6. `.agent/tasks/CODEX_TASK_2.md`
7. `docs/news-coverage/REDESIGN.md`
8. origin/main fresh-check
9. production schema/read-only current state

競合禁止:
- G2 OAuth / Vault / social_accounts / x-oauth-connect
- Push dispatcher claim/retry / notification claim RPC
- 他slotが同じ important-news producer/app news files/schemaを触っている場合

既存未コミット変更は触らない。

## Production safety

まずローカル実装・テストまで。

K1前は禁止:
- production migration/RPC変更
- Edge Function deploy
- user settings変更
- manual/synthetic Push
- synthetic candidate
- Cron変更
- X投稿
- migration history repair
- `supabase db push`

read-only production auditは可。

## Tests

最低限:

### App visibility
- emergency / critical / high / medium market-wideが表示対象
- low market-wideは非表示
- company news既存表示回帰なし
- category日本語ラベル
- severity日本語ラベル
- list/detail rendering
- Fact failed itemは表示/Push条件で安全側

### Presets
- quiet: company critical+, market emergency only
- standard: company high+, market critical+
- many: company medium+, market high+
- all_useful: company medium+, market medium+
- lowは全presetでPushしない
- push_enabled=false → 0
- important_news=false → 0
- emergency_alerts=false → market emergency 0
- category OFF → 該当category 0
- category設定が存在しない場合のdefault挙動を明示・テスト
- tracked/sector不一致でもmarket emergencyはpreset条件次第でeligible
- Fact fail → 0
- duplicate → 0
- existing important-news company producer regression
- existing market-critical regression
- personalized report Push regression
- dispatcher claim/retry testsは変更しないが既存suiteが壊れていないこと

### Static
- app tsc
- Deno check
- git diff --check

## Resource / UX review

Reportで最低限:
- 直近7日データに新presetを当てた場合、各presetで何件程度Push対象になる見込みかをread-onlyで試算する。
- emergency誤検出が多すぎないか。
- mediumをアプリ表示へ広げた場合、一覧件数が現実的か。

これはPush実送信ではなくread-only集計のみ。

## Completion

実装・テスト完了時:
- status: review_required
- next_owner: chatgpt
- origin/mainへ安全に同期

Report必須:
- task_id
- result
- model_used
- source_base
- current_app_visibility
- new_app_visibility
- category_labels
- severity_labels
- current_notification_logic
- proposed_or_implemented_presets
- legacy_settings_compatibility
- emergency_behavior
- category_setting_behavior
- schema_changes
- producer_changes
- dispatcher_changes (expected: none)
- 7day_notification_volume_estimate
- medium_feed_volume_estimate
- tests
- production_changes
- deploy_status
- changed_files
- commit_hash
- push
- remaining_issues
- next_recommendation

本番変更が0件なら明記する。
K1で承認するまでproduction migration/deployは行わない。