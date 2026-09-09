# Codex Task

- task_id: important-news-throughput-and-coverage-hardening-20260909
- owner: codex
- slot: codex-1
- status: done
- next_owner: chatgpt
- priority: urgent
- recommended_model: Sol

## C1 Final Review

- review_result: approved
- reviewed_by: chatgpt
- implementation_review: pass
- production_review: pass_with_observation

## Approved result

- implementation commit/push completed
- `important-news-monitor` production deploy completed
- ACTIVE version: 33
- natural Cron path confirmed an `important` candidate reached publication
  - `publish_attempts=1`
  - `status=published`
  - X post ID recorded in production report
- manual X post: 0
- manual candidate injection: 0
- cutover-before backlog publication: 0
- unrelated Edge Functions / Cron / DB schema / secrets / OAuth unchanged

## Verified implementation

- `important` / `most_important` both eligible under safety gates
- `most_important` priority retained
- existing 10-minute cooldown retained for both tiers
- `important` overnight hold retained; `most_important` existing bypass retained
- `MISSING_EXPLICIT_YEAR` false positive reduced without weakening core date safety
- retryable Voice issues get at most one targeted rewrite; material Fact/entity/source/safety errors remain hard-fail
- source/model request timeouts added to reduce monitor stalls
- overseas coverage loss was confirmed to be primarily downstream rejection/generation/publish filtering rather than total source absence

## Tests verified

- important-news-monitor tests: 265 passed / 0 failed
- additional timeout/judgement/generation tests: 120 passed / 0 failed
- changed pure-module Deno checks: pass
- `git diff --check`: pass
- remaining full `index.ts` type-check failures are pre-existing and not introduced by this task

## Residual observation

`NEWS_MONITOR_STALE_RUNTIME_TERMINATION` was still observed once after version 33 deployment, so the stale-runtime issue is not considered proven eliminated. However, the following natural run completed successfully with 183 fetched items, 2 new candidates, and ~24-second completion time. This does not block this task because the required post-deploy observation was completed and the main publish-path objective is verified in production.

Future action: continue read-only monitoring of stale recurrence. If stale repeats materially, create a dedicated runtime-stall task rather than reopening this completed throughput/publish task.

## Safety

- old ready backlog was not batch-published or re-claimed
- no manual candidate injection
- no manual X posting used as proof of success
- no Fact major-gate removal
- no unlimited retry
- no indiscriminate all-news expansion
- no unrelated deploy
- no migration/schema/GRANT/secrets/OAuth change
- no morning_greeting / morning_report / close_report / Push-app change
