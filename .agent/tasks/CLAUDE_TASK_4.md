# Claude Task 4

- task_id: x-ai-salaryman-dev-diary-pr61-date-validation-fix-20260930
- owner: claude
- slot: claude-4
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（中）
- target: PR #61
- purpose: H2最終レビューで見つかった impossible calendar date のみを修正し、PR #61をmerge/deploy可能な状態にする。

## Fix

Current issue:
- diary date validation checks only YYYY-MM-DD shape
- JavaScript normalizes impossible dates such as 2026-09-31
- this can incorrectly pass freshness and allow a diary topic to be treated as recent

Required:
- validate actual calendar dates strictly
- use round-trip validation or equivalent so impossible dates are rejected
- reject invalid leap-day/month/day combinations
- impossible dates must fall back to evergreen, never diary/current-progress mode
- do not change the accepted runtime snapshot/import architecture
- do not change hashtag behavior
- do not change sanitizer scope except what is strictly required for date validation

## Tests

Add regression coverage for at least:
- 2026-09-31 rejected
- 2026-02-29 rejected
- valid leap day accepted
- valid month-end accepted
- invalid date falls back to evergreen
- existing context/profile/generator/scheduled suites remain green
- rerun current-head relevant tests with updated counts
- deno check changed files
- git diff --check
- secret scan

## Production

No deploy and no real X post.
production_mutation=0.

## Completion / K4

Report exact validation rule, changed_files, tests/current counts, PR head, production_mutation=0, and readiness for final H2 re-review.
Then status -> review_required, next_owner -> chatgpt, STOP for K4.
