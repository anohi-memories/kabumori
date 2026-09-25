# Claude Task 4

- task_id: x-admin-netlify-live-site-preview-qa-20260925
- owner: claude
- slot: claude-4
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（高）
- purpose: 既にrepository準備済みの apps/admin を実際のNetlifyサイトへ接続し、最初のDeploy Previewで proxy.ts / Supabase SSR / protected route / PR #15 UI semantics を安全にQAする。PR #15 mergeやVercel production deployは行わない。

## Previous G4 closure

Previous task:
- `x-admin-netlify-deploy-preview-pipeline-20260924`

Final K4:
- PASS
- implementation commit: `12b994e00a4f7ae83076e6c9c44a09d339cebb9d`
- branch: `admin-netlify-deploy-preview-phase2-20260924`
- repository-side Netlify config/runbook complete
- live Netlify site connection not yet performed
- `proxy.ts` runtime on Netlify not yet verified
- PR #15 remains unmerged and semantically untouched
- Vercel/production/DB/DNS mutation = 0

## Goal

Complete the external/live half of the Netlify Preview setup:

1. connect/create the Netlify site for this repo/admin app
2. set the correct base/build configuration
3. set only required public env vars
4. verify a real Netlify Deploy Preview
5. validate auth/session/protected-route behavior, especially Next.js 16 `proxy.ts`
6. validate PR #15 behavior on Preview without merging it

This task is allowed to perform Netlify development/preview configuration only.

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read this TASK and previous G4 Report
5. Fresh fetch origin/main
6. Confirm independent dedicated G4 worktree
7. Inspect G3/H1/H2/G1/G2 and prove no overlap
8. Re-read `apps/admin/docs/phase2-netlify-deploy-preview.md`
9. Re-read current `apps/admin/netlify.toml`
10. Verify PR #15 current head and that apps/admin source semantics have not drifted unexpectedly

## Scope A — Netlify account/site connection

Preferred path:
- use an existing authorized Netlify integration/session if available
- connect repository `anohi-memories/kabumori`
- create or link the admin site
- base directory: `apps/admin`

Do not create multiple duplicate Netlify sites if one already exists.

If interactive browser/account authorization is required and cannot be completed inside the current tool/session:
- STOP before guessing or bypassing
- record the exact blocking screen/action
- do not substitute Vercel
- do not weaken authentication
- report the minimal user action required

## Scope B — build configuration

Expected:
- Base directory: `apps/admin`
- build command: use repository `netlify.toml`
- publish/runtime: Netlify Next.js adapter/default
- Node version: use existing repository configuration
- Deploy Previews: enabled for PRs

Confirm final live Netlify settings match repository intent.

Do not add a custom Next.js adapter unless the automatic adapter demonstrably fails and the change is narrowly justified.

## Scope C — environment variables

Allowed Netlify env vars:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`

Use existing authorized/public values only.

Forbidden in Netlify admin preview env:
- service_role key
- OAuth client secret
- Vault secret/plaintext/reference material
- OpenAI private keys
- X access/refresh tokens
- any unrelated production secret

Confirm no server-only secret is accidentally exposed through `NEXT_PUBLIC_*`.

If the required public values cannot be safely retrieved from an already-authorized source, STOP and report the missing operator input. Do not invent them.

## Scope D — first live Deploy Preview

Create or trigger a Preview build for a safe branch/PR.

Preferred target:
- PR #15, because its reviewed selector semantics need real Preview QA and it is intentionally still unmerged

If Netlify cannot preview the already-open PR directly, use the safest repository-supported equivalent without changing PR #15 semantics.

Record:
- site id/name
- preview/deploy id if available
- branch/PR head
- build status
- build/runtime adapter version if exposed
- preview URL in Report only if non-secret/public

Do not merge PR #15.

## Scope E — proxy.ts / auth QA

This is the main unresolved risk.

Verify on actual Netlify runtime:

1. unauthenticated request to protected admin route redirects/fails closed
2. login page loads
3. authenticated session cookie is recognized
4. `src/proxy.ts` session refresh behavior executes correctly on Netlify
5. expired/invalid session does not grant access
6. protected layout still performs its own auth/authorization checks
7. Server Action authorization remains enforced

If full authenticated QA requires a production credential not safely available:
- perform all possible unauthenticated/fail-closed QA
- do not create or expose credentials
- report exactly what authenticated step remains blocked

## Scope F — PR #15 Preview QA

Against PR #15 Preview, verify:

- Kabumori / AI Lab selector renders correctly
- switching active brand changes only intended scoped admin data/views
- Important News remains Kabumori-only
- AI Lab does not expose Kabumori-only system toggle
- tampered/unknown selector value fails closed or resolves safely
- direct URL navigation respects active-brand rules
- auth/RLS boundary remains intact
- no cross-brand leakage
- representative SSR/dynamic pages render
- no hydration/runtime errors attributable to Netlify

Do not change selector semantics merely to make Preview pass.

## Scope G — Netlify logs/runtime evidence

Inspect only what is necessary:
- build logs
- Next.js runtime/function logs
- proxy/middleware-related runtime evidence
- auth redirect errors

Do not copy secret values into TASK/Report.

If logs expose secrets unexpectedly, stop and report a security issue without reproducing the secret.

## Scope H — local regression

Before/after live QA run:

- node tests for apps/admin
- `npx tsc --noEmit`
- `npm run lint`
- `npm run build`
- `git diff --check`
- secret scan

If PR #15 has current scoped tests, run them at its exact head too.

## Scope I — deployment policy verification

Confirm the intended workflow is actually viable:

feature branch / PR
→ local tests
→ Netlify Deploy Preview
→ implementation K review
→ Codex review when needed
→ merge/final approval
→ Vercel production only at final release stage

Netlify Preview success should remove Vercel rate limit from ordinary development QA.

## PR #15 safety

PR #15 remains:
- unmerged
- no Vercel production deploy
- no production admin behavior switch

This task may Preview and QA PR #15 only.

## Forbidden

- merge PR #15
- Vercel production deploy/config/plan changes
- DNS/custom-domain production cutover
- production Supabase DB migration/RPC/view/policy mutation
- Edge Function/Cron/OAuth/Vault/token mutation
- X API/post/media actions
- changing ADMIN_BRANDS/selector semantics unless a concrete bug is found and a separate fix is explicitly warranted
- service_role exposure
- disabling auth/RLS to make Preview work
- G1/G2/G3 source changes

## Production mutation budget

0 for:
- Vercel production
- production DB/schema/RPC/Auth/X/Cron/Vault

Allowed:
- Netlify development/preview site connection and Preview environment/configuration

## Completion / K4

When complete:
- status -> review_required
- next_owner -> chatgpt

Report:
1. fresh main SHA
2. worktree/branch
3. Netlify site connection result
4. exact blocker if interactive auth stopped execution
5. live configuration read-back
6. env-var names configured (never values)
7. Preview branch/PR/head
8. build/deploy result
9. `proxy.ts` QA result
10. unauthenticated/authenticated protected-route QA
11. PR #15 selector/brand boundary QA
12. local regression counts
13. changed files, if any
14. Netlify-only mutations performed
15. production mutation=0
16. PR #15 remains unmerged confirmation
17. remaining risks
18. next recommendation

If the only blocker is interactive Netlify authorization:
- leave status `review_required`
- document the exact one-time user action required
- STOP for K4.

Do not merge PR #15 or deploy production in this task.
