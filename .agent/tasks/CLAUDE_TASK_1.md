# Claude Task 1

- task_id: broader-stock-news-coverage-phase3-market-relevance-20260911
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Opus 5
- purpose: トランプ政権・関税・戦争/停戦・制裁・半導体規制・原油などの市場全体ニュースを、全ユーザーへ無差別に出さず、保有/監視銘柄との関連性に応じてアプリ `/news` へ安全に表示できる仕組みを作る。X投稿量とPush配信量は今回増やさない。

## Context

Phase 1/2はChatGPTのK1レビューで完了承認済み。

現在:
- app severity `critical / high / medium / low` は既存判定結果から決定論的に導出できる
- `/news` は個別銘柄について critical/high/medium を表示できる
- 従来rejectedだった保有者向けmediumニュースも安全条件付きで表示可能
- market-wide（company_codeなし）は、関連付けが無いため全ユーザー表示を意図的に除外中
- X publish gate、Push producer、Cron、auto_publishは従来どおり
- important-news-monitor v38、send-push-notifications v4

## Product principle

**市場全体ニュースも拾う。ただし、関係のあるユーザーだけに見せる。**

トランプ発言、関税、戦争、停戦、制裁などを人物名・キーワードだけで無差別配信しない。日本株/米株/為替/金利/原油/半導体/特定業種への伝播経路を説明できるものを対象とする。

## Model

関連性設計、既存severity、stocks_master sector、SQL/RPC、X/Push安全境界を横断するため **Opus 5** を使用する。Sonnet系へ落とさない。

## Required startup checks

1. PROJECT_RULES.md
2. .agent/ORCHESTRATION.md
3. .agent/CURRENT_STATE.md
4. このTASK
5. origin/main fresh-check
6. shared checkout / clean worktree確認
7. 他slot TASKをread-only確認
8. Claude slot 2はx-oauth-connect作業中。OAuth/Vault/social_accounts/同じmigrationやproduction設定には触れない
9. Codex2はx-test-post作業。x-test-postには触れない
10. 他slotが important_news_candidates schema、get_my_important_stock_news、stocks_master sector、alert_settings、important-news-monitor を変更中なら競合確認。安全に分離できない場合は開始せず報告
11. migration history乖離を再確認し、blind db push禁止
12. 既存未コミット差分には触れない

## Phase 3A: Existing data / schema audit

実装前にread-onlyで確定する。

- market-wide候補で既に保存されている `affected_entities`、category、judgement_reason、source_type、title/body_summary等
- `stocks_master` の sector / market 等、ユーザー銘柄との突合に使える既存列と実データ品質
- `tracked_stocks` の tracking_type（holding/watch）と active条件
- Phase 2 RPCとseverity導出関数
- 直近market-wide候補の件数と代表例
- トランプ/関税/戦争/停戦/制裁/半導体規制/原油などで、既存データだけから安全に affected_assets / affected_sectors を導ける範囲

## Phase 3B: Deterministic relevance mapping

新規AI呼び出しは追加せず、可能な限り決定論的に市場ニュースの影響タグを導出する。

最低限検討するタグ:
- assets: japan_equities, us_equities, usd_jpy, jpy, rates, oil, lng, semiconductors, shipping など
- sectors: semiconductors, autos, exporters, banks, trading_companies, energy, airlines, shipping, defense など

代表マッピング例:
- 米国の対日自動車追加関税 → autos / exporters / japan_equities
- 対中半導体・AI輸出規制 → semiconductors
- 台湾海峡緊張 → semiconductors / shipping / japan_equities
- 中東戦闘拡大・ホルムズ障害 → oil / lng / shipping / airlines / energy
- 停戦・制裁解除 → oil等への逆方向影響も「対象」として関連付ける。方向性の投資助言までは行わない
- FRB/日銀サプライズ → rates / usd_jpy / banks / exporters / japan_equities
- 単なる政治発言で具体策・市場伝播経路なし → 関連付け対象外

重要:
- sector名の表記揺れを監査してから対応する
- キーワード1個だけでcritical判定しない
- relevanceは「表示対象か」を決める補助であり、売買方向を推奨しない
- source/fact basisが弱いニュースはfail closed

