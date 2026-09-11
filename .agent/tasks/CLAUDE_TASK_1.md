# Claude Task 1

- task_id: personalized-portfolio-morning-close-reports-phase1-20260911
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
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


## Report

- task_id: personalized-portfolio-morning-close-reports-phase1-20260911
- result: Phase 1A complete (foundation deployed, not yet running). DB/RLS/RPC, the generation function, and the app UI are in production and main. Per K1 instructions, no manual generation, saving, Push, or Cron registration was done. Phase 1B (real-data dry-run → one E2E → Cron registration) is left for K1 approval.
- model_used: Claude Opus 5 (implementation). Report generation model = `gpt-5.6-luna` (same as app copy; 1 generation + 1 Fact check per report).

### current_architecture_audit
- The X morning_report / close_report runs are unreliable as a shared input: in the last 4 days, close failed on 09-10 (VOICE_EVALUATION_EMPTY_OUTPUT) and 09-11 (CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE); morning failed on 09-10 (FACT_CHECK_FAILED) and 09-11 (SEARCH_BUDGET_EXCEEDED). close_report_runs.market_data is often empty.
- No per-stock price table exists in the DB. The Yahoo chart API (`<code>.T`, interval=1d) returns daily closes for all 20 tracked stocks, including 285A. The X side uses the same source for Nikkei/TOPIX.
- tracked_stocks: holding/watch, quantity, average_price, position_type (cash/margin), side (long/short) are available. Only 1 production user (2 holdings with quantity/average price, 18 watches).
- alert_settings.morning_report / close_report already exist (default true). send-push-notifications gates any source_type other than important_news on push_enabled only, so no dispatcher change is needed. The payload's source_type/source_id work for deep links.
- notifications_dedupe includes tracked_stock_id (NULL for report notifications), so it cannot prevent duplicate report pushes → added a partial unique index.

### chosen_design
- A standalone lane separate from X: new Edge Function `personalized-reports` + new table. It does not read, write, or wait on X runs, scheduled_posts, or OAuth. The app version is generated even when the X side fails.
- Every number (prices, change, same-day P/L, unrealized P/L, weights, relative strength vs TOPIX) is computed deterministically in code (`report_logic.ts`) and stored in `portfolio_snapshot`. The app renders the numbers from the snapshot.
- The LLM only writes the commentary. Its input is a packet of formatted strings plus Fact-passed news; no URLs or internal IDs are included.
- Local checks run first: numbers not in the packet, unknown tickers, advice/assertive language, URLs, emoji, markup, length limits. Only if those pass does the Fact check run against the packet. Only `completed` + `fact_status=passed` can be displayed or pushed.
- The row claim (INSERT generating + unique) makes the same user/type/date run only once. No retry.

### schema_rpc_rls_changes (`20260911230000_personalized_reports.sql`, expand-only)
- `personalized_reports` table: user_id / report_type(morning|close) / trading_date / status(generating|completed|failed) / title_ja / summary_ja / body jsonb / portfolio_snapshot jsonb / source_basis jsonb / fact_status / fact_issues / model_used / tokens / api_cost_usd / error / generated_at / notified_at.
  - UNIQUE(user_id, report_type, trading_date)
  - CHECK(completed ⇒ fact passed)
  - RLS: SELECT only for authenticated users on their own completed+passed rows. authenticated has SELECT only (no INSERT/UPDATE/DELETE); service_role has full access.
- `notifications_personalized_report_once`: partial UNIQUE(user_id, source_type, source_id) WHERE source_type='personalized_report'.
- `personalized_report_news_inputs(p_user_id, p_since)`: service_role only, SECURITY DEFINER, search_path=''.
  - Runs the existing `get_my_important_stock_news` as the target user, so it uses the same gate, dedupe, and sector ranking.
  - Passes on only 3 kinds of text: app copy (Fact passed), verified post (Fact passed), and verbatim TDnet/company IR titles. Restores claims afterwards.
- `enqueue_personalized_report_notification(p_report_id)`: service_role only.
  - Inserts 1 row only when completed+passed and push_enabled and the matching morning_report/close_report is true. Sets notified_at.
  - Title is fixed: 「今日のあなたのポート見通しができました」 / 「今日のポート振り返りができました」. Body = title_ja (Fact passed). importance normal.
- Not recorded in migration history (single-file apply via db query). schema_migrations max is 20260911020704 (recorded by another slot; not a change from this task).

