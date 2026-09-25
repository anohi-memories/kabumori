# Claude Task 3

- task_id: x-autopost-phase1i-pr30-merge-postmerge-verify-20260925
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sonnet5（高）
- purpose: C1 PASS-WITH-FIX済みPR #30をfresh mainで安全にmergeし、Phase1I修正がreviewed headから変わっていないこととpost-merge回帰を確認する。production migration/apply/deploy/refreshは禁止。

## Reviewed source

- PR #30 reviewed/fixed head: `94000720e10649612e84cb3811327de1a63364e9`
- Review verdict: PASS-WITH-FIX
- Production activation: NO

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read H1 Phase1I report and Final C1
5. Fresh fetch origin/main
6. Fresh fetch PR #30
7. Confirm PR head is still exactly `94000720e10649612e84cb3811327de1a63364e9`
8. Confirm mergeability and no Phase1I file drift
9. Confirm dedicated G3 worktree and no overlap with active slots

## Scope A — merge

If and only if reviewed head is unchanged and merge is clean:
- merge PR #30 to main
- do not alter source semantics
- record merge commit

If head changed or conflict affects Phase1I scope:
- STOP and report; do not resolve semantically without new review

## Scope B — post-merge verification

Run:
- Phase1I focused/helper/static/dispatcher
- Phase1B–1I focused
- x-test-post
- _shared
- important-news-monitor
- greeting/tip-specific
- disposable Phase1I behavior/concurrency
- relevant Phase1D/E/F/G/H proofs
- changed TS deno check/lint
- bash -n
- git diff/check as appropriate

Verify:
- cross-account ref-swap regression remains fixed
- settled-attempt commit regression remains fixed
- gate remains OFF/unwired
- production migration remains unapplied
- no real OAuth/Vault/X operation

## Forbidden

- production migration/apply
- db push/history repair
- Edge deploy
- Cron change
- real OAuth refresh/token rotation
- production Vault read/write
- real X API/post/media
- gate enable
- scheduler/claim switch
- apps/admin/**
- G4 work

## Production mutation budget

0 excluding normal GitHub merge.

## Completion / K3

Report:
- fresh main before merge
- exact reviewed PR head
- mergeability
- merge commit
- post-merge test counts
- safety checks
- production mutation=0 excluding merge
- remaining blockers
- next recommendation

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

Do not activate/deploy Phase1I.

## Report

- task_id: `x-autopost-phase1i-pr30-merge-postmerge-verify-20260925`
- result: **PR #30 merged; post-merge verification PASS; production mutation 0 (excluding the GitHub merge).** Run on Opus 5.5 (recommended Sonnet5（高）; no quality impact, noted to the user). Stop for K3.
- worktree/branch: dedicated G3 worktree `/Users/yuya/Developer/kabumori-g3-phase1d`; local-only `claude/g3-pr30-premerge-check` and `claude/g3-pr30-postmerge`. No overlap: H2 ready on PR #32 (app morning Fact contract); G1/G2/G4/H1 done.
- fresh main before merge: `31235d7` (no Phase1I-file drift since the PR base `7204253`; other main changes were `.agent/**` and `important-news-monitor`, which explains that suite's growth to 473 — unrelated).
- reviewed PR head: `94000720e10649612e84cb3811327de1a63364e9` = PR head (single commit); merge pinned with `--match-head-commit`.
- scope check: 4 files (Phase1I migration, `account_refresh_migration_test.ts`, Phase1I behavior SQL, Phase1I doc). The fix: `begin` snapshots brand / platform user id / oauth client / both Vault ref ids into the lease; `commit` takes `SHARE` on `social_accounts`, locks attempt → post → account → state, and turns the lease `uncertain` (`X_REFRESH_ACCOUNT_CHANGED`) unless the attempt is still the leased, `pre_x`, outcome-less attempt of a `running` post bound to the same account/brand, the account is unchanged (brand, platform user id, publish, client, both ref ids, `updated_at`), refs are distinct, and no other account references them. Closes (a) a silent Vault-ref swap that could have written a rotated token into another account's secret and (b) a commit after the attempt was settled. No other change; TS and dispatcher untouched.
- mergeability/conflicts: GitHub `MERGEABLE` (`UNSTABLE` only because Vercel = `build-rate-limit`, target `…?upgradeToPro=build-rate-limit`; the PR touches no `apps/**`; Netlify deploy-preview SUCCESS); local merge preview clean.
- tests (pre-merge preview; repeated post-merge on `origin/main`, identical): focused Phase1B–1I **124/124**; `x-test-post` **477/477**; greeting/publish_claim/tip **138/138**; `_shared` **141/141**; `important-news-monitor` **473/473**; disposable PostgreSQL 17 Phase1I behavior (incl. new §7 silent ref swap and §8 attempt settled mid-refresh) + races **PASS ×2 pre-merge, PASS post-merge**; Phase1D/1E/1F/1G/1H proofs PASS; `deno check --no-config` + `deno lint` PASS; `bash -n` on all six runners PASS; `git diff --check` PASS.
- merge commit SHA: `a9b1ef4d359d5ef554284fc56427e0cafeaec648` (merge commit; branch kept; merged 2026-09-25T09:42:30Z).
- post-merge read-back (`origin/main` = `a9b1ef4`): reviewed head is an ancestor; all 10 Phase1I-related files are blob-identical to `9400072`; diff vs. pre-merge main = exactly the 4 PR files; `x-test-post/index.ts` has 0 references to the v2 gate, dispatcher or refresh path → gate OFF/unwired; migrations remain unapplied.
- production mutation: **0** excluding the GitHub merge (apply/db push/history 0, deploy 0, Cron 0, real OAuth refresh/rotation 0, production Vault read/write 0, X API/post/media 0, gate enable 0, scheduler/claim switch 0).
- remaining blockers: unchanged from Phase1I — Kabumori token still in `oauth_token_store`/env; AI Lab refresh ref to verify on its own row; operator runbook + monitoring for `refreshing`/`uncertain`/`reauth_required`; the fix adds a brief `SHARE` lock on `social_accounts` per commit — confirm no long-running `social_accounts` writer in the live-definition read-back; interaction poll seam; brand_post completion source; real v2 content adapters + gate-OFF entrypoint; production gates (ordered 1B→1I apply proof, staged rollback plan).
- next_recommendation: K3. Next source-only step: gate-OFF v2 entrypoint with real content adapters and the refresh port wired, or the Kabumori credential migration plan into its account's Vault refs (Opus5.5（高）).