## Phase 3C: App feed integration

`get_my_important_stock_news` を最小変更し、以下を満たす。

1. 個別銘柄ニュース: Phase 2の挙動を完全維持
2. market-wide: company_codeなしでも、ユーザーのactive tracked stockのsector等とaffected sectorが一致する場合のみ表示候補
3. market-wideは原則 severity critical/high のみ。mediumを入れるなら明確な理由をReportし、ノイズ増加を実データで評価
4. market-wideを全ユーザーへ無差別表示しない
5. 同じmarket-wideニュースが複数保有銘柄に一致してもfeedではnews_id単位で1件にdedupe
6. 可能なら `relevance_reason` または `matched_sector` を戻り値へ追加。ただしapp互換を壊さない
7. order/limit既存維持。critical/highがmediumに埋もれない並びも検討し、変更する場合は明示する

### holding / watch

今回は表示についてはactive holding/watchどちらも関連銘柄として扱ってよい。ただしReportで件数差を出す。

Push差分はまだ有効化しない。

## Phase 3D: Optional market alerts setting design

将来の全体アラート用 `market_alerts` 設定案を設計する。

- 既定OFFを推奨
- これを理由に今回全ユーザーPushはしない
- alert_settings migrationを今回追加する必要が無ければ設計だけに留める

## Required tests

最低限:
- tariff -> autos/exporters関連ユーザー positive
- semiconductor export control -> semiconductor関連 positive
- war/Hormuz/oil shock -> energy/shipping/airline関連 positive
- FRB/BOJ surprise -> relevant sector/asset positive
- unrelated sector user negative
- market-wide全ユーザー表示なし
- company_codeなしでも関連性があれば表示
- 同一newsの複数sector matchでfeed重複なし
- weak/unknown relevance fail closed
- low severity negative
- individual stock feed Phase 2 regression
- other-user/inactive/untracked negative
- duplicate_of exclusion
- order/limit/return shape compatibility
- X publish gate unchanged
- Push producer unchanged / notifications増加なし
- important-news-monitor regression
- SQL parity/static checks where applicable
- app tsc --noEmit
- git diff --check

## Production rule

監査・実装・テストPASS後に限り、**必要最小限のDB migration/RPC更新のみ本番適用可**。

- `supabase db push` 禁止
- 対象migrationを単独・トランザクションで適用
- 事前にrollback付き本番データ検証
- `important-news-monitor` Edge deploy禁止
- `send-push-notifications` deploy禁止
- `x-test-post` deploy禁止
- Cron/auto_publish/secrets/OAuth変更禁止
- Push producer変更禁止

本番適用後:
- RPC/関数定義・ACLをread-only確認
- 本人feedで関連market-wideがあれば自然データで確認
- 無ければrollback付き既存market-wideデータで関連ユーザー条件を証明してよい
- 非関連ユーザーへ漏れないことを確認
- 個別銘柄feedの既存表示を壊していないことを確認
- notifications増加0
- X/Cron/auto_publish unchanged

## Forbidden

- X publish基準変更
- X投稿量増加
- Push配信対象拡大
- market-wide全ユーザーPush
- 新しいAI API呼び出し
- 無制限web検索追加
- artificial candidate本番投入
- candidate status変更/削除
- destructive migration
- OAuth/Vault/social_accounts変更
- x-test-post変更
- dispatcher変更

## Completion

完了時:
- status: review_required
- next_owner: chatgpt
- Report追記・origin/main同期

Report必須:
- task_id
- result
- model_used
- market_data_audit
- sector_data_audit
- relevance_mapping
- chosen_implementation
- schema_or_rpc_changes
- individual_feed_regression
- market_wide_feed_behavior
- existing_data_proof
- holding_vs_watch_result
- tests
- x_publish_invariants
- push_invariants
- production_apply_method
- production_verification
- changed_files
- commit_hash
- push
- remaining_issues
- safety_checks
- phase4_recommendation

## Report

未開始。`G1` で開始すること。
