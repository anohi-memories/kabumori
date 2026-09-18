# Codex Task

- task_id: important-news-web-search-cost-throttle-20260919
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: urgent
- recommended_model: Sol Medium
- purpose: OpenAI Web Search費用を抑えるため、productionの重要ニュースfetch cadenceだけを安全に最適化する。2026-09-19〜09-23の5連休は2時間おき、2026-09-24以降は通常1時間おき＋朝刊/大引け前後だけ20分刻みで厚く検索する。重要ニュース判定/生成ロジックや他Cronは変更しない。

## Background / confirmed facts

2026-09-19 read-only production audit:
- `important-news-fetch` は現在 `0,20,40 * * * *` で1日72回。
- breaking market Web Search実績:
  - 2026-09-17: 328 calls
  - 2026-09-18: 233 calls
- OpenAI 429は 2026-09-18 18:00 JSTから発生。17:40までは200。
- 重要ニュース監視が直近コストの最大要因。
- ユーザー決定:
  - 9/19〜9/23: 2時間おきで十分
  - 9/24以降: 1時間おき
  - 朝刊・大引けレポートの前後だけ厚く検索

## Mandatory startup

開始前に:
1. `.agent/ORCHESTRATION.md`
2. `.agent/CURRENT_STATE.md`
3. this TASK
4. `.agent/CODEX_REPORT.md`
5. all other TASKs
6. fresh `origin/main`
7. production `cron.job` read-only inventory

Conflict:
- このH1は **jobid/name = important-news-fetch のschedule/commandだけ** を扱う。
- `x-test-post`, market-report Cron, MIC Cron, important-news judgement/generation/publish Cron, OAuth/Vault, Edge Function sourceは変更禁止。
- 他slotが同じ `important-news-fetch` Cronを変更中ならSTOP。

## Desired schedule semantics (JST)

### A. 5連休: 2026-09-19〜2026-09-23 inclusive

OpenAI breaking Web Searchを伴う `important-news-fetch` 実行は **2時間おき**。
推奨: JST 偶数時の 00分（00:00, 02:00, ... 22:00）。

### B. 2026-09-24以降

通常は **1時間おき**（毎時00分）。

加えて朝刊・大引けの前後だけ **20分刻み**にする。

厚くするJST window:
- 朝刊前後: **07:00〜09:00**
- 大引け前後: **16:00〜18:00**

このwindowでは00/20/40分に検索。
それ以外は毎時00分だけ。

意図:
- 朝刊8:20前後に直近材料を拾う
- 大引け17:00前後に直近材料を拾う
- それ以外は毎時でコスト抑制

## Implementation preference

現在のCron trigger `0,20,40 * * * *` を維持してもよいが、**command側でJST date/time gateを入れてHTTP call自体を抑制**する方式を第一候補とする。
理由:
- 9/23→9/24を手動変更なしで自動切替できる
- 1本のjobで管理できる
- pg_cron起動自体のコストは無視でき、OpenAIを呼ぶHTTPだけ抑止できる

条件イメージ:
- JST date <= 2026-09-23:
  - minute=0 AND hour even
- JST date >= 2026-09-24:
  - minute=0
  - OR hour in 07..09 / 16..18 AND minute in (20,40)

境界は必ず `timezone('Asia/Tokyo', now())` 等でJSTを明示し、UTC hour直書きによる日付ズレを避ける。

## Production preflight

Read-onlyで:
- `important-news-fetch` jobid/name/schedule/command hash
- `important-news-judgement`
- `important-news-generation`
- `important-news-publish-ready`
- market-report Cron
- MIC Cron
を記録。

## Allowed production mutation

**`important-news-fetch` Cron 1本のschedule/commandだけ。**

禁止:
- Edge Function deploy/source modification
- `important-news-judgement` / generation / publish_ready変更
- market-report Cron変更
- MIC Cron変更
- DB schema/migration
- secrets/Vault
- OAuth/X
- manual OpenAI call
- manual X/Push
- scheduled post retry/backfill

## Verification

変更後:
1. `important-news-fetch` schedule/command read-back
2. 他Cronの schedule/active/command hash が不変
3. JST gateをSQL上で代表時刻に対してproof:
   - 2026-09-19 08:00 => run
   - 2026-09-19 08:20 => skip
   - 2026-09-19 09:00 => skip（奇数時）
   - 2026-09-24 06:20 => skip
   - 2026-09-24 07:00 => run
   - 2026-09-24 07:20 => run
   - 2026-09-24 08:40 => run
   - 2026-09-24 10:00 => run
   - 2026-09-24 10:20 => skip
   - 2026-09-24 16:40 => run
   - 2026-09-24 18:40 => run
   - 2026-09-24 19:20 => skip
4. Web Search expected daily upper boundを算出:
   - 連休中: fetch 12回/日 × 最大query数
   - 9/24以降: baseline24回 + dense追加分
5. 429中でも無駄な高頻度OpenAI requestが減ることを確認。

## Rollback

即時rollback:
- `important-news-fetch` を元の `0,20,40 * * * *` + 元commandへ戻せるよう、変更前commandをReportにhash付きで保存。
- 問題が無ければrollbackは実行しない。

## Completion / C1 return

完了時:
- `.agent/CODEX_REPORT.md` 先頭に結果
- before/after Cron
- exact SQL/change method
- JST gate proof
- expected cost-call reduction
- unrelated Cron unchanged proof
- production mutations exact count
- remaining issues
- this TASK `status: review_required`, `next_owner: chatgpt`
- control metadata同期
- C1待ちでSTOP
