# Claude Task 1

- task_id: broader-stock-news-coverage-phase2-20260911
- owner: claude
- slot: claude-1
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Opus 5
- purpose: Phase 1で設計・検証したapp severityを、X投稿量とPush配信量を増やさず、アプリのニュース一覧へ安全に接続する。個別銘柄IRと市場全体ニュースの将来拡張に耐える形を優先する。

## Context

前TASK `broader-stock-news-coverage-phase1-20260910` はChatGPTのK1レビューで完了承認済み。

Phase 1で確定したこと:
- 現行は `importance` が「Xへ出す価値」と「アプリで見る価値」を兼ねており、保有者には有用でもX級でないニュースが `no_post -> rejected` で消える
- app向け severity `critical / high / medium / low` を既存判定結果から決定論的に導く pure module `news_severity_logic.ts` を実装済み
- 本番直近7日665件のシミュレーションで、X対象104件は不変のまま、アプリ表示候補を新たに271件増やせる見込み
- 個別銘柄に加え、トランプ大統領・米政権、関税、米中摩擦、半導体/AI輸出規制、戦争/停戦/制裁、中東・原油、台湾海峡、海運障害、OPEC+、FRB/日銀サプライズ、為替介入、大規模災害・パンデミック・サイバー等も taxonomy 対象
- `news_severity_logic.ts` はまだ本番 `index.ts` から参照していないため、現行本番挙動は不変
- `important-news-monitor` v38、`send-push-notifications` v4、`/news` RPC published対応は本番済み

## Product principle

**収集は広く、表示は有用に、Push/Xは慎重に。**

今回のPhase 2では:
- アプリ `/news` で critical / high / medium を見られるようにする
- X publish条件は一切変更しない
- Push producer対象は一切広げない
- 市場全体ニュースを全ユーザーへPushしない
- holding/watchのPush差分はまだ本番有効化しない

## Model

DB migration/RPC、既存candidateデータ、app feed互換、X/Push安全境界、migration履歴乖離をまたぐため **Opus 5を使用する**。Sonnet系へ落とさない。

## Required startup checks

1. `PROJECT_RULES.md`
2. `.agent/ORCHESTRATION.md`
3. `.agent/CURRENT_STATE.md`
4. このTASK
5. `origin/main` fresh-check
6. shared checkout / clean worktree確認
7. 他slot TASKをread-only確認
8. 他slotが `important_news_candidates` schema、同じmigration/RPC、`get_my_important_stock_news`、`/news` を変更中なら開始せず競合報告
9. 本番 `get_my_important_stock_news` 定義と repo migrationをread-only確認
10. 本番 migration history乖離を再確認し、`db push` を盲目的に使わない
11. 既存未コミット変更は他workstream所有として触らない

## Phase 2A: Choose persistence strategy

Phase 1の severity を本番フィードで使えるようにする方法を比較し、最小で安全な方を選ぶ。

候補:
A. `important_news_candidates` に `app_severity` / `ir_subtype` をexpand-only追加し、判定時に保存
B. 既存列からSQL/RPC側で決定論的に導出
C. view / generated-compatible projectionで導出

判断基準:
- 既存行を安全に扱える
- X publish / Push producerに影響しない
- backfillの事故リスクが低い
- app `/news` で安定して使える
- migration履歴乖離下でも個別適用しやすい
- severityロジックの二重実装を極力避ける

**既存データの破壊的UPDATEや大量status変更は禁止。**

## Phase 2B: App feed behavior

`/news` の対象を、現在の `importance in ('important','most_important')` 中心から、app severityベースへ拡張する。

最低要件:
- critical / high / medium を表示候補
- low は表示しない
- 個別銘柄ニュースは `tracked_stocks.user_id = auth.uid()` + `is_active=true` の既存対象判定を維持
- 他ユーザー/非登録銘柄を混ぜない
- inactiveは出さない
- `duplicate_of is null`維持
- 既存 `published / ready_for_publish / generation_failed` を壊さない
- severityがmedium以上なら、従来 `rejected` だった「アプリでは有用」ニュースを表示できる設計を検討・実装
- ただし単なるAI失敗やFact不確かな rejected を無条件で表示しない。severity根拠とFact basisが必要
- order / limit / return shape は可能な限り維持
- app `src/app/news.tsx` の互換性を維持。severity表示を追加する場合は最小UI変更にする

