# Codex Task

- task_id: important-news-hourly-cadence-simplify-20260919
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Luna
- purpose: 重要ニュース監視のコスト最適化方針を簡素化する。2026-09-19〜09-23の連休中は現行どおり2時間おき、2026-09-24以降は朝刊・大引け前後の20分刻み増強を撤回し、終日1時間おき（毎時00分）へ変更する。

## Background

C1 PASS済みの現行production設定:
- `important-news-fetch` schedule: `0,20,40 * * * *`
- command gate:
  - 2026-09-19〜09-23: JST偶数時の00分のみ（12回/日）
  - 2026-09-24以降: 毎時00分＋07:00〜09:00 / 16:00〜18:00だけ20分・40分も実行（36回/日）

ユーザー判断:
- 朝刊・大引けレポート側は通常の重要ニュース監視とは別に独自Web Search経路を持つ。
- そのため重要ニュース監視まで朝刊/大引け前後だけ高頻度化する意味は薄い。
- 9/24以降は終日1時間おきで十分。

## Mandatory startup

開始前に必ず確認:
1. `.agent/ORCHESTRATION.md`
2. `.agent/CURRENT_STATE.md`
3. this TASK
4. `.agent/CODEX_REPORT.md`
5. 他3slot TASK
6. fresh `origin/main`
7. production `cron.job` read-only

他slotが `important-news-fetch` を変更中ならSTOP。

## Desired schedule semantics (JST)

### 2026-09-19〜2026-09-23 inclusive
現行維持:
- 2時間おき
- JST偶数時の00分のみ
- 12回/日

### 2026-09-24以降
変更:
- **終日1時間おき**
- JST毎時00分のみ
- 24回/日
- 朝刊前後 / 大引け前後の `:20` / `:40` 追加実行は撤回

## Preferred implementation

現行 `0,20,40 * * * *` triggerを維持し、command gateだけ最小変更してよい。

JST条件:
- date <= 2026-09-23:
  - minute=0 AND hour even
- date >= 2026-09-24:
  - minute=0 only

必ず `timezone('Asia/Tokyo', clock_timestamp())` 等でJSTを明示。

## Allowed production mutation

**`important-news-fetch` Cron 1本のcommand gateだけ。**

禁止:
- schedule変更（必要性がない限り）
- Edge Function deploy/source変更
- `important-news-judgement`
- `important-news-generation`
- `important-news-publish-ready`
- market-report Cron
- MIC Cron
- DB schema/migration
- OAuth/Vault/secrets
- X/Push
- manual OpenAI request
- manual retry/backfill

## Required verification

変更前後で:
1. `important-news-fetch` jobid/name/schedule/active/command hash
2. 他関連Cronのschedule/active/command hash不変
3. JST gate proof:
   - 2026-09-19 08:00 => run
   - 2026-09-19 08:20 => skip
   - 2026-09-19 09:00 => skip
   - 2026-09-24 06:00 => run
   - 2026-09-24 06:20 => skip
   - 2026-09-24 07:00 => run
   - 2026-09-24 07:20 => skip
   - 2026-09-24 08:40 => skip
   - 2026-09-24 10:00 => run
   - 2026-09-24 10:20 => skip
   - 2026-09-24 16:00 => run
   - 2026-09-24 16:40 => skip
   - 2026-09-24 18:00 => run
   - 2026-09-24 18:40 => skip
4. 9/24以降の実HTTP上限 = 24回/日
5. 旧72回/日比で約66.7%削減
6. 連休中12回/日は維持

## Rollback

変更前commandをhash付きでReportへ保存し、必要なら直前C1 PASS状態（9/24以降36回/日）へ戻せること。

## Completion / C1 return

完了時:
- `.agent/CODEX_REPORT.md` を最新結果で更新
- before/after
- exact production mutation count
- JST proof
- cost-call reduction
- unrelated Cron unchanged proof
- rollback情報
- this TASKを `review_required`
- `next_owner: chatgpt`
- control metadataをGitHub mainへ同期
- C1待ちでSTOP
