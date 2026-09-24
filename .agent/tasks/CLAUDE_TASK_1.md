# Claude Task 1

- task_id: kabumori-mobile-release-blockers-phase1-merge-only-20260924
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
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

## Report

- task_id: kabumori-mobile-release-blockers-phase1-merge-only-20260924
- result: PR #13 merged with a normal merge commit after the user approved it in chat. Production mutation = 0.
- merge approval: my first `gh pr merge` was denied by the auto-mode safety check ("merge without review"). I stopped and did not work around it. The user then approved in chat: a normal merge, no bypass of the safety check or branch protection. The second attempt used the same normal `gh pr merge 13 --merge`.

### Pre-merge state

- pre-merge main SHA: `2343e26` (my in_progress control commit on `9500b0c`). Merge landed on top of G2's concurrent control commits (`f405270`, `7b2d826`).
- PR #13 head: `8b78ecc22524b830c5e440e8f0b995fbb9a6f014`. This is the exact K1-reviewed SHA; no new commits.
- mergeability: `MERGEABLE` / `CLEAN`, checked twice (before and after main moved)
- checks: Vercel `pass`, Vercel Preview Comments `pass`

### Drift / conflict result

- Main changed since the PR base (`bc30294`): `.agent/*` control files, the PR #12 Important News caller-auth files, `docs/runbooks/important-news-monitor-caller-auth.md`, and migration `20260923110440`. None overlaps the 25 PR files.
- Migration ordering: the latest main migration before this was `20260924090000`, and `20260924100000_ensure_my_profile.sql` stays last. No collision.
- Ownership: H1 (Important News caller-auth), H2 (x-test-post Phase0c) and G2 (apps/admin Netlify) do not own any of the 25 files, `ensure_my_profile`, or `account-delete`.

### Merge / resulting main

- merge commit / resulting main SHA: `f7ace17336c29edec49bb8daa0f95116a30d42fb`
- mergedAt: 2026-09-24T00:15:19Z

### Read-back

- `git diff 8b78ecc2 f7ace17 -- <all 25 reviewed files>` returned an empty diff. All 25 files are byte-identical to the reviewed head.
- `git diff --name-only 2343e26 f7ace17` shows 28 paths: the 25 reviewed files plus 3 `.agent` files from G2's concurrent pushes. No other implementation file changed.
- On merged main, `deno test --no-check --no-lock --allow-read tests/app/ supabase/functions/account-delete/` passed **94 / 0**, the same as at review time.

### Production state (read-only verification, no mutation)

- **account-delete not deployed:** `supabase functions list` returns 16 functions and no `account-delete`.
- **Migration not applied:**
  - `supabase migration list` shows `20260924100000` as local only, with no remote entry.
  - This repo's remote history is known to drift from local timestamps, so the history alone is weak evidence. I also ran a read-only catalog query, which returned `ensure_my_profile_exists = 0` (`public.ensure_my_profile` does not exist in production).
- **Remote history entry I did not make:** `20260924001508` was recorded at 00:15:08 UTC. This session ran no migration apply, `db push` or history repair. The entry comes from another workstream and I did not investigate it (outside this slot's scope).
- **Not changed by this session:**
  - Auth redirect allowlist and dashboard settings. No Auth config command was run.
  - No real recovery email was sent.
  - No real account was deleted.
  - No production user or profile row was modified.
  - No TestFlight or App Store action was taken.
  - No Vercel or Netlify setting was changed.
- Not touched: the Important News caller-auth rollout, and the x-test-post, social-mobile and market-report workstreams.
- The only production calls were read-only: `functions list`, `migration list`, and one `pg_proc` count query.

### Production prerequisites still pending (each needs separate approval)

1. Apply only `supabase/migrations/20260924100000_ensure_my_profile.sql`, as a single file. No `db push` and no history repair/reconcile. Then read back the function's existence, its `security invoker` setting and its grants.
2. Deploy only `account-delete`, with `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` and platform JWT verification on. Then read back the runtime source and confirm no other function's version or `updated_at` moved.
3. Add `kabumori://reset-password` (plus the Expo dev URL for testing) to the Supabase Auth redirect allowlist.
4. Confirm the project's auth flow (PKCE or implicit). The PKCE branch only succeeds on PKCE.
5. Decide `EXPO_PUBLIC_PRIVACY_POLICY_URL` / `EXPO_PUBLIC_TERMS_OF_SERVICE_URL` / `EXPO_PUBLIC_SUPPORT_URL`.
6. Run one real recovery and one real deletion on a disposable test account.
7. Social-mobile follow-up, owned by that workstream: when a user is deleted, their `brands` / `social_accounts` rows remain.

### Ordering note for step 1

The app on main now calls `ensure_my_profile` on every accepted session. A build shipped before the migration is applied will fail profile preparation and show the recovery screen. So in production, **apply the migration before shipping any build from this main.**
