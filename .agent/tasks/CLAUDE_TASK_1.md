# Claude Task 1

- task_id: personalized-portfolio-morning-close-reports-phase1-20260911
- owner: claude
- slot: claude-1
- status: in_progress
- next_owner: claude
- priority: urgent
- recommended_model: Opus 5
- purpose: かぶモリアプリに、X向け市場全体レポートとは別系統の「ユーザー個別ポートフォリオ特化 朝刊 / 大引けレポート」を追加する。保有・監視銘柄、取得単価、保有区分、関連ニュース、市場地合いを組み合わせ、Xより一段深い内容をアプリ内で提供し、希望ユーザーにはPushで完成通知する。

## Product goal

現在の体験を以下の3本柱にする。

1. 重要ニュース: 既存の保有/監視銘柄関連ニュースPush
2. 朝刊: そのユーザーのポートフォリオに特化した「今日どう見ればよいか」
3. 大引けレポート: そのユーザーのポートフォリオに特化した「今日なぜ動いたか / 明日何を見るか」

X版morning_report / close_reportは公開向け市場全体コンテンツとして維持する。
アプリ版はX本文のコピーではなく、共通市場データ・ニュースを再利用しつつ、ユーザーの登録ポートフォリオを掛け合わせて別生成する。

## Core UX

アプリ内ではニュースと混ぜず、少なくとも以下を独立表示する。
- 今日の朝刊
- 今日の大引けレポート
- 重要ニュース

ホームまたはレポート専用画面から最新レポートへ1タップで入れる構成を優先する。
Pushは全文ではなく完成通知を基本とする。
- 朝刊: 「今日のあなたのポート見通しができました」
- 大引け: 「今日のポート振り返りができました」
Push tapで該当レポート詳細へ遷移する。

## Personalization requirements

利用可能な範囲で最低限以下を反映する。
- tracked_stocksのholding / watch区分
- 保有数量
- 取得単価
- 現物 / 信用等の保有区分（既存DBに存在する場合）
- 銘柄名 / code / sector
- 当日の銘柄関連重要ニュース
- 市場全体の重要材料
- 日経平均 / TOPIX等の市場地合い
- 業種テーマ

### Morning report

ユーザーが「今日何を見るべきか」を理解できる内容にする。
最低セクション案:
- 今日のポート総合見通し（強気/中立/慎重など、断定しすぎない）
- 影響が大きそうな保有銘柄 TOP3
- 保有銘柄ごとの主要材料
- 監視銘柄で今日注目すべきもの
- ポートの業種偏り / リスク要因
- 今日のチェックポイント

### Close report

ユーザーが「今日なぜ自分の資産がこう動いたか」を理解できる内容にする。
最低セクション案:
- 今日のポート総括
- 上昇寄与 / 下落寄与の主要銘柄
- 市場（日経/TOPIX）に対してポートが相対的に強かった/弱かったか
- 各保有銘柄の値動きと確認できた材料
- 今日のニュースとの接続
- 明日見るポイント

可能なら数量を使った概算寄与も検討するが、価格データの信頼性が十分でない場合は無理に数値化しない。
取得単価を使う場合も、含み損益と当日騰落を混同しない。

## Accuracy / safety principles

- 投資助言の断定表現を避ける。
- 「買うべき / 売るべき」を自動で断定しない。
- ニュースとの因果関係は確認できる範囲だけ。
- Fact未確認の内容をレポート本文に使わない。
- 価格や損益計算は可能な限りコードで決定的に計算し、LLMへ算術を丸投げしない。
- 取得できないデータは推測で埋めない。
- X版レポートの品質gateを緩めない。
- 既存重要ニュースPushを壊さない。

## Architecture direction

最初に既存構造を監査し、最小で安全な分離を設計する。
想定:
1. 市場全体 morning/close の既存run・材料を共通入力として再利用できる部分を特定
2. ユーザーごとのportfolio snapshot / tracked_stocksを取得
3. アプリ専用レポート生成
4. Fact / schema validation
5. DBへ保存
6. アプリが保存済みレポートを読む
7. 生成成功後のみPush候補をenqueue

画面表示時にAI生成しない。表示時は保存済みレポートを読むだけにする。

## DB design

既存テーブルを監査し、アプリ専用レポート保存先を設計する。
候補: `personalized_reports`
- id
- user_id
- report_type: morning / close
- trading_date
- status
- title_ja
- summary_ja
- detail/body structured JSON
- portfolio_snapshot / source basis metadata
- fact_status
- model_used
- generated_at
- error

既存schemaと重複するなら別設計でよい。
要件:
- user_id + report_type + trading_date で同日重複防止
- 本人だけ読めるRLS
- service role生成
- destructive migration禁止
- expand-only
- migration history乖離があるため `supabase db push` 禁止

## Notification settings

