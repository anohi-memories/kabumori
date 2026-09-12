# Claude Task 1

- task_id: broad-market-news-coverage-phase2-production-wiring-20260912
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
- priority: urgent
- recommended_model: Opus 5
- purpose: Phase 1で特定したニュース収集の穴を埋め、北朝鮮ミサイル・ホルムズ海峡攻撃級を収集段階で落とさない広域ニュース収集と分類を、既存の重要ニュースパイプラインへ安全に接続する。Push量の拡張はまだ行わない。

## Prior phase / K1 approval

Phase 1 `broad-market-news-collection-and-user-notification-control-20260912` はK1承認済み。

確定事項:
- 北朝鮮ミサイルは severity/notification で落ちたのではなく、source discovery/query 段階で未検索だった。
- ホルムズ関連は一部候補化されており、事象によってはその後の分類・関連度・表示/通知条件で落ちる。
- 現行の制約は保存上限ではなく、取得元と検索トピックの不足。
- collection / classification / notification policy を分離する。
- `emergency / critical / high / medium / low` とカテゴリ分類の設計は `docs/news-coverage/REDESIGN.md` を正とする。
- Phase 1で追加した `news_coverage_logic.ts` / `news_collection_scope_proposal.ts` は未接続実装。既存本番挙動は変更していない。
- Phase 1 tests: 157 pass / 0 failed、deno check PASS、git diff --check PASS。

## Goal for Phase 2

まず「広く拾える」状態を作る。

このPhaseでは、通知量を増やすことより先に、以下を達成する。

1. 北朝鮮・ミサイル・Jアラート級を候補化できる。
2. ホルムズ・中東・海運・原油供給途絶を安定して候補化できる。
3. 災害・金融政策・主要市場インフラ障害なども広域収集対象へ入る。
4. 保存時に severity / category / market-wide / relevance を付けられる。
5. `emergency` は保有銘柄・監視銘柄・sector一致がなくても保存される。
6. 既存のTDnet/企業IR/個別重要ニュース経路を壊さない。
7. Push eligibilityは現行のまま維持し、今回の収集拡張だけで通知量を急増させない。

## Required implementation

### A. Breaking-market query coverage

既存 `important-news-monitor` の breaking_market 検索を拡張する。

最低限、以下を明示的な検索対象に含める。
- North Korea / 北朝鮮 / missile / ballistic missile / projectile / J-Alert / EEZ
- Hormuz / Strait of Hormuz / tanker attack / shipping attack / blockade / maritime security
- Iran / Israel / Middle East escalation / Gulf shipping
- oil supply disruption / crude spike / energy supply
- Taiwan Strait / military escalation
- major earthquake / tsunami / disaster / major infrastructure outage
- emergency central-bank action / emergency rate move
- exchange outage / clearing / financial-system disruption

既存4トピックを無制限に増やして検索コストを暴騰させないこと。
Phase 1設計に沿って固定/回転トピックを再設計し、各重要カテゴリの最大未監視頻度を明示する。

### B. Primary / authoritative sources

実装可能な範囲で一次情報源を追加する。

優先候補:
- 防衛省 / 統合幕僚監部
- 首相官邸 / 内閣官房の緊急情報
- 気象庁（地震・津波等）
- 日本銀行
- FRB
- EIA
- UN等、既存の信頼できる一次情報

HTML/RSS/APIの安定性・利用条件・取得コストを確認し、壊れやすいスクレイピングを無理に増やさない。
一次情報を追加できないカテゴリは breaking_market web search で補完し、Reportへ理由を書く。

### C. Classification wiring

Phase 1で追加した未接続ロジックを既存パイプラインへ安全に接続する。

最低限:
- severity: emergency / critical / high / medium / low
- category: geopolitics / disaster / monetary_policy / fx / rates / oil_energy / commodities / shipping_logistics / semiconductors / ai_tech / us_market / japan_market / regulation_policy / corporate / earnings / financial_system
- market-wide eventをcompany_codeなしで保持できる既存構造を優先
- Fact未通過はPush対象にしない既存原則を維持
- cross-source same-event dedupeを弱めない