### generation_pipeline
1. X-Cron-Secret auth (reuses the existing `SEND_PUSH_NOTIFICATIONS_CRON_SECRET`, no new secret).
2. Skip weekends and market_holidays (JPX). close is skipped before 15:30 JST.
3. Fetch the active tracked stocks per user (max 20 users per run, 110 s time budget).
4. Fetch Yahoo daily prices for all stocks plus ^N225 and ^TPX (6 in parallel).
   - close: uses the day's bar only when regularMarketTime is on the day at or after 15:30 JST.
   - morning: last completed session vs the one before.
5. Insert a claim row (`generating`). If it already exists, skip.
6. `personalized_report_news_inputs` (news since 15:00 JST of the previous trading day).
7. Snapshot → packet → generation → local checks → Fact check.
8. Save.
9. Only if completed, call the enqueue RPC.

`dry_run: true` writes nothing and enqueues nothing (not run this time).

### personalization_inputs
holding/watch split; quantity, average price, cash/margin, long/short; ticker code, company name, sector; the day's per-stock important news (Fact-gated); market-wide critical/high news matching tracked sectors (the /news logic as-is); Nikkei and TOPIX; holding sector weights (by market value when every holding is valued, otherwise by count).

### morning_report_output
- The AI writes: title / summary / tone (positive|neutral|cautious, never assertive) / 今日のポート見通し / notes for the TOP3 holdings by impact and all holdings (priority = own news severity > sector-matched market news > position size) / notable watch stocks (max 5) / risks such as sector concentration (max 3) / today's checkpoints (1–4).
- The code computes: previous close, previous-session change, market value, unrealized P/L vs average price, and index figures.

### close_report_output
- The AI writes: 今日のポート総括 (uses the code-computed TOPIX comparison label only when available) / price move and confirmed news per holding / watch stocks with notable moves or news / points to watch tomorrow.
- The code computes: close, change vs previous day, same-day P/L (sign × quantity × (close − previous close)), unrealized P/L (shown separately to avoid confusion), portfolio P/L and %, the pt difference vs TOPIX (±0.3pt = about the same), and the top 3 up/down contributors.
- The AI is forbidden from stating causes. It lists them as facts confirmed on the same day.

### notification_behavior
- One completion push per report. The body shows only the title; details are in the app. Tapping opens `/reports/<id>`.
- No push when: generation failed / Fact failed / morning_report OFF / close_report OFF / push_enabled OFF / second attempt.
- The dispatcher (send-push-notifications) is unchanged. Existing important_news pushes are unchanged; this task adds only new functions.

### app_ui_changes
- New 「レポート」 tab (native: SF chart.line.uptrend.xyaxis / web: text tab), separate from the news tab.
- List: today's 朝刊 and 大引け cards (with updated time; an empty card with the schedule when none exists), 朝刊通知 / 大引けレポート通知 switches, past reports.
- Detail: tone badge, index and portfolio figures (from code), TOPIX comparison, summary, up/down contributors, per-holding cards (TOP3 numbered in the morning; price, P/L, unrealized, note, links to related news), watch stocks, sector-weight bars, points of caution, market news, checkpoints, missing-data notes, disclaimer (numbers computed by the app / AI text checked against the data / not a trading recommendation).
- `use-push-notification-navigation`: routes `personalized_report` to the report detail (important_news behaviour unchanged).

### tests
- `supabase/functions/personalized-reports/report_logic_test.ts`: 22/22 pass. Covers:
  - trading days / holidays / news window
  - Yahoo parsing, close requires 15:30 or later, morning uses the previous session
  - holding/watch separation, holding priority
  - safe fallback when quantity or average price is missing; short position signs
  - blocking when all prices are missing
  - no URLs or IDs in the packet
  - numbers not in the packet, unknown tickers, advice/assertion, URLs
  - positive morning and positive close
  - Fact failure → no text (no push); local check failure → no Fact call
  - missing data → 0 model calls; transport errors mapped to safe codes
- `tests/app/report-presentation_test.ts` + the existing news tests: 25/25 pass. Covers:
  - formatting; holding/watch display (watch shows no P/L)
  - fallback when quantity is missing; no guessed values when a price is missing
  - morning wording; TOPIX comparison and missing-data notes
  - deep link (only personalized_report routes, invalid IDs go to `/reports`)
- Rolled-back production pre-test (all ROLLBACK). Results:
  - RLS: own rows 1 (failed rows hidden) / other user 0; authenticated INSERT denied.
  - Both RPCs denied to authenticated.
  - Duplicate same-day row blocked; completed with fact failed blocked.
  - Pushes: failed report 0 / morning OFF 0 / close OFF 0 / push_enabled OFF 0 / first 1 / second 0; notified_at set.
  - news inputs 4 of 4 rows (app_copy 2, verified_post 1, disclosure_title 1); 0 rows violating the gate; claims restored.