既存 `alert_settings` の morning_report / close_report を監査する。
Push条件の原則:
- `push_enabled=true`
- 対応する `morning_report=true` / `close_report=true`
- レポート生成成功
- 同じuser/report/dateへ二重通知しない

既存notifications / send-push-notificationsを可能な限り再利用する。
dispatcher変更なしで実現できるなら変更しない。
Push本文は短くし、詳細はアプリへ誘導する。

## App UI

最低限:
- ホームまたは専用レポート領域に「朝刊」「大引けレポート」カード
- 今日の有無 / 更新時刻
- 詳細画面
- 長文スクロール
- 保有銘柄ごとのセクションが読みやすい
- Push tap deep link
- ニュース画面とは別枠

通知設定UIが既にあるなら:
- 朝刊通知 ON/OFF
- 大引けレポート通知 ON/OFF
を明示する。

## Phase 1 scope

今回は土台を完成させることを優先する。
優先順位:
1. 現状監査と正式設計
2. DB / RPC / RLS
3. 個別レポート生成ロジック
4. 保存
5. アプリ一覧/詳細UI
6. Push完成通知
7. 実データで1ユーザーE2E確認

実装量が大きい場合はPhase 1A / 1Bへ安全に分割してよい。その場合も、どこまでが本番利用可能かをReportで明確にする。

## Scheduling

X版の朝刊/大引け投稿時間を変更しない。
アプリ版は既存市場レポートが利用可能になった後に生成することを優先する。
目安:
- 朝刊: 既存morning_report生成後
- 大引け: 現在17:00 JSTへ変更済みのclose_report生成後

ただしX投稿成功そのものを必須条件にする必要はない。市場データ/Fact-passed基盤を再利用できるなら、X投稿失敗でもアプリ版だけ生成できる設計を検討する。

## Required startup checks

1. `PROJECT_RULES.md`
2. `.agent/ORCHESTRATION.md`
3. `.agent/CURRENT_STATE.md`
4. このTASK
5. `origin/main` fresh-check
6. clean worktree確認
7. 他slot TASKをread-only確認
8. 同じDB migration/RPC/Edge Function/workflow/production設定を他slotが変更中なら開始しない
9. 既存未コミット変更には触れない
10. migration history乖離を確認し、blind `supabase db push` 禁止

## Parallel safety

Claude slot 2はX複垢/OAuth系の別workstream。
以下へ触れない:
- OAuth/Vault/social_accounts
- multibrand OAuth callback
- X認証情報

Codex側が `x-test-post` / schedulerを変更中なら競合を確認する。
同じファイル/Functionを触る必要がある場合は開始せず競合報告する。

## Production safety

本番反映は段階的に行う。
許可:
- expand-only schema/RPC/RLS（rollback-contained proof後）
- 新規Edge Functionが必要なら追加
- app code変更
- notifications enqueue logic追加

禁止:
- `supabase db push`
- destructive migration
- 既存X投稿量/時刻/内容の無断変更
- morning_report / close_report X品質gateの緩和
- important-news producerの無関係変更
- secrets/OAuth変更
- 人工X投稿
- 同日Xレポート強制再実行

既存Edge Functionを変更する必要がある場合、他slotとの競合を必ず確認する。

## Required tests

最低限:
- 本人以外のpersonalized reportを読めないRLS
- 同user/type/date重複防止
- holding/watch分離
- holding優先順位
- 取得単価/数量が無い場合のsafe fallback
- Fact failed sourceを本文に使わない
- 朝刊生成positive
- 大引け生成positive
- 欠損データ時のfail-safe
- report生成失敗時Push 0
- morning_report setting OFF -> Push 0
- close_report setting OFF -> Push 0
- push_enabled OFF -> Push 0
- 同日同report二重Pushなし
- news Push regression
- app list/detail rendering
- deep link routing
- app `tsc --noEmit`
- changed Deno modules `deno check`
- `git diff --check`

## Real-data proof

人工的な架空保有銘柄を本番ユーザーへ追加しない。
既存の登録銘柄を使い、read-only snapshotから生成できることを確認する。
Push E2Eを行う場合:
- ユーザー設定を勝手に変更しない
- 同日重複通知を作らない
- 必要ならK1で明示承認を求める

## Completion

完了時:
- status: `review_required`
- next_owner: `chatgpt`
- このTASK末尾へ `## Report` 追記
- origin/main同期

Report必須:
- task_id
- result
- model_used
- current_architecture_audit
- chosen_design
- schema_rpc_rls_changes
- generation_pipeline
- personalization_inputs
- morning_report_output
- close_report_output
- notification_behavior
- app_ui_changes
- tests
- real_data_proof
- production_changes
- deploy_verification
- changed_files
- commit_hash
- push
- remaining_issues
- safety_checks
- next_recommendation
