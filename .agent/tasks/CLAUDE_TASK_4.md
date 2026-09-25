# Claude Task 4

- task_id: x-admin-pr15-netlify-preview-live-qa-continuation-20260925
- owner: claude
- slot: claude-4
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（高）
- purpose: Netlify visibility blockerとPR #15 Preview再トリガーが解消したため、PR #15の実Deploy Previewでproxy/auth/selector/cross-brand QAを完了する。PR #15 merge/Vercel productionは禁止。

## Resolved operator blockers

1. Netlify project visibility was changed by the user from Private to Public.
   - previous Team protection blocker is resolved.
2. PR #15 branch was retriggered without source changes using an empty commit:
   - previous head: `b04442561d9e9c6d01b4a9fcf640c2cf731cd923`
   - new head: `a8f98444425c25796e9fef611445b0f574120669`
   - tree is byte-identical to prior head; commit only retriggers CI/deploy
   - message: `chore(netlify): retrigger deploy preview`
3. GitHub status now shows:
   - Netlify context: `netlify/shiny-kheer-77a154/deploy-preview`
   - state at assignment time: pending
   - description: `Deploy Preview processing.`
   - deploy id in target URL: `6ab628818a42a8000831c5d1`
   - Vercel remains rate-limited and is irrelevant to this Preview QA

Do not merge PR #15.

## Mandatory startup

- Read PROJECT_RULES.md
- Read .agent/ORCHESTRATION.md
- Read .agent/CURRENT_STATE.md
- Read this TASK
- Fresh fetch origin/main
- Fresh fetch PR #15 and verify head is still `a8f98444425c25796e9fef611445b0f574120669`
- Confirm dedicated G4 worktree
- Confirm no apps/admin overlap with G3/G1/G2/H1/H2
- Confirm empty retrigger commit changed no tree content

## Scope A — wait/read Netlify Preview result

Use GitHub status/check/deployment evidence first.

Verify:
- Netlify status reaches success or concrete failure
- preview target URL
- exact preview head SHA
- no source drift

If failed, inspect failure evidence and stop with concrete cause.

## Scope B — live unauthenticated QA

On actual PR #15 Deploy Preview:
- /login renders
- /posts unauthenticated redirects/fails closed
- /important-news unauthenticated redirects/fails closed
- invalid/no session cannot access protected admin content
- no redirect loop
- no Netlify 404 for valid dynamic routes
- no 5xx attributable to adapter/runtime
- proxy.ts participates in request handling

## Scope C — authenticated QA

Only if an already-authorized authenticated browser/session is legitimately available.

Verify:
- valid session recognized
- session refresh works
- protected layout remains enforced
- server actions remain authorized

Do not request or record passwords/tokens. If unavailable, mark only this subsection blocked.

## Scope D — PR #15 brand QA

Verify live where possible:
- Kabumori / AI Lab selector
- switching brand scopes intended views/data
- Important News remains Kabumori-only
- AI Lab does not expose Kabumori-only system toggle
- unknown/tampered selector fails closed or safely defaults
- direct navigation respects active brand
- no obvious cross-brand leakage
- no hydration/runtime errors

If auth blocks interactive selector QA, combine source/test proof with live unauth proof and state exact residual.

## Scope E — regressions

On PR #15 exact head:
- node tests
- tsc --noEmit
- lint
- build
- diff check
- targeted secret scan

Confirm empty commit tree identity with prior head.

## Forbidden

- merge PR #15
- Vercel production deploy
- production DB/Auth/X mutation
- DNS/custom-domain cutover
- service_role exposure
- weakening auth/RLS
- unrelated source changes

## Production mutation budget

0.

## Completion / K4

Set:
- status -> review_required
- next_owner -> chatgpt

Report:
- fresh main
- PR #15 head/tree identity
- Netlify Preview status/id/url
- live /login
- protected-route results
- proxy/runtime evidence
- authenticated QA or blocker
- brand-selector/cross-brand QA
- regression counts
- changed files/commits (should be none beyond the empty retrigger commit)
- production mutation=0
- PR #15 remains unmerged
- readiness classification
- next recommendation

STOP for K4.
