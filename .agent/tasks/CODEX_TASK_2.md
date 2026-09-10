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
- reason: 実終値が無い場合に安全停止するgateは実装されたが、今回TASKで要求した「なぜ16:00時点で前場情報しか取れなかったかの取得経路分析」と「当日終値を安定して取得する経路」の実装・検証がReport上未完了。現状のままでは品質事故は防げるが、毎日終値取得に失敗してclose_report自体が投稿されない可能性が残る。

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
- numeric / source-backed / fresh / same JST date / 15:00 JST以降を要求。
- 前場値・11時台値はgateを通過しない。
- 不足時は `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE` でX前に停止。
- AIに「終値未確認」と言い訳させて投稿するfallbackは禁止のまま維持。

### Tests already accepted

- targeted close_report + Voice retry: 51 passed / 0 failed
- full `x-test-post`: 372 passed / 0 failed
- pure-module deno check: pass
- git diff --check: pass
- whole index.tsの既存6 type errorsは今回scope外として分離可。

## Required follow-up C: actually acquire same-day close values reliably

1. `origin/main`をfresh-checkし、他slotが `supabase/functions/x-test-post/**` や同じproduction設定を変更中でないことを再確認する。
2. 既存ローカル未コミット変更には触れず、必要ならclean worktreeを使う。
3. 2026-09-10 16:00 runで、なぜ日経平均/TOPIXが前場情報しか取得できなかったのか、現在のcollection request・source selection・timestamp extraction経路をコード上で具体的に特定する。
4. 「gateで止めるだけ」で終わらず、15:30以降に当日の日経平均・TOPIX終値を安定して取得できる既存許可source / 直接指数ページを優先する経路を実装または既存collectionへ明示的に誘導する。
5. ユーザー確認では株探トップ/指数ページのように15:30確定値を直接表示する経路が利用可能だった。特定サイトの無断スクレイピング固定を前提にせず、現在の許可sourceポリシーと取得方式を確認した上で、記事検索より指数の確定値ページを優先できる安全な最小実装を選ぶ。
6. 日経平均・TOPIXそれぞれ、取得値に以下を必須とする。
   - same JST trading date
   - observed timestamp >= 15:00 JST（可能なら15:30以降を優先）
   - numeric close value
   - source URL
   - stale/front-session rejection
7. 大引け記事の検索インデックス反映待ちだけに依存しないこと。指数確定値を取る経路と、材料/テーマを集めるニュース検索を分離できるならその方針を優先する。
8. 無差別なweb search追加は禁止。必要な追加取得は日経/TOPIX closeのための限定的なものにする。
9. 取得経路が一時的に失敗した場合は、既に実装済み `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE` gateで安全停止する。
10. Production DBはread-only確認のみ可。手動X投稿、手動close_report publish、人工candidate、本番OpenAI/API invocationは禁止。

## Required tests for follow-up

- 15:30以降のsame-day Nikkei closeを正しく採用する。
- 15:30以降のsame-day TOPIX closeを正しく採用する。
- 同日でも前場/11時台データは採用しない。
- 前日終値・timestamp不明・source不明は採用しない。
- valid close valuesが取れた場合、close-data gateを通過して既存Fact/Voice経路へ進む。
- close source取得失敗時は `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE` でX未到達。
- 既存Voice single-retry testsを維持。
- targeted + full `x-test-post` regression。
- changed pure modules deno check。
- `git diff --check`。

## Production / safety

- 今回のfollow-up承認は実装・テスト・commit/pushまで。
- 本番 `x-test-post` deployはまだ禁止。C2再レビュー後に明示承認を受ける。

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
- 無差別web検索増加

## Completion

- Voice single retry実装済み
- close-data safety gate実装済み
- close data取得失敗の具体的root causeをReport
- same-day Nikkei/TOPIX closeの安定取得経路を実装/検証
- targeted + full tests pass
- commit/push済み
- `.agent/CODEX_REPORT_2.md` 更新
- status: review_required
- next_owner: chatgpt
