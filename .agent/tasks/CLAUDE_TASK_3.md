# Claude Task 3

- task_id: x-autopost-phase1i-pr30-merge-postmerge-verify-20260925
- owner: claude
- slot: claude-3
- status: ready
- next_owner: claude
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
