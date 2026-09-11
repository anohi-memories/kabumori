# Codex Task 2

- task_id: close-report-1700-schedule-and-close-source-hardening-20260911
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: urgent
- recommended_model: Sol High
- purpose: 大引けレポートを16:00 JSTから17:00 JSTへ変更し、生成・Cron・posting_windows・自動投稿判定を整合させる。あわせて、2026-09-11 16:00自然実行でNikkei/TOPIX終値が取得できず `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE` になった原因を踏まえ、17:00時点で当日終値を安定取得できる経路を監査・改善する。

## Context

2026-09-11の自然なclose_report実行は16:00 JSTに走ったが、以下で失敗した。

- status: failed
- error: `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE`
- Nikkei: empty
- TOPIX: empty
- source_urls: empty
- X post: 0

既存v95では:
- Yahoo Finance chart `^N225` / `^TPX` のdirect acquisitionあり
- same JST date / numeric / source-backed
- 15:30 JST以降だけcloseとして採用
- 取得不能時はfail-closed
- Voice evaluator output failureはclose_reportのみ最大1回retry

安全性は改善したが、16:00時点ではdirect sourceから有効な当日終値を取得できなかった。

ユーザー方針:
- 大引けレポートを **17:00 JST** に変更して試す
- 必要なら **X自動投稿側の時間も17:00基準へ変更して整合させる**
- 単にCronだけ変えて投稿判定が16:00前提のまま、という不整合は残さない

## Model

スケジュール、production設定、posting_windows、自動投稿判定、close data取得経路を横断するため **Sol High** を使用する。

## Required startup checks

1. `.agent/ORCHESTRATION.md`
2. `.agent/CURRENT_STATE.md`
3. このTASK
4. `origin/main` fresh-check
5. clean worktree確認
6. 他slot TASKをread-only確認
7. 他slotが `supabase/functions/x-test-post/**`、close_report設定、posting_windows、同じCron/schedulerを変更中なら開始せず競合報告
8. 既存未コミット変更には触れない
9. production deploy/change前には必ず root / HEAD / config / project ref を確認する

## Phase A: 17:00 schedule audit

まず現在のclose_reportの実行時刻を決めている全経路をコード・DB・Cron設定から列挙する。

最低限監査:
- Supabase Cron / pg_cron / scheduler
- `posting_windows`
- `scheduled_posts`
- `close_report_settings`
- `x-test-post` 内のcategory/time判定
- plan/claim系RPCや関数
- auto_publish判定
- 16:00固定値・JST/UTC変換

Reportに「どこが実行時刻の正本か」を明記する。

## Phase B: change close_report to 17:00 JST

close_reportの自然実行を **17:00 JST** に変更する。

要件:
- 生成開始時刻を17:00 JSTへ
- X自動投稿判定・posting windowも必要なら17:00基準へ揃える
- UTCでは08:00として扱う（DSTなしのJST前提）
- morning_report / morning_greeting / other categoriesの時間は変更しない
- close_report以外の投稿枠をずらさない
- 同日二重生成・二重投稿を起こさない
- existing publish_claim / dedupeを維持

既存の仕組み上、Cronは毎分で「due判定」する構造なら、Cron自体ではなくdue/posting_window側だけを変えるなど、最小変更を選ぶ。

## Phase C: close source reliability at 17:00

17:00へ遅らせるだけでYahoo chartの15:30以降pointが安定して取得できるか、コードと可能ならread-only実データ/HTTPの性質を監査する。

重要:
- 「17:00ならたぶん取れる」で終わらせない
- 2026-09-11 16:00 runでdirect acquisitionが空だった具体的原因を可能な範囲で特定する
- Yahoo chartレスポンスのtimestamp/interval/rangeの特性、当日終値point反映タイミングを確認する
- 17:00時点でも不安定なら、既存許可sourceの範囲で安全なfallback/primary経路を設計する
- 特定サイトの脆いHTMLスクレイピング固定は避ける
- 無差別web searchを終値取得の代替にしない
- 終値取得経路と材料ニュース検索は分離する

