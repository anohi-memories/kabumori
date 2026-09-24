# Claude Task 4

- task_id: x-admin-netlify-deploy-preview-pipeline-20260924
- owner: claude
- slot: claude-4
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（高）
- purpose: X自動投稿・複数ブランド管理画面 apps/admin の開発中PreviewをNetlifyへ移し、Vercelのdeployment rate limitに依存せずテスト・レビューできる状態を作る。最終production deployのみVercelへ残す。

## Deferred previous G4 task

Previous task:
- x-admin-phase2-vercel-gate-merge-and-postmerge-qa-20260924
- PR #15 remains unmerged because Vercel check is rate-limited
- reviewed code/test state is preserved in prior G4 Report
- do NOT discard or reinterpret that work
- its remaining steps (Vercel final gate -> merge -> post-merge read-back -> production QA) are intentionally deferred by explicit user instruction while Netlify Preview is introduced

This Netlify task supersedes the active slot temporarily; the deferred PR #15 final-production gate must be resumed later as a separately assigned task after Netlify workflow is established.

## User-approved deployment policy

New standard:
- development / PR / test deploy: Netlify Deploy Preview
- code review occurs against source + Netlify Preview
- Vercel is reserved for final production deployment after implementation and review are complete
- do not spend Vercel deployment quota on ordinary intermediate testing where Netlify can validate the same web behavior

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read this TASK and prior G4/G2 reports for PR #15 context
5. Fresh fetch origin/main
6. Confirm dedicated independent G4 worktree
7. Inspect G3/H1/H2/G1/G2 scopes and prove no overlap
8. Audit apps/admin Next.js version, package scripts, proxy/middleware, Supabase SSR, Server Actions, dynamic routes, and current Vercel-specific config
9. Audit any existing Netlify config before changing files

## Scope A — Netlify Preview architecture

Configure apps/admin so PR/branch builds can run as Netlify Deploy Previews.

Requirements:
- preserve Next.js 16 App Router semantics
- preserve Supabase SSR/cookie behavior
- preserve protected route behavior
- preserve Server Actions / proxy or middleware behavior supported by the chosen Netlify adapter/runtime
- do not convert secure server reads to client-side reads merely to make Netlify work
- no weakening of auth/RLS/admin boundaries
- no production DNS/domain change
- no production Supabase mutation

If a Vercel-specific assumption blocks Netlify, document and minimally abstract it; do not redesign unrelated admin behavior.

## Scope B — environment and secret boundary

Classify every env var needed by apps/admin:
- public/browser-safe
- server-only
- unavailable / external setup required

Rules:
- never commit secret values
- never expose service_role, OAuth secrets, Vault material, OpenAI private keys, or other server-only values via NEXT_PUBLIC
- Preview must fail closed if required server-only configuration is absent
- document exact Netlify UI environment-variable names required, but not values

If Netlify connection/site setup requires interactive account authorization, prepare the repository completely and report only the exact remaining UI steps.

## Scope C — build and preview verification

Run:
- apps/admin clean install as appropriate
- node tests (31/31 baseline or current higher count)
- npx tsc --noEmit
- npm run lint
- npm run build
- Netlify-compatible local/build command if available
- git diff --check
- secret scan

If actual Netlify Preview deploy is available through existing credentials/integration, verify:
- deploy succeeded
- login/auth redirect behavior
- protected pages
- Kabumori / AI Lab selector rendering
- Important News remains Kabumori-only
- AI Lab does not expose Kabumori-only toggle
- representative SSR/dynamic pages render

Do not mutate production operational settings during QA.

## Scope D — deployment workflow

Document the new normal flow:

feature branch/PR
-> local tests
-> Netlify Deploy Preview
-> Claude implementation completion
-> ChatGPT K review
-> Codex review when required
-> fixes/regression
-> final approval
-> Vercel production deploy only at the end

Vercel failure/rate-limit must no longer block ordinary implementation review if Netlify Preview and local tests cover the required web checks.

## Scope E — preserve PR #15

Do not merge PR #15 merely as part of setting up Netlify.

After Netlify Preview is working:
- identify whether PR #15 can be previewed on Netlify without modifying its reviewed semantics
- if yes, record the safe procedure for the later final gate
- keep the actual production merge/deploy deferred until separately resumed

## Forbidden

- PR #15 merge in this task
- Vercel production deploy/config/plan change
- DNS/domain change
- DB migration/RPC/view/policy changes
- Edge Function/Cron/OAuth/Vault/token changes
- x-test-post/queue Phase1D changes
- selector semantics or ADMIN_BRANDS behavior changes
- weakening auth/RLS
- secret exposure

## Completion / K4

When complete:
- status -> review_required
- next_owner -> chatgpt
- append Report with:
  - fresh main SHA
  - worktree
  - exact changed files
  - Netlify config/adapter/build decisions
  - environment variable classification
  - local build/test results
  - actual Preview deploy result or exact external authorization blocker
  - preview QA results
  - proof PR #15 semantics remain unchanged
  - Vercel production mutation=0
  - deferred PR #15 state
  - remaining risks
  - next recommendation
- STOP for K4.