`emergency` の例:
- 日本周辺の弾道ミサイル/Jアラート級
- ホルムズ封鎖・大規模攻撃
- 戦争の急拡大
- 台湾有事級
- 大規模地震・津波
- 緊急金融政策
- 主要取引所/決済インフラの重大障害
- 大規模な原油供給途絶

誤報防止のsource/Fact gateは維持する。

## Important product rule

**収集するかどうかと通知するかどうかを分離する。**

このPhaseで新しいニュースを多く保存しても、ユーザーのPush通知条件を勝手に広げない。

- `send-push-notifications` のclaim/retry実装を変更しない。
- notifications claim RPCを変更しない。
- `alert_settings` のpreset/category schemaはまだ本番適用しない。
- emergency用の新PushをこのPhaseで勝手に有効化しない。

まずDBに「拾えている」状態を作り、K1後に実データを観測してから通知Phaseへ進む。

## Read / parallel safety

開始前に必ず確認:
- `.agent/ORCHESTRATION.md`
- `.agent/CURRENT_STATE.md`
- このTASK
- `.agent/tasks/CLAUDE_TASK.md`
- `.agent/tasks/CODEX_TASK.md`
- `.agent/tasks/CODEX_TASK_2.md`
- `docs/news-coverage/REDESIGN.md`
- origin/main fresh-check

G2はX複垢/OAuth作業中。以下は触らない:
- `x-oauth-connect`
- OAuth / Vault / social_accounts
- X token / callback

Codex Push hardeningと競合させない:
- `send-push-notifications` claim/retry
- `claim_pending_push_notifications`
- notifications claim schema/RPC

同じファイル/DB migration/RPC/Edge Functionを別slotが現在変更している場合は開始せず、競合箇所を具体的に報告する。

## Migration / production safety

migration historyは乖離中。

禁止:
- `supabase db push`
- migration history repair/reconcile
- destructive migration
- unrelated schema/RPC変更
- Cron変更
- synthetic production candidate/notification
- manual Push
- X投稿
- user alert settings変更

### Production rollout rule

まずローカル実装・テストを完了する。

既存 `important-news-monitor` の本番deployや本番schema変更が必要な場合:
1. exact diffとテスト結果をReportへ出す
2. statusを `review_required / next_owner: chatgpt`
3. **K1前には本番deployしない**

read-only本番調査は可。

## Tests

最低限:
- North Korea missile fixture → candidate対象
- J-Alert / EEZ系fixture → geopolitics + emergency候補
- Hormuz tanker/shipping attack fixture → shipping_logistics + geopolitics、重大条件でemergency
- oil supply disruption fixture → oil_energy
- earthquake/tsunami fixture → disaster
- emergency central-bank action → monetary_policy
- ordinary low-impact geopolitical articleを過剰にemergency化しない
- market emergencyはtracked stock / sector一致なしでもcollection/save eligibility true
- notification OFFでもcollectionはtrue
- Fact failはPush eligibility false
- company news existing dedupe regression
- existing severity SQL parity regression
- breaking_market resource/search budget
- important-news monitor regressions
- deno check
- git diff --check

可能なら、Phase 1で問題になった北朝鮮/ホルムズ相当の実ニュース本文・タイトルを匿名化fixtureとして追加する。

## Completion / Report

完了時:
- status: `review_required`
- next_owner: chatgpt
- origin/mainへ安全に同期

Report必須:
- task_id
- result
- model_used
- source_base
- query_topics_before_after
- primary_sources_before_after
- north_korea_coverage
- hormuz_coverage
- disaster_coverage
- classification_wiring
- collection_vs_notification_boundary
- resource_cost / search cadence
- changed_files
- tests
- production_changes
- deploy_status
- commit_hash
- push
- remaining_issues
- next_recommendation

本番変更が0なら明記する。K1で承認されるまでは本番deployしない。