推奨優先順位:
1. same-day確定値を直接返す構造化source
2. Yahoo chart direct source
3. source-backed同日終値を明示取得できる既存許可経路
4. 全て失敗 -> `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE`

ただし新規source導入が安全に確定できない場合は、今回は17:00化＋現行Yahoo sourceの挙動改善までに留めてもよい。その場合はremaining issueへ明記する。

## Data validity requirements

Nikkei / TOPIXとも:
- same JST trading date
- observation timestamp >= 15:30 JST
- numeric close
- source URL
- stale/front-session rejection
- previous-day rejection
- unknown timestamp rejection

17:00実行だからといって16時台のニュース本文から推測した数値をclose扱いしない。

## Required tests

最低限:
- close_report due at 17:00 JST
- 16:00 JSTではdueにならない
- 16:59ではdueにならない
- 17:00ではdue
- UTC 08:00との変換確認
- other posting categories unchanged
- close_report posting window / auto-post pathが17:00と整合
- same-day duplicate prevention維持
- 15:30以降のNikkei/TOPIX close accept
- 15:29以前reject
- previous day / unknown / source missing reject
- source取得失敗 -> `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE`
- Voice single-retry regression
- close_report targeted tests
- full `x-test-post` regression
- changed pure modules `deno check`
- `git diff --check`

## Production safety

### DB / schedule changes

スケジュール変更がDB値の更新だけで済む場合:
- 現在値をread-onlyで確認
- 変更対象とrollback値をReport
- 必要最小限のUPDATEのみ
- schema migration不要ならmigrationを作らない

Cron変更が必要なら:
- 既存job名/commandを確認
- close_report関連だけ変更
- 他7/8本のCronへ触れない
- 変更前後をread-back

### x-test-post deploy

コード変更が必要な場合のみdeployする。
- `pwd`
- `git HEAD`
- `origin/main`
- worktree-local `supabase/config.toml`
- project ref `wsmznyzcvmuitkglfeuj`
- `[functions.x-test-post] verify_jwt=false`
- `--no-verify-jwt`
- deploy後 `functions download --use-api`
- 全function files byte compare
- 他Edge Function version / updated_at不変確認

repoに `supabase/config.toml` が無い場合は、前回承認済み方針どおりclean clone内だけの一時configを使用してよい。正本へはcommitしない。

## Explicit production authorization

このTASKでは、ユーザーが「17:00へ変更し、必要ならX自動投稿時間も変えてよい」と明示しているため、close_reportに必要な **production schedule / posting_window設定変更と、必要なx-test-post deploy** まで実施してよい。

ただし以下は禁止:
- 手動X投稿
- 手動close_report publish
- 人工candidate
- 同日強制再実行
- OpenAI/X APIの手動呼び出し
- morning系その他categoryの時刻変更
- unrelated Edge Function deploy
- DB schema/RLS/RPC変更（必要なら一旦停止してC2相談）
- secrets/OAuth/Vault/social_accounts変更
- important-news/Push系変更

## Natural observation

今日の同日再実行はしない。
次の自然な営業日の17:00 runで:
- schedulerが17:00に走る
- Nikkei/TOPIX same-day closeを取得
- Fact/Voiceを通る
- X投稿成功、または正当な品質gateで停止

をread-onlyで観測する。

## Completion

完了時:
- status: `review_required`
- next_owner: `chatgpt`
- `.agent/CODEX_REPORT_2.md` 更新
- origin/main同期

Report必須:
- task_id
- result
- model_used
- current_schedule_audit
- schedule_source_of_truth
- changes_to_1700
- x_auto_post_time_changes
- close_source_root_cause
- close_source_changes_or_none
- tests
- production_changes
- x_test_post_deploy_or_none
- deploy_verification
- cron/posting_window readback
- unchanged_scopes
- changed_files
- commit_hash
- push
- remaining_issues
- next_recommendation
