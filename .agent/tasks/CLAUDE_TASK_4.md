# Claude Task 4

- task_id: x-admin-pr33-rebase-stabilize-auth-review-prep-20260925
- owner: claude
- slot: claude-4
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Opus5.5（高）
- purpose: open PR #33（Web Admin password recovery / invite flow）をfresh mainへ安全に追従させ、現在のmerge conflictを解消し、既存Admin/Auth/brand境界を壊さずにsource/Preview候補として再安定化する。production Auth URL設定・merge・本番反映はこのTASKでは行わず、K4後に独立Codexレビューへ渡せる状態まで仕上げる。

## Current known state

PR #33:
- title: `feat(admin): Web password recovery and invite flow (G4)`
- branch: `g4/admin-password-recovery-20260925`
- current head: `dd66921a1578d6b54e707e5dce81eaa6ab1701af`
- state: open
- commits: 5
- changed_files: 11
- additions: 1198
- mergeable: false
- mergeable_state: dirty

Implemented already:
- `/forgot-password`
- `/auth/confirm`
- `/reset-password`
- login page password-reset entry/notice
- generic recovery response to avoid account enumeration
- fixed-origin redirect construction / no arbitrary next redirect
- recovery/invite-only confirmation flow
- recent email-link AMR requirement for reset
- sign-out after password update
- Admin authorization remains separate through `admin_users`

Prior source tests:
- auth/lib tests 46/46
- tsc/lint/build/diff PASS
These must be rerun after conflict resolution.

## Mandatory startup

1. Read `PROJECT_RULES.md`, `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK.
2. Use a dedicated independent G4 worktree/checkout.
3. Fresh fetch `origin/main` and PR #33.
4. Confirm H1 is reviewing universal OAuth files only and there is no overlap with `apps/admin/**`.
5. Inspect exact PR #33 vs current main conflict set before changing anything.
6. Preserve all post-PR15 production Admin behavior now on main:
   - multibrand selector
   - admin_users gate
   - Kabumori/AI Lab brand isolation
   - Netlify/Vercel runtime behavior
7. Do not touch G3/H1 OAuth/Vault/migration files.

## Scope A — conflict analysis

Determine exactly why PR #33 is dirty against current main.

For every conflict:
- identify whether main or PR #33 owns the newer semantic behavior
- preserve both when non-conflicting
- do not blindly choose ours/theirs
- especially inspect login/auth/layout/proxy/runtime files changed since PR #33 branched

Produce a concise conflict map in the Report.

## Scope B — integrate PR #33 onto fresh main

Update the PR branch safely so it is based on current main semantics.

Required invariants:
- no regression to PR #15 multibrand Admin behavior
- `admin_users` remains the only Admin authorization gate
- password reset/invite never grants Admin authorization
- no service_role in browser/client
- no password/token in URL/log
- no account enumeration
- no open redirect
- normal password-login session cannot access reset-password flow
- recovery/invite link is short-lived / appropriately recent per existing design
- callback types outside allowed recovery/invite fail closed
- sign-out after password update remains
- existing mobile `kabumori://reset-password` flow outside apps/admin is untouched

## Scope C — tests

At minimum rerun:
- all `apps/admin/src/lib/*.test.ts`
- targeted recovery/invite tests
- existing PR #15 multibrand/admin boundary tests
- `npx tsc --noEmit`
- lint
- build
- `git diff --check`
- targeted secret/credential scan

Add adversarial tests if needed for:
- arbitrary `next`/redirect URL
- recovery email enumeration
- normal-login session trying `/reset-password`
- expired/stale recovery session
- wrong token type
- reused callback
- query/fragment credential leakage
- non-admin reset success followed by Admin route access denial

## Scope D — Netlify Preview

If current repo policy allows automatic PR Preview after branch update:
- verify exact updated PR head deploys successfully to Netlify
- unauthenticated `/forgot-password`, `/auth/confirm`, `/reset-password`, `/login` behavior
- no 404/5xx/redirect loop
- do not perform destructive Auth mutation merely for Preview QA

If one real recovery E2E requires production/real Auth configuration not already safely available, STOP and report the exact operator gate. Do not change Site URL/Redirect URLs in this task.

## Explicitly forbidden

- PR #33 merge
- Vercel production deploy
- Supabase Site URL / Redirect URL mutation
- Auth user/admin_users mutation
- DB/RLS/RPC/migration changes
- service_role exposure
- G3/H1 OAuth/Vault/token-refresh changes
- X API call/post/media
- important-news/common-search work
- unrelated cleanup

## Production mutation budget

- DB/schema/RLS/RPC: 0
- Auth config/user mutation: 0
- Edge deploy: 0
- X/OAuth/Vault: 0
- production Admin deploy: 0
- business-data mutation: 0

Netlify PR Preview caused by normal branch update is allowed.

## Completion / K4

Report:
- fresh main/head
- exact conflict map
- resolution decisions
- final PR head
- changed files
- tests/counts
- multibrand/Admin regression result
- security invariants
- Netlify Preview result
- production mutation=0
- remaining operator gates
- whether independent Codex Auth/security review is ready

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K4.

Because this is Auth/security-sensitive, K4 should normally route one focused Codex review before merge.
Recommended Codex model after K4: Sol（高）.

## Report

- pending
