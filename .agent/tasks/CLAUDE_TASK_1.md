# Claude Task 1

- task_id: broader-stock-news-coverage-phase1-20260910
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Opus 5
- purpose: かぶモリアプリの価値を高めるため、現行の「Xへ出す重大ニュース」だけでなく、保有・監視銘柄ユーザーに有用なニュースをより広く収集できる基盤へ拡張する。今回は収集範囲の監査・カテゴリ設計・安全な最小実装・テストまでを行い、X自動投稿基準や本番配信量を勝手に広げない。

## Context

直前TASK `important-news-push-copy-quality-20260910` はChatGPTのK1レビューで完了承認済み。

現在までに完成している重要ニュースPush基盤:
- `important-news-monitor` v38 が本番稼働
- 自然publish後、登録銘柄ユーザー向けnotification producerが動く
- `send-push-notifications` v4 が毎分Cronで配信
- `alert_settings.push_enabled` / `important_news` opt-outを本番実証済み
- `/news` RPCは `published` を含む
- Push本文はFact/Voice通過済みX投稿文を優先して読みやすく改善済み
- Push → `/news` の導線は構造上つながっている

既知の次の課題は、現在の収集・判定が「Xへ出すほど重大なニュース」に寄っており、保有者には有用だがX全体投稿には強すぎない材料を十分拾えていないこと。

## Product Principle

**収集は広く、配信は狭く。**

今回もっとも重要な原則:
- ニュースを拾う範囲は広げる
- ただし、現在のX自動投稿基準を勝手に緩めない
- 「収集された」ことと「Xへpublishする」ことを同一条件にしない
- 将来、保有銘柄 / ウォッチ銘柄 / severity に応じてPushやアプリ表示を分けられる構造を優先する

## Model

ニュース取得・分類・X publish安全性・Push・将来のseverity設計を横断するため **Opus 5を使用する**。Sonnet系へ落とさない。

## Required startup checks

1. `PROJECT_RULES.md`
2. `.agent/ORCHESTRATION.md`
3. `.agent/CURRENT_STATE.md`
4. このTASK
5. `origin/main` fresh-check
6. shared checkout / clean worktreeの状態確認
7. `.agent/tasks/CODEX_TASK.md` / `.agent/tasks/CODEX_TASK_2.md` / `.agent/tasks/CLAUDE_TASK.md` をread-only確認
8. 他slotが `important-news-monitor/**`、同じnews source、同じRPC/migration、同じproduction設定を変更中なら開始せず競合報告
9. 本番 `important-news-monitor` v38のsource/versionをread-only確認し、origin/mainとの一致を確認
10. 既存未コミット変更は他workstream所有として扱い、変更・削除・stage・commitしない

## Phase 1A: Current coverage audit

実装前に、現在のニュース取得からX publishまでの経路をコードと本番read-onlyデータで確定する。

最低限確認:
- `official_source_fetchers.ts`
- `market_macro_source_fetchers.ts`
- `breaking_market_source_fetchers.ts`
- importance judgement / grouping / candidate logic
- generation / Fact / Voice / publish gate
- auto_publish cutover / rate control
- notification producerとの接続条件
- `/news` で現在見えるstatus / importance

以下を整理する:
1. 現在拾えているsource種別
2. 現在候補化されるニュース種別
3. importance=`important` / `most_important` の現行判定
4. どの段階でニュースが落ちるか
5. 「保有者には有用だが現在拾えていない/落ちている」代表例
6. X公開基準とアプリ/Push向け基準を分離できるポイント

可能なら直近の本番候補データをread-onlyで分類し、件数と具体例をReportする。人工candidateは作らない。

## Phase 1B: Coverage taxonomy

少なくとも以下のカテゴリを、現行で拾える / 一部拾える / 拾えていない に分類する。

- 決算発表
- 業績予想の上方/下方修正
- 配当増減・無配・復配
- 自社株買い / 消却
- 株主優待の新設・変更・廃止
- M&A / TOB / 買収 / 売却
- 資本業務提携 / 大型提携
- 大口受注 / 大型契約
- 増資 / CB / 社債など資金調達
- 株式分割 / 併合
- 主要株主・大量保有に関する重要変化
- 行政処分 / 規制 / 訴訟
- 不祥事 / 事故 / 工場停止 / サイバー事故
- 経営トップ交代
- 大型製品・サービスの発表 / 延期 / 中止
- 市場で重要な格付け・レーティング変更（信頼できるsourceがある場合）
- その他、保有者の投資判断に直接影響しうるIR

