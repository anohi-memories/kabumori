# Codex Task

- task_id: x-admin-pr33-auth-fix-round2-final-review-20260926
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: high
- recommended_model: Sol（高）
- purpose: K4 PASS済みPR #33 head 2528b56 の3つのAuth修正を再レビューし、merge前のsource gateを判定する。レビュー範囲はC1指摘3点と既存Admin境界への回帰に限定する。

## Target

PR #33:
- head: `2528b5686bcbb3630fb636cec12162803f921f8f`
- previous failing head: `e6b93beccfb9209dbe640fb9ea1464f2568f3c74`
- status: OPEN / MERGEABLE
- Netlify Preview: PASS

## Required review

Verify all three findings are actually fixed:

1. generic `otp` / `magiclink` can no longer authorize reset.
2. recovery/invite purpose and 15-minute freshness are rechecked immediately before password update using verified server-side claims/current server time.
3. signOut returned-error and thrown-error paths cannot claim confirmed logout or redirect to success.

Also verify:
- no open redirect/account enumeration regression
- no service_role/client secret exposure
- admin_users remains sole Admin gate
- non-admin cannot gain Admin through reset/invite
- PR #15 multibrand/brand isolation remains intact
- no mobile reset flow changes outside apps/admin

## Tests

Run focused:
- apps/admin src/lib tests
- new recovery-context/action tests
- otp/magiclink negative cases
- stale-open-form case
- signOut returned/thrown failures
- admin/brand boundary tests
- tsc/lint/build
- git diff --check
- targeted secret scan

## Real E2E gate

Determine whether source is review-approved before E2E.

Even if source PASS:
- do not merge yet.
- one bounded real recovery flow and one invite flow remain required before merge.
- no real email/Auth mutation in this review.

## Production safety

Read-only only.
No merge, production deploy, Supabase Auth config/user mutation, DB/RLS/RPC migration, service_role exposure, G3 OAuth changes, or important-news/common-search work.

## Completion / C1

Report:
- verdict PASS / PASS-WITH-FIX / FAIL
- reviewed/fixed head
- verdict on each of the 3 prior findings
- tests/counts
- source readiness for real E2E
- exact remaining E2E/operator gate
- production mutation=0

Then:
- status -> review_required
- next_owner -> chatgpt
- update .agent/CODEX_REPORT.md
- STOP for C1.


## Final C1 disposition — round2

- verdict: **PASS for source readiness to bounded real E2E**.
- reviewed PR #33 head: `2528b5686bcbb3630fb636cec12162803f921f8f`.
- all three prior Auth findings are fixed.
- source tests 83/83 PASS; tsc/lint/build/diff/secret scan PASS.
- PR #15 Admin/multibrand boundaries remain intact.
- production mutation=0.
- this is not merge approval. One bounded real recovery flow + one invite flow remain mandatory before merge.
- the E2E requires separate user authorization because it may require temporary Supabase Redirect URL configuration and test-account/email operations.
