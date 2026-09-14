# Codex Task

- task_id: x-multibrand-phase3j-ai-lab-posting-schedule-20260914
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sol High
- purpose: ユーザー指定の「1日10回程度・時間は適当」をAI Labの具体的なposting scheduleへ落とし込み、live化前の安全な設定状態まで進める。実X投稿・OAuth write scope変更・publish有効化はまだ行わない。

## Confirmed production state

- Phase 3I C1: PASS
- production `x-test-post`: ACTIVE v108 / `verify_jwt=false`
- deployed source: exact commit `c4eb2855f2adc66e5518feaa51eef63bbf139e4d`, 39/39 runtime files byte-verified
- AI Lab brand: `publish_mode=dry_run`
- AI Lab social account: `ai_salaryman_lab_x` / handle `kaishain_ai_lab` / `identity_verified` / `publish_enabled=false`
- OAuth scopes remain read-only: `tweet.read users.read offline.access`
- no real AI Lab X post yet
- no AI Lab posting window currently enabled

## User schedule decision — source of truth

User instruction: **「投稿スケジュールは1日10回程度適当に」**

Interpretation for initial production schedule design:
- timezone: `Asia/Tokyo`
- post_type: `brand_post`
- 10 slots per calendar day
- same schedule on weekdays/weekends initially
- random execution time inside each slot/window is preferred over fixed minute posting
- no overnight posting
- target windows (JST):
  1. 07:30–08:30
  2. 09:00–10:00
  3. 10:30–11:30
  4. 12:00–13:00
  5. 13:30–14:30
  6. 15:30–16:30
  7. 17:30–18:30
  8. 19:00–20:00
  9. 20:30–21:30
  10. 22:00–23:00
- initial `daily_probability`: 1.0 per slot. "程度" is satisfied by random timing inside windows; if the existing scheduler semantics make exact 10/day inappropriate, stop and report before changing semantics rather than inventing a different probability model.

## Goal

1. Inspect current `posting_windows` schema and planner semantics read-only.
2. Confirm how window start/end, timezone, slot_no, daily_probability and `is_active` are interpreted.
3. Prepare/apply only the minimum AI Lab schedule rows needed for the 10 slots above.
4. Keep them **inactive** unless the current schema/planner cannot represent inactive configured rows safely; if so, stop and report instead of enabling them.
5. Verify the rows read back correctly and are brand-scoped to `ai_salaryman_lab` / `brand_post`.
6. Do not change Cron, OAuth scopes, publish flags, token state, or X posting.

## Production authorization boundary

The user's schedule instruction authorizes configuring the schedule values above, but does **not** authorize live publishing.

Allowed:
- read-only inspection of `posting_windows` and planner/RPC semantics
- insert/update only AI Lab `posting_windows` rows required to represent the 10-slot schedule
- keep those rows `is_active=false`
- read-back verification
- code/test changes only if needed to support the existing schema semantics safely; any source change must stop for C1 before deploy

Not allowed:
- `is_active=true` for AI Lab posting windows
- `publish_mode=live`
- `publish_enabled=true`
- `tweet.write` / `media.write`
- OAuth reauthorization
- token refresh/liveness test
- real/test X post or media upload
- Cron changes
- Kabumori or Mio schedule/settings changes
- unrelated DB/schema/RPC changes
- `supabase db push`
- migration history repair/reconcile
- secret/token/password/2FA output

## Mandatory safety checks

Before any DB write:
- read `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK, `.agent/CODEX_REPORT.md`
- fresh-check `origin/main`
- inspect other active slots for overlap with `posting_windows`, planner RPCs, Cron, or `x-test-post`
- read production `posting_windows` schema/indexes/constraints and existing AI Lab rows
- verify unique/index key expected for brand/post_type/slot_no
- inspect `plan_daily_posts()` / related planner logic and confirm inactive rows are ignored

If another slot overlaps the same table/planner/Cron, STOP and report conflict.

## Verification

After schedule configuration:
- read back exactly 10 AI Lab `brand_post` rows
- confirm timezone `Asia/Tokyo`
- confirm slot numbers 1–10 and expected windows
- confirm `daily_probability=1.0`
- confirm all rows `is_active=false`
- confirm Kabumori/Mio rows unchanged
- confirm no scheduled post was created as a side effect
- confirm no Cron change
- confirm X/media writes 0

## Completion

When complete:
- set `status: review_required`
- set `next_owner: chatgpt`
- update `.agent/CODEX_REPORT.md`
- sync only control/report metadata as needed

Report exact rows/values, planner semantics, DB writes performed, unchanged components, and next required gate.

## Next gate after this task

After schedule rows are safely configured and reviewed, the next separate phase is OAuth write readiness:
- add `tweet.write` while retaining `tweet.read users.read offline.access`
- reauthorize and verify `/2/users/me` remains `kaishain_ai_lab`
- still keep publish disabled until a separate first-live-post approval.

## Execution result — 2026-09-14

- Production schema/planner preflight passed. `posting_windows` is RLS-enabled and has `UNIQUE(post_type, slot_no)` plus `UNIQUE(brand_id, post_type, slot_no)`. Before insertion there were no `brand_post` windows for any brand and no `brand_post` scheduled rows in the next 10 days.
- The current `plan_daily_posts(date)` implementation selects only rows with `w.is_active=true`, an active brand, and `publish_mode IN ('dry_run','live')`. `daily_probability=1.0` always passes its deterministic probability gate; each candidate time is randomized in its window using the row timezone. Therefore `is_active=false` safely prevents planning even while the AI Lab brand remains active/dry_run.
- Inserted exactly 10 rows for `brand_id='ai_salaryman_lab'`, `post_type='brand_post'`, slots 1–10, `timezone='Asia/Tokyo'`, `daily_probability=1.0`, all `is_active=false`. Exact times are in `.agent/CODEX_REPORT.md`.
- Read-back confirmed the 10 exact rows, all disabled. Existing non-AI-Lab rows (all Kabumori) were unchanged; no Mio posting-window rows existed before or after. Upcoming `brand_post` scheduled_posts remain 0.
- The active `dispatch-scheduled-posts` Cron remains unchanged at every minute. There are no triggers on `posting_windows`; no planner or `x-test-post` invocation was triggered manually for this task, and no direct X API/media call was made.
- No schema/migration/RPC, OAuth/scope/token, publish flag, Cron, source code, or other production setting was changed. AI Lab remains `publish_mode='dry_run'`, account `identity_verified`, `publish_enabled=false`.
- Schema caveat for future multi-brand use: both `posting_windows(post_type, slot_no)` and `scheduled_posts(schedule_date, post_type, slot_no)` are brand-agnostic unique keys. There is no current competing `brand_post` schedule, so this inactive AI Lab configuration is representable; do not add another brand's same `brand_post` slots without separately resolving/reviewing that uniqueness design.
- Result: `review_required`. No first/live post is authorized.