カテゴリを増やすこと自体が目的ではない。投資判断への関連性とsource信頼性を基準にする。

## Phase 1C: Severity / delivery design

現行importanceを壊さず、将来以下のように分離できる最小設計を提案する。

推奨概念:
- Critical: 市場全体または銘柄に非常に大きな影響。X対象候補。
- High: 保有者にはかなり重要。Push候補だが、必ずしもXへ出さない。
- Medium: アプリ一覧で見る価値が高い。通常はPushしない。
- Low: 原則保存しないか、参考情報扱い。

ただし、今回いきなりDB schemaを増やす必要はない。既存の `importance` 等で安全に表現できるなら最小変更を優先し、schema変更が必要なら実装前に理由を明示する。

### Holdings vs Watchlist future policy

将来の推奨方針もReportする:
- holdings: Critical + HighをPush候補
- watchlist: 原則Critical、またはユーザー設定でHighも許可
- app feed: Critical + High + Medium

**今回はこの配信ポリシーを本番有効化しない。** 設計だけ整理する。

## Phase 1D: Minimal implementation

監査の結果、既存構造を壊さず安全に追加できるニュースカテゴリ/sourceが明確なら、最小の実装を行う。

実装ルール:
- `important-news-monitor` 内で完結する範囲を優先
- sourceは公式IR/TDnet/信頼できる既存許可sourceを優先
- 無差別な一般Web検索を増やさない
- source URL / published time / company_code等のFact basisを必須とする
- duplicate/grouping既存仕様を維持
- 既存のCritical相当/X publish判定を緩めない
- 新たに収集したHigh/Medium相当ニュースが、誤って既存X auto_publishへ流れないfail-closed設計にする
- 自然X投稿件数が増える変更は今回禁止
- Push producerの対象範囲を勝手に広げない
- `/news` RPC変更は今回原則行わない

もし安全な最小実装にschema/RPC変更が必須なら、コードを書き始める前にReportのdesign sectionへ理由を記録し、今回は設計・テストまでで停止してよい。

## Required tests

最低限:
- 新たに対象とするカテゴリのpositive cases
- 無関係な一般ニュースは候補化しない
- company/ticker誤紐付けをしない
- source_url / published_at等の必須Fact basis欠損はfail closed
- duplicate/grouping維持
- 既存 `important` / `most_important` 判定の回帰
- 既存X publish gateの回帰
- 新しく広げた収集が既存X publish量を増やさないこと
- producer / user targetingを変更していないこと
- important-news-monitor全回帰テストPASS
- changed pure modules `deno check`
- `git diff --check`

## Production rule for this task

**本番deployは禁止。**

今回は:
- audit
- design
- safe minimal implementation
- local/test validation
- commit/push
まで。

K1レビュー後にChatGPTが、本番投入してよい範囲を別途明示する。

本番について許可するのはread-only確認のみ:
- candidate件数/分類
- current Function version/source
- current settings/Cron状態

禁止:
- Edge Function deploy
- migration/RPC適用
- Cron変更
- auto_publish設定変更
- candidate status変更
- X投稿
- artificial candidate作成
- notification作成

## Forbidden

- `send-push-notifications`変更/deploy
- `x-test-post`変更/deploy
- `/news` RPC変更（監査で必須理由が出ない限り）
- Cron変更
- secrets/OAuth変更
- alert_settings変更
- X投稿基準の緩和
- auto_publish対象拡大
- Push配信対象の本番拡大
- unrelated DB migration
- テスト用の人工important-news candidateを本番投入
- 既存backlogのstatus変更/削除
- 一般Webクロールの無制限追加

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
- current_pipeline_map
- source_inventory
- current_category_coverage
- missed_or_undercovered_categories
- real_data_audit
- proposed_taxonomy
- proposed_severity_model
- holdings_vs_watchlist_policy
- chosen_phase1_implementation
- why_x_publish_volume_does_not_increase
- changed_files
- tests
- production_changes（必ずnoneのはず）
- commit_hash
- push
- remaining_issues
- safety_checks
- phase2_recommendation

## Report

未開始。`G1` で開始すること。
