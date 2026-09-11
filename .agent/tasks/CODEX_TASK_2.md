# Codex Task 2

- task_id: close-report-1700-schedule-and-close-source-hardening-20260911
- owner: codex
- slot: codex-2
- status: done
- next_owner: user
- priority: urgent
- recommended_model: Sol High
- purpose: 大引けレポートを16:00 JSTから17:00 JSTへ変更し、生成・Cron・posting_windows・自動投稿判定を整合させる。あわせて、2026-09-11 16:00自然実行でNikkei/TOPIX終値が取得できず `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE` になった原因を踏まえ、17:00時点で当日終値を安定取得できる経路を監査・改善する。

## C2 Final Review — 2026-09-11

- review_result: approved
- reviewed_by: chatgpt
- implementation_commit: `955a3ab5edc95a63fce181c07c0d7460b7e2961c`
- production_version: `x-test-post v96`
- production_status: ACTIVE
- verify_jwt: false

### Approved outcome

- close_report scheduling source of truth remains `close_report_settings.center_time` via `plan_close_report()`.
- Production close_report time changed from 16:00 JST to 17:00 JST.
- `close_report_settings`: 16:58–17:00–17:02 JST.
- `posting_windows`: 16:58–17:02 JST; existing inactive state preserved.
- pg_cron remains every minute and was not changed.
- X auto-post / due path is aligned to the 17:00 scheduled claim.
- `resolveCloseRunMode()` uses the approved tolerant execution window around 17:00 while DB due time remains exactly 17:00.
- Direct Nikkei/TOPIX acquisition changed to Yahoo structured query2 chart endpoint with `range=5d&interval=1m`.
- Live close data still requires same JST date, numeric/source-backed data, and observation timestamp >=15:30 JST.
- Missing/invalid close data still fails closed with `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE`.
- Existing Fact/Voice gates and close-report-only Voice single retry remain unchanged.
- morning_report / morning_greeting / tip / interaction / us_premarket_report schedules were not changed.

### Verification

- targeted close-data/close-report/Voice tests: 60 passed / 0 failed
- full x-test-post regression: 381 passed / 0 failed
- changed pure-module deno check: pass
- git diff --check: pass
- production `x-test-post v96 ACTIVE`, `verify_jwt=false`
- post-deploy source download completed and runtime files byte-matched deploy source
- other Edge Function versions / updated_at unchanged
- no manual close_report run, OpenAI/X API execution, X post, DB schema/migration/RLS/RPC, Cron definition, secrets, OAuth, or unrelated category changes

### Remaining monitoring only

- 次の自然なJPX営業日の17:00 runをread-onlyで観測する。
- Nikkei/TOPIX当日終値取得、Fact/Voice通過、X投稿成功または正当な品質gate停止を確認する。
- 同日手動再実行や人工投稿は不要。

## Completion

- status: done
- next_owner: user
