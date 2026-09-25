# Claude Task 4

- task_id: x-admin-netlify-pr15-live-preview-auth-qa-20260925
- owner: claude
- slot: claude-4
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（高）
- purpose: ユーザーがNetlify初回サイト接続とNext.js Runtime設定を完了したため、PR #15の実Deploy Previewを成立させ、proxy.ts / Supabase SSR / protected route / Kabumori-AI Lab selector境界をlive Netlify runtimeでQAする。PR #15 merge/Vercel production deployは禁止。

## Operator-completed Netlify setup

User has completed the previously blocked one-time Netlify setup.

Observed live facts:
- Netlify project/site created from `anohi-memories/kabumori`
- site name currently shown as `shiny-kheer-77a154`
- Base directory = `apps/admin`
- build command = `npm run build`
- publish directory = `apps/admin/.next` as rendered by Netlify UI
- Functions directory = Netlify default under `apps/admin/netlify/functions`
- environment variable names configured:
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- no server-only secrets intentionally configured
- initial deploy detected Next.js 16.3.4 but produced 0 functions while Runtime was unset
- user then set Netlify Runtime = `Next.js`
- cacheless redeploy completed
- live `/login` now renders the Kabumori Admin login page successfully
- therefore the prior interactive authorization/runtime blocker is resolved

Do not remove the Next.js Runtime.

## Goal

1. Verify the connected Netlify site configuration from repository/runtime evidence.
2. Ensure PR #15 gets a real Netlify Deploy Preview.
3. QA unauthenticated fail-closed behavior and live `proxy.ts` execution.
4. QA authenticated behavior if safely possible without asking for or exposing user credentials.
5. QA PR #15 brand-selector semantics and cross-brand boundaries.
6. Preserve PR #15 unmerged until K4/Codex decision.

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read this TASK and prior G4 reports
5. Fresh fetch origin/main
6. Confirm dedicated independent G4 worktree
7. Inspect G3/H1/H2/G1/G2 scopes; prove no apps/admin overlap
8. Fresh-read PR #15 state/head/base/mergeability/checks/statuses
9. Fresh-read `apps/admin/netlify.toml`
10. Fresh-read `apps/admin/src/proxy.ts` and auth/protected-layout/server-action boundaries

## Scope A — verify live Netlify integration from GitHub-visible evidence

Use GitHub PR checks/statuses/deployments where available to verify Netlify is attached.

Record:
- PR #15 head SHA
- whether Netlify check/status exists
- preview deployment/check URL if GitHub exposes it
- branch/head used by the preview
- build status

Do not require Netlify CLI login if GitHub status/deployment evidence is sufficient.

If Netlify CLI/browser authorization is unavailable, do not bypass it.

## Scope B — make PR #15 produce a Deploy Preview safely

Preferred:
- use existing Netlify automatic PR integration

If PR #15 predates the site and no preview is generated:
1. first verify whether GitHub/Netlify offers re-run/redeploy without source change
2. if not available, determine the smallest source-neutral way to retrigger preview
3. merging/freshening `origin/main` into the PR branch is allowed only if:
   - PR #15 remains semantically the same admin feature
   - no apps/admin conflict
   - resulting diff against fresh main is reviewed before push
   - no unrelated feature code is introduced beyond main reconciliation
4. do not force-push/rebase if avoidable
5. never merge PR #15 into main in this task

If safe retrigger cannot be done, STOP and report exact operator action.

## Scope C — live unauthenticated/proxy QA

On the real Netlify preview/runtime verify:

- `/login` returns/renders normally
- unauthenticated `/posts` does not expose admin content
- unauthenticated `/important-news` does not expose admin content
- protected route behavior is redirect/fail-closed as intended
- invalid/expired session cookie does not grant access
- `src/proxy.ts` is present in build/runtime evidence and actually participates in request handling
- no redirect loop
- no Netlify 404 for valid dynamic routes
- no 5xx attributable to runtime adapter

Use only safe unauthenticated HTTP/browser checks unless authenticated context is already legitimately available.

## Scope D — authenticated QA, only if safely available

If an already-authenticated operator session is available in the current authorized environment, verify:
- valid session recognized
- session refresh/cookie behavior works on Netlify
- protected layout authorizes correctly
- server actions remain authorized

If credentials/session are not available:
- do NOT ask the user to paste passwords/tokens into TASK/report
- do NOT create a new admin credential
- mark authenticated-only checks blocked
- continue all unauthenticated/static/automated QA

## Scope E — PR #15 selector semantics

On PR #15 exact preview head verify as much as safely possible:

- Kabumori / AI Lab selector renders
- switching active brand changes only intended scoped views/data
- Important News remains Kabumori-only
- AI Lab does not expose Kabumori-only system toggle
- tampered/unknown selector input fails closed or safely defaults
- direct URL navigation respects brand rules
- no cross-brand leakage in server-rendered payloads/network-visible data
- auth/RLS boundary unchanged
- no hydration/runtime error

If authenticated UI interaction is blocked, prove the same boundaries through current source/tests plus unauthenticated live behavior and clearly separate what remains unverified live.

## Scope F — runtime/deploy evidence

Inspect:
- Netlify/GitHub check evidence
- build log indicators for Next.js Runtime/OpenNext if accessible
- dynamic route/function generation evidence
- proxy/middleware/runtime warnings

Do not record secret values.

## Scope G — local regression

On fresh main and PR #15 exact head:
- `node --experimental-strip-types --test src/lib/*.test.ts`
- `npx tsc --noEmit`
- `npm run lint`
- `npm run build`
- `git diff --check`
- targeted secret scan

Record exact counts.

## Scope H — decide PR #15 readiness

At completion classify one of:

1. `PREVIEW_QA_PASS`
   - real Deploy Preview exists
   - runtime/proxy unauth checks pass
   - no source regression
   - authenticated-only residuals, if any, are non-blocking and explicitly listed

2. `PREVIEW_QA_PASS_AUTH_BLOCKED`
   - preview/runtime pass
   - only authenticated operator QA remains unavailable

3. `PREVIEW_QA_FAIL`
   - runtime/selector/auth boundary defect found

4. `SAFE_STOP_OPERATOR_ACTION`
   - preview cannot be triggered/accessed without user action

Do not merge PR #15 in any classification.

## Allowed mutations

Allowed:
- Netlify preview/redeploy actions only if already authorized
- safe PR #15 branch refresh against main if strictly necessary and conflict-free
- minimal source fix only if a concrete PR #15 / Netlify runtime defect is found; if source semantics change materially, stop and require review rather than silently broadening scope

## Forbidden

- merge PR #15 into main
- Vercel production deploy/config/plan mutation
- DNS/custom-domain production cutover
- production Supabase schema/RPC/policy/Auth mutation
- service_role exposure
- X API/post/media
- OAuth/Vault/token changes
- weakening auth/RLS
- G1/G2/G3 source changes
- unrelated MIC work

## Production mutation budget

0 for production DB/Auth/X/Vercel/DNS.

Netlify Preview/development deployment is allowed.

## Completion / K4

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K4

Report:
1. fresh main SHA
2. worktree/branch
3. PR #15 exact head/base
4. Netlify integration/check evidence
5. preview URL/id/status if safely available
6. any branch refresh performed
7. `/login` live result
8. protected-route unauth results
9. proxy/runtime evidence
10. authenticated QA result or exact blocker
11. selector/brand-boundary QA
12. local regression counts
13. changed files/commit/push if any
14. Netlify preview mutations
15. production mutation=0
16. PR #15 remains unmerged
17. readiness classification
18. remaining risks
19. next recommendation

Do not merge PR #15 or deploy Vercel production.
