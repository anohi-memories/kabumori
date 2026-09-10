# Codex Task 2

- task_id: close-report-live-data-and-voice-retry-hardening-20260910
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: urgent
- recommended_model: Sol High
- purpose: 2026-09-10 16:00 JSTのclose_report失敗を受け、①Voice評価がmax_output_tokens/empty output/JSON parse系で壊れた場合の安全な1回だけの再評価、②大引けなのに終値を取得できず前場データ中心の低品質原稿が生成される問題を修正する。

## Context

直前TASK `morning-report-fact-diagnostics-and-greeting-status-fix-20260910` は実装・本番deployまで完了し、`x-test-post` v91 ACTIVE / `verify_jwt=false`。自然path観測のみ翌朝待ち。今回のTASKは同じ `x-test-post` を触るため、別slotではなくH2に継続して割り当てる。

## Confirmed production incident: close_report 2026-09-10

- scheduled: 2026-09-10 16:00 JST
- scheduled_posts: failed
- X post: 0
- generated_text: 663 chars
- Fact Check: passed
- direct failure: `VOICE_EVALUATION_EMPTY_OUTPUT`
- Voice evaluator response:
  - HTTP 200
  - response_status=`incomplete`
  - finish_state=`max_output_tokens`
  - incomplete_details.reason=`max_output_tokens`
  - reasoning items only
  - extracted text chars=0
- Therefore X API was correctly not called.

## Quality issue found in same run

16:00の「大引け」なのに、取得できた主要市場データは主に前場時点だった。

- 日経平均終値: 未取得
- TOPIX終値: 未取得
- Growth250終値: 未取得
- 15:45前後の先物: 未取得
- generated_text itself stated that final values were not confirmed and relied on 11:xx JST market information.

今回たまたまVoice gateで止まったが、この品質の原稿を「大引け」としてXへ出してはいけない。

## Required work A: Voice evaluator transport/output retry

1. close_reportのVoice評価で、以下のような evaluator transport/output failure のみ最大1回再評価する。
   - `VOICE_EVALUATION_EMPTY_OUTPUT`
   - `VOICE_EVALUATION_JSON_PARSE_FAILED`
   - response incomplete / `max_output_tokens` により最終判定JSONが取得できない同等ケース
2. 再評価は同一本文・同一Fact basisに対して行い、本文の意味変更やFact gate緩和はしない。
3. 「評価結果として文章が不適切」と判定された通常のVoice failと、評価API自体が壊れたケースを分離する。
4. retryは最大1回。unlimited retry禁止。
5. 2回目も evaluator output failureならX投稿せず安全にfailed。
6. retry回数・1回目/2回目のdiagnosticsを既存runログへ安全に残す。secret/raw token等は保存しない。
7. morning_report / useful_tip等への横展開は今回必須ではない。共通化が安全かつ最小差分なら検討可だが、scopeを無用に拡大しない。

## Required work B: Close report must have real close data

8. live close_reportを「大引け」として投稿するための最低限の市場データ品質gateを追加する。
9. 少なくとも以下を必須候補として扱い、実際の16:00 close_reportで当日終値が取得できない場合はX投稿しない。
   - 日経平均 当日終値
   - TOPIX 当日終値
10. Growth Market 250 / 売買代金 / 15:45頃先物等は取得経路と安定性を調べ、確実に取得可能なら品質向上に使う。ただし必須gateをむやみに増やして可用性を壊さない。
11. 前場値・11時台の市場データを「大引け」の終値として代用しない。
12. timestamp/freshnessを厳格に確認し、当日大引け後の値であることを検証する。
13. 終値取得不能なら、`CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE` 等の明確なreasonをrunへ保存してX投稿前に停止する。
14. 取得不能をAIに文章で言い訳させて投稿するfallbackは禁止。
15. Fact gateを緩めない。

## Investigation

16. 現在のclose_report取得経路を確認し、なぜ16:00時点で前場情報しか取れなかったかを特定する。
17. 公式/信頼できる既存許可sourceで当日終値を安定取得できる経路を優先する。
18. 取得元追加が必要なら最小限。無差別web検索増加は禁止。
19. read-only production確認は可。手動X投稿/人工candidate/本番DB書込は禁止。

## Tests

- close_report Fact/data freshness/format tests
- Voice evaluator retry tests
- 1回目 EMPTY_OUTPUT → 2回目 success → X投稿可能になること
- 1回目/2回目とも evaluator output failure → X未到達
- 普通のVoice rejectionを無限retryしないこと
- 16:00 liveで日経/TOPIX当日終値不足 → X未到達
- 前場データだけではclose data gateを通過しないこと
- valid当日終値あり →既存Fact/Voiceを経て投稿可能
- full `x-test-post` regression
- changed pure modules `deno check`（既存由来エラーは分離）
- `git diff --check`

## Production / safety

今回の割当は実装・テスト・commit/pushまで。

本番 `x-test-post` deployはC2レビュー後に別途明示承認を受けること。

禁止:
- 手動X投稿
- 手動close_report publish
- Cron / scheduler / posting_windows変更
- DB schema / migration / RLS / GRANT / RPC変更
- secrets / OAuth変更
- 他Edge Function deploy
- morning_greeting / morning_reportの今回TASK外変更
- important-news / Pushアプリ変更
- Fact gate緩和
- unlimited retry

既存未コミット変更は他workstream所有として触れない。必要ならclean worktreeを使用し、作業前にorigin/mainをfresh-checkする。

## Completion

- root cause分析
- close data quality gate実装
- Voice evaluator output failureの最大1回retry実装
- targeted + full tests pass
- commit/push済み
- `.agent/CODEX_REPORT_2.md` 更新
- status: review_required
- next_owner: chatgpt
