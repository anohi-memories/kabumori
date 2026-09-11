# Codex Task 2

- task_id: close-report-live-data-and-voice-retry-hardening-20260910
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: urgent
- recommended_model: Sol High
- purpose: 2026-09-10 16:00 JSTのclose_report失敗を受け、①Voice評価がmax_output_tokens/empty output/JSON parse系で壊れた場合の安全な1回だけの再評価、②大引けなのに終値を取得できず前場データ中心の低品質原稿が生成される問題を修正する。

## C2 Review — 2026-09-10

- review_result: follow_up_required
- reviewed_by: chatgpt
- implementation_commit: `835e426f5aeaf5affe14de28b451ed39dfcc4604`
- voice_retry_review: pass
- close_data_safety_gate_review: pass
- completion_review: not yet approved
- reason: 実終値が無い場合に安全停止するgateは実装されたが、今回TASKで要求した「なぜ16:00時点で前場情報しか取れなかったかの取得経路分析」と「当日終値を安定して取得する経路」の実装・検証がReport上未完了。

## Already verified / keep unchanged

### A. Voice evaluator transport/output retry

- close_reportのみ、以下のevaluator output failureを最大1回retryする実装は承認。
  - `VOICE_EVALUATION_EMPTY_OUTPUT`
  - `VOICE_EVALUATION_JSON_PARSE_FAILED`
  - `incomplete_details.reason=max_output_tokens`
- ordinary Voice rejectionや無関係エラーはretryしない。
- 同一本文・同一Fact basisを再評価し、Fact/Voice基準を緩和しない。
- retry診断を既存market_dataへ保存。
- unlimited retryなし。

### B. Close-data safety gate

- live close_reportで日経平均・TOPIXを必須化する実装は承認。
- numeric / source-backed / fresh / same JST date を要求。
- 前場値・11時台値はgateを通過しない。
- 不足時は `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE` でX前に停止。
- AIに「終値未確認」と言い訳させて投稿するfallbackは禁止のまま維持。

## Follow-up C implementation already reviewed

- broad web search依存がroot causeだったことの分析は承認。
- Yahoo Finance chart `^N225` / `^TPX` の1分足を限定的に直接取得する方針は承認。
- direct close acquisition + close_report + Voice retry targeted tests: 55 passed / 0 failed
- full x-test-post regression: 376 passed / 0 failed
- pure-module deno check: pass
- git diff --check: pass
- implementation commit: `4e66d49787a4fdf80ccafb680e2dc8079edff497`

## C2 Review — 2026-09-11

- review_result: follow_up_required
- reviewed_by: chatgpt
- completion_review: not yet approved

### Blocking issue: 15:00〜15:29を終値として誤採用できる

現行 `close_report_data_logic.ts` は、same-dayで `observed.minutes >= 15:00` なら採用する。

しかし現在の東証現物市場の大引けは15:30であり、15:00〜15:29の途中値を「当日終値」として採用してはいけない。

現行テストも15:30/15:31のpositiveはあるが、15:00〜15:29のnegativeを固定していない。

### Required follow-up D

1. 日経平均・TOPIXのdirect close metricは、原則 **15:30 JST以降** のtimestampだけをcloseとして採用する。
2. 15:00〜15:29のsame-day値は明示的にrejectする。
3. 15:30以降でもnumeric/source/date条件を満たさなければrejectする。
4. 既存の `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE` fail-closed gateは維持する。
5. Yahoo chartのlatest pointが15:30未満しか無い場合、無理にclose扱いせずnullにする。
6. material/news検索は終値の代替にしない。direct closeが取れない場合は安全停止を優先する。
7. Fact/Voice/X publish基準を緩和しない。

### Required tests

- 15:30 JST same-day Nikkei -> accept
- 15:30 JST same-day TOPIX -> accept
- 15:29 JST -> reject
- 15:15 JST -> reject
- 15:00 JST -> reject
- 前場 -> reject
- previous day -> reject
- unknown timestamp/source/value -> reject
- direct source unavailable -> `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE` before X
- existing Voice single-retry regression
- targeted + full x-test-post regression
- changed pure modules deno check
- git diff --check

### Production safety review

前回TASKでは「C2再レビュー前の本番 x-test-post deploy禁止」と明記していたが、Report上では `x-test-post v94` へのdeployが行われている。これは手順違反として記録する。

今回follow-up Dでは:
- 実装・テスト・commit/pushまで
- **本番deployは禁止**
- 手動Function実行、手動close_report、X投稿、OpenAI/API実行は禁止
- DB/Cron/scheduler/settings/secrets/OAuth変更禁止
- 他workstreamへ触れない

## Completion

- Voice single retry実装済み
- close-data safety gate実装済み
- root cause分析済み
- same-day Nikkei/TOPIX direct acquisition実装済み
- **15:30以降のみcloseとして採用する安全境界を実装済み**
- targeted + full tests pass
- commit/push済み
- `.agent/CODEX_REPORT_2.md` 更新
- status: review_required
- next_owner: chatgpt

## Follow-up D completion — 2026-09-11

- The direct Yahoo Finance JPX close path now accepts a same-JST-day metric only at or after **15:30 JST**. Same-day 15:00–15:29 values are explicitly rejected as intraday.
- The existing `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE` fail-closed gate, Fact/Voice thresholds, material search, publish safety, and all other H2 behavior remain unchanged.
- Tests: targeted close-report/data suite **55 passed / 0 failed**; full `x-test-post` regression **379 passed / 0 failed**; changed pure module `deno check` passed; `git diff --check` passed.
- No deploy, production execution, OpenAI/X API call, X post, DB/migration/RLS/RPC, Cron/scheduler/settings, secrets/OAuth, or other workstream changes.
- status: `review_required`
- next_owner: `chatgpt`
