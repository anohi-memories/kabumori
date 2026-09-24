# Claude Task 1

- task_id: kabumori-mobile-release-blockers-phase1-merge-only-20260924
- owner: claude
- slot: claude-1
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Opus 5.5
- purpose: K1 PASS済みのPR #13 consumer mobile release-blocker candidateを最新mainへfreshenし、semantic driftを確認したうえで通常手順でmergeする。production migration/deploy/Auth設定変更は行わない。

## K1 decision

Previous task `kabumori-release-mobile-blockers-phase1-auth-account-settings-20260924` is **PASS for source candidate**.

Accepted candidate:
- PR #13 head: `8b78ecc22524b830c5e440e8f0b995fbb9a6f014`
- Implements:
  - idempotent `ensure_my_profile()` RPC candidate
  - missing-profile recovery UX
  - password reset request + recovery deep-link handling
  - dedicated `account-delete` Edge Function candidate
  - Settings / Account / Privacy / Terms / Support / Logout / Delete Account entry points
- Account deletion trusts only the verified JWT identity; no caller-supplied arbitrary user id.
- Existing FK cascades are used rather than maintaining a drifting per-table delete list.
- App tests: 77/77 PASS
- account-delete tests: 17/17 PASS
- combined: 94/94 PASS
- new Function deno checks PASS
- Expo web export PASS; 10 routes unchanged
- disposable PostgreSQL proof PASS, including a negative control for privileges
- `git diff --check` PASS
- two app TypeScript errors are pre-existing stale Expo typed-route errors and unchanged from clean base
- Vercel check on PR #13 head: success
- production mutation = 0
- Important News caller-auth files/migration untouched

Current main drift since PR #13 base is control/task-only at review time; however fresh-check again before merge.

## Mandatory startup

1. Read `PROJECT_RULES.md`
2. Read `.agent/ORCHESTRATION.md`
3. Read `.agent/CURRENT_STATE.md`
4. Read this TASK and the prior task report
5. Fresh fetch `origin/main`
6. Inspect PR #13 current head/checks/mergeability
7. Compare latest main against PR #13 base/head
8. Confirm H1/H2/G2 ownership does not overlap any of PR #13's 25 changed files or `ensure_my_profile` / `account-delete`

## Work

If and only if:
- PR #13 still contains the reviewed semantics,
- latest-main drift has no semantic overlap,
- required checks remain green,
- no conflicting workstream owns the same files/DB objects,

then freshen/rebase as needed and merge PR #13 using normal repository rules.

After merge:
- read back resulting main SHA
- verify all reviewed implementation files are present and semantically unchanged
- confirm migration `20260924100000_ensure_my_profile.sql` is source-only and unapplied
- confirm `account-delete` is not deployed
- confirm no Auth redirect allowlist/dashboard setting changed
- confirm no real reset email or account deletion occurred

## Forbidden production actions

Do NOT:
- apply the migration
- deploy `account-delete`
- change Supabase Auth redirect allowlist/settings
- send a real recovery email
- delete a real account
- modify production user/profile rows
- perform TestFlight/App Store action
- change Vercel/Netlify settings
- touch Important News caller-auth rollout
- touch x-test-post/social-mobile/market-report workstreams

## Handoff

Update this task Report with:
- pre-merge main SHA
- final PR head/checks
- drift/conflict result
- merge/resulting main SHA
- read-back result
- production mutation = 0
- exact production prerequisites still pending

Then:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for K1

**推奨モデル：Opus 5.5。**
