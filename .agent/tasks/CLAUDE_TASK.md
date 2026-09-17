# Claude Task 2

- task_id: morning-greeting-image-disable-cost-gate-20260916
- owner: claude
- slot: claude-2
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sonnet
- purpose: 管理画面で「朝の挨拶」をOFFにしたとき、投稿予定だけでなく毎朝05:30 JSTのOpenAI画像生成も止め、不要なAPI費を発生させない。ON時の既存生成・投稿経路は維持する。

## User decision / source of truth

2026-09-16、ユーザーがOpenAI API費の節約を希望。調査で以下を確認後、「それしよ」と実装を承認:
- 管理画面の`morning_greeting` toggleは現在 `posting_windows` の `post_type='morning_greeting'` の `is_active` だけを切り替える。
- 画像生成は別系統の `.github/workflows/morning-greeting-image.yml` が毎日 `20:30 UTC = 05:30 JST` に起動する。
- そのため現状は朝の挨拶を管理画面でOFFにしても、画像生成だけは毎日OpenAI APIを消費する。

## Confirmed current implementation

- Admin toggle: `apps/admin/src/lib/actions/system-toggle.ts`
  - `morning_greeting` → `posting_windows` / `post_type='morning_greeting'` / `is_active`
- Image workflow: `.github/workflows/morning-greeting-image.yml`
  - daily 05:30 JST
  - runs `scripts/morning-greeting-image.ts`
  - uses `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- Posting/payload path later expects `storage://morning-greeting-assets/generated/<date>.png`

## Parallel-safety boundary

H1 is currently AI Lab live test and owns `x-test-post`, OAuth, AI Lab posting windows/planner. Do not touch those.

H2 owns `important-news-monitor` generation/cost hardening. Do not touch that.

This G2 may touch only the morning greeting image pre-generation path and its tests/docs/control metadata:
- `.github/workflows/morning-greeting-image.yml`
- `scripts/morning-greeting-image.ts`
- `scripts/morning-greeting-image.test.ts`
- a new small helper/test if needed

Do not modify:
- `supabase/functions/x-test-post/**`
- admin toggle behavior unless absolutely necessary; current `posting_windows.is_active` should remain source of truth
- posting planner/RPC/Cron
- OAuth/Vault/social accounts
- important-news-monitor
- personalized reports

## Required startup

1. `.agent/ORCHESTRATION.md`
2. `.agent/CURRENT_STATE.md`
3. this TASK
4. `.agent/tasks/CODEX_TASK.md`
5. `.agent/tasks/CODEX_TASK_2.md`
6. `.agent/tasks/CLAUDE_TASK_1.md`
7. fresh `origin/main`

Use isolated clean worktree. Existing uncommitted changes belong to other workstreams.

## Goal

Before any OpenAI image-generation request is made by the scheduled workflow, check the authoritative production setting for Kabumori morning greeting.

Expected behavior:
- `posting_windows` has `brand_id='kabumori'`, `post_type='morning_greeting'`, `is_active=true` → generate exactly as today
- same setting `is_active=false` → exit successfully **before any OpenAI API call and before image generation**
- setting row missing / Supabase read failure / malformed response → fail safely and do not call OpenAI; do not silently generate billable image when enablement is unknown

## Design requirements

Preferred design:
- make the enablement check in `scripts/morning-greeting-image.ts` (or a small helper called before generation), because workflow already has Supabase URL/service-role credentials
- query only the minimum fields needed
- explicitly scope to Kabumori + morning_greeting
- never print service role key, OpenAI key, auth headers, or secrets
- an OFF result should be a normal successful skip, not a workflow failure
- log a short safe message such as `morning greeting disabled; image generation skipped`
- ON path should preserve current target-date/theme/storage behavior unchanged

Do not rely only on workflow-level string flags duplicated from DB. `posting_windows.is_active` is the existing admin source of truth.

## Cost-safety invariant

The test must prove that on OFF:
- OpenAI image call count = 0
- Storage image write count = 0
- no replacement/deletion of existing images

On ON:
- existing behavior remains one image generation attempt according to current bounded behavior
- existing storage path remains unchanged

## Edge cases

Cover at minimum:
- one Kabumori morning_greeting row enabled
- row disabled
- missing row
- Supabase non-2xx/read failure
- unrelated brand row enabled while Kabumori row disabled → must still skip
- unrelated post_type enabled → must not affect decision
- explicit workflow_dispatch target_date still respects enablement gate

If there are multiple Kabumori morning_greeting rows unexpectedly, do not invent semantics. Inspect current schema. If the intended source of truth cannot be unambiguously resolved, STOP and report.

## Tests

Run at minimum:
- `scripts/morning-greeting-image.test.ts`
- new enablement-gate tests
- any existing morning greeting script tests affected
- `git diff --check`

All external OpenAI/Supabase calls in tests must be mocked. No billable production image generation for verification.

## Production / deployment boundary

This task may prepare and push the GitHub workflow/script change for review.

Before K2 review, do not:
- manually dispatch the production workflow
- generate a synthetic production image
- call OpenAI production API for testing
- change `posting_windows` production values
- change admin setting on user's behalf
- deploy/modify `x-test-post`
- change Cron/planner/RPC/migrations

Normal GitHub scheduled workflow must not be changed on production main beyond the reviewed code commit until K2 approval if the implementation branch is separate. If project workflow requires main for GitHub Actions testing, STOP and report rather than bypassing review.

## Completion

