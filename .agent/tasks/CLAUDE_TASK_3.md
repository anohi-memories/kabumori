# Claude Task 3

- task_id: x-autopost-phase1e-pr22-merge-postmerge-verify-20260924
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sonnet5（高）
- purpose: C1 PASS-WITH-FIX済みのPhase1E PR #22をfresh mainに対して安全に統合・mergeし、post-merge回帰確認を行う。production activation/deployは行わない。

## Reviewed target

PR #22:
- branch: `codex/h1-phase1e-security-review-20260924`
- reviewed head: `7406c1c60506323400247b6c24162a5da4097419`
- state at C1: OPEN / unmerged

Accepted review result:
- Phase1E source candidate PASS-WITH-FIX
- production activation remains NO
- H1 fixes:
  1. manual redirects for credential RPC/X requests; create 3xx => uncertain
  2. Vault-origin P0001 masking
  3. transactional CREATE/REVOKE/GRANT to close PUBLIC EXECUTE window

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read this TASK
5. Read H1 Phase1E report + Final C1
6. Fresh fetch origin/main and PR #22 head
7. Confirm dedicated independent G3 worktree/checkout
8. Confirm no overlap with active G4/H1/H2 work
9. Verify PR #22 head still equals reviewed `7406c1c...`
10. If head drifted semantically, STOP and report

## Integration checks before merge

- compare PR #22 changed files against fresh main
- confirm no conflicting changes landed in:
  - Phase1E migration
  - x_v2_claim_credentials*
  - x_v2_one_request_provider*
  - Phase1E tests/docs
- confirm PR #22 contains only the reviewed Phase1E fix scope
- verify mergeability
- do not resolve unrelated conflicts by guessing

## Required pre-merge verification

At minimum:
- focused Phase1E tests
- full x-test-post regression
- full _shared regression
- important-news-monitor regression
- disposable PostgreSQL Phase1E proof if local environment permits
- deno/static checks for changed sources
- git diff --check

If a required check cannot run, report why before merge and decide conservatively.

## Merge

If:
- PR head is unchanged from reviewed head
- no unsafe semantic drift/conflict
- required checks remain acceptable

then merge PR #22 to main using normal repository flow.

Do not squash away evidence unless repository convention requires it.

## Post-merge verification

After merge:
1. fresh fetch origin/main
2. record merge commit SHA
3. confirm each reviewed Phase1E source file on main matches the reviewed PR head semantics
4. rerun focused Phase1E tests
5. rerun key regressions
6. verify live dispatcher/legacy credential paths remain unchanged
7. verify no production apply/deploy occurred

## Forbidden

