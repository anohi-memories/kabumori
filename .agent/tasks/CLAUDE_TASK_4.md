# Claude Task 4

- task_id: x-admin-pr15-merge-production-verify-20260925
- owner: claude
- slot: claude-4
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（中）
- purpose: Codexレビュー済み・authenticated live QA済みのPR #15を、reviewed head以降の差分がNetlify再build用コメント1行だけであることをfreshに再確認したうえでmainへmergeし、Web管理画面のproduction反映とブランド境界を安全に確認する。新規機能実装ではなくmerge-only + production verificationを主眼とする。

## Known-good context

PR:
- #15 `feat(admin): multibrand selector + brand-parameterized dashboard queries (Phase 2)`
- branch: `admin-multibrand-selector-phase2-20260924`
- latest known head: `f04c44ac564aa775fc0d68106648a0d2e4fcd564`
- Codex reviewed functional head: `de354e7ff9f647435a3c42a87629be1e735794eb`
- review verdict: PASS-WITH-FIX
- reviewed-head以降の既知変更: `apps/admin/netlify.toml` のNetlify再build用runtime影響なしコメント1行のみ
- Netlify Deploy Preview: PASS
- authenticated live QA: PASS
- かぶモリ ⇄ 会社員AIラボ ブランド切替: PASS
- service_role/RLS bypass: none
- apps/admin tests at review: 34/34
- focused boundary: 20/20
- tsc/lint/build: PASS

Deployment policy:
- development / PR / Preview: Netlify
- final production: Vercel
- Vercel Preview rate-limit failure aloneはこのTASKのmerge前ブロッカーにしない
- production反映は実際に確認できた場合だけ成功扱いする

## Mandatory startup

1. Read `PROJECT_RULES.md`
2. Read `.agent/ORCHESTRATION.md`
3. Read `.agent/CURRENT_STATE.md`
4. Read `.agent/ACTIVE_TASK.md`
5. Read this G4 TASK
6. Fresh fetch `origin/main`
7. Fresh fetch PR #15 metadata / latest head / mergeability / checks
8. Confirm PR #15 latest head is still `f04c44ac564aa775fc0d68106648a0d2e4fcd564`
9. Compare `de354e7ff9f647435a3c42a87629be1e735794eb..f04c44ac564aa775fc0d68106648a0d2e4fcd564`
10. Confirm reviewed head以降の変更がNetlify再build用コメント1行のみで、機能/Auth/brand logic差分がない
11. Confirm dedicated independent G4 worktree/checkout; do not share a working directory with G1/G2/G3/H1/H2
12. Confirm no active slot overlaps `apps/admin/**`, auth/admin boundary, production Admin deployment, or PR #15
13. If any head drift, semantic diff, conflict, or ownership ambiguity exists: STOP and report; do not merge

## Scope A — pre-merge safety check

Verify:
- PR #15 remains OPEN and mergeable
- latest head exactly matches expected candidate
- reviewed head ancestor / diff is understood
- no new functional changes since Codex review
- Netlify Preview remains successful or equivalent latest candidate Preview is successful
- authenticated QA evidence remains applicable to the exact candidate
- no unrelated source drift in the PR
- no secret-bearing diff
- no service_role addition
- no RLS bypass
- no admin_users/Auth user mutation embedded in PR
- no DB/migration/RPC/Edge Function change embedded in PR

If semantic source changed since review:
- do not self-approve
- STOP for ChatGPT review-routing decision

## Scope B — merge

Only if Scope A passes:
1. Fresh-check `origin/main` immediately before merge
2. Reconfirm no competing push changed relevant Admin/auth/brand files
3. Merge PR #15 to `main`
4. Record exact merge commit SHA
5. Do not add unrelated cleanup or refactor
6. Do not change PR #33 in this task

## Scope C — post-merge source verification

On fresh `origin/main` after merge:
- confirm PR #15 candidate files are present as merged
- rerun relevant `apps/admin` tests
- rerun focused brand-boundary tests
- `npx tsc --noEmit`
- lint
- build
- `git diff --check`
- targeted secret scan
- verify brand-scoped data queries retain `brand_id` filtering
- verify Kabumori-only surfaces remain unavailable/non-operable for AI Lab
- verify `setSystemEnabled()` cannot mutate Kabumori from another active brand
- verify `admin_users` remains the Admin entry gate
- verify no service_role or RLS bypass exists

## Scope D — production deployment / verification

Use existing approved production deployment path only. Do not invent a new hosting/config model.

1. Determine whether merge to main automatically triggers the intended Vercel production deploy.
2. If production deploy is blocked by a platform limit or requires a destructive/manual configuration change, do not fake success; report the blocker.
3. If production deploy completes, verify the exact production deployment corresponds to the merged commit.
4. Read-only/live QA on production:
   - `/login` reachable
   - successful Admin login using the existing operator account without recording credentials
   - かぶモリ ⇄ 会社員AIラボ selector works
   - brand-specific dashboard data does not cross-mix
   - Kabumori-only controls/surfaces are not operable while AI Lab is active
   - unauthorized/non-admin boundary still fails closed
   - no obvious secret/token exposure in rendered output or logs available to the task
5. Do not mutate business data merely to test reads.
6. If a write-path check would mutate production, use an existing safe read-only/static boundary proof instead unless separately authorized.

## Explicitly forbidden

- DB/schema change
- migration apply/create/edit
- RPC change
- Edge Function change/deploy
- RLS/policy change
- `admin_users` mutation
- Supabase Auth user mutation
- Supabase Site URL / Redirect URL change
- OAuth change
- Vault read/write for X credentials
- X secret/token mutation
- X API post/media action
- service_role addition/exposure
- PR #33 merge or modification
- unrelated source cleanup/refactor
- G1/G2/G3/H1/H2 task/control-file overwrite
- changing another slot's branch/worktree/server

## Production mutation budget

Allowed:
- normal GitHub merge of PR #15
- normal production deployment caused by that merge, if it follows the existing approved pipeline
- authenticated read-only production QA

Not allowed:
- DB/Auth/RLS/OAuth/Vault/X/business-data mutations

## Completion conditions

PASS only if:
- exact PR candidate verified against reviewed head
- no semantic drift requiring new review
- PR #15 merged successfully
- post-merge tests/checks pass
- production deployment status is truthfully determined
- if deployed, exact merged commit is verified in production
- authenticated production QA passes for login + brand switching + brand isolation + Kabumori-only boundary
- forbidden mutations remain 0

If production deployment is blocked:
- source/merge may be reported PASS
- deployment must be reported BLOCKED/PENDING, not PASS
- provide the exact blocker and safest next step

## Report

At completion append `## Report` containing:
- task_id
- result
- model_used
- dedicated worktree / branch
- fresh main before merge
- PR #15 exact head
- reviewed head comparison result
- mergeability/checks
- merge commit SHA
- changed_files / semantic drift assessment
- tests with exact counts
- Netlify status
- Vercel production deploy status
- production commit/version evidence
- authenticated production QA results
- brand isolation / Kabumori-only boundary results
- secret/service_role/RLS safety checks
- production mutations performed
- remaining_issues
- next_recommendation

Then set:
- status -> review_required
- next_owner -> chatgpt

STOP for K4.

## Review policy for this task

No automatic new Codex review is required if:
- latest PR head is unchanged,
- reviewed-head以降が本当にruntime影響なしコメント1行のみ,
- merge-only/post-merge verification does not alter source semantics.

If any semantic source drift is found, STOP and return to ChatGPT before merge.

## Report

- pending
