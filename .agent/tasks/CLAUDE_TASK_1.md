# Claude Task 1

- task_id: market-critical-alerts-dedupe-relevance-phase4-20260911
- owner: claude
- slot: claude-1
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Opus 5
- purpose: 市場全体Criticalニュースをユーザー設定に基づいて安全にPush候補へ接続しつつ、アプリ内ニュースのソース横断重複と関連業種表示を改善する。X投稿基準・X投稿量は変更しない。

## Context

前TASK `in-app-news-japanese-detail-summary-20260911` はChatGPTのK1レビューで完了承認済み。

現在までに:
- `/news` は個別銘柄 critical/high/medium を表示
- market-wide critical/high はactive tracked stocksの業種関連性がある場合だけ表示
- 英語ニュースはFactチェック済み日本語タイトル・要約・詳細をアプリ内で読める
- `important-news-monitor` v39
- `send-push-notifications` v4
- market-wideニュースのPushはまだ無効
- 同一イベントが複数sourceから別candidateとして表示されることがある
- matched_sectorは複数一致時の選択が最適でないことがある

## Product principle

**重大な市場ニュースは見逃さない。ただし、ユーザーが望んだ範囲だけ通知する。**

- トランプ政権/関税
- 戦争・軍事衝突
- 停戦・和平
- 制裁/制裁解除
- 半導体・AI輸出規制
- 為替介入
- FRB/日銀のサプライズ政策
- 原油/LNG・ホルムズ/紅海等の重大障害
- その他、日本株・為替・金利・主要セクターを大きく動かしうるCriticalニュース

を対象とする。

## Model

Push policy、ユーザー設定、DB/RPC、producer、dedupe、market relevanceを横断するため **Opus 5** を使用する。Sonnet系へ落とさない。

## Required startup checks

1. `PROJECT_RULES.md`
2. `.agent/ORCHESTRATION.md`
3. `.agent/CURRENT_STATE.md`
4. このTASK
5. `origin/main` fresh-check
6. shared checkout / clean worktree確認
7. 他slot TASKをread-only確認
8. Codex2は `x-test-post`、Claude2はOAuth/Vault/social_accounts系。各担当範囲へ触れない
9. 他slotが `important-news-monitor/**`、`send-push-notifications`、`alert_settings`、`get_my_important_stock_news`、同じmigration/RPCを変更中なら開始せず競合報告
10. migration history乖離を再確認し、blind `supabase db push` 禁止
11. 既存未コミット差分は他workstream所有として触れない

## Phase 4A: Market alert preference

ユーザーが市場全体CriticalニュースのPushを受け取るかを設定できるようにする。

推奨:
- `alert_settings.market_critical_news` 等のboolean
- **既定OFF**
- 既存ユーザーに突然Pushが増えないfail-closed
- `push_enabled=false` の場合は必ず送らない
- `important_news=false` との関係を明確化する。原則、market Criticalも重要ニュースの一部として扱い、両方の設定境界をテストする

既存 `alert_settings` の構造を監査し、最小expand-only migrationを選ぶ。

## Phase 4B: Market Critical Push targeting

market-wide（company_codeなし）のうち **severity=critical** だけをPush候補にする。

最低条件:
- market_critical_news=true のユーザーのみ
- push_enabled=true
- important_news=true（既存方針と整合させる）
- Fact basisが十分
- duplicate_of is null
- AI日本語コピーまたは既存Fact-passed日本語テキストが安全に利用できる
- 同じニュースを同じユーザーへ複数通知しない
- high/mediumは今回Pushしない

Pushの本文は、可能なら今回完成したアプリ用Fact-checked日本語コピーを再利用する。画面表示時やPush時に追加AI呼び出しをしない。

### Important

業種関連があるmarket Criticalについても、**設定OFFならPushしない**。
設定ONの場合に「全市場Criticalを受け取る」設計にするか、「関連Criticalだけ」を受け取る設計にするかを実データ件数で比較し、ノイズが少ない方を選ぶ。原則は関連Criticalを優先し、全Criticalは明示的な別設定なしに広げない。

## Phase 4C: Cross-source news dedupe

