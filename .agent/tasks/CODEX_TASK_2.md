# Codex Task 2

- task_id: morning-report-fact-diagnostics-and-greeting-status-fix-20260910
- owner: codex
- slot: codex-2
- status: ready
- next_owner: codex
- priority: urgent
- recommended_model: Sol High
- purpose: `x-test-post` の朝系2件を最小変更で修正する。① morning_report のFact失敗時に実際の失敗理由・retrieval diagnosticsが消えて原因不明になる問題、② morning_greeting がX投稿成功後のlegacy Storage receipt保存400で scheduled_posts / 管理画面上だけfailedになる問題。

## Confirmed production symptoms

### A. morning_report 2026-09-10

- scheduled_post: 2026-09-10 08:20 JST
- result: `failed`
- error: `MORNING_REPORT_FACT_CHECK_FAILED`
- model: `gpt-5.6-luna`
- `fact_check_notes=[]`
- `source_urls=[]`
- `market_data={}`
- `generated_text=null`
- X投稿前に停止している。
- 現コードでは通常のFact失敗catch時に `draft.factCheckNotes` / retrieval diagnostics を保存せず、voice/lane系だけ詳細保存するため、どのFact gateで落ちたか本番記録から特定不能。

### B. morning_greeting 2026-09-10

- X投稿自体は成功。
- authoritative `publish_claims` は `status=published`、X post ID保存済み。
- その後のlegacy Storage receipt `published/YYYY-MM-DD.json` 保存がHTTP 400。
- `morning-greeting-assets` bucketは image/png, image/jpeg, image/webp のみ許可され、JSON receiptと不整合。
- error: `MORNING_GREETING_X_POST_RECORD_FAILED:400`
- その例外により scheduled_posts / 管理画面上は `failed` になる。
- コードコメント上もDB `publish_claims` がauthoritativeで、Storage receiptはbackward compatibility用。

## Required work

1. `.agent/ORCHESTRATION.md`、`.agent/CURRENT_STATE.md`、このTASK、`.agent/CODEX_REPORT_2.md` を確認。
2. `origin/main` fresh-checkし、他slotが `supabase/functions/x-test-post/**` または同じproduction設定を変更中でないことを確認。競合があれば開始せず具体的に報告。
3. 既存未コミット変更は他workstream所有として触れない・stageしない・commitしない。

### A. Morning report Fact failure observability

4. live scheduled morning_report のplain Fact失敗時にも、draftが存在する限り次を失わず `morning_report_runs` へ保存する。
   - `fact_check_notes = draft.factCheckNotes`
   - `source_urls`
   - `market_data_timestamp`
   - token / web search / cost（取得済みなら）
   - retrieval diagnostics / candidate counts / publisher count 等、既存 `morningRunMarketData(...)` で安全に保存できる診断情報
   - generated_text / character_count は実際にdraft textがある場合のみ正しく保存
5. `MORNING_REPORT_FACT_CHECK_FAILED` のFact gate自体は今回緩和しない。原因追跡可能性の修正が主目的。
6. Fact失敗をVoice失敗扱いにしない。既存Voice/Lane failure loggingとretry semanticsを壊さない。
7. dry-run / liveで診断保存の意味が乖離しないよう確認する。
8. regression testで、plain Fact failure時に `fact_check_notes` が `[MORNING_REPORT_FACT_CHECK_FAILED]` や空配列へ潰れず、draft由来の具体的理由を保存することを固定する。

### B. Morning greeting X-success / admin-failed split brain

9. `publish_claims` をauthoritativeな投稿完了記録として維持する。
10. X投稿成功 + `completePublishSlot(...)` 成功後のlegacy Storage receipt保存失敗を、投稿全体の失敗へ昇格させない。
11. 最小安全案を優先:
    - legacy receipt writeをbest-effort化してwarningのみ、または
    - backward compatibility上不要と確認できればwriteを廃止。
    どちらでも `x_posted=true` / DB claim `published` 後に `MORNING_GREETING_X_POST_RECORD_FAILED:*` でscheduled postをfailedへ落とさないこと。
12. duplicate preventionはatomic DB `publish_claims` を維持し、二重X投稿を絶対に増やさない。
13. 既存receiptが存在する過去日のduplicate check互換性を壊さない。
14. regression testで以下を固定する。
    - X post成功
    - DB claim complete成功
    - legacy receipt write 400
    - runは投稿成功として扱われる
    - `failPublishSlot` でpublished claimをfailedへ戻さない
    - 同日再実行でXへ二重投稿しない
15. scheduled path側でも、成功結果がscheduled_postsを成功扱いにできることを既存mock/test範囲で確認する。

## Testing

- morning_report関連テスト
- morning_greeting publish / claim / scheduled path関連テスト
- `x-test-post` 全体回帰テスト
- changed pure modules `deno check`（既存由来エラーは分離報告）
- `git diff --check`

## Production / safety

今回のTASK割当は **実装・テスト・commit/pushまで** を承認する。

本番 `x-test-post` deployはこのTASKではまだ実行しない。C2レビュー後、必要なら明示承認を受けてdeployする。

禁止:
- 手動X投稿
- 手動morning_greeting publish
- 手動candidate注入
- Fact gateの緩和
- Cron / scheduler / posting_windows変更
- DB schema / migration / RLS / GRANT / RPC変更
- secrets / OAuth変更
- 他Edge Function deploy
- important-news / close_report / Pushアプリの変更
- legacy backlog再実行

Production DB確認が必要な場合はread-onlyのみ。

## Completion

- root causeに対応する最小実装完成
- targeted + full regression tests pass
- commit/push済み
- `.agent/CODEX_REPORT_2.md` に変更点、テスト、残課題、本番deploy未実施を明記
- `status: review_required`
- `next_owner: chatgpt`
