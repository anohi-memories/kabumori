# Claude Task 2

- task_id: kabumori-personalized-reports-prod-deploy-dryrun-20260924
- owner: claude
- slot: claude-2
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Opus5.5（高）
- purpose: PR #19でmain反映済みのpersonalized-reports新実装を、market_report_consumer_settings.app_enabled=falseを維持したままproductionへ安全にdeployし、dry-run/実LLM検証で品質・Fact合格率・出力量・費用・表示互換を確認する。gate ONはこのTASKでは禁止。

## User authorization

User explicitly approved proceeding with the next rollout stage.

Authorized in this TASK:
- production Edge Function deploy of `personalized-reports`
- read-only production verification
- controlled dry-run / test invocation needed to validate the deployed function
- observation of generated output/cost/timing/safety signals, only in ways that do not enqueue or deliver unintended notifications

Not authorized:
- `market_report_consumer_settings.app_enabled=true`
- production cron schedule changes
- DB/schema/migration changes
- push notification delivery changes
- broad user-cohort expansion
- Auth/RLS changes
- X posting changes

## Accepted source state

PR #19 is merged:
- merged head: `2b743f3a9799f35409ab1e61652b9e76b04977c5`
- merge/main SHA: `518542702f820e490d0c02050b0ef470f023ce5a`
- final K2: PASS
- post-merge tests: 154/154 PASS
- deno check/lint PASS
- no new src TypeScript errors
- Expo export 10 routes PASS
- H2 privacy/user-boundary review: PASS-WITH-FIX
- production deploy has not yet occurred

## Product/cohort boundary

- Scheduled cohort remains users with active `tracked_stocks` rows.
- Watch-only users may receive a market-only report.
- Users with zero active tracked stocks are out of scope.
- Do not infer eligibility from profiles/alert settings.

## Mandatory startup

1. Use independent worktree/checkout.
2. Read PROJECT_RULES.md, .agent/ORCHESTRATION.md, .agent/CURRENT_STATE.md, this TASK, G2 Final K2, H2/C2 PR #19 report.
3. Fresh fetch origin/main.
4. Confirm `personalized-reports` source on main contains merge `5185427` and H2 missing-value fix.
5. Confirm no overlap with G1/PR #21 review work.
6. Read current production function/settings before mutation:
   - deployed `personalized-reports` version/config if inspectable
   - `market_report_consumer_settings.app_enabled`
   - relevant cron state
   - current required secrets/env presence without exposing plaintext values
7. If `app_enabled` is not false, STOP immediately and report. Do not deploy into an unexpectedly enabled lane.

## Pre-deploy gate

Before deploy:
- rerun focused personalized-reports tests
- deno check/lint
- git diff --check
- verify deploy target/project
- verify no migration/schema change required
- verify no source drift from reviewed main

If any check fails, do not deploy.

## Production deploy

Deploy only:
- `supabase/functions/personalized-reports`

Rules:
- no other function deploy
- no migration
- no cron change
- no settings update
- no `app_enabled` change
- capture deployed version/identifier if available
- immediately read back deployment status

## Dry-run / validation

After successful deploy, with `app_enabled=false` still confirmed:

1. Use the safest existing dry-run path or direct controlled invocation supported by the function.
2. Prevent unintended push delivery:
   - use existing dry_run/skip-notify mechanism if present
   - if no safe dry-run path exists, STOP before any invocation that could send user-visible output/push.
3. Validate at least:
   - morning path
   - close path if safely invocable with available data
   - one real eligible user if privacy-safe and already authorized by normal app semantics
   - watch-only/no-holdings behavior if safely testable without cohort mutation
4. Record:
   - generation success/failure
   - Fact pass/fail
   - local validation failures
   - token/output size if available
   - latency
   - any provider/API cost indicators available from source/response/logs
   - saved body structure
   - market detail presence/absence under gate OFF
   - holding impacts
   - morning-to-close comparison availability
5. Do not display or copy secrets, auth tokens, emails, user IDs, or sensitive portfolio details into TASK/Report. Summarize only.

## Quality gates

Stop and report without enabling `app_enabled` if any:
- cross-user anomaly
- unsupported causal claim that local/Fact validation allows
- repeated Fact failure
- malformed body
- push unexpectedly sent
- output truncation
- cost/latency materially outside reasonable expectations
- deployed function fails normal legacy path
- shared packet dependency behaves unexpectedly
- blocked shared packet causes non-fail-closed behavior

## Explicit gate rule

`app_enabled` MUST remain false throughout this TASK.

Even if dry-run is perfect:
- do not enable it
- recommend whether it is safe to enable in the Report
- wait for K2 / ChatGPT decision for a separate gate-activation task

## Rollback

If deploy causes a concrete regression and a previously deployed known-good version is available:
- rollback only if the deployment mechanism and exact prior version are confidently known
- otherwise stop and report rather than improvising
- never change DB/schema to compensate

## Required checks after deploy

- function deployed/read-back confirmed
- `app_enabled=false` confirmed after deploy
- no cron changes
- no DB/schema changes
- no X/shared fact mutation
- dry-run evidence recorded
- production logs inspected only as needed and without leaking secrets
- git status clean / no unrelated local edits

## Completion / K2

When complete:
- status -> review_required
- next_owner -> chatgpt
- Report must include:
  1. fresh main SHA
  2. pre-deploy production state
  3. exact deployed function/version
  4. deploy result
  5. dry-run method
  6. morning/close validation result
  7. Fact/local-validation result
  8. latency/output/cost observations
  9. push-safety result
  10. app_enabled read-back = false
  11. production mutations performed
  12. rollback status if any
  13. whether a separate app_enabled activation task is recommended
  14. remaining real-device QA needs
- STOP for K2.
