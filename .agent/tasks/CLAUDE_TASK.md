# Claude Task 2

- task_id: morning-greeting-image-disable-cost-gate-20260916
- owner: claude
- slot: claude-2
- status: ready
- next_owner: claude
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
