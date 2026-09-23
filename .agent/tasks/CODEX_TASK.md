# Codex Task

- task_id: kabumori-pr8-gpt6-news-portfolio-final-merge-20260923
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: high
- recommended_model: Luna
- purpose: C1 PASS済みのPR #8（Important News producer V2 + Portfolio validator fix + GPT-6 Luna upgrade）をlatest mainへfreshenし、必要チェック通過後mainへmergeする。production deploy/migration/backfillは行わない。

## C1 decision

Previous task `kabumori-gpt6-luna-model-upgrade-on-pr8-20260923` is **PASS**.

Verified at C1:
- Official OpenAI model ID is `gpt-6-luna`.
- Standard short-context pricing is input $0.10 / 1M tokens and output $0.50 / 1M tokens.
- Important News app-copy model constant is `gpt-6-luna`.
- Personalized Reports model constant is `gpt-6-luna`.
- Usage ledger includes explicit GPT-6 Luna pricing.
- PR #8 head `6f5b184bfd7406d356f2f499342013774fec02d5` has required Vercel status = success.
- PR #8 remains open and git-mergeable.
- Current main is 25 commits ahead of the old merge base, but those main-side changes have **zero overlap** with the 11 PR #8 changed files.
- Production mutation = 0.

## Approved PR contents

PR #8 currently contains:
- Important News source-backed app-copy V2
- Portfolio full-width Japanese company-name validator fix
- GPT-6 Luna upgrade for Important News app-copy draft/Fact
- GPT-6 Luna upgrade for Personalized Reports draft/Fact
- GPT-6 Luna cost-estimator updates and related tests

Do not broaden scope.

## Mandatory startup

1. Read `.agent/ORCHESTRATION.md`
2. Read `.agent/CURRENT_STATE.md`
3. Read this TASK
4. Read `.agent/CODEX_REPORT.md`
5. Fresh fetch `origin/main`
6. Re-check PR #8 head/status and current main
7. Re-check overlap against these approved files:
   - `supabase/functions/important-news-monitor/app_copy_logic.ts`
   - `supabase/functions/important-news-monitor/app_copy_logic_test.ts`
   - `supabase/functions/important-news-monitor/app_copy_v2_migration_static_test.ts`
   - `supabase/functions/important-news-monitor/cost_path_audit_test.ts`
   - `supabase/functions/important-news-monitor/index.ts`
   - `supabase/functions/important-news-monitor/usage_ledger.ts`
   - `supabase/functions/important-news-monitor/usage_ledger_test.ts`
   - `supabase/functions/personalized-reports/report_logic.ts`
   - `supabase/functions/personalized-reports/report_logic_test.ts`
   - `supabase/functions/personalized-reports/shared_market_consumer_test.ts`
   - `supabase/migrations/20260922110000_important_news_app_copy_v2_source_backed_candidates.sql`
8. Confirm no H2/G1/G2 ownership conflict.

## Freshen / merge rules

- Freshen/rebase/cherry-pick onto latest `origin/main` as needed without dragging stale `.agent` control history.
- If a genuinely new semantic main edit appears in any approved file, STOP for C1 instead of auto-resolving.
- Rerun relevant tests after freshening.
- Required Vercel check must be success on the final merge head.
- No branch-protection bypass.
- If Vercel rate limit returns, leave PR open and report blocker.

## Verification

Minimum:
- targeted Important News app-copy tests PASS
- targeted Personalized Reports tests PASS
- model-id assertions PASS
- cost-estimator tests PASS
- important-news relevant/full suite status recorded
- changed-file Deno checks PASS
- `git diff --check` PASS
- verify GPT-6 Luna constants/pricing preserved
- verify previously approved producer V2 and Portfolio validator behavior preserved
- production mutation = 0

## Merge

If all checks pass:
- merge PR #8 to `main`
- read back resulting main SHA
- verify PR is merged/closed
- verify approved files on main
- do NOT apply migration
- do NOT deploy `important-news-monitor`
- do NOT deploy `personalized-reports`
- do NOT regenerate/backfill the 9/18 close report

## Handoff

Update `.agent/CODEX_REPORT.md` with:
1. pre-freshen main SHA
2. final PR head SHA
3. verification results
4. Vercel required-check result
5. PR merge/resulting main SHA
6. read-back proof that GPT-6 Luna + producer V2 + Portfolio validator fix are on main
7. production mutation = 0
8. remaining production rollout items:
   - exact migration apply
   - `important-news-monitor` deploy
   - `personalized-reports` deploy
   - safe one-time 9/18 close regeneration/backfill decision

On completion:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for C1

**推奨モデル：Luna。**