When implementation/tests are complete:
- set `status: review_required`
- set `next_owner: chatgpt`
- append `## Report` to this TASK
- sync control/report metadata to origin/main

Report:
- exact gating logic
- changed files
- OFF-path OpenAI call count proof = 0
- ON-path regression result
- tests
- commit/push
- production changes (expected 0 before K2)
- remaining issues
- next rollout recommendation

## Report

- exact gating logic: 新規`checkMorningGreetingEnabled()`（`scripts/morning-greeting-image.ts`）が、OpenAI呼び出し前に`posting_windows`を`select=is_active&brand_id=eq.kabumori&post_type=eq.morning_greeting`でread-only参照する。行が1件かつ`is_active=true`→既存の生成処理をそのまま実行。1件かつ`is_active=false`→OpenAI/Storageへ一切アクセスせず`exit 0`の正常スキップ（ログ: `morning greeting disabled; image generation skipped`）。行が0件・複数行で値が不一致・非2xx・ネットワーク失敗・JSON不正のいずれか→enablementを「不明」として扱い、生成を行わず`exit 1`で可視化された失敗にする（安全側のデフォルトを発明しない）。この判定と既存の`runMorningGreetingImageWorkflow()`を合成した`runMorningGreetingImageJob()`を新設し、`main()`はこの1関数だけを呼ぶ構成にした（`workflow_dispatch`の`target_date`を指定してもgateは迂回できない）。
- changed_files:
  - `scripts/morning-greeting-image.ts`（`checkMorningGreetingEnabled`, `MorningGreetingEnablementCheckError`, `runMorningGreetingImageJob`を追加。既存`runMorningGreetingImageWorkflow`は無変更。`main()`のみ新しいjob関数を呼ぶよう更新）
  - `scripts/morning-greeting-image.test.ts`（新規15テスト追加。既存13テストは無変更のまま全て通過）
  - `.github/workflows/morning-greeting-image.yml`は変更なし（既に`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`をenvで渡していたため、スクリプト側の変更だけで完結）
- OFF-path OpenAI call count proof = 0: `runMorningGreetingImageJob`の直接呼び出しテストで、`posting_windows`が`is_active=false`を返した場合、それ以外のURLへのfetchが1件でも来たら即座に例外を投げてテスト失敗させる構成にして検証。スケジュール実行相当（`date`未指定）と`workflow_dispatch`の`target_date`指定相当の両方で実行し、いずれもネットワーク呼び出し件数0を確認。
- ON-path regression result: 既存の生成経路（`runMorningGreetingImageWorkflow`）は一切変更しておらず、既存13テスト（正常生成、同日画像スキップ、canonical取得失敗、OpenAI失敗時の非リトライ、日付境界処理、workflow yml内容確認等）は全て無変更のまま通過。加えて`runMorningGreetingImageJob`経由でも同じON挙動（enablement読み取り1回→通常の生成1回）になることを新規テストで確認。
- tests: `node --experimental-strip-types --test scripts/morning-greeting-image.test.ts`で28/28 pass（既存13 + 新規15、うち1件はmain()が新job関数のみを呼び生の`runMorningGreetingImageWorkflow`を直接呼ばないことを確認するsource-inspectionテスト）。`git diff --check`で空白エラーなし。必須エッジケース（有効1件/無効1件/行なし/非2xx/ネットワーク失敗/不正レスポンス/無関係ブランド行/無関係post_type行/複数行一致/複数行不一致）を全てカバー。外部OpenAI/Supabase呼び出しは全テストでfetchImplによりモック済みで、課金対象の実生成は一切発生していない。
- commit/push: `morning-greeting-image-cost-gate-20260916`ブランチへコミット`afe5d87`をpush済み（mainへは未マージ、K2レビュー待ち）。PRは未作成（`.agent/`側の運用に合わせ、ブランチpushのみで報告）。
- production changes: 0件。管理画面・migration・RPC・Cron・workflow YAML・admin toggle動作のいずれも変更していない。手動でのworkflow_dispatch実行、実OpenAI呼び出し、`posting_windows`本番値の変更、admin設定の代理変更も一切行っていない。
- remaining issues:
  1. 今回のenablementクエリは`brand_id=kabumori`固定。将来AI Lab等の別ブランドが独自の朝の挨拶を持つ場合は、このスクリプト自体を呼び出し元でブランドごとに分ける設計が別途必要（本タスクのスコープ外、admin toggle側もpost_type単位でしか区別していない既存の制約と同じ）。
  2. `apps/admin/src/lib/actions/system-toggle.ts`の`setPostingWindowFlag`は`post_type`のみでフィルタし`brand_id`を見ていない（現状は行が1件のみのため実害なし）。これは既存実装であり本タスクでは変更していない。将来的な整理対象として記録のみ。
  3. GitHub Actionsでの実ワークフロー動作確認（実際のcron発火・実Supabase接続）はK2承認後、mainマージ後の初回実行で確認することを推奨。
- next rollout recommendation: レビュー後は`morning-greeting-image-cost-gate-20260916`ブランチをmainへマージし、次回05:30 JSTの定時実行（またはmanual workflow_dispatch検証）で実際に`posting_windows`の現在値（`is_active=true`）に対して従来通り生成されることを一度確認する。その後、実際にAdminで朝の挨拶をOFFにした状態でのworkflow実行ログ（`morning greeting disabled; image generation skipped`）を確認できれば、コスト削減効果が本番で実証されたことになる。
