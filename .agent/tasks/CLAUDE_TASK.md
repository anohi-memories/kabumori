# Claude Task 2

- task_id: x-admin-multibrand-selector-phase2-merge-only-20260924
- owner: claude
- slot: claude-2
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Opus 5.5
- purpose: K2 PASS済みのPR #15（admin multibrand selector Phase2）を最新mainへfreshen/rebaseし、apps/admin/**の意味的差分がレビュー済みcandidateと同一であることを確認し、tests再実行後にPR #15だけを安全にmergeする。Netlify deployやDB policy変更は行わない。

## Reviewed candidate

- PR: #15
- branch: `admin-multibrand-selector-phase2-20260924`
- reviewed commit: `6c23227`
- K2 verdict: PASS
- current known branch lag at K2: 5 commits behind main, all in `.agent/**`, no `apps/admin/**` drift

## Mandatory fresh start

1. `git fetch origin main`
2. fresh `origin/main`
3. read `.agent/ORCHESTRATION.md`
4. read `.agent/CURRENT_STATE.md`
5. read this TASK
6. inspect H1/H2/G1 scope overlap
7. compare PR #15 branch against fresh main
8. inspect any `apps/admin/**` changes since reviewed base

If latest main contains nontrivial overlapping `apps/admin/**` changes, STOP and report exact files. Do not auto-resolve semantic conflicts.

## Allowed

- rebase/freshen PR #15 branch onto fresh main
- resolve trivial control-file-only ancestry drift
- rerun full Phase2 admin tests/build checks
- update PR head
- merge PR #15 only after verification
- post-merge read-back

## Forbidden

- any new Phase2 feature
- selector behavior changes
- adding/removing brands from ADMIN_BRANDS
- DB migration/RPC/view/policy
- Netlify site creation/deploy
- Vercel production change
- x-test-post/**
- queue/idempotency work
- Cron/OAuth/Vault/token changes
- consumer mobile changes
- Important News backend changes
- cross-brand aggregate dashboard

## Required verification before merge

- diff remains restricted to the reviewed `apps/admin/src/**` Phase2 files
- selected-brand authority flow unchanged
- explicit brand filters remain on all operational queries
- Important News remains Kabumori-only
- system-toggle remains Kabumori-only and posting_windows update remains brand-filtered
- no service-role/X/OpenAI/OAuth secrets introduced
- node tests: 31/31 expected or higher only if main added unrelated tests
- `npx tsc --noEmit` PASS
- `npm run lint` PASS
- `npm run build` PASS using public Supabase env only
- `git diff --check` PASS
- secret scan clean
- fresh compare immediately before merge

## Merge policy

- do not merge stale reviewed head directly
- use normal PR merge or equivalent reviewed merge
- pin/verify the exact freshened head before merge
- if rebase changes Phase2 semantics, STOP for K2 instead of merging

## Post-merge

Fresh-read `origin/main` and verify:
- all reviewed Phase2 files match freshened head
- no unrelated `apps/admin/**` files were changed
- no production settings changed
- PR #15 merged and closed
- production mutation 0

## Production mutation budget

0.

## Completion / K2

When complete:
- status -> `review_required`
- next_owner -> `chatgpt`
- append `## Report`

Report:
1. fresh main SHA
2. drift/conflict findings
3. freshened PR head
4. exact changed files
5. tests/build results
6. PR #15 merge result + merge SHA
7. post-merge file read-back
8. production mutation=0
9. remaining risks
10. next recommendation
11. fresh-origin verification

Then STOP for K2.