- production migration/DDL/DML/RPC apply
- `supabase db push`
- migration-history repair
- Edge Function deploy
- Cron mutation
- OAuth/Vault/token production mutation
- token refresh/rotation
- X API calls/posts/media
- enabling v2 producer/dispatcher
- apps/admin/**
- consumer mobile/**
- G1/G2 app work
- G4 Netlify work
- unrelated MIC work

## Production mutation budget

0, excluding normal GitHub merge.

## Completion / K3

When complete:
- status -> review_required
- next_owner -> chatgpt
- Report:
  - fresh main before merge
  - PR #22 head verified
  - mergeability/conflict result
  - exact tests/counts
  - merge commit SHA
  - post-merge read-back
  - production mutation=0 excluding GitHub merge
  - remaining blockers before Phase1F / production
  - next recommendation

STOP for K3.

Do not start Phase1F in the same task.

## Report

- task_id: `x-autopost-phase1e-pr22-merge-postmerge-verify-20260924`
- result: **PR #22 merged; post-merge verification PASS; production mutation 0 (excluding the GitHub merge).** No apply/deploy/activation. Stop for K3.
- worktree/branch: dedicated G3 worktree `/Users/yuya/Developer/kabumori-g3-phase1d`; local-only branches `claude/g3-pr22-premerge-check` (merge preview) and `claude/g3-pr22-postmerge` (read-back). Shared checkout and other slots untouched. G4 `done`, H1 `done`, H2 on PR #21 (app) — no overlap.
- fresh main before merge: `d472480`.
- PR #22 head verified: `7406c1c60506323400247b6c24162a5da4097419` = reviewed head, single commit `Harden Phase1E credential and one-request boundaries`. The merge was pinned with `--match-head-commit`.
- scope check: 8 files, all Phase1E (`x_v2_claim_credentials.ts`/`_test`, `x_v2_one_request_provider.ts`/`_test`, `claim_bound_credential_reader_migration_test.ts`, Phase1E migration, `x_autopost_phase1e_behavior.sql`, Phase1E `.md`). The diff contains exactly the three C1-accepted fixes: `redirect: "manual"` on the credential RPC, `/2/users/me` and create (3xx create → `x_outcome_uncertain`); Vault read wrapped so a Vault-side `P0001` is masked to `X_CREDENTIAL_UNAVAILABLE`; `begin; … commit;` around CREATE/REVOKE/GRANT. No semantic drift.
- mergeability/conflict: main had no changes to any Phase1E file since the PR base `87c1866`; GitHub `MERGEABLE`; local merge preview clean. Only check: Vercel `FAILURE` = `build-rate-limit` (target URL `…?upgradeToPro=build-rate-limit`). The PR touches no `apps/**`; CURRENT_STATE policy says Vercel rate limits are not a merge blocker (PR #19 merged under the same condition). Not bypassed or retried.
- tests (pre-merge on the local merge preview of fresh main + PR head):
  - focused Phase1E: **31/31** (resolver 12, seam 13, Phase1E static 6)
  - full `x-test-post` **422/422**; full `_shared` **116/116**; `important-news-monitor` **431/431**
  - disposable PostgreSQL 17 Phase1E proof (incl. the new Vault-`P0001` masking case) **PASS ×2**, cleanup PASS; Phase1D proof **PASS** (behavior, race, cleanup)
  - `deno check --no-config` on the 5 changed TS files: PASS; `git diff --check`: PASS
- merge commit SHA: `bb297ff5b76ec8d218365d0db6e837bc4357df66` (merge commit, repo convention; branch not deleted; merged 2026-09-24T13:41:45Z).
- post-merge read-back (fresh `origin/main` = `bb297ff`):
  - reviewed head `7406c1c` is an ancestor of main; all 10 Phase1E source/test/doc files on main are blob-identical to `7406c1c`.
  - diff `d472480..bb297ff` = exactly the 8 PR files; `x-test-post/index.ts`, `_shared/x_oauth2_post.ts`, `_shared/brand/**`, `important-news-monitor/**` unchanged → live dispatcher and legacy credential paths unchanged.
  - reruns on main: focused Phase1B/1D/1E static + Phase1E TS **44/44**; `x-test-post` **422/422**; `_shared` **116/116**; `important-news-monitor` **431/431**; disposable Phase1E proof **PASS**.
- production mutation: **0** excluding the GitHub merge — migration/DDL/DML/RPC apply 0, `db push` 0, deploy 0, Cron 0, OAuth/Vault/token 0, refresh/rotation 0, X API calls 0, v2 producer/dispatcher 0. A local `deno.lock` produced by test runs was deleted, not committed.
- remaining blockers before Phase1F / production:
  - Phase1F: atomic per-post-type v2 completion + provider-step outcome model, including an `x_rejected` ledger outcome (today it must be recorded as uncertain), tip threads and morning_greeting media+create.
  - per-account pre-X token refresh writer; Kabumori credential moved into its own account's Vault refs (operator step).
  - live-definition diff (legacy claim/retry/fail/planners, `social_accounts` Vault columns, AI Lab Vault RPC, Vault ACL and function owner/grants — H1 noted production service_role has `vault.decrypted_secrets` SELECT, so the service-role key must stay in the trusted runtime).
  - atomic migration proof: the Phase1E migration now has an explicit `begin; … commit;`. Confirm the chosen apply tool does not already wrap each file in a transaction (a nested BEGIN only warns, but the inner COMMIT would end the outer transaction early), or apply it as its own unit.
  - staged rollback plan; Phase1B standalone proof stacked on Phase1D still expects FK violations where the Phase1D guard now raises `BOUND_ROW_REQUIRES_V2_PATH` (test expectation only).
- next_recommendation: K3. Then assign Phase1F (atomic per-type completion + provider-step outcome model) as source-only; recommended Opus5.5（高） given ledger/RPC/completion semantics.
