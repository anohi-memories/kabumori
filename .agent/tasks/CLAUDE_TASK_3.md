# Claude Task 3

- task_id: x-autopost-phase1f-pr25-merge-postmerge-verify-20260924
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sonnet5（高）
- purpose: C1 PASS-WITH-FIX済みのPhase1F PR #25をfresh mainに対して安全にmergeし、post-merge回帰確認する。production activation/deployは行わない。

## Reviewed target

PR #25:
- branch: `codex/h1-phase1f-ledger-review-20260924`
- reviewed head: `b3740cc7c39010f02ad3505721a5b37d2e707dba`
- state at C1: OPEN / unmerged

Accepted H1 fixes:
1. revoke direct API-role DML on `scheduled_posts`
2. enforce provider-step first-kind/order/reply-parent integrity
3. reject late unfinished-step mutation once parent attempt is terminal

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read this TASK
5. Read H1 Phase1F report + Final C1
6. Fresh fetch origin/main and PR #25 head
7. Confirm dedicated independent G3 worktree
8. Confirm no overlap with active G4/H1/H2/G1/G2 work
9. Verify PR #25 head still equals reviewed `b3740cc7...`
10. If semantic drift exists, STOP

## Pre-merge checks

- compare PR #25 changed files against fresh main
- verify only reviewed Phase1F scope is present
- check no conflicts in Phase1F migration/tests
- verify mergeability
- rerun:
  - focused Phase1F + Phase1B/1D/1E regressions
  - x-test-post
  - _shared
  - important-news-monitor
  - disposable PostgreSQL behavior/race if available
  - deno check/lint
  - bash -n
  - git diff --check

## Merge

If reviewed head unchanged and checks remain acceptable, merge PR #25 using normal repository flow.

Do not bypass unrelated required checks; Vercel build-rate-limit is not relevant to this Supabase source-only change and must not trigger any production deployment workaround.

## Post-merge verification

After merge:
1. fresh fetch origin/main
2. record merge commit SHA
3. confirm reviewed Phase1F files on main match PR #25 semantics
4. rerun focused Phase1F and key regressions
5. confirm live dispatcher/producers remain unwired
6. confirm no migration apply/deploy occurred

## Forbidden

- production migration/DDL/DML/RPC apply
- `supabase db push`
- migration-history repair
- deploy
- Cron/OAuth/Vault/token production mutation
- X API/posts/media
- enabling v2 dispatcher/producers
- apps/admin/**
- consumer mobile/**
- G1/G2 app work
- G4 work

## Production mutation budget

0, excluding normal GitHub merge.

## Completion / K3

Report:
- fresh main
- reviewed PR head
- mergeability/conflicts
- exact test counts
- merge commit SHA
- post-merge read-back
- production mutation=0 excluding GitHub merge
- remaining blockers
- next recommendation

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

Do not start Phase1G in this task.

## Report

- task_id: `x-autopost-phase1f-pr25-merge-postmerge-verify-20260924`
- result: **PR #25 merged; post-merge verification PASS; production mutation 0 (excluding the GitHub merge).** Stop for K3.
- worktree/branch: dedicated G3 worktree `/Users/yuya/Developer/kabumori-g3-phase1d`; local-only `claude/g3-pr25-premerge-check` (merge preview) and `claude/g3-pr25-postmerge` (read-back). No overlap: G2 in_progress owns only `personalized-reports` (DB/X forbidden to it); G1/G4/H1/H2 done.
- fresh main before merge: `ac97508` (no `supabase/` change between the merge preview and the merge).
- reviewed PR head: `b3740cc7c39010f02ad3505721a5b37d2e707dba` = PR head, single commit `fix: harden Phase1F ledger transitions and schedule ACL`; merge pinned with `--match-head-commit`.
- scope check: 4 files (Phase1F migration, `atomic_completion_migration_test.ts`, Phase1F behavior SQL, Phase1F `.md`), exactly the three C1-accepted fixes: (1) `revoke insert, update, delete, truncate on public.scheduled_posts from public, anon, authenticated, service_role`; (2) provider steps: first step cannot be `create_reply`, kind sequence enforced (`media_upload → create_post`, `create_* → create_reply`), reply parent chained; (3) `finish_provider_step_v2` locks the attempt `FOR UPDATE` and refuses to finish a step once the attempt is terminal. No other change.
- mergeability/conflicts: main had no changes to any Phase1F file since the PR base `26311f5`; GitHub `MERGEABLE`; local merge preview clean. Only check: Vercel `FAILURE` = `build-rate-limit`; not relevant to this Supabase-source-only PR and not worked around.
- tests (pre-merge on the local merge preview; repeated post-merge on `origin/main`, identical):
  - focused Phase1B/1D/1E/1F static + resolver/seam/outcome-ledger **55/55**
  - `x-test-post` **429/429**; `_shared` **120/120**; `important-news-monitor` **431/431**
  - disposable PostgreSQL 17: Phase1F behavior + duplicate-completion race **PASS ×2** pre-merge, **PASS** post-merge (race: one `completed`, one `already_completed`, side effects `2|1`); Phase1E proof PASS; Phase1D proof PASS; cleanup PASS
  - `deno check --no-config` and `deno lint` on the changed/related TS: PASS; `bash -n` runner: PASS; `git diff --check`: PASS
- merge commit SHA: `b2fdc1f58114eac55b3f31a1f781e3c555558cf4` (merge commit, repo convention; branch kept; merged 2026-09-24T14:47:38Z).
- post-merge read-back (`origin/main` = `b2fdc1f`): reviewed head is an ancestor; all 8 Phase1F files (migration, static test, outcome-ledger TS + test, fixture, behavior, runner, doc) are blob-identical to `b3740cc`; diff vs. pre-merge main = exactly the 4 PR files; `x-test-post/index.ts`, `_shared/x_oauth2_post.ts`, `_shared/brand/**`, `important-news-monitor/**` unchanged; `index.ts` contains 0 references to any v2 claim/completion/step RPC → dispatcher and producers remain unwired.
- production mutation: **0** excluding the GitHub merge (apply/DDL/DML/RPC 0, db push 0, deploy 0, Cron/OAuth/Vault/token 0, X API 0, dispatcher/producers 0). Generated `deno.lock` removed.
- remaining blockers before Phase1G / production:
  - new live-definition dependency from fix (1): after apply, **no API role (incl. service_role) can INSERT/UPDATE/DELETE `scheduled_posts` directly**. Repository source has no such writer (admin `recent-failures`/`today-scheduled-posts`/`post-history`, social-mobile and the morning-report stale reconciler only SELECT; all writes go through owner-executed RPCs), but any production-only writer (SQL console jobs, functions not in repo) must be checked in the live-definition diff before apply.
  - step-ledger-driven completions for tip and morning_greeting; brand_post completion SQL must be captured into source; poll-capable seam for interaction; v2 dispatcher itself; per-account pre-X refresh writer; Kabumori credential into its account's Vault refs; uncertain→proven-created reconciliation path.
  - production gates: live-definition diff, atomic migration proof for the 1B→1F chain (explicit transactions in 1E/1F vs. apply tooling), staged rollback plan.
- next_recommendation: K3. Then Phase1G as source-only (step-ledger completions for tip/morning_greeting, or the gated-OFF v2 dispatcher for the five enabled types), recommended Opus5.5（高）.