現在、同一イベント（例: 同じ米雇用統計）がAP/BLS等の別sourceから別candidateとしてfeedに出ることがある。

これを改善する。

要件:
- source URL一致だけに依存しない
- 同一イベント判定は deterministic を優先
- titleの単純類似だけで誤統合しない
- event category + published time window +主要数値/主体/affected entities等、既存データで安全に判定できる範囲を使う
- 既存candidateを大量UPDATE/削除しない
- feed/RPC側のdedupeで解決できるなら優先
- Push dedupeにも同一event keyを再利用できる設計を検討
- 同じ雇用統計など実在データでproofする

誤統合リスクが高い場合は、最小安全範囲（例: macro統計のみ）に限定してよい。

## Phase 4D: matched_sector / relevance display improvement

現在、複数業種に一致しても単純な順序で1業種が選ばれる場合がある。

改善候補:
1. ユーザーが登録している銘柄数の多い一致業種を優先
2. holdingをwatchより優先
3. 複数一致なら上位2〜3業種を返す

アプリで「なぜこのニュースが表示されているか」が自然に分かることを優先する。

例:
- 為替ニュースが、実際は電気機器の登録が最多なのに「機械」とだけ出る不自然さを改善
- `relevance_reason` の方向性（上がる/下がる）断定は禁止のまま

## Required tests

最低限:
- market_critical_news default OFF
- OFF -> market Critical Push 0
- ON + push_enabled=true + important_news=true -> 対象Criticalのみ通知候補
- push_enabled=false -> 0
- important_news=false -> 0
- high/medium market news -> 0 Push
- company-specific existing Push behavior regression
-同一market newsの同一user二重通知なし
- source横断の同一イベントfeed重複抑制
- 誤統合negative case
- existing individual feed維持
- market-wide relevance維持
- matched_sector改善のpositive/priority tests
- Fact failed app copyはPush本文に使わない
- app Japanese title/detail regressions
- X publish gate unchanged
- `important-news-monitor` full regression
- dispatcher regression（変更した場合のみ）
- app `tsc --noEmit`
- changed pure modules `deno check`
- `git diff --check`

## Production safety

まず監査・実装・テストを完了する。

本番反映:
- expand-only migration / RPCは、rollback付き事前検証後に対象ファイル単独適用可
- `supabase db push`禁止
- `important-news-monitor` deployが必要な場合、root / HEAD / config / project refを確認してから `--no-verify-jwt`
- deploy後は本番sourceをdownloadして期待commitと全ファイルbyte compare
- `send-push-notifications` は既存設定で実現できるなら変更しない。変更が必要なら理由をReportし、K1前に本番deployしない

### Real production proof

人工candidate・人工marketニュースは禁止。
自然な既存Criticalニュースで:
- 設定OFFのユーザーへ通知が作られないこと
- 設定ONのrollback付きテスト等で対象ユーザーが正しく選ばれること
- 可能なら自然Critical発生時に観測

本番でユーザー設定を実際にONへ変更して自然Pushを待つ必要がある場合は、勝手に変更せずK1へ相談する。

## Forbidden

- X publish条件変更
- X投稿量増加
- high/medium market-wide Push
- market Criticalの無条件全ユーザーPush
- `x-test-post`変更
- OAuth/Vault/social_accounts変更
- Cron schedule変更
- auto_publish変更
- secrets変更
- 人工candidate作成
- candidate status変更/削除
- destructive migration
- 画面表示時/Push時の追加AI呼び出し
- Fact未確認テキストの通知利用
- unrelated Edge Function deploy

## Completion

完了時:
- status: `review_required`
- next_owner: `chatgpt`
- Report追記
- origin/main同期

Report必須:
- task_id
- result
- model_used
- alert_settings_audit
- chosen_market_alert_policy
- market_push_targeting
- cross_source_dedupe_design
- matched_sector_improvement
- schema_or_rpc_changes
- producer_changes
- dispatcher_changes_or_none
- app_changes
- existing_data_proof
- tests
- x_publish_invariants
- push_safety_invariants
- production_changes
- deploy_verification
- changed_files
- commit_hash
- push
- remaining_issues
- safety_checks
- next_recommendation

未開始。`G1`で開始すること。