### Important: market-wide news

company_codeなしの市場全体ニュースについては、今回は**全ユーザーのニュース一覧へ無差別表示しない**。

理由:
- 現時点で affected_sectors / affected_assets / market alert preference が本番設計されていない
- トランプ・戦争・関税などは重要でも、ユーザー関連性を決めずに全件混ぜるとノイズになる

今回できること:
- 将来 market-wide feedへ接続可能なseverity/taxonomy設計を保持
- 必要ならRPC側で market-wideを明示的に除外し、その理由をReport
- Phase 3向けに affected_sectors / affected_assets / market_alerts の最小案を提示

## Phase 2C: X / Push invariants

絶対条件:
- `important-news-monitor` のX publish gateを変更しない
- `checkPublishCandidate` / auto_publish条件を変更しない
- `important` / `most_important` のX判定を緩めない
- `send-push-notifications`変更なし
- notification producerの対象/importance条件変更なし
- 新たなmedium/highニュースからnotificationを作らない
- Cron変更なし
- X投稿件数が増える変更なし

## Phase 2D: Existing data proof

本番read-onlyデータを使って、実際に以下を証明する。

- 現在 `/news` に出ている既存ニュースが新方式でも維持される
- 現在 `no_post/rejected` だがseverity medium以上となる登録銘柄ニュースが存在するか
- 存在する場合、新RPC定義のrollback付きテスト等で本人フィードに出ることを確認
- 非登録銘柄、inactive、他ユーザーは出ない
- market-wide company_codeなしは今回の方針どおり無差別表示されない
- duplicateなし
- limit/order維持

人工candidateの本番投入は禁止。

## Required tests

最低限:
- critical/high/medium positive
- low negative
- existing important/most_important regression
- medium相当rejectedの安全な表示
- Fact basis不足 / 不確かなrejectedはfail closed
- tracked active positive
- untracked negative
- inactive negative
- other-user negative
- duplicate exclusion
- market-wide company_codeなしの無差別表示なし
- order/limit維持
- return shape/app compatibility
- X publish gateの回帰
- Push producer対象不変
- `important-news-monitor` 全回帰
- SQL/migration lint可能範囲
- changed pure modules deno check
- `git diff --check`

## Production rule

このPhase 2は、監査・実装・テストPASS後に限り、**必要最小限のDB migration/RPC更新のみ本番適用してよい**。

ただし:
- `supabase db push` は禁止。migration history乖離があるため、対象ファイル単独の安全な適用方法を選ぶ
- Edge Function deployは禁止。もしseverity保存のため `important-news-monitor` deployが必須と判断した場合は、本番deployせずK1へ理由をReportして停止する
- `/news` appコード変更が必要ならcommit/pushまで可。ストア配布等は不要

本番適用後は:
1. RPC/schema定義をread-only確認
2. 本人フィードをread-only確認
3. 既存表示維持 + 新しいmedium/high候補の表示を証明
4. 非対象ニュース漏れなし
5. notifications 0増加を確認
6. X投稿経路・Cron・auto_publish・secrets/OAuth無変更を確認

## Forbidden

- `important-news-monitor` Edge deploy
- `send-push-notifications`変更/deploy
- `x-test-post`変更/deploy
- Cron変更
- auto_publish変更
- X publish gate変更
- Push配信対象拡大
- market-wide全ユーザーPush
- secrets/OAuth変更
- alert_settings変更
- 人工candidate本番投入
- backlogのstatus変更/削除
- unrelated migration
- destructive schema change
- blind `supabase db push`

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
- persistence_strategy_comparison
- chosen_strategy
- schema_or_rpc_changes
- app_feed_rule_before_after
- market_wide_handling
- existing_data_proof
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
- phase3_recommendation

## Report

未開始。`G1` で開始すること。
