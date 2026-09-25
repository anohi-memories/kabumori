# Claude Task 3

- task_id: x-autopost-phase1g-pr27-merge-postmerge-verify-20260925
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sonnet5（高）
- purpose: C1 PASS-WITH-FIX済みのPhase1G PR #27をfresh mainに対して安全にmergeし、post-merge回帰確認する。production activation/deployは行わない。

## Reviewed target

PR #27:
- branch: `codex/h1-phase1g-multistep-review-20260925`
- reviewed head: `5a62af547dbc840c1f7b140d6d51d8876c1a7223`
- state at C1: OPEN / unmerged

Accepted H1 fixes:
1. reject stale/non-current-JST morning_greeting schedule date at publish-claim acquisition
2. recheck execution-day JST before each provider step
3. helper rejects duplicate confirmed thread IDs before suggesting completion

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read this TASK
5. Read H1 Phase1G report + Final C1
6. Fresh fetch origin/main and PR #27 head
7. Confirm dedicated independent G3 worktree
8. Confirm no overlap with active G4/H1/H2/G1/G2 work
9. Verify PR #27 head still equals reviewed `5a62af54...`
10. If semantic drift exists, STOP

## Pre-merge verification

- compare PR #27 changed files against fresh main
- confirm only reviewed Phase1G scope is present
- verify no conflicting Phase1G changes landed on main
- verify mergeability
- rerun:
  - focused Phase1G + Phase1B/1D/1E/1F regressions
  - x-test-post
  - _shared
  - important-news-monitor
  - greeting/tip-specific suites
  - disposable PostgreSQL behavior/race if available
  - deno check/lint
  - bash -n
  - git diff --check

## Merge

If reviewed head unchanged, no unsafe conflict/drift, and checks remain acceptable, merge PR #27 through normal GitHub flow.

Do not bypass or workaround production infrastructure checks.

## Post-merge verification

After merge:
1. fresh fetch origin/main
2. record merge commit SHA
3. confirm reviewed Phase1G files on main are semantically/blob identical to PR #27
4. rerun focused Phase1G and key regressions
5. confirm live v2 dispatcher/producers remain unwired
6. confirm no migration apply/deploy/X calls occurred

## Forbidden

- production migration/DDL/DML/RPC apply
- db push/history repair
- deploy
- Cron/OAuth/Vault/token mutation
- real X API/posts/media
- enabling v2 dispatcher/producers
- apps/admin/**
- consumer mobile/**
- G1/G2 app work
- G4 work

## Production mutation budget

0, excluding normal GitHub merge.

## Completion / K3

Report:
- fresh main before merge
- reviewed PR head
- mergeability/conflict result
- exact tests/counts
- merge commit SHA
- post-merge read-back
- production mutation=0 excluding GitHub merge
- remaining blockers
- next recommendation

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

Do not start live v2 dispatcher implementation in this task.

## Report

- task_id: `x-autopost-phase1g-pr27-merge-postmerge-verify-20260925`
- result: **PR #27 merged; post-merge verification PASS; production mutation 0 (excluding the GitHub merge).** Stop for K3.
- worktree/branch: dedicated G3 worktree `/Users/yuya/Developer/kabumori-g3-phase1d`; local-only `claude/g3-pr27-premerge-check` (merge preview) and `claude/g3-pr27-postmerge` (read-back). No overlap: G2 in_progress on PR #26 = `personalized-reports` only (already merged); G1/G4/H1/H2 done.
- fresh main before merge: `f423680` (no `supabase/` change between the merge preview and the merge).
- reviewed PR head: `5a62af547dbc840c1f7b140d6d51d8876c1a7223` = PR head, single commit `fix: reject stale JST greeting plans in Phase1G`; merge pinned with `--match-head-commit`.
- scope check: 7 files, all Phase1G (migration, `x_v2_multistep.ts` + test, `multistep_completion_migration_test.ts`, Phase1G behavior/fixture/doc). Exactly the three C1-accepted fixes: (1) `acquire_greeting_publish_claim_v2` raises `GREETING_SCHEDULE_DATE_STALE` unless the post's `schedule_date` is the current JST day (closes an overdue-row → prior-day claim → publish-today path in the original G3 design); (2) `begin_planned_provider_step_v2` rechecks the JST day before every greeting step; (3) `nextThreadAction` blocks duplicate confirmed ids. Fixture/behavior now use per-scenario brands for same-day greetings plus a stale-schedule case. No other change.
- mergeability/conflicts: main had no changes to any Phase1G file since the PR base `66fb046`; GitHub `MERGEABLE` / `CLEAN`; checks Vercel SUCCESS + Vercel Preview Comments SUCCESS; local merge preview clean.
- tests (pre-merge on the local merge preview; repeated post-merge on `origin/main`, identical):
  - focused Phase1B/1D/1E/1F/1G static + resolver/seam/outcome-ledger/multistep **72/72**
  - `x-test-post` **437/437**; morning_greeting/publish_claim/tip-specific files **138/138**; `_shared` **129/129**; `important-news-monitor` **431/431**
  - disposable PostgreSQL 17: Phase1G behavior + concurrent thread-completion race **PASS ×2** pre-merge and **PASS** post-merge (one completed / one already_completed / side effects `1|1`); Phase1F, 1E, 1D proofs PASS; cleanup PASS. The Phase1G behavior sets `timezone = 'Asia/Tokyo'`, so its `current_date` matches the functions' JST day (only a run straddling JST midnight could differ).
  - `deno check --no-config` + `deno lint` on the changed TS: PASS; `bash -n` on all four runners: PASS; `git diff --check`: PASS
- merge commit SHA: `3b33321d474946d1da117c647cdc3691e5618a3d` (merge commit; branch kept; merged 2026-09-25T01:36:35Z).
- post-merge read-back (`origin/main` = `3b33321`): reviewed head is an ancestor; all 10 Phase1G files (migration, multistep TS + test, outcome-ledger TS + test, static test, behavior, fixture, runner, doc) are blob-identical to `5a62af5`; diff vs. pre-merge main = exactly the 7 PR files; `x-test-post/index.ts`, `morning_greeting_publish_logic.ts`, `publish_claim_logic.ts`, `_shared/x_oauth2_post.ts`, `_shared/brand/**`, `important-news-monitor/**` unchanged; `index.ts` and `morning_greeting_publish_logic.ts` contain 0 references to any v2 claim/step/completion RPC → live dispatcher, greeting publisher and producers remain unwired.
- production mutation: **0** excluding the GitHub merge (apply/DDL/DML/RPC 0, db push/history 0, deploy 0, Cron/OAuth/Vault/token 0, X API/posts/media 0, dispatcher/producers 0). Generated `deno.lock` removed.
- remaining blockers before production: v2 dispatcher + producers (not written/enabled); brand_post completion SQL not in source; interaction poll seam; per-account pre-X refresh writer; Kabumori credential into its account's Vault refs; uncertain→proven-created reconciliation; operator path for failed greeting days; production gates — live-definition diff (legacy RPCs/planners, `scheduled_posts` writers, `publish_claims`/`tips` shape and grants, AI Lab Vault RPC, Vault ACL), atomic 1B→1G chain apply proof (explicit transactions in 1E/1F/1G vs. apply tooling), staged rollback plan.
- next_recommendation: K3. Next source-only step: the v2 dispatcher behind a gate that stays OFF (claim → Phase1E resolve/identity → greeting claim/plan → mark → one-request/step provider → Phase1F/1G ledger + typed completion), recommended Opus5.5（高）.
