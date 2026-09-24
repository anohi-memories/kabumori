# Claude Task 2

- task_id: x-admin-netlify-thin-control-plane-phase1-merge-only-20260924
- owner: claude
- slot: claude-2
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Opus 5.5
- purpose: K2 PASS済みのPhase1 candidate branchを最新mainへfreshen/rebaseし、apps/admin/**のdrift/競合がないこととtestsを再確認したうえで、Phase1変更だけをmainへ安全にmergeする。brand selector配線やquery parameterizationはこのtaskではまだ行わない。

## Reviewed candidate

- branch: `admin-netlify-thin-control-plane-phase1-20260924`
- reviewed commit: `3505269386b6345468a025749a5dd22b4ededbb7`
- K2 verdict: PASS
- reviewed changed files:
  - `apps/admin/docs/phase1-netlify-thin-control-plane.md`
  - `apps/admin/netlify.toml`
  - `apps/admin/src/lib/admin-context.ts`
  - `apps/admin/src/lib/admin-context.test.ts`
  - `apps/admin/tsconfig.json`

At K2 review time the branch was 17 commits behind main.

## Mandatory fresh start

1. `git fetch origin main`
2. fresh `origin/main`
3. read `.agent/ORCHESTRATION.md`
4. read `.agent/CURRENT_STATE.md`
5. read this TASK
6. inspect H1/H2/G1 scopes for overlap
7. inspect current main diffs under `apps/admin/**`
8. compare current reviewed branch to latest main

If latest main has conflicting `apps/admin/**` changes, STOP and report exact files. Do not overwrite or auto-resolve semantically ambiguous changes.

## Scope

This is merge-only/freshening work.

Allowed:
- rebase/freshen the reviewed branch onto latest main
- resolve only trivial/non-semantic conflicts when exact intended reviewed content remains unchanged
- rerun all Phase1 tests/build checks
- create/update PR if needed
- merge Phase1 only after validation

Not allowed:
- brand selector UI
- parameterizing the four query modules
- changing system-toggle behavior
- new DB migration/RPC/view/Edge Function
- Netlify site creation/deploy
- Vercel change
- production DB/Function/Cron/OAuth/Vault changes
- x-test-post/Phase0 changes
- consumer mobile changes
- Important News changes

## Required verification before merge

- changed files remain exactly within the five reviewed Phase1 files
- no secret/service-role/X/OpenAI/OAuth token dependency introduced
- existing Kabumori-only query modules remain unchanged
- existing `brand-boundary.test.ts` remains unchanged and passing
- new `admin-context.test.ts` passes
- `node --experimental-strip-types --test src/lib/*.test.ts` passes
- `npx tsc --noEmit` passes
- `npm run lint` passes
- `npm run build` passes using only public Supabase env vars
- `git diff --check` passes
- fresh compare immediately before merge

## Merge policy

- Prefer normal PR merge or fast-forward-equivalent reviewed merge.
- Do not merge stale reviewed head directly if branch is behind.
- If freshening changes semantics beyond trivial conflict resolution, STOP for K2 instead of merging.
- After merge, fresh-read main and verify the five files match the freshened reviewed candidate.

## Production mutation budget

0.

## Completion / K2

When complete:
- status -> `review_required`
- next_owner -> `chatgpt`
- append `## Report`

Report:
1. fresh main SHA
2. branch freshness/drift findings
3. conflict handling
4. exact changed files
5. tests/build results
6. PR/merge result and merge SHA
7. post-merge file read-back
8. production mutation=0
9. remaining issues
10. next recommendation: separate Phase2 brand-selector/query-parameterization task
11. fresh-origin verification

Then STOP for K2.
