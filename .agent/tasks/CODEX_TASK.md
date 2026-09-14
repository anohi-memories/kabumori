# Codex Task

- task_id: x-multibrand-phase3k-ai-lab-first-live-test-20260916
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: high
- recommended_model: Sol High
- purpose: 2026-09-16 JSTから会社員AIラボの実投稿テストを段階的に開始する。まずOAuth write readinessと本人確認を行い、1件の制御された実投稿を確認した後に10枠の自動投稿テストを開始する。問題があれば自動化へ進まず停止する。

## Confirmed state

- Phase 3I production pre-live deploy: C1 PASS
- production `x-test-post`: ACTIVE v108 / `verify_jwt=false`
- deployed source: exact reviewed commit `c4eb2855f2adc66e5518feaa51eef63bbf139e4d`
- Phase 3J posting schedule: C1 PASS
- AI Lab `posting_windows`: 10 rows, `brand_post`, `Asia/Tokyo`, all `is_active=false`
- windows:
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
- each `daily_probability=1.0`
- current AI Lab brand `publish_mode=dry_run`
- current AI Lab social account `ai_salaryman_lab_x` / handle `kaishain_ai_lab` / `identity_verified` / `publish_enabled=false`
- current AI Lab OAuth scopes: `tweet.read users.read offline.access`
- no real AI Lab X post yet

## User decision — source of truth

User instruction on 2026-09-15 JST: **「16日からテスト開始しよ」**.

Interpretation:
- target test start date: **2026-09-16 JST**
- user authorizes beginning a controlled real-post test on that date, followed by the already-approved 10-slot schedule only if the controlled first post succeeds and safety checks pass
- this is a test rollout, not an unconditional authorization to continue after errors

## Start rule

Do not perform write-scope reauthorization, publish enablement, posting-window activation, or real X posting before **2026-09-16 JST**.

At/after 2026-09-16 JST, begin only after mandatory fresh checks below pass.

## Mandatory fresh checks