- `deno check` (index.ts, test) OK. App `tsc --noEmit`: 0 errors under src/ (existing errors outside apps/admin, supabase/, and tests are unrelated). `git diff --check` OK.

### real_data_proof
- Not run, per the K1 instruction (no manual generation, save, or Push). Confirmed instead with read-only checks:
  - Yahoo returns daily data for all 20 production tracked stocks, including 285A.
  - The production feed passes through the Fact gate without leaks (pre-test above).

### production_changes
1. Applied `supabase/migrations/20260911230000_personalized_reports.sql` alone (`supabase db query --linked -f`, no db push). Result: rows=[] (success).
2. Deployed the new Edge Function `personalized-reports` v1 (`--no-verify-jwt`, from the worktree, HEAD=ed7c2f7, ref wsmznyzcvmuitkglfeuj, verify_jwt=false entry added to the local config.toml).

### deploy_verification
- `supabase functions download personalized-reports --use-api` into an empty directory:
  - index.ts matches ed7c2f7 byte for byte (cmp)
  - report_logic.ts matches ed7c2f7 byte for byte (cmp)
- Other functions' version/updated_at unchanged before and after deploy: x-test-post v96, important-news-monitor v40, send-push-notifications v4, stocks-master-sync v6, stocks-new-listing-sync v5, x-oauth-connect v4.
- POST without the secret → 401; POST with a wrong secret → 401 (generates nothing).
- Read-only DB check:
  - personalized_reports: 0 rows, RLS enabled, 1 policy (SELECT authenticated, own + completed + passed)
  - grants: authenticated SELECT only
  - both RPCs: service_role EXECUTE only, SECURITY DEFINER, search_path=''
  - partial unique index present
  - notifications 0 (personalized_report 0); report HTTP calls in net._http_response 0
  - cron 8 jobs, unchanged (no report cron); auto_publish=true unchanged
  - user settings unchanged (morning/close/push/important/market all true, i.e. DB defaults plus the user's own ON)

### changed_files
- supabase/migrations/20260911230000_personalized_reports.sql (new)
- supabase/functions/personalized-reports/index.ts, report_logic.ts, report_logic_test.ts (new)
- src/app/reports/_layout.tsx, index.tsx, [id].tsx (new)
- src/lib/personalized-reports.ts, src/lib/report-presentation.ts (new)
- tests/app/report-presentation_test.ts (new)
- src/components/app-tabs.tsx, src/components/app-tabs.web.tsx, src/hooks/use-push-notification-navigation.ts (modified)
- Local only, not in Git: supabase/config.toml (added a verify_jwt=false entry for personalized-reports)

### commit_hash
- Implementation: `ed7c2f7fb9f7100a599d720c22207319fb92c30f`
- Report: this commit

### push
- origin/main (fast-forward)

### remaining_issues
- Phase 1B (needs K1 approval):
  1. `dry_run` run on production data to check quality: from SQL, call via net.http_post with the Vault secret, as cron does; the secret never leaves the DB.
  2. One real generation → push delivered to the device → tap opens the report.
  3. Cron registration (planned: morning 08:35 JST = `35 23 * * 0-4` UTC, close 17:15 JST = `15 8 * * 1-5` UTC, Vault `send_push_notifications_cron_secret`, after the X close report at 17:00).
- alert_settings.morning_report / close_report default to true, so the existing user will get pushes once Cron starts. The in-app switches can turn them OFF. Please decide in K1 whether defaults should change to opt-in (not changed this time).
- No retry after a failure (a transient Yahoo or OpenAI failure means no report that day). The claim also stays failed when the time budget is exceeded. A retry policy needs a separate design.
- The morning report has no overnight US market or futures input (no reusable source that passed Fact checks; the X morning report runs are unreliable). To be considered in Phase 2.
- The Yahoo chart API is unofficial (same dependency as the X side).
- Existing issues carried over: migration history drift (this migration is not recorded either), 17 test watch stocks to delete after E2E, config.toml untracked, etc.

### safety_checks
- No `supabase db push`. No changes to other migrations, RPCs, Edge Functions, Cron, secrets, OAuth, Vault, or social_accounts.
- No X-related changes (x-test-post unchanged at v96; X quality gates, posting times, and volume untouched).
- No personalized report generation, saving, or push. notifications 0; personalized_reports 0 rows.
- No changes to production user settings; no fake holdings added.
- Did not touch the shared checkout's uncommitted changes; no secrets printed.

### next_recommendation
In K1, approve Phase 1B:
1. Production dry_run: check quality, including the local-check and Fact pass rate.
2. One real close report E2E: generate → push → tap opens the report.
3. Cron registration.

Before item 3, decide whether morning_report / close_report should default to true or become opt-in.
