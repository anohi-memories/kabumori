# Claude Task 1

- task_id: broad-market-news-collection-and-user-notification-control-20260912
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
- priority: urgent
- recommended_model: Opus 5
- purpose: かぶモリのニュース監視を「収集段階ではChatGPTの1時間監視に近い広さで拾い、通知するかどうかはユーザー設定で決める」設計へ見直す。北朝鮮ミサイル発射やホルムズ海峡周辺の攻撃のような、日本市場へ影響し得る重大事象を収集段階で落とさない。

## Product direction

現在の問題は「通知が多くならないように、収集段階でニュースを絞りすぎている」こと。

今後は以下を分離する。

1. **Collection**: 国内外の市場関連ニュースを広く収集する。
2. **Classification**: 重要度・カテゴリ・市場影響・銘柄関連度を付与する。
3. **Notification policy**: ユーザー設定に応じてPushする/しないを決める。

重要原則:
- 「保有/監視銘柄と直接関係が薄い」ことを理由に、地政学・災害・金融政策などの重大ニュースを収集時点で捨てない。
- 通知がうるさいかどうかはユーザーが決める。
- ユーザーが望むなら、かなり多めに通知できる設計にする。

## Concrete missed-event audit

最低限、以下2件がどこで落ちたかを追跡する。

1. 2026-09-12 北朝鮮のミサイル/飛翔体発射
2. ホルムズ海峡周辺の攻撃・タンカー/航路リスク拡大

確認する段階:
- source discovery / query
- fetch
- candidate insert
- dedupe
- severity classification
- category classification
- market-wide判定
- tracked-stock / sector relevance filter
- Fact gate
- app/news storage
- notification enqueue

「仕様通り落ちた」で終わらず、プロダクト要件に照らして取りこぼし原因として整理する。

## Required audit

以下をread-onlyで監査する。

- `important-news-monitor`
- `market-intelligence-ingest`
- `important_news_candidates`
- `market_events` / `market_metrics` / `mic_*` 系
- 現在のニュースsource/query/category/severityロジック
- market criticalのsector relevance条件
- notifications producer条件
- alert_settingsの現行構造
- Cron頻度と収集タイミング

`market-intelligence-ingest` は最近本番に存在することが確認されているが、今回の監査開始時点では出所を推測しない。git history / TASK / migration / Edge Function sourceをread-onlyで確認して位置づけを特定する。

## Target collection scope

少なくとも以下を収集対象として扱える設計を作る。

- 日本株/国内企業
- 米国株/主要指数
- 為替
- 金利/国債
- 原油・天然ガス・主要コモディティ
- 半導体/AI/大型テック
- 中央銀行/金融政策
- 政府・規制・関税
- 地政学/戦争/軍事衝突
- 北朝鮮/台湾海峡/中東など日本市場に波及しやすい安全保障
- 災害/地震/津波/大規模停電・インフラ障害
- 海運/ホルムズ海峡/スエズ等の物流チョークポイント
- 金融システム/銀行・取引所障害
- 主要企業の決算/下方修正/上方修正/大型M&A

収集は広く、保存後に重要度・カテゴリ・関連度を付ける。

## Classification design

重要度は最低限:
- emergency
- critical
- high
- medium
- low

カテゴリは最低限:
- geopolitics
- disaster
- monetary_policy
- fx
- rates
- oil_energy
- commodities
- shipping_logistics
- semiconductors
- ai_tech
- us_market
- japan_market
- regulation_policy
- corporate
- earnings
- financial_system

必要なら複数カテゴリを持てる設計を提案する。

### Emergency concept

`emergency` は保有/監視セクター一致を必須にしない。

例:
- 日本周辺のミサイル/Jアラート級
- 戦争の急拡大
- ホルムズ海峡の封鎖/大規模攻撃
- 台湾有事級
- 大規模地震/津波
- 主要中央銀行の緊急政策
- 金融市場インフラの重大障害
- 原油供給の大規模途絶