1. Read `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK, `.agent/CODEX_REPORT.md`.
2. Fresh-check `origin/main` and current production Function state.
3. Inspect all other active slots. Stop on overlap with `x-oauth-connect`, `x-test-post`, `social_accounts`, AI Lab `brands`, AI Lab posting windows, planner/Cron, or OAuth/Vault routing.
4. Confirm production still has:
   - `x-test-post` v108 or a separately reviewed newer equivalent
   - AI Lab `publish_mode=dry_run`
   - AI Lab `publish_enabled=false`
   - 10 AI Lab `brand_post` windows present and inactive
   - handle `kaishain_ai_lab`
5. Confirm no unexpected scheduled `brand_post` rows or prior AI Lab real posts appeared.

If any expected state differs, STOP for C1 instead of improvising.

## Phase A — OAuth write readiness

Goal: obtain a fresh AI Lab authorization that can post text while retaining read/refresh access.

Required scopes:
- `tweet.read`
- `tweet.write`
- `users.read`
- `offline.access`

Do not add `media.write` in this task.

Safety requirements:
- use only the AI Lab account path
- no Kabumori token fallback or mutation
- before replacing/saving usable token refs, verify X `/2/users/me` returns username exactly `kaishain_ai_lab`
- if handle mismatches, reject and STOP without enabling publishing
- do not expose access/refresh tokens, Vault secret values, password, or 2FA
- preserve fixed account id `ai_salaryman_lab_x`
- verify token refs are Vault-backed after success

If current `x-oauth-connect` source cannot safely request the additional write scope without code change, implement only the minimum isolated AI Lab scope change, test it, push for C1, and STOP before deploy/re-authorization. Do not silently broaden Kabumori or Mio scope behavior.

## Phase B — controlled first real post

Only after Phase A succeeds and `/2/users/me` verified `kaishain_ai_lab`:

1. Keep all ten posting windows inactive.
2. Prepare exactly one AI Lab `brand_post` through the production path.
3. Confirm generated text is <=280 Unicode code points under the implemented server-side rule and cross-brand dedupe passes.
4. Change only the minimum AI Lab flags required for the single controlled test:
   - `publish_mode=live`
   - `publish_enabled=true`
5. Execute **one** real text-only AI Lab X post.
6. Confirm:
   - returned X post id exists
   - scheduled/completion state is terminal and not retryable
   - fingerprint is persisted or completion safely records the persisted=false terminal outcome without replay risk
   - post appears under `kaishain_ai_lab`
   - no Kabumori/Mio mutation
   - no media call

If any uncertainty exists after the X write, do not retry automatically. Use the existing duplicate-resend-safe terminal/hold behavior and STOP for review.

## Phase C — begin 10-slot test schedule

Only if the single controlled post is confirmed successful and no safety issue is found:

- keep `publish_mode=live`
- keep `publish_enabled=true`
- set only the ten existing AI Lab `brand_post` posting-window rows to `is_active=true`
- do not alter their time windows, timezone, slot numbers, or probability
- do not change Cron cadence
- ensure planner creates only AI Lab `brand_post` rows as expected
- do not backfill missed slots from before activation time on 2026-09-16
- activation should apply prospectively from the remaining windows on/after activation

Initial test target: approximately 10 posts/day according to the configured ten windows. Do not create extra manual posts beyond the one controlled first post unless specifically required to recover from a non-posting pre-X failure and explicitly justified in Report.

## Automatic stop conditions

Immediately disable the ten AI Lab windows (`is_active=false`) and set AI Lab publishing back to a safe disabled state if practical, then STOP and report if any of these occur:
- wrong X account/handle
- duplicate or suspected duplicate post
- over-280 dispatch attempt
- unexpected Kabumori/Mio route use
- token refresh/routing anomaly
- completion uncertainty that could cause duplicate resend
- repeated generation failure suggesting a loop
- any unexpected media call
- more than one post from a single intended slot
- unexpected scheduler/backfill behavior

Do not delete data to hide failures.

## Explicitly authorized by this task

At/after 2026-09-16 JST, subject to the staged gates above:
- AI Lab OAuth reauthorization adding only `tweet.write` while retaining `tweet.read users.read offline.access`
- exact-account `/2/users/me` verification
- one controlled real text-only AI Lab X post
- AI Lab-only `publish_mode=live` and `publish_enabled=true` for the test
- activation of the existing ten AI Lab posting-window rows after first-post success
- read-only/read-back verification and necessary planner invocation already used by the normal system

## Still prohibited

- `media.write` or media upload
- changes to Kabumori OAuth/token/handle/publish/schedule/Cron
- Mio changes
- unrelated Function deploys
- unrelated DB/schema/RPC/migration changes
- `supabase db push`
- migration-history repair/reconcile
- changing the ten schedule window values without a new user decision
- hiding or deleting failed execution evidence
- exposing token/secret/password/2FA values

## Verification / observation

Record at minimum:
- exact OAuth scopes after reauthorization
- `/2/users/me` result as username only (no sensitive token data)
- first real post id and timestamp
- first real post character count
- fingerprint/completion result
- AI Lab flags before/after
- posting-window active state before/after
- planner result for 2026-09-16 prospectively
- any naturally executed scheduled test posts observed during task window
- explicit X text-write count and media-write count
- Kabumori/Mio unchanged evidence

## Completion

After staged rollout/observation:
- set `status: review_required`
- set `next_owner: chatgpt`
- update `.agent/CODEX_REPORT.md`
- sync only the necessary task/report/current-state metadata

If Phase A requires a code change, stop before production deployment and leave `review_required` for C1.
If Phase B fails, do not activate the ten windows.
If Phase B succeeds and Phase C activates, report exact activation time and which 2026-09-16 windows remain eligible prospectively.

This task authorizes a controlled test start on 2026-09-16, not an unchecked production rollout.