ただし誤報防止のFact/source gateは維持する。

## User notification model

収集範囲と通知範囲を分離する。

通知プリセット案を設計する。

### 静かめ
- 保有/監視銘柄 critical 以上
- market emergency

### 標準
- 保有/監視銘柄 high 以上
- market critical 以上

### 多め
- 保有/監視銘柄 medium 以上
- market high 以上

### 全部通知
- 保存された有用ニュースをかなり広く通知
- lowまで含めるかはノイズ量を見て提案

さらにカテゴリ別ON/OFFを将来追加できるschemaを検討する。

例:
- 地政学
- 災害
- 為替
- 金利
- 原油/エネルギー
- 半導体
- 米国市場
- 国内企業
- 決算

## UX principle

ユーザーが「通知多め」を選べることを重視する。

アプリが勝手に「うるさいだろう」と判断して収集自体を止めない。

通知しないニュースでも、必要ならアプリのニュース一覧には残せる構造を優先する。

## Phase 1 scope

今回は **監査 + 正式設計 + 必要最小限のローカル実装案** まで。

優先順:
1. 現行パイプラインの完全監査
2. 北朝鮮/ホルムズのdrop point特定
3. collectionとnotificationの分離設計
4. severity/category schema設計
5. user notification preset設計
6. 既存重要ニュースPushとの互換性確認
7. 最小変更案と段階的 rollout plan

コード変更が安全に分離でき、production変更なしでローカル実装・テストまで可能なら進めてよい。
ただし大きなschema変更や本番deployはK1前に行わない。

## Parallel safety

現在:
- Claude slot 2はX複垢/OAuth作業中。
- Codex slot 2のPush dispatcher hardeningは本番反映済みで自然観測待ち。

このG1では以下を触らない:
- `x-oauth-connect`
- OAuth / Vault / social_accounts
- X token
- multibrand OAuth callback
- `send-push-notifications` のclaim/retry実装
- notifications claim RPC

もしニュース拡張のために上記と同じファイル/RPCを変更する必要が出たら、開始せず競合として報告する。

## Production safety

K1前は禁止:
- production DB migration/RPC変更
- Edge Function production deploy
- Cron変更
- synthetic production candidate/notification
- manual Push
- OpenAI/X APIの人工実行
- user alert_settings変更
- `supabase db push`

read-only production investigationは可。

## Migration safety

migration historyは既知の乖離がある。

- `supabase db push` 禁止
- migration history repair/reconcileは別タスク
- schema変更案はexpand-onlyを基本とする
- migration versionを勝手に修復しない

## Tests / proof expected

設計またはローカル実装を行う場合、最低限以下を確認する。

- market-wide emergencyがtracked-stock/sector一致なしでも保存対象になる
- 通常のcompany newsは既存dedupeを維持
- severity mapping deterministic cases
- category mapping deterministic cases
- user presetごとのnotification eligibility
- push_enabled=falseは最終的に通知0
- preset/category OFFで通知0
- collection自体はnotification OFFでも保存可能
- same event cross-source dedupe方針
- Fact未通過はPushしない
- existing important-news regression
- `deno check`
- `git diff --check`

## Deliverable

`CLAUDE_TASK_1.md` 末尾へ `## Report` を追記する。

Report必須:
- task_id
- result
- model_used
- current_collection_architecture
- north_korea_drop_point
- hormuz_drop_point
- market_intelligence_ingest_origin
- root_causes
- proposed_collection_scope
- proposed_severity_model
- proposed_category_model
- proposed_notification_presets
- schema_changes_proposed
- producer_changes_proposed
- app_settings_changes_proposed
- compatibility_with_existing_push
- parallel_conflicts
- tests
- production_changes
- changed_files
- commit_hash
- push
- remaining_issues
- next_recommendation

完了時:
- status: review_required
- next_owner: chatgpt
- origin/mainへ安全に同期